use std::{
    collections::HashSet,
    net::IpAddr,
    path::Path,
    time::{Duration, Instant},
};

use moni_protocol::{HostInfo, MetricsFrame};
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, Networks, ProcessRefreshKind, ProcessesToUpdate,
    RefreshKind, System,
};

use crate::{
    config::Config,
    window::{Counters, Sample},
};

fn include_iface(name: &str, allowlist: &[String]) -> bool {
    if !allowlist.is_empty() {
        return allowlist.iter().any(|allowed| allowed == name);
    }
    name != "lo"
        && ![
            "docker", "veth", "br-", "virbr", "cni", "flannel", "tun", "wg",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

fn include_disk(device: &str, mount: &Path, allowlist: &[String]) -> bool {
    if allowlist.is_empty() {
        device.starts_with("/dev/")
    } else {
        allowlist.iter().any(|allowed| mount == Path::new(allowed))
    }
}

pub struct Sampler {
    sys: System,
    disks: Disks,
    networks: Networks,
    counters: Counters,
    ifaces: Vec<String>,
    mounts: Vec<String>,
    last_sample: Instant,
    last_disk: Instant,
    disk_used: u64,
    disk_total: u64,
}

impl Sampler {
    pub fn new(config: &Config) -> Self {
        let sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                .with_memory(MemoryRefreshKind::everything()),
        );
        let mut sampler = Self {
            sys,
            disks: Disks::new_with_refreshed_list(),
            networks: Networks::new_with_refreshed_list(),
            counters: Counters::default(),
            ifaces: config.ifaces.clone(),
            mounts: config.disks.clone(),
            last_sample: Instant::now(),
            last_disk: Instant::now(),
            disk_used: 0,
            disk_total: 0,
        };
        sampler.update_disk_totals();
        sampler
            .counters
            .update(sampler.net_counters(), Duration::ZERO);
        sampler.last_sample = Instant::now();
        sampler
    }

    pub fn host_info(&self) -> HostInfo {
        HostInfo {
            hostname: System::host_name().unwrap_or_default(),
            os: System::long_os_version().unwrap_or_default(),
            kernel: System::kernel_version().unwrap_or_default(),
            arch: System::cpu_arch(),
            cpu_model: self
                .sys
                .cpus()
                .first()
                .map(|cpu| cpu.brand().to_owned())
                .unwrap_or_default(),
            cpu_cores: self.sys.cpus().len() as u32,
            boot_time_ms: System::boot_time()
                .saturating_mul(1_000)
                .min(i64::MAX as u64) as i64,
        }
    }

    /// Candidates for geolocation, IPv4 first because providers place it more reliably.
    pub fn public_addresses(&self) -> Vec<IpAddr> {
        let mut addresses: Vec<IpAddr> = self
            .networks
            .iter()
            .filter(|(name, _)| include_iface(name, &self.ifaces) && !crate::geo::tunnel(name))
            .flat_map(|(_, data)| data.ip_networks().iter().map(|network| network.addr))
            .filter(crate::geo::public)
            .collect();
        addresses.sort_by_key(IpAddr::is_ipv6);
        addresses.dedup();
        addresses
    }

    fn net_counters(&self) -> Vec<(String, u64, u64)> {
        self.networks
            .iter()
            .filter(|(name, _)| include_iface(name, &self.ifaces))
            .map(|(name, network)| {
                (
                    name.clone(),
                    network.total_received(),
                    network.total_transmitted(),
                )
            })
            .collect()
    }

    fn update_disk_totals(&mut self) {
        let mut seen = HashSet::new();
        (self.disk_used, self.disk_total) = self
            .disks
            .iter()
            .filter(|disk| {
                include_disk(
                    &disk.name().to_string_lossy(),
                    disk.mount_point(),
                    &self.mounts,
                )
            })
            .filter(|disk| seen.insert(disk.name().to_owned()))
            .fold((0u64, 0u64), |(used, total), disk| {
                (
                    used.saturating_add(disk.total_space().saturating_sub(disk.available_space())),
                    total.saturating_add(disk.total_space()),
                )
            });
    }

    pub fn sample(&mut self, ts_ms: i64) -> Sample {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        self.networks.refresh(true);
        let now = Instant::now();
        let traffic = self
            .counters
            .update(self.net_counters(), now.duration_since(self.last_sample));
        self.last_sample = now;
        if now.duration_since(self.last_disk) >= Duration::from_secs(10) {
            self.disks.refresh(true);
            self.update_disk_totals();
            self.last_disk = now;
        }
        let load = System::load_average();
        Sample {
            frame: MetricsFrame {
                ts_ms,
                cpu_pct: self.sys.global_cpu_usage(),
                mem_used: self.sys.used_memory(),
                mem_total: self.sys.total_memory(),
                swap_used: self.sys.used_swap(),
                swap_total: self.sys.total_swap(),
                disk_used: self.disk_used,
                disk_total: self.disk_total,
                load1: load.one as f32,
                load5: load.five as f32,
                load15: load.fifteen as f32,
                uptime_s: System::uptime(),
                process_count: self.sys.processes().len().min(u32::MAX as usize) as u32,
                ..MetricsFrame::default()
            },
            traffic,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interface_filter_and_allowlist_override() {
        for name in [
            "lo",
            "docker0",
            "vethabc",
            "br-123",
            "virbr0",
            "cni0",
            "flannel.1",
            "tun0",
            "wg0",
        ] {
            assert!(!include_iface(name, &[]), "{name}");
        }
        for name in ["eth0", "ens3", "enp0s1"] {
            assert!(include_iface(name, &[]));
        }
        assert!(include_iface("wg0", &["wg0".into()]));
        assert!(!include_iface("eth0", &["wg0".into()]));
    }

    #[test]
    fn disk_filter_uses_physical_devices_or_explicit_mounts() {
        assert!(include_disk("/dev/vda1", Path::new("/"), &[]));
        assert!(!include_disk("tmpfs", Path::new("/run"), &[]));
        assert!(include_disk("overlay", Path::new("/"), &["/".into()]));
        assert!(!include_disk(
            "/dev/vda1",
            Path::new("/data"),
            &["/".into()]
        ));
    }
}
