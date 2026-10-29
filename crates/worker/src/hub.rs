//! Persistent state lives in SQLite; live connection state survives hibernation in attachments.

mod alerts;
mod appearance;
mod data;
mod schema;
mod servers;
mod updates;

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    time::Duration,
};

use moni_protocol::api::{ApiErrorCode, DashboardEvent, LoginRequest, MetricsFrame, Traffic};
use moni_protocol::{AgentMessage, CLOSE_INCOMPATIBLE, HubMessage, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use worker::*;

use crate::{
    auth::{self, H_ADMIN, H_COUNTRY, H_SERVER_ID, H_TOKEN_HASH, now_ms},
    error, logic, report_interval,
};

const TAG_AGENT: &str = "agent";
const TAG_DASH: &str = "dash";
const TAG_PUBLIC: &str = "public";
const ALARM_PERIOD_MS: i64 = 30_000;

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "role", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
enum Attachment {
    Agent(AgentConn),
    Dash { closing: bool },
}

#[derive(Serialize, Deserialize, Clone)]
struct AgentConn {
    server_id: String,
    last_seen_ms: i64,
    closing: bool,
    latest: Option<MetricsFrame>,
    parse_warn_ms: Option<i64>,
    pending: HashMap<String, i64>,
    pending_warn_ms: Option<i64>,
    traffic_month: CachedTraffic,
    report_interval_s: u32,
    report_grace_until_ms: Option<i64>,
    hello_received: bool,
    update_repo: Option<String>,
    update_sent_job_id: Option<String>,
    update_sent_ms: Option<i64>,
    update_attempts: u8,
}

// Attachments use JS numbers; serializing a u64 above 2^53 through workers-rs fails.
#[derive(Serialize, Deserialize, Clone)]
struct CachedTraffic {
    rx_bytes: f64,
    tx_bytes: f64,
    since_ms: i64,
}

impl From<CachedTraffic> for Traffic {
    fn from(value: CachedTraffic) -> Self {
        Self {
            rx_bytes: value.rx_bytes as u64,
            tx_bytes: value.tx_bytes as u64,
            since_ms: value.since_ms,
        }
    }
}

fn tag_for(id: &str) -> String {
    format!("server:{id}")
}

fn agent_conn(ws: &WebSocket) -> Option<AgentConn> {
    match ws.deserialize_attachment().ok().flatten() {
        Some(Attachment::Agent(conn)) => Some(conn),
        _ => None,
    }
}

fn save(ws: &WebSocket, conn: AgentConn) -> Result<()> {
    ws.serialize_attachment(Attachment::Agent(conn))
}

#[durable_object]
pub struct Hub {
    state: State,
    env: Env,
    login_failures: RefCell<logic::LoginFailures>,
    rules_cache: RefCell<Option<Vec<moni_protocol::api::AlertRule>>>,
    alarm_check_ms: Cell<Option<i64>>,
}

impl DurableObject for Hub {
    fn new(state: State, env: Env) -> Self {
        if schema::migrate(&state.storage()).is_err() {
            console_error!("Hub schema migration failed");
        }
        let hub = Self {
            state,
            env,
            login_failures: RefCell::default(),
            rules_cache: RefCell::default(),
            alarm_check_ms: Cell::new(None),
        };
        if hub.rules().is_err() {
            console_error!("Hub alert rule loading failed");
        }
        hub
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let is_test = req.path() == "/api/alerts/test";
        let result = self.route(req).await;
        if !is_test && let Err(error) = self.dispatch_notifications() {
            console_error!("Hub notification dispatch failed: {}", error);
        }
        error::finish(result)
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let Some(mut conn) = agent_conn(&ws).filter(|c| !c.closing) else {
            return Ok(());
        };
        let WebSocketIncomingMessage::String(text) = message else {
            return Ok(());
        };
        if text.len() > 16_384 {
            self.on_disconnect(&ws)?;
            ws.close(Some(1009), Some("message too large"))?;
            return Ok(());
        }
        let message = match serde_json::from_str::<AgentMessage>(&text) {
            Ok(message) => message,
            Err(error) => {
                let now = now_ms();
                if logic::warning_due(conn.parse_warn_ms, now) {
                    console_warn!(
                        "Invalid Agent message server={}: {}",
                        conn.server_id,
                        logic::safe_parse_error(&error)
                    );
                    conn.parse_warn_ms = Some(now);
                    save(&ws, conn)?;
                }
                return Ok(());
            }
        };
        conn.last_seen_ms = now_ms();
        conn.report_grace_until_ms = None;
        self.heal_alarm(conn.last_seen_ms).await;
        self.refresh_traffic(&ws, &mut conn)?;
        match message {
            AgentMessage::Hello {
                protocol,
                agent_version,
                host,
                update_repo,
                country,
            } => {
                if conn.hello_received {
                    self.on_disconnect(&ws)?;
                    ws.close(Some(1008), Some("duplicate Hello"))?;
                    return Ok(());
                }
                if protocol != PROTOCOL_VERSION {
                    self.on_disconnect(&ws)?;
                    ws.close(Some(CLOSE_INCOMPATIBLE), Some("incompatible protocol"))?;
                    return Ok(());
                }
                // Bound untrusted metadata before storage; no host data is kept in attachments.
                if serde_json::to_string(&host)?.len() > 8192
                    || agent_version.len() > 128
                    || update_repo
                        .as_deref()
                        .is_some_and(|repo| !moni_protocol::release::valid_repo(repo))
                {
                    self.on_disconnect(&ws)?;
                    ws.close(Some(1009), Some("host metadata too large"))?;
                    return Ok(());
                }
                // The Agent sees its own interface address, which a proxy or tunnel hides from
                // Cloudflare, so its answer replaces the edge's guess made at connect time.
                let country = logic::country_code(country.as_deref());
                self.state.storage().sql().exec(
                    "UPDATE servers SET host_json = ?, agent_version = ?, country = COALESCE(?, country) WHERE id = ?",
                    vec![
                        serde_json::to_string(&host)?.into(),
                        agent_version.as_str().into(),
                        country.into(),
                        conn.server_id.as_str().into(),
                    ],
                )?;
                conn.hello_received = true;
                conn.update_repo = update_repo;
                conn.report_interval_s = self.desired_report_interval();
                ws.send(&HubMessage::Welcome {
                    server_id: conn.server_id.clone(),
                    report_interval_s: conn.report_interval_s,
                })?;
                self.confirm_update(&conn.server_id, &agent_version)?;
                self.deliver_update(&ws, &mut conn)?;
                save(&ws, conn.clone())?;
                self.broadcast(&DashboardEvent::Online {
                    id: conn.server_id.clone(),
                    agent_version: Some(agent_version),
                    host: Some(host),
                });
                self.upsert_event(&conn.server_id)?;
            }
            AgentMessage::Metrics(frame) => {
                conn.latest = Some(frame.clone());
                self.evaluate_metrics(&mut conn, &frame)?;
                save(&ws, conn.clone())?;
                self.broadcast(&DashboardEvent::Metrics {
                    id: conn.server_id,
                    frame,
                });
            }
            AgentMessage::Rollup(rollup) => {
                let stored = match self.store_rollup(&mut conn, &rollup).and_then(|stored| {
                    save(&ws, conn.clone())?;
                    Ok(stored)
                }) {
                    Ok(stored) => stored,
                    Err(error) => {
                        console_error!(
                            "Hub rollup persistence failed server={}: {}",
                            conn.server_id,
                            error
                        );
                        if let Err(error) = self.on_disconnect(&ws) {
                            console_error!("Hub disconnect after rollup failure failed: {}", error);
                        }
                        ws.close(Some(1011), Some("rollup persistence failed"))?;
                        return Err(error);
                    }
                };
                if stored {
                    self.broadcast(&DashboardEvent::Traffic {
                        id: conn.server_id,
                        traffic: conn.traffic_month.into(),
                    });
                }
                ws.send(&HubMessage::Ack {
                    minute_ms: rollup.minute_ms,
                })?;
            }
            AgentMessage::UpdateStatus {
                job_id,
                version,
                state,
                error,
            } => {
                self.receive_update_status(&conn, &job_id, &version, state, error)?;
                save(&ws, conn)?;
            }
        }
        self.dispatch_notifications()?;
        Ok(())
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        _code: usize,
        _reason: String,
        _clean: bool,
    ) -> Result<()> {
        self.on_disconnect(&ws)?;
        ws.close(Some(1000), None::<&str>)
    }

    async fn websocket_error(&self, ws: WebSocket, _error: Error) -> Result<()> {
        self.on_disconnect(&ws)?;
        ws.close(Some(1011), Some("connection error"))
    }

    async fn alarm(&self) -> Result<Response> {
        // Reschedule before fallible work so a bad row or connection cannot stop maintenance.
        let had_agents = self.has_agents();
        let scheduled = match self.schedule_alarm().await {
            Ok(()) => true,
            Err(error) => {
                console_error!("Hub alarm scheduling failed: {}", error);
                false
            }
        };
        let now = now_ms();
        for ws in self.state.get_websockets_with_tag(TAG_AGENT) {
            let Some(conn) = agent_conn(&ws).filter(|c| !c.closing) else {
                continue;
            };
            let deadline = logic::agent_deadline(conn.last_seen_ms, conn.report_interval_s)
                .max(conn.report_grace_until_ms.unwrap_or(0));
            if now > deadline {
                if let Err(error) = self.on_disconnect(&ws) {
                    console_error!("Hub stale disconnect failed: {}", error);
                }
                let _ = ws.close(Some(4000), Some("stale"));
            }
        }
        if let Err(error) = self.evaluate_offline(now) {
            console_error!("Hub offline alerts failed: {}", error);
        }
        if let Err(error) = self.dispatch_notifications() {
            console_error!("Hub notification dispatch failed: {}", error);
        }
        if let Err(error) = self.maintain(now) {
            console_error!("Hub maintenance failed: {}", error);
        }
        if let Err(error) = self.maintain_updates(now) {
            console_error!("Hub update maintenance failed: {}", error);
        }
        if (!scheduled || had_agents != self.has_agents())
            && let Err(error) = self.schedule_alarm().await
        {
            console_error!("Hub alarm scheduling failed: {}", error);
            return Err(error);
        }
        Response::from_json(&"ok")
    }
}

impl Hub {
    async fn route(&self, req: Request) -> Result<Response> {
        schema::ready(&self.state.storage().sql())?;
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/api/auth/login") => self.login(req).await,
            (Method::Get, "/ws/agent") => self.accept_agent(req).await,
            (Method::Get, "/ws/dashboard") => {
                self.accept_dash(req.headers().get(H_ADMIN)?.is_some())
            }
            (Method::Get, "/api/alerts/rules") => Response::from_json(&self.rules()?),
            (Method::Post, "/api/alerts/rules") => self.create_rule(req).await,
            (Method::Get, "/api/alerts/active") => Response::from_json(&self.active_alerts()?),
            (Method::Get, "/api/alerts/events") => self.alert_events(&req),
            (Method::Post, "/api/alerts/test") => self.test_notifications().await,
            (Method::Get, "/api/servers") => Response::from_json(&self.snapshot()?),
            (Method::Get, "/api/agent-updates") => Response::from_json(&self.agent_updates()?),
            (Method::Post, "/api/agent-updates") => self.request_updates(req).await,
            (Method::Post, "/api/servers") => self.create_server(req).await,
            (Method::Get, "/api/appearance") => Response::from_json(&self.appearance()?),
            (Method::Put, "/api/appearance") => self.set_appearance(req).await,
            _ => {
                if let Some(id) = path.strip_prefix("/api/alerts/rules/") {
                    return match req.method() {
                        Method::Patch => self.update_rule(id, req).await,
                        Method::Delete => self.delete_rule(id),
                        _ => error::not_found(),
                    };
                }
                let Some(rest) = path.strip_prefix("/api/servers/") else {
                    return error::not_found();
                };
                if let Some(id) = rest.strip_suffix("/token") {
                    if req.method() == Method::Post && auth::valid_id(id) {
                        return self.rotate_token(id);
                    }
                } else if let Some(id) = rest.strip_suffix("/history") {
                    if req.method() == Method::Get && auth::valid_id(id) {
                        return self.history(id, &req);
                    }
                } else if auth::valid_id(rest) {
                    match req.method() {
                        Method::Patch => return self.update_server(rest, req).await,
                        Method::Delete => return self.delete_server(rest),
                        _ => {}
                    }
                }
                error::not_found()
            }
        }
    }

    async fn login(&self, mut req: Request) -> Result<Response> {
        let secrets = auth::Secrets::load(&self.env).ok_or("Missing secrets")?;
        let Ok(input) = req.json::<LoginRequest>().await else {
            return error::bad_request("Expected a password");
        };
        let ip = req
            .headers()
            .get("CF-Connecting-IP")?
            .unwrap_or_else(|| "local".into());
        let valid = auth::secret_eq(&input.password, &secrets.password);
        if self
            .login_failures
            .borrow_mut()
            .limited(&ip, now_ms(), !valid)
        {
            return error::error(
                429,
                ApiErrorCode::RateLimited,
                "Too many failed logins; retry in one minute",
            );
        }
        if !valid {
            return error::unauthorized();
        }
        auth::session_response(&req, &secrets.session_key, false)
    }

    async fn schedule_alarm(&self) -> Result<()> {
        let seconds = if self.has_agents() { 30 } else { 300 };
        self.state
            .storage()
            .set_alarm(Duration::from_secs(seconds))
            .await
    }

    async fn heal_alarm(&self, now: i64) {
        if self
            .alarm_check_ms
            .get()
            .is_some_and(|last| now.saturating_sub(last) < 300_000)
        {
            return;
        }
        // This throttle may be lost on eviction; correctness lives in the platform alarm.
        self.alarm_check_ms.set(Some(now));
        let result = async {
            if self.state.storage().get_alarm().await?.is_none() {
                self.schedule_alarm().await?;
            }
            Ok::<(), Error>(())
        }
        .await;
        if let Err(error) = result {
            console_error!("Hub alarm recovery failed: {}", error);
        }
    }

    async fn accept_agent(&self, req: Request) -> Result<Response> {
        let Some(id) = req.headers().get(H_SERVER_ID)? else {
            return error::unauthorized();
        };
        let Some(hash) = req.headers().get(H_TOKEN_HASH)? else {
            return error::unauthorized();
        };
        let Some(row) = self.server_row(&id)? else {
            return error::unauthorized();
        };
        if !auth::secret_eq(&hash, &row.token_hash) {
            return error::unauthorized();
        }

        let tag = tag_for(&id);
        for old in self.state.get_websockets_with_tag(&tag) {
            if let Some(mut conn) = agent_conn(&old).filter(|c| !c.closing) {
                // Mark before close so the later callback cannot announce the replacement offline.
                conn.closing = true;
                save(&old, conn)?;
            }
            let _ = old.close(Some(4002), Some("replaced by new connection"));
        }
        let pair = WebSocketPair::new()?;
        self.state
            .accept_websocket_with_tags(&pair.server, &[TAG_AGENT, &tag]);
        let now = now_ms();
        save(
            &pair.server,
            AgentConn {
                server_id: id.clone(),
                last_seen_ms: now,
                closing: false,
                latest: None,
                parse_warn_ms: None,
                pending: HashMap::new(),
                pending_warn_ms: None,
                traffic_month: self.safe_traffic_month(&id),
                report_interval_s: report_interval(&self.env),
                report_grace_until_ms: None,
                hello_received: false,
                update_repo: None,
                update_sent_job_id: None,
                update_sent_ms: None,
                update_attempts: 0,
            },
        )?;
        // Geolocation rides along with the connect write, so it costs no extra row write.
        let country = logic::country_code(req.headers().get(H_COUNTRY)?.as_deref());
        self.state.storage().sql().exec(
            "UPDATE servers SET last_seen_ms = ?, country = COALESCE(?, country) WHERE id = ?",
            vec![now.into(), country.into(), id.as_str().into()],
        )?;
        self.broadcast(&DashboardEvent::Online {
            id: id.clone(),
            agent_version: row.agent_version,
            host: row
                .host_json
                .and_then(|json| serde_json::from_str(&json).ok()),
        });
        self.resolve_server_alerts(&id, true)?;
        self.upsert_event(&id)?;
        let alarm = self.state.storage().get_alarm().await?;
        if alarm.is_none_or(|t| t > now + 2 * ALARM_PERIOD_MS) {
            self.schedule_alarm().await?;
        }
        Response::from_websocket(pair.client)
    }

    fn accept_dash(&self, admin: bool) -> Result<Response> {
        let servers = self.snapshot()?;
        let snapshot = if admin {
            DashboardEvent::Snapshot {
                servers,
                alerts: self.active_alerts()?,
            }
        } else {
            DashboardEvent::Snapshot {
                servers: servers.into_iter().map(logic::redact_server).collect(),
                alerts: Vec::new(),
            }
        };
        let pair = WebSocketPair::new()?;
        // The tag, not instance state, records the audience so it survives hibernation.
        let tag = if admin { TAG_DASH } else { TAG_PUBLIC };
        self.state.accept_websocket_with_tags(&pair.server, &[tag]);
        if let Err(error) = (|| {
            pair.server
                .serialize_attachment(Attachment::Dash { closing: false })?;
            pair.server.send(&snapshot)
        })() {
            let _ = pair
                .server
                .serialize_attachment(Attachment::Dash { closing: true });
            let _ = pair.server.close(Some(1011), Some("snapshot failed"));
            return Err(error);
        }
        self.sync_report_intervals();
        Response::from_websocket(pair.client)
    }

    fn on_disconnect(&self, ws: &WebSocket) -> Result<()> {
        if matches!(
            ws.deserialize_attachment()?,
            Some(Attachment::Dash { closing: false })
        ) {
            // Close callbacks can still see their socket in get_websockets_with_tag.
            ws.serialize_attachment(Attachment::Dash { closing: true })?;
            self.sync_report_intervals();
            return Ok(());
        }
        let Some(mut conn) = agent_conn(ws).filter(|c| !c.closing) else {
            return Ok(());
        };
        conn.closing = true;
        let id = conn.server_id.clone();
        let last_seen_ms = conn.last_seen_ms;
        save(ws, conn)?;
        if self
            .state
            .get_websockets_with_tag(&tag_for(&id))
            .iter()
            .any(|other| agent_conn(other).is_some_and(|c| !c.closing))
        {
            return Ok(());
        }
        self.state.storage().sql().exec(
            "UPDATE servers SET last_seen_ms = ? WHERE id = ?",
            vec![last_seen_ms.into(), id.as_str().into()],
        )?;
        self.broadcast(&DashboardEvent::Offline { id, last_seen_ms });
        Ok(())
    }

    fn idle_report_interval(&self) -> u32 {
        crate::var_u32(&self.env, "REPORT_IDLE_INTERVAL_S", 30).max(report_interval(&self.env))
    }

    fn desired_report_interval(&self) -> u32 {
        let has_viewers = [TAG_DASH, TAG_PUBLIC].into_iter().any(|tag| {
            self.state.get_websockets_with_tag(tag).iter().any(|ws| {
                matches!(
                    ws.deserialize_attachment().ok().flatten(),
                    Some(Attachment::Dash { closing: false })
                )
            })
        });
        if has_viewers {
            report_interval(&self.env)
        } else {
            self.idle_report_interval()
        }
    }

    fn update_report_interval(
        &self,
        ws: &WebSocket,
        conn: &mut AgentConn,
        interval: u32,
    ) -> Result<()> {
        let previous = conn.report_interval_s;
        if !conn.hello_received || previous == interval {
            return Ok(());
        }
        ws.send(&HubMessage::SetReportInterval {
            report_interval_s: interval,
        })?;
        // A faster period must allow a fresh sample; viewer churn must not keep a dead agent alive.
        let grace = logic::agent_deadline(conn.last_seen_ms, previous)
            .max(logic::agent_deadline(now_ms(), interval))
            .max(conn.report_grace_until_ms.unwrap_or(0))
            .min(logic::agent_deadline(
                conn.last_seen_ms,
                self.idle_report_interval(),
            ));
        conn.report_interval_s = interval;
        conn.report_grace_until_ms = Some(grace);
        Ok(())
    }

    fn sync_report_intervals(&self) {
        let interval = self.desired_report_interval();
        for ws in self.state.get_websockets_with_tag(TAG_AGENT) {
            let Some(mut conn) = agent_conn(&ws).filter(|c| !c.closing) else {
                continue;
            };
            if !conn.hello_received || conn.report_interval_s == interval {
                continue;
            }
            if let Err(error) = self
                .update_report_interval(&ws, &mut conn, interval)
                .and_then(|()| save(&ws, conn))
            {
                console_error!("Hub report interval update failed: {}", error);
                let _ = self.on_disconnect(&ws);
                let _ = ws.close(Some(1011), Some("report interval update failed"));
            }
        }
    }

    fn broadcast(&self, event: &DashboardEvent) {
        let Ok(json) = serde_json::to_string(event) else {
            return;
        };
        for ws in self.state.get_websockets_with_tag(TAG_DASH) {
            let _ = ws.send_with_str(&json);
        }
        let public = self.state.get_websockets_with_tag(TAG_PUBLIC);
        if public.is_empty() {
            return;
        }
        let redacted = match logic::public_view(event) {
            logic::PublicView::Same => json,
            logic::PublicView::Redacted(event) => match serde_json::to_string(&event) {
                Ok(json) => json,
                Err(_) => return,
            },
            logic::PublicView::Hidden => return,
        };
        for ws in public {
            let _ = ws.send_with_str(&redacted);
        }
    }
}
