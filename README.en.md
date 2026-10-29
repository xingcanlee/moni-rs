# moni-rs

[![CI](https://github.com/xingcanlee/moni-rs/actions/workflows/ci.yml/badge.svg)](https://github.com/xingcanlee/moni-rs/actions/workflows/ci.yml)
[![Deploy](https://github.com/xingcanlee/moni-rs/actions/workflows/deploy.yml/badge.svg)](https://github.com/xingcanlee/moni-rs/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[简体中文](README.md) | **English**

A VPS monitor written in Rust that runs entirely on the **Cloudflare free tier**. You don't need a server of your own: fork the repo, add a few secrets, and deploy with one GitHub Actions run.

![Overview](docs/screenshots/theme-clay-light.png)

## Highlights

- **No cost and nothing to operate**: the back end is a Rust Worker compiled to WebAssembly plus one singleton Durable Object with built-in SQLite. The dashboard is served as Workers static assets. There is no database, server or container to maintain.
- **Live updates**: agents and dashboards connect over hibernating WebSockets. Frames arrive every 2 s while someone is watching and drop to every 30 s when nobody is, to save quota.
- **No data loss on disconnect**: the agent samples every second and sends one rollup per minute, keeping each until the server acknowledges it. It buffers up to 24 h of rollups while offline and resends them after reconnecting.
- **History and traffic**: charts from 1 h to 90 d (CPU, memory/swap, network, disk, load), plus monthly traffic for each server.
- **Alerts**: threshold and offline alerts, sent to Telegram or a webhook.
- **Secure by default**: each server has its own token, compared in constant time. The agent runs as a non-root user under systemd hardening. Updates must pass an RSA signature check and a SHA-256 check, and roll back automatically if they fail.
- **Public read-only dashboard**: visitors can see the overview and history, but not hostnames, kernels, IPs, tokens or alert rules. Managing servers requires signing in.
- **Seven themes, light/dark modes and phone layouts**: the admin sets a site default, and visitors can pick their own theme.

## Performance

| Item | Figure |
|---|---|
| Agent memory | RSS about 4 MB, CPU ≈ 0% |
| Agent binary | static musl build, about 3 MB (amd64 / arm64) |
| Worker bundle | about 890 KiB of wasm (about 340 KiB gzipped); the free-plan limit is 3 MiB |
| Front end | landing page about 232 KB of JS and 20 KB of CSS (gzipped); detail and admin pages load on demand |
| Sampling / reporting | samples every 1 s; live frames every 2 s (someone watching) or 30 s (nobody watching); one rollup per minute |
| Retention | per-minute data for 7 days, per-hour data for 90 days |
| Free-tier capacity | about **30 servers**, limited by SQLite rows written per day (about 3k per server per day); see [design §5.4](docs/design.md) |

## Screenshots

<table>
  <tr>
    <td><img src="docs/screenshots/theme-clay-dark.png" alt="Clay, dark"><br><sub>Clay (dark)</sub></td>
    <td><img src="docs/screenshots/theme-cyberpunk-dark.png" alt="Cyberpunk"><br><sub>Cyberpunk</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/theme-material-light.png" alt="Material"><br><sub>Material</sub></td>
    <td><img src="docs/screenshots/theme-cloudflare-light.png" alt="Cloudflare"><br><sub>Cloudflare</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/theme-terminal-dark.png" alt="Terminal"><br><sub>Terminal</sub></td>
    <td><img src="docs/screenshots/theme-nord-dark.png" alt="Nord"><br><sub>Nord</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/theme-geist-light.png" alt="Geist"><br><sub>Geist</sub></td>
    <td><img src="docs/screenshots/theme-clay-light.png" alt="Clay, light"><br><sub>Clay (light, default)</sub></td>
  </tr>
</table>

**Mobile**

<p>
  <img src="docs/screenshots/mobile-overview.png" alt="Mobile overview" width="260">
  <img src="docs/screenshots/mobile-detail.png" alt="Mobile detail" width="260">
</p>

<details>
<summary>Server detail page</summary>

![Detail](docs/screenshots/detail.png)

</details>

> The dashboard UI is in Simplified Chinese.

## Quick start

You only need a browser; nothing has to be installed locally.

1. **Set up Cloudflare**: open **Workers & Pages** once and register your `*.workers.dev` subdomain. Note your **Account ID**, then create an **API Token** from the *Edit Cloudflare Workers* template.
2. **Fork this repo** and enable workflows on the **Actions** tab.
3. **Add secrets** (Settings → Secrets and variables → Actions):

   | Secret | Required | Notes |
   |---|:---:|---|
   | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | ✅ | The credentials from step 1 |
   | `ADMIN_PASSWORD` | ✅ | Dashboard sign-in password |
   | `AUTH_SECRET` | ✅ | A random string of at least 32 bytes, e.g. from `openssl rand -hex 32`. **Changing it invalidates every session and agent token** |
   | `TG_BOT_TOKEN` / `TG_CHAT_ID` / `WEBHOOK_URL` | | Optional alert channels |

4. **Deploy**: run **Actions → Deploy → Run workflow**. When it finishes, the run Summary shows `https://moni-rs.<subdomain>.workers.dev`.
5. **Release the agent**: push a `v*` tag (e.g. `v0.1.2`). **Release agent** builds the amd64 / arm64 binaries and attaches them to the Release. Signing needs `AGENT_RELEASE_SIGNING_KEY`; see [agent-updates.md](docs/agent-updates.md). The repo must be public.
6. **Add a server**: in the dashboard, open **设置 (Settings) → 服务器 (Servers) → 添加服务器 (Add server)**, copy the install command, and run it as root on the VPS:

   ```sh
   curl -fsSL https://github.com/<owner>/moni-rs/releases/latest/download/install-agent.sh \
     | sudo sh -s -- --repo <owner>/moni-rs \
         --server wss://moni-rs.<subdomain>.workers.dev/ws/agent \
         --token mn_<server_id>_<secret>
   ```

To upgrade, rerun the install command with no arguments. Add `--auto-update` to check for new releases every 6 h. To uninstall, run `sudo sh install-agent.sh --uninstall`. Optional settings are listed in [scripts/agent.env.example](scripts/agent.env.example).

## Local development

You need Rust ≥ 1.94 with the `wasm32-unknown-unknown` target, `worker-build` 0.8.7, Node 22+ and pnpm 10.

```sh
pnpm install && cp crates/worker/.dev.vars.example crates/worker/.dev.vars
pnpm build:web
pnpm dev                                      # http://127.0.0.1:8787
cargo run -p moni-agent -- --server ws://127.0.0.1:8787/ws/agent --token mn_xxx_yyy
scripts/e2e.sh --quick --ui                   # end-to-end tests + browser smoke test
pnpm --filter moni-web screenshots           # regenerate docs/screenshots from mock data
```

## FAQ

**Can't reach the dashboard from mainland China?** `*.workers.dev` is blocked there. Add a custom domain hosted on Cloudflare to the Worker, and use that domain in the install command's `--server`.

**Don't want a public dashboard?** Set `PUBLIC_DASHBOARD` to `"false"` in `crates/worker/wrangler.jsonc` and redeploy.

## Docs

[Architecture](docs/architecture.md) · [Design](docs/design.md) · [API](docs/api.md) · [Signed agent updates](docs/agent-updates.md) · [ADRs](docs/adr/)

## License

[MIT](LICENSE) © xingcanlee
