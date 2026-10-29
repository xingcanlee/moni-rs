use std::{io, net::IpAddr, sync::Arc, time::Duration};

use rustls::{ClientConfig, RootCertStore, pki_types::ServerName};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
use tokio_rustls::TlsConnector;

use crate::config::country_code;

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE: u64 = 16 * 1024;

/// Each lookup names the address explicitly, so a proxy carrying the request cannot substitute
/// its own exit for it.
const PROVIDERS: [(&str, &str); 2] = [("ipinfo.io", "/{ip}/country"), ("api.country.is", "/{ip}")];

/// Proxy clients and overlay networks bind addresses that belong to someone else's network.
pub fn tunnel(name: &str) -> bool {
    [
        "tun",
        "utun",
        "tap",
        "wg",
        "warp",
        "CloudflareWARP",
        "tailscale",
        "zt",
        "Meta",
        "mihomo",
        "clash",
        "sing",
        "xray",
        "nekoray",
        "ipsec",
        "vti",
        "gre",
        "sit",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}

/// Globally routable unicast only; also rejects CGNAT and the 198.18.0.0/15 fake-IP range
/// that transparent proxies hand out.
pub fn public(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && b & 0xc0 == 64)
                || (a == 198 && b & 0xfe == 18)
                || (a == 192 && b == 0 && c == 0))
        }
        IpAddr::V6(v6) => {
            let [s0, s1, ..] = v6.segments();
            s0 & 0xe000 == 0x2000 && s0 != 0x2002 && !(s0 == 0x2001 && (s1 == 0 || s1 == 0x0db8))
        }
    }
}

/// Resolves the first address any provider can place; `None` defers to Cloudflare.
pub async fn locate(addresses: &[IpAddr]) -> Option<String> {
    for addr in addresses {
        for (host, path) in PROVIDERS {
            let path = path.replace("{ip}", &addr.to_string());
            if let Ok(Ok(body)) = timeout(LOOKUP_TIMEOUT, get(host, &path)).await
                && let Some(code) = parse(&body)
            {
                return Some(code);
            }
        }
    }
    None
}

/// Accepts a bare code (ipinfo) or a JSON object with a `country` field (country.is).
fn parse(body: &str) -> Option<String> {
    let body = body.trim();
    country_code(body).or_else(|| {
        serde_json::from_str::<serde_json::Value>(body)
            .ok()?
            .get("country")?
            .as_str()
            .and_then(country_code)
    })
}

async fn get(host: &str, path: &str) -> io::Result<String> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(io::Error::other)?
            .with_root_certificates(roots)
            .with_no_client_auth();
    let name = ServerName::try_from(host.to_owned()).map_err(io::Error::other)?;
    let tcp = TcpStream::connect((host, 443)).await?;
    let mut tls = TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await?;
    // HTTP/1.0 rules out chunked encoding, so the body is whatever follows the headers.
    let request = format!(
        "GET {path} HTTP/1.0\r\nHost: {host}\r\nAccept: */*\r\nUser-Agent: moni-agent/{}\r\n\r\n",
        env!("CARGO_PKG_VERSION")
    );
    tls.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    // Servers often skip close_notify; a complete body followed by EOF is still usable.
    if let Err(error) = (&mut tls)
        .take(MAX_RESPONSE)
        .read_to_end(&mut response)
        .await
        && (error.kind() != io::ErrorKind::UnexpectedEof || response.is_empty())
    {
        return Err(error);
    }
    body(&response).ok_or_else(|| io::Error::other("unexpected HTTP response"))
}

fn body(response: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(response).ok()?;
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status = head.lines().next()?.split_whitespace().nth(1)?;
    (status == "200").then(|| body.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_globally_routable_addresses_are_public() {
        for addr in ["8.8.8.8", "2606:4700::1111", "2400:8500:1302:1::1"] {
            assert!(public(&addr.parse().unwrap()), "{addr}");
        }
        for addr in [
            "203.0.113.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "198.18.0.1",
            "198.19.255.1",
            "0.1.2.3",
            "255.255.255.255",
            "::1",
            "fe80::1",
            "fd00::1",
            "2001:db8::1",
            "2002:c000:0204::1",
        ] {
            assert!(!public(&addr.parse().unwrap()), "{addr}");
        }
    }

    #[test]
    fn tunnels_are_recognised_by_name() {
        for name in [
            "tun0",
            "utun3",
            "wg0",
            "Meta",
            "tailscale0",
            "sing-box",
            "CloudflareWARP",
        ] {
            assert!(tunnel(name), "{name}");
        }
        for name in ["eth0", "ens3", "enp1s0", "venet0"] {
            assert!(!tunnel(name), "{name}");
        }
    }

    #[test]
    fn responses_yield_a_code_only_on_success() {
        assert_eq!(
            body(b"HTTP/1.1 200 OK\r\nA: b\r\n\r\nJP\n").as_deref(),
            Some("JP\n")
        );
        assert_eq!(body(b"HTTP/1.1 429 Too Many\r\n\r\nslow down"), None);
        assert_eq!(parse("jp\n").as_deref(), Some("JP"));
        assert_eq!(
            parse(r#"{"ip":"1.1.1.1","country":"AU"}"#).as_deref(),
            Some("AU")
        );
        assert_eq!(parse("<html>"), None);
        assert_eq!(parse(r#"{"country":"XX"}"#), None);
    }
}
