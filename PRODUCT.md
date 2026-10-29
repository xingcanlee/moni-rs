# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Owner-operator**: one person running a handful of VPSes (often a mix of providers and regions: Tokyo, Hong Kong home broadband NAT, Frankfurt). They glance at health several times a day, frequently on a phone, and drill into one server when something looks off.
- **Public visitors**: when `PUBLIC_DASHBOARD="true"`, anyone with the URL sees a redacted, read-only dashboard: friends, users of services hosted on those nodes, people checking whether a node is up. Owner and visitor views carry equal weight.

## Product Purpose
moni-rs is a self-hosted VPS monitor that runs entirely inside Cloudflare's free tier: a Rust agent on each server streams metrics over WebSocket to a Rust Worker + Durable Object, which serves a live dashboard, 1h–90d history, monthly traffic and threshold/offline alerts (Telegram / Webhook). Success: at a glance you know which machines are up, which are strained, and how much traffic they burned this month, with no server of your own to run.

## Positioning
Zero-cost, zero-infrastructure: fork the repo, set two secrets, deploy to Cloudflare, `curl | sh` the agent. Live data arrives every 5 s over a hibernating WebSocket; history is kept in SQLite rollups sized to the free-tier write budget.

## Operating Context
- Overview → server detail → management (servers, alert rules, alert events, notification channels).
- Roles: admin (signed-in, full data and management), public (anonymous, hostname/kernel/agent version/alert state stripped), locked (login required).
- Region per server comes from the agent's egress IP (`cf.country`).
- Used on desktop and phone; light and dark themes follow the system with a manual toggle.

## Capabilities and Constraints
- Metrics: CPU %, load, memory/swap, disk, network rx/tx rate, monthly traffic, uptime, process count, host info.
- History ranges 1h, 6h, 24h, 7d, 30d, 90d; charts: CPU avg/peak, memory/swap, net avg/peak, disk, load.
- Front end: React 19 + Tailwind v4 + Vite, uPlot charts, built into static assets served by the Worker. Must stay small; the Worker runs on the free tier.
- UI copy is Simplified Chinese. No backward-compatibility constraints on the visual layer: the redesign may replace anything visual.

## Brand Commitments
- Name: **moni** (repo `moni-rs`). Author: xingcanlee, https://github.com/xingcanlee/moni-rs, MIT license. The footer must credit the author with copyright and link to GitHub.
- Visual register (owner, 2026-10-17): clean, restrained, enterprise, in the spirit of Apple and Anthropic product pages. Warm neutrals, one quiet accent, generous spacing, soft corners.
- Rejected by the owner: purple/blue gradients, glow, glass; stark black-and-white; decorative or novelty icons; metaphor devices on server cards (the station-clock direction was shipped and rejected).
- No filler copy: no taglines or self-descriptions ("开源 VPS 监控 · 运行在 Cloudflare Workers") in the chrome.

## Evidence on Hand
Real UI and live data from local agents; no testimonials, user counts or benchmarks exist, and none may be invented.

## Product Principles
1. State first: online/offline and strain are readable in one glance, never by colour alone.
2. One screen for owner and visitor: the public view is the same product with fields removed, not a separate page.
3. Phone is a first-class viewport.
4. Honest numbers: units, tabular figures, and no decoration that competes with data.

## Accessibility & Inclusion
WCAG AA contrast in both themes; status never conveyed by colour alone; keyboard focus visible; respects `prefers-reduced-motion`.
