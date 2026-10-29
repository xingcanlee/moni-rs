use std::fmt::Debug;

use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    AgentMessage, HostInfo, HubMessage, MetricsFrame, MinuteRollup, PROTOCOL_VERSION, api::*,
};

const NOW_MS: i64 = 1_792_166_400_000;

fn assert_roundtrip<T>(expected: Value) -> T
where
    T: Serialize + DeserializeOwned + PartialEq + Debug,
{
    let decoded: T = serde_json::from_value(expected.clone()).unwrap();
    let encoded = serde_json::to_string(&decoded).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&encoded).unwrap(), expected);
    assert_eq!(serde_json::from_str::<T>(&encoded).unwrap(), decoded);
    decoded
}

fn host() -> Value {
    json!({
        "hostname": "vps-1", "os": "Linux", "kernel": "6.12", "arch": "x86_64",
        "cpu_model": "AMD EPYC", "cpu_cores": 4, "boot_time_ms": NOW_MS - 60_000
    })
}

fn metrics() -> Value {
    json!({
        "seq": 7, "ts_ms": NOW_MS, "cpu_pct": 12.5,
        "mem_used": 1024, "mem_total": 4096, "swap_used": 128, "swap_total": 512,
        "disk_used": 8192, "disk_total": 16384,
        "net_rx_bps": 128, "net_tx_bps": 256,
        "load1": 0.5, "load5": 1.0, "load15": 1.5,
        "uptime_s": 60, "process_count": 42
    })
}

fn rollup() -> Value {
    json!({
        "minute_ms": NOW_MS, "samples": 60, "cpu_avg": 12.5, "cpu_max": 25.0,
        "mem_used_avg": 1024, "mem_total": 4096, "swap_used_avg": 128, "swap_total": 512,
        "disk_used": 8192, "disk_total": 16384,
        "rx_bytes": 7680, "tx_bytes": 15360, "rx_bps_max": 256, "tx_bps_max": 512,
        "load1_avg": 0.5
    })
}

fn traffic() -> Value {
    json!({"rx_bytes": 7680, "tx_bytes": 15360, "since_ms": 1_791_158_400_000_i64})
}

fn server(online: bool) -> Value {
    json!({
        "id": "vps-1", "name": "VPS 1", "created_ms": NOW_MS - 60_000,
        "online": online, "last_seen_ms": if online { json!(NOW_MS) } else { Value::Null },
        "agent_version": if online { json!("0.1.0") } else { Value::Null },
        "host": if online { host() } else { Value::Null },
        "metrics": if online { metrics() } else { Value::Null },
        "traffic_month": traffic(), "alerts_firing": 1,
        "country": if online { json!("JP") } else { Value::Null }
    })
}

fn rule_input() -> Value {
    json!({
        "name": "CPU high", "server_id": null, "metric": "cpu", "op": "gt",
        "threshold": 90.0, "recover_threshold": null, "duration_s": 300, "enabled": true
    })
}

fn active_alert(value: Value) -> Value {
    json!({
        "rule_id": "cpu-high", "rule_name": "CPU high", "server_id": "vps-1",
        "server_name": "VPS 1", "metric": "cpu", "value": value, "since_ms": NOW_MS
    })
}

#[test]
fn agent_messages_match_design() {
    assert_eq!(PROTOCOL_VERSION, 3);
    for repo in [Value::Null, json!("owner/moni-rs")] {
        let hello = assert_roundtrip::<AgentMessage>(json!({
            "type": "hello", "protocol": 3, "agent_version": "0.1.0", "host": host(),
            "update_repo": repo
        }));
        assert!(matches!(
            hello,
            AgentMessage::Hello {
                protocol: 3,
                country: None,
                ..
            }
        ));
    }
    let hello = assert_roundtrip::<AgentMessage>(json!({
        "type": "hello", "protocol": 3, "agent_version": "0.1.0", "host": host(),
        "update_repo": null, "country": "JP"
    }));
    assert!(matches!(hello, AgentMessage::Hello { country: Some(c), .. } if c == "JP"));

    let mut frame = metrics();
    frame["type"] = json!("metrics");
    assert!(matches!(
        assert_roundtrip::<AgentMessage>(frame),
        AgentMessage::Metrics(_)
    ));

    let mut minute = rollup();
    minute["type"] = json!("rollup");
    assert!(matches!(
        assert_roundtrip::<AgentMessage>(minute),
        AgentMessage::Rollup(_)
    ));
}

#[test]
fn hub_messages_match_design() {
    assert_roundtrip::<HubMessage>(json!({
        "type": "update", "job_id": "0123456789abcdef0123456789abcdef",
        "version": "v0.1.1", "repo": "owner/moni-rs"
    }));
    assert_roundtrip::<AgentMessage>(json!({
        "type": "update_status", "job_id": "0123456789abcdef0123456789abcdef",
        "version": "v0.1.1", "state": "accepted", "error": null
    }));
    assert!(matches!(
        assert_roundtrip::<HubMessage>(json!({
            "type": "set_report_interval", "report_interval_s": 15
        })),
        HubMessage::SetReportInterval {
            report_interval_s: 15
        }
    ));
    assert!(matches!(
        assert_roundtrip::<HubMessage>(json!({
            "type": "welcome", "server_id": "vps-1", "report_interval_s": 5
        })),
        HubMessage::Welcome {
            report_interval_s: 5,
            ..
        }
    ));
    assert!(matches!(
        assert_roundtrip::<HubMessage>(json!({"type": "ack", "minute_ms": NOW_MS})),
        HubMessage::Ack { minute_ms: NOW_MS }
    ));
}

#[test]
fn dashboard_events_match_api() {
    assert_roundtrip::<DashboardEvent>(
        json!({"type":"traffic", "id":"vps-1", "traffic": {"rx_bytes":100, "tx_bytes":20, "since_ms":0}}),
    );
    let events = [
        (
            "snapshot",
            json!({"servers": [server(true), server(false)], "alerts": [active_alert(json!(95.0))]}),
        ),
        ("server_upsert", json!({"server": server(true)})),
        ("server_removed", json!({"id": "vps-1"})),
        (
            "online",
            json!({"id": "vps-1", "agent_version": "0.1.0", "host": host()}),
        ),
        (
            "online",
            json!({"id": "vps-1", "agent_version": null, "host": null}),
        ),
        ("offline", json!({"id": "vps-1", "last_seen_ms": NOW_MS})),
        ("metrics", json!({"id": "vps-1", "frame": metrics()})),
        (
            "alert",
            json!({"kind": "firing", "alert": active_alert(json!(95.0))}),
        ),
        (
            "alert",
            json!({"kind": "resolved", "alert": active_alert(Value::Null)}),
        ),
    ];
    for (tag, mut expected) in events {
        expected["type"] = json!(tag);
        let event = assert_roundtrip::<DashboardEvent>(expected);
        assert_eq!(serde_json::to_value(&event).unwrap()["type"], tag);
        assert!(matches!(
            (tag, event),
            ("snapshot", DashboardEvent::Snapshot { .. })
                | ("server_upsert", DashboardEvent::ServerUpsert { .. })
                | ("server_removed", DashboardEvent::ServerRemoved { .. })
                | ("online", DashboardEvent::Online { .. })
                | ("offline", DashboardEvent::Offline { .. })
                | ("metrics", DashboardEvent::Metrics { .. })
                | ("alert", DashboardEvent::Alert { .. })
        ));
    }
}

#[test]
fn config_and_server_dtos_match_api() {
    for repo in [Value::Null, json!("owner/moni-rs")] {
        assert_roundtrip::<AppConfig>(json!({
            "version": "0.1.0", "report_interval_s": 5, "agent_release_repo": repo,
            "retention": {"minute_days": 7, "hour_days": 90},
            "notifications": {"telegram": true, "webhook": false}
        }));
    }
    assert_roundtrip::<Retention>(json!({"minute_days": 7, "hour_days": 90}));
    assert_roundtrip::<Notifications>(json!({"telegram": true, "webhook": false}));
    assert_roundtrip::<HostInfo>(host());
    assert_roundtrip::<MetricsFrame>(metrics());
    assert_roundtrip::<MinuteRollup>(rollup());
    assert_roundtrip::<Traffic>(traffic());
    assert_roundtrip::<ServerStatus>(server(true));
    assert_roundtrip::<ServerStatus>(server(false));
}

#[test]
fn appearance_dtos_match_api() {
    let public: PublicInfo = assert_roundtrip(json!({
        "enabled": true,
        "appearance": {"theme": "cyberpunk", "mode": "dark", "locked": true}
    }));
    assert!(public.appearance.valid());
    assert_eq!(
        serde_json::to_value(Appearance::default()).unwrap(),
        json!({"theme": "clay", "mode": "system", "locked": false})
    );
    assert!(
        serde_json::from_value::<Appearance>(
            json!({"theme": "x", "mode": "auto", "locked": false})
        )
        .is_err()
    );
    for theme in ["", "Clay", "a b", "../x", &"a".repeat(33)] {
        let appearance = Appearance {
            theme: theme.into(),
            ..Appearance::default()
        };
        assert!(!appearance.valid(), "{theme:?}");
    }
}

#[test]
fn history_dtos_match_api() {
    let point = json!({
        "ts_ms": NOW_MS, "cpu_avg": 12.5, "cpu_max": 25.0,
        "mem_pct": 25.0, "swap_pct": 25.0, "disk_pct": 50.0,
        "rx_bytes": 7680, "tx_bytes": 15360, "rx_bps_max": 256, "tx_bps_max": 512,
        "load1": 0.5
    });
    assert_roundtrip::<HistoryPoint>(point.clone());
    for (range, step_ms) in [
        ("1h", 60_000),
        ("6h", 60_000),
        ("24h", 60_000),
        ("7d", 600_000),
        ("30d", 3_600_000),
        ("90d", 3_600_000),
    ] {
        assert_roundtrip::<History>(json!({"range": range, "step_ms": step_ms, "points": [point]}));
    }
    assert_roundtrip::<History>(json!({"range": "24h", "step_ms": 60_000, "points": []}));
    assert_eq!(HistoryRange::default(), HistoryRange::TwentyFourHours);
}

#[test]
fn alert_dtos_match_api() {
    assert_roundtrip::<AlertRuleInput>(rule_input());
    let mut rule = rule_input();
    rule["id"] = json!("cpu-high");
    rule["created_ms"] = json!(NOW_MS);
    assert_roundtrip::<AlertRule>(rule.clone());
    rule["server_id"] = json!("vps-1");
    rule["recover_threshold"] = json!(81.0);
    assert_roundtrip::<AlertRule>(rule);

    for value in [Value::Null, json!(95.0)] {
        assert_roundtrip::<ActiveAlert>(active_alert(value.clone()));
        for kind in ["firing", "resolved"] {
            assert_roundtrip::<AlertEvent>(json!({
                "id": 1, "rule_id": "cpu-high", "rule_name": "CPU high",
                "server_id": "vps-1", "server_name": "VPS 1", "kind": kind,
                "value": value, "ts_ms": NOW_MS
            }));
        }
    }
}

#[test]
fn request_and_response_dtos_match_api() {
    assert_roundtrip::<LoginRequest>(json!({"password": "example-password"}));
    assert_roundtrip::<AuthMeResponse>(json!({"authenticated": true}));
    for id in [Value::Null, json!("vps-1")] {
        assert_roundtrip::<CreateServerRequest>(json!({"name": "VPS 1", "id": id}));
    }
    let create: CreateServerRequest = serde_json::from_value(json!({"name": "VPS 1"})).unwrap();
    assert_eq!(create.id, None);
    assert_eq!(
        serde_json::to_value(create).unwrap(),
        json!({"name": "VPS 1", "id": null})
    );
    assert_roundtrip::<CreateServerResponse>(
        json!({"server": server(false), "token": "mn_vps-1_example"}),
    );
    assert_roundtrip::<UpdateServerRequest>(json!({"name": "Renamed"}));

    assert_eq!(
        serde_json::from_value::<UpdateServerRequest>(json!({})).unwrap(),
        UpdateServerRequest::default()
    );
    assert_roundtrip::<TokenResponse>(json!({"token": "mn_vps-1_example"}));
    assert_roundtrip::<AlertTestResponse>(json!({"telegram": "ok", "webhook": "disabled"}));
    assert_roundtrip::<AlertTestResponse>(
        json!({"telegram": "request timed out", "webhook": "ok"}),
    );
}

#[test]
fn patch_preserves_missing_null_and_values() {
    let empty = serde_json::from_value::<AlertRulePatch>(json!({})).unwrap();
    assert_eq!(empty, AlertRulePatch::default());
    assert_eq!(serde_json::to_value(empty).unwrap(), json!({}));

    let cleared: AlertRulePatch = serde_json::from_value(json!({
        "server_id": null, "recover_threshold": null
    }))
    .unwrap();
    assert_eq!(cleared.server_id, Some(None));
    assert_eq!(cleared.recover_threshold, Some(None));
    assert_eq!(cleared.name, None);

    let patch = assert_roundtrip::<AlertRulePatch>(json!({
        "name": "CPU low", "server_id": "vps-1", "metric": "cpu", "op": "lt",
        "threshold": 10.0, "recover_threshold": 11.0, "duration_s": 60, "enabled": false
    }));
    assert_eq!(patch.server_id, Some(Some("vps-1".into())));
    assert_eq!(patch.recover_threshold, Some(Some(11.0)));
    assert_eq!(patch.enabled, Some(false));
    assert_eq!(
        serde_json::to_value(cleared).unwrap(),
        json!({"server_id": null, "recover_threshold": null})
    );
    assert_eq!(
        serde_json::to_value(AlertRulePatch {
            threshold: Some(95.0),
            ..Default::default()
        })
        .unwrap(),
        json!({"threshold": 95.0})
    );
}

#[test]
fn enum_values_match_api() {
    for (range, name) in [
        (HistoryRange::OneHour, "1h"),
        (HistoryRange::SixHours, "6h"),
        (HistoryRange::TwentyFourHours, "24h"),
        (HistoryRange::SevenDays, "7d"),
        (HistoryRange::ThirtyDays, "30d"),
        (HistoryRange::NinetyDays, "90d"),
    ] {
        assert_eq!(assert_roundtrip::<HistoryRange>(json!(name)), range);
    }
    for (metric, name) in [
        (AlertMetric::Cpu, "cpu"),
        (AlertMetric::Mem, "mem"),
        (AlertMetric::Swap, "swap"),
        (AlertMetric::Disk, "disk"),
        (AlertMetric::Load1, "load1"),
        (AlertMetric::NetRx, "net_rx"),
        (AlertMetric::NetTx, "net_tx"),
        (AlertMetric::Offline, "offline"),
    ] {
        assert_eq!(assert_roundtrip::<AlertMetric>(json!(name)), metric);
    }
    for (op, name) in [(AlertOp::Gt, "gt"), (AlertOp::Lt, "lt")] {
        assert_eq!(assert_roundtrip::<AlertOp>(json!(name)), op);
    }
    for (kind, name) in [
        (AlertKind::Firing, "firing"),
        (AlertKind::Resolved, "resolved"),
    ] {
        assert_eq!(assert_roundtrip::<AlertKind>(json!(name)), kind);
    }
    for (code, name) in [
        (ApiErrorCode::Unauthorized, "unauthorized"),
        (ApiErrorCode::Forbidden, "forbidden"),
        (ApiErrorCode::NotFound, "not_found"),
        (ApiErrorCode::BadRequest, "bad_request"),
        (ApiErrorCode::Conflict, "conflict"),
        (ApiErrorCode::RateLimited, "rate_limited"),
        (ApiErrorCode::NotConfigured, "not_configured"),
        (ApiErrorCode::Internal, "internal"),
    ] {
        assert_eq!(assert_roundtrip::<ApiErrorCode>(json!(name)), code);
        let error =
            assert_roundtrip::<ApiError>(json!({"error": name, "message": "Readable explanation"}));
        assert_eq!(error.error, code);
    }
}

#[test]
fn timestamps_use_unix_milliseconds_and_ms_field_names() {
    fn assert_ms_field<T: Serialize>(value: T, field: &str, expected: i64) {
        let value = serde_json::to_value(value).unwrap();
        assert!(field.ends_with("_ms"));
        assert_eq!(value[field], expected);
        assert!(expected > 1_000_000_000_000);
    }
    assert_ms_field(
        assert_roundtrip::<HostInfo>(host()),
        "boot_time_ms",
        NOW_MS - 60_000,
    );
    assert_ms_field(
        MetricsFrame {
            ts_ms: NOW_MS,
            ..Default::default()
        },
        "ts_ms",
        NOW_MS,
    );
    assert_ms_field(
        MinuteRollup {
            minute_ms: NOW_MS,
            ..Default::default()
        },
        "minute_ms",
        NOW_MS,
    );
    assert_ms_field(
        assert_roundtrip::<Traffic>(traffic()),
        "since_ms",
        1_791_158_400_000_i64,
    );
    let server = assert_roundtrip::<ServerStatus>(server(true));
    assert_ms_field(&server, "created_ms", NOW_MS - 60_000);
    assert_ms_field(&server, "last_seen_ms", NOW_MS);
    assert_ms_field(
        assert_roundtrip::<ActiveAlert>(active_alert(Value::Null)),
        "since_ms",
        NOW_MS,
    );
    assert_ms_field(HubMessage::Ack { minute_ms: NOW_MS }, "minute_ms", NOW_MS);
    assert_ms_field(
        DashboardEvent::Offline {
            id: "vps-1".into(),
            last_seen_ms: NOW_MS,
        },
        "last_seen_ms",
        NOW_MS,
    );
}

#[test]
fn integers_keep_full_rust_precision_on_the_wire() {
    let frame = MetricsFrame {
        seq: u64::MAX,
        ts_ms: i64::MAX,
        mem_used: u64::MAX,
        ..Default::default()
    };
    let encoded = serde_json::to_string(&frame).unwrap();
    assert_eq!(
        serde_json::from_str::<MetricsFrame>(&encoded).unwrap(),
        frame
    );
    let ack = HubMessage::Ack {
        minute_ms: i64::MIN,
    };
    let encoded = serde_json::to_string(&ack).unwrap();
    assert_eq!(serde_json::from_str::<HubMessage>(&encoded).unwrap(), ack);
}

#[test]
fn missing_or_unknown_message_tags_are_rejected() {
    for invalid in [json!({}), json!({"type": "unknown"})] {
        assert!(serde_json::from_value::<AgentMessage>(invalid.clone()).is_err());
        assert!(serde_json::from_value::<HubMessage>(invalid.clone()).is_err());
        assert!(serde_json::from_value::<DashboardEvent>(invalid).is_err());
    }
    assert!(
        serde_json::from_value::<AgentMessage>(json!({"type": "metrics", "frame": metrics()}))
            .is_err()
    );
    assert!(
        serde_json::from_value::<HubMessage>(json!({"type": "ack", "minute": NOW_MS})).is_err()
    );
    assert!(
        serde_json::from_value::<DashboardEvent>(
            json!({"type": "server_removed", "server_id": "vps-1"})
        )
        .is_err()
    );
}
