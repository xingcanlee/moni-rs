mod config;
mod geo;
mod queue;
mod rollup;
mod sampler;
mod session;
mod update;
mod window;

use std::{
    cell::{Cell, RefCell},
    process::ExitCode,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use clap::Parser;
use moni_protocol::{HostInfo, MetricsFrame};
use tokio::{
    sync::{Notify, watch},
    time::{Instant, MissedTickBehavior},
};
use tracing::{error, info, warn};
use tracing_subscriber::{Layer, layer::SubscriberExt, util::SubscriberInitExt};

use config::{Config, Country};
use queue::PendingQueue;
use rollup::Rollup;
use sampler::Sampler;
use session::End;
use window::Window;

struct State {
    queue: RefCell<PendingQueue>,
    window: RefCell<Window>,
    seq: Cell<u64>,
    ready: Notify,
    sample_ready: Notify,
}

impl State {
    fn new(config: &Config) -> Self {
        Self {
            queue: RefCell::new(PendingQueue::new(config.queue_capacity)),
            window: RefCell::new(Window::default()),
            seq: Cell::new(0),
            ready: Notify::new(),
            sample_ready: Notify::new(),
        }
    }

    fn frame(&self) -> Option<MetricsFrame> {
        let seq = self.seq.get().wrapping_add(1);
        let frame = self.window.borrow_mut().take(seq)?;
        self.seq.set(seq);
        Some(frame)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

async fn collect(mut sampler: Sampler, state: &State) {
    let mut rollup = Rollup::default();
    let period = Duration::from_secs(1);
    let mut tick = tokio::time::interval_at(Instant::now() + period, period);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let sample = sampler.sample(now_ms());
        state.window.borrow_mut().push(&sample);
        state.sample_ready.notify_one();
        if let Some(minute) = rollup.push(&sample) {
            if let Some(minute_ms) = state.queue.borrow_mut().insert(minute) {
                warn!(
                    minute_ms,
                    "pending rollup queue full; dropped oldest minute"
                );
            }
            state.ready.notify_one();
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RetryAction {
    Exit(u8),
    Delay(Duration),
}

fn retry_action(end: End, backoff_s: u64, jitter_ms: u64) -> RetryAction {
    match end {
        End::Shutdown => RetryAction::Exit(0),
        End::Closed(Some(4001)) => RetryAction::Exit(2),
        End::Closed(Some(4003)) => RetryAction::Exit(3),
        End::Closed(Some(4002)) => RetryAction::Delay(Duration::from_secs(30)),
        _ => RetryAction::Delay(
            (Duration::from_secs(backoff_s) + Duration::from_millis(jitter_ms))
                .min(Duration::from_secs(60)),
        ),
    }
}

async fn reconnect(
    config: &Config,
    host: &HostInfo,
    state: &State,
    mut shutdown: watch::Receiver<bool>,
) -> u8 {
    let mut backoff_s = 1;
    // A per-process seed keeps agents started together from reconnecting in lockstep.
    let mut jitter = (now_ms() as u64) ^ (u64::from(std::process::id()) << 32);
    loop {
        let started = Instant::now();
        let end = session::run(config, host, state, &mut shutdown).await;
        match end {
            End::Closed(Some(4001)) => error!(
                code = 4001,
                "disconnected: incompatible protocol; upgrade the agent"
            ),
            End::Closed(Some(4003)) => error!(
                code = 4003,
                "disconnected: token invalid (HTTP 401 or close 4003); replace MONI_TOKEN"
            ),
            End::Closed(code) => warn!(?code, "disconnected"),
            End::Retry(reason) => warn!(reason, "disconnected"),
            End::Shutdown => {
                info!("disconnected; shutting down");
            }
        }
        if started.elapsed() >= Duration::from_secs(60) {
            backoff_s = 1;
        }
        jitter = jitter.wrapping_mul(6364136223846793005).wrapping_add(1);
        match retry_action(end, backoff_s, (jitter >> 32) % 1_000) {
            RetryAction::Exit(code) => return code,
            RetryAction::Delay(delay) => {
                info!(delay_ms = delay.as_millis() as u64, "reconnecting");
                tokio::select! {
                    biased;
                    _ = shutdown.changed() => return 0,
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        }
        if end != End::Closed(Some(4002)) {
            backoff_s = (backoff_s * 2).min(60);
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<ExitCode> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        // tungstenite traces raw HTTP headers even when HeaderValue is marked sensitive.
        .with(
            tracing_subscriber::fmt::layer().with_filter(tracing_subscriber::filter::filter_fn(
                |metadata| {
                    !matches!(
                        metadata.target().split("::").next(),
                        Some("tungstenite" | "tokio_tungstenite")
                    )
                },
            )),
        )
        .init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut config = Config::parse();
    let sampler = Sampler::new(&config);
    let host = sampler.host_info();
    if config.country == Country::Auto {
        let addresses = sampler.public_addresses();
        config.country = match geo::locate(&addresses).await {
            Some(code) => {
                info!(country = code, "located by interface address");
                Country::Fixed(code)
            }
            None => {
                // NAT hosts carry no public address; Cloudflare then places the egress IP.
                info!(
                    candidates = addresses.len(),
                    "no interface address located; using Cloudflare geolocation"
                );
                Country::Off
            }
        };
    }
    let state = State::new(&config);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let shutdown_signal = async {
        #[cfg(unix)]
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
        #[cfg(not(unix))]
        tokio::signal::ctrl_c().await
    };
    let reconnect = reconnect(&config, &host, &state, shutdown_rx);
    tokio::pin!(reconnect);
    let code = tokio::select! {
        code = &mut reconnect => code,
        _ = collect(sampler, &state) => 0,
        result = shutdown_signal => {
            result?;
            info!("shutdown requested; closing WebSocket");
            let _ = shutdown_tx.send(true);
            tokio::time::timeout(Duration::from_secs(3), &mut reconnect).await.unwrap_or(0)
        }
    };
    Ok(ExitCode::from(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_codes_choose_exit_replacement_delay_or_bounded_backoff() {
        assert_eq!(
            retry_action(End::Closed(Some(4001)), 1, 50),
            RetryAction::Exit(2)
        );
        assert_eq!(
            retry_action(End::Closed(Some(4003)), 1, 50),
            RetryAction::Exit(3)
        );
        assert_eq!(retry_action(End::Shutdown, 1, 50), RetryAction::Exit(0));
        assert_eq!(
            retry_action(End::Closed(Some(4002)), 1, 50),
            RetryAction::Delay(Duration::from_secs(30))
        );
        assert_eq!(
            retry_action(End::Closed(Some(4000)), 1, 50),
            RetryAction::Delay(Duration::from_millis(1050))
        );
        assert_eq!(
            retry_action(End::Retry("test"), 60, 999),
            RetryAction::Delay(Duration::from_secs(60))
        );
    }
}
