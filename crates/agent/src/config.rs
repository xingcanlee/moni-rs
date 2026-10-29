use std::num::NonZeroUsize;

use clap::Parser;

#[derive(Parser)]
#[command(version, about = "moni-rs VPS agent")]
pub struct Config {
    /// Hub endpoint, e.g. wss://moni.example.workers.dev/ws/agent
    #[arg(long, env = "MONI_SERVER")]
    pub server: String,
    /// Agent token
    #[arg(long, env = "MONI_TOKEN", hide_env_values = true)]
    pub token: String,
    /// Preferred report interval in seconds; Hub Welcome overrides this value
    #[arg(long, env = "MONI_INTERVAL", default_value_t = 5, value_parser = clap::value_parser!(u32).range(1..))]
    pub interval: u32,
    /// Interface allowlist, overriding virtual-interface filtering
    #[arg(long, env = "MONI_IFACES", value_delimiter = ',', value_parser = list_item)]
    pub ifaces: Vec<String>,
    /// Mount-point allowlist, overriding physical-device filtering
    #[arg(long, env = "MONI_DISKS", value_delimiter = ',', value_parser = list_item)]
    pub disks: Vec<String>,
    /// Maximum number of unacknowledged minutes kept in memory
    #[arg(long, env = "MONI_QUEUE_CAPACITY", default_value = "1440")]
    pub queue_capacity: NonZeroUsize,
    /// Trusted release repository, enabled only when the root update helper is installed
    #[arg(long, env = "MONI_UPDATE_REPO", value_parser = update_repo)]
    pub update_repo: Option<String>,
    /// Region shown on the dashboard: `auto` geolocates the public address bound to a local
    /// interface, `off` leaves it to Cloudflare's view of the egress IP, or an ISO 3166-1
    /// alpha-2 code such as `JP` pins it
    #[arg(long, env = "MONI_COUNTRY", default_value = "auto", value_parser = country)]
    pub country: Country,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Country {
    Auto,
    Off,
    Fixed(String),
}

impl Country {
    pub fn code(&self) -> Option<String> {
        match self {
            Self::Fixed(code) => Some(code.clone()),
            Self::Auto | Self::Off => None,
        }
    }
}

pub fn country_code(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_uppercase();
    (value.len() == 2 && value.bytes().all(|b| b.is_ascii_uppercase()) && value != "XX")
        .then_some(value)
}

fn country(value: &str) -> Result<Country, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "auto" => Ok(Country::Auto),
        "off" => Ok(Country::Off),
        _ => country_code(value)
            .map(Country::Fixed)
            .ok_or_else(|| "country must be auto, off or a two-letter ISO code".to_owned()),
    }
}

fn update_repo(value: &str) -> Result<String, String> {
    moni_protocol::release::valid_repo(value)
        .then(|| value.to_owned())
        .ok_or_else(|| "update repository must be owner/repo".to_owned())
}

fn list_item(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err("allowlist entries must not be empty".into())
    } else {
        Ok(value.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_allowlists_and_rejects_zero_limits() {
        let args = [
            "agent",
            "--server",
            "ws://localhost/ws/agent",
            "--token",
            "test",
        ];
        let config = Config::try_parse_from(args.into_iter().chain([
            "--ifaces",
            "eth0, wg0",
            "--disks",
            "/,/data",
        ]))
        .unwrap();
        assert_eq!(config.ifaces, ["eth0", "wg0"]);
        assert_eq!(config.disks, ["/", "/data"]);
        assert!(Config::try_parse_from(args.into_iter().chain(["--interval", "0"])).is_err());
        assert!(Config::try_parse_from(args.into_iter().chain(["--queue-capacity", "0"])).is_err());
    }

    #[test]
    fn country_is_auto_off_or_an_iso_code() {
        let args = [
            "agent",
            "--server",
            "wss://example.com/ws/agent",
            "--token",
            "test",
        ];
        assert_eq!(Config::try_parse_from(args).unwrap().country, Country::Auto);
        let parse = |value| Config::try_parse_from(args.into_iter().chain(["--country", value]));
        assert_eq!(parse("OFF").unwrap().country, Country::Off);
        assert_eq!(parse("jp").unwrap().country, Country::Fixed("JP".into()));
        for bad in ["", "J", "JPN", "XX", "1A"] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn update_repository_is_optional_and_cannot_be_a_url_or_path() {
        let args = [
            "agent",
            "--server",
            "wss://example.com/ws/agent",
            "--token",
            "test",
        ];
        let config = Config::try_parse_from(args).unwrap();
        assert!(config.update_repo.is_none());
        let config =
            Config::try_parse_from(args.into_iter().chain(["--update-repo", "owner/moni-rs"]))
                .unwrap();
        assert_eq!(config.update_repo.as_deref(), Some("owner/moni-rs"));
        for repo in [
            "",
            "../repo",
            "owner/repo/other",
            "https://github.com/owner/repo",
            "owner/repo\n",
        ] {
            assert!(
                Config::try_parse_from(args.into_iter().chain(["--update-repo", repo])).is_err()
            );
        }
    }
}
