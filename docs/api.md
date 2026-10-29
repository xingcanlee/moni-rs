# moni-rs API 契约（v1）

前后端之间的唯一契约。Rust 类型定义在 `crates/protocol/src/api.rs`，TS 类型由 ts-rs 生成到 `web/src/api/generated/`。
本文与代码不一致时，**以本文为准**，并修正代码。

约定：
- JSON 字段一律 snake_case；时间戳统一为 Unix 毫秒，字段名以 `_ms` 结尾；字节数用 `u64`，速率单位为 bytes/s。
- `u64`/`i64` 在 TS 中映射为 `number`（ts-rs 通过 `#[ts(type = "number")]` 指定）。
- 错误响应：HTTP 4xx/5xx，响应体 `{"error": "<code>", "message": "<可读说明>"}`。错误码：`unauthorized`、`forbidden`、`not_found`、`bad_request`、`conflict`、`rate_limited`、`not_configured`、`internal`。
- 鉴权：除 `/api/health`、`/api/public`、`/api/auth/login` 外，所有 `/api/*` 和 `/ws/dashboard` 都需要管理员会话（Cookie `moni_session`）或 `Authorization: Bearer <ADMIN_PASSWORD>`。
- 公开访问：Worker 变量 `PUBLIC_DASHBOARD="true"` 时，未登录访客可以只读访问 `GET /ws/dashboard` 和 `GET /api/servers/:id/history`，看到的是**脱敏视图**（见 §5.1）。其他接口仍返回 `401`。公开的 history 响应带 `Cache-Control: public, max-age=60` 并写入边缘缓存，避免访客消耗 Hub 的请求与读取额度。
- CSRF：使用 Cookie 鉴权时，`/ws/dashboard` 握手和所有非 GET 的 `/api/*` 请求都必须带 `Origin`，并且与请求目标源完全一致（缺失、`null` 或不一致 → `403 forbidden`）；带请求体的写操作必须使用 `Content-Type: application/json`（否则返回 `415`，错误码 `bad_request`）。Bearer 鉴权（CLI）不校验 Origin。`/api/auth/login` 同样校验 Origin（存在时必须一致）。

## 1. 认证

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/auth/login` | `{"password": string}` | `204` + `Set-Cookie`；失败返回 `401 unauthorized`；限流时返回 `429 rate_limited` |
| POST | `/api/auth/logout` | — | `204`，清除 Cookie |
| GET | `/api/auth/me` | — | `200 {"authenticated": true}`，或 `401` |
| GET | `/api/health` | — | `200 "ok"`（无需鉴权） |
| GET | `/api/public` | — | `200 {"enabled": boolean, "appearance": Appearance}`（无需鉴权）。`enabled` 即 `PUBLIC_DASHBOARD` 是否开启；`appearance` 见 §2.1。响应带 `Cache-Control: public, max-age=60` 并写入边缘缓存 |

## 2. 配置

`GET /api/config` → `AppConfig`
```ts
type AppConfig = {
  version: string;                 // worker 版本（CARGO_PKG_VERSION）
  report_interval_s: number;       // 有人查看时的实时上报周期，默认 2 秒；不是当前连接的动态周期
  agent_release_repo: string | null;   // 例如 "owner/moni-rs"，用于生成安装命令
  retention: { minute_days: number; hour_days: number };
  notifications: { telegram: boolean; webhook: boolean };
};
```

### 2.1 外观

站点默认外观存在 Hub `meta` 表（`k = 'appearance'`），只在管理员保存时写入。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/appearance` | — | `200 Appearance` |
| PUT | `/api/appearance` | `Appearance` | `200 Appearance`；`theme` 不合法返回 `400 bad_request`。成功后清除当前边缘节点的 `/api/public` 缓存，其他节点最多 60 秒后生效 |

```ts
type ThemeMode = "light" | "dark" | "system";
type Appearance = {
  theme: string;      // 前端主题 id，1–32 位小写字母/数字/-；未知 id 由前端回退到 "clay"
  mode: ThemeMode;    // 默认明暗；仅暗色主题忽略此项
  locked: boolean;    // true 时访客不能换主题，只能切换明暗
};
// 未设置时：{"theme": "clay", "mode": "system", "locked": false}
```

## 3. 服务器

```ts
type HostInfo = {
  hostname: string; os: string; kernel: string; arch: string;
  cpu_model: string; cpu_cores: number; boot_time_ms: number;
};

type MetricsFrame = {
  seq: number; ts_ms: number; cpu_pct: number;
  mem_used: number; mem_total: number; swap_used: number; swap_total: number;
  disk_used: number; disk_total: number;
  net_rx_bps: number; net_tx_bps: number;
  load1: number; load5: number; load15: number;
  uptime_s: number; process_count: number;
};

type Traffic = { rx_bytes: number; tx_bytes: number; since_ms: number };  // since_ms = 当月 1 日 00:00 UTC

type ServerStatus = {
  id: string; name: string; created_ms: number;
  online: boolean; last_seen_ms: number | null;
  agent_version: string | null;
  host: HostInfo | null;
  metrics: MetricsFrame | null;     // 仅在线时非空
  traffic_month: Traffic;
  alerts_firing: number;            // 当前处于 firing 状态的告警数
  country: string | null;           // 服务器所在国家（ISO 3166-1 alpha-2）：优先 Agent 上报，否则为 Cloudflare 看到的出口 IP
};
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/servers` | — | `ServerStatus[]`（按 name 排序） |
| POST | `/api/servers` | `{"name": string, "id"?: string}` | `201 {"server": ServerStatus, "token": string}`。id 省略时由 name 生成 slug，冲突时追加 `-2`、`-3`…；id 已存在且是显式指定的 → `409 conflict` |
| PATCH | `/api/servers/:id` | `{"name"?: string}` | `200 ServerStatus` |
| DELETE | `/api/servers/:id` | — | `204`。断开 Agent 连接，删除该服务器的所有数据（包括 metrics、alert_state、alert_events），不发送 resolved 通知 |
| POST | `/api/servers/:id/token` | — | `200 {"token": string}`。轮换 token，断开当前 Agent（关闭码 4003） |
| GET | `/api/servers/:id/history?range=` | `range` ∈ `1h,6h,24h,7d,30d,90d`，默认 `24h` | `200 History` |

```ts
type HistoryRange = "1h" | "6h" | "24h" | "7d" | "30d" | "90d";
type HistoryPoint = {
  ts_ms: number;
  cpu_avg: number; cpu_max: number;
  mem_pct: number; swap_pct: number; disk_pct: number;
  rx_bytes: number; tx_bytes: number;       // 该桶的总字节数
  rx_bps_max: number; tx_bps_max: number;
  load1: number;
};
type History = { range: HistoryRange; step_ms: number; points: HistoryPoint[] };  // points 按 ts_ms 升序；缺失的桶不补点
```
`step_ms`：1h/6h/24h = 60000，7d = 600000，30d/90d = 3600000。

## 4. 告警

```ts
type AlertMetric = "cpu" | "mem" | "swap" | "disk" | "load1" | "net_rx" | "net_tx" | "offline";
type AlertOp = "gt" | "lt";
type AlertRule = {
  id: string; name: string;
  server_id: string | null;        // null 表示所有服务器
  metric: AlertMetric; op: AlertOp;
  threshold: number; recover_threshold: number | null;
  duration_s: number; enabled: boolean; created_ms: number;
};
type AlertRuleInput = Omit<AlertRule, "id" | "created_ms">;
type AlertEvent = {
  id: number; rule_id: string; rule_name: string;
  server_id: string; server_name: string;
  kind: "firing" | "resolved"; value: number | null; ts_ms: number;
};
type ActiveAlert = {
  rule_id: string; rule_name: string; server_id: string; server_name: string;
  metric: AlertMetric; value: number | null; since_ms: number;
};
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/alerts/rules` | — | `AlertRule[]` |
| POST | `/api/alerts/rules` | `AlertRuleInput` | `201 AlertRule` |
| PATCH | `/api/alerts/rules/:id` | `Partial<AlertRuleInput>` | `200 AlertRule` |
| DELETE | `/api/alerts/rules/:id` | — | `204`，同时清除该规则的 firing 状态 |
| GET | `/api/alerts/active` | — | `ActiveAlert[]` |
| GET | `/api/alerts/events?limit=50&before_id=` | — | `AlertEvent[]`（按 id 倒序，limit 最大 200） |
| POST | `/api/alerts/test` | — | `200 {"telegram": "ok" \| "disabled" \| string, "webhook": 同上}`（string 为错误信息） |

单位约定：cpu/mem/swap/disk 用百分比（0–100），load1 为原值，net_rx/net_tx 为 bytes/s，offline 规则只使用 `duration_s`。

## 5. Dashboard WebSocket

`GET /ws/dashboard`（需管理员会话；浏览器会自动带上同源 Cookie）。服务端只推送消息，客户端发送的消息会被忽略。

```ts
type DashboardEvent =
  | { type: "snapshot"; servers: ServerStatus[]; alerts: ActiveAlert[] }
  | { type: "server_upsert"; server: ServerStatus }       // 新增 / 改名 / 上线时推送完整对象
  | { type: "server_removed"; id: string }
  | { type: "online"; id: string; agent_version: string | null; host: HostInfo | null }
  | { type: "offline"; id: string; last_seen_ms: number }
  | { type: "metrics"; id: string; frame: MetricsFrame }
  | { type: "traffic"; id: string; traffic: Traffic }        // 每次写入 Rollup 后推送更新后的本月流量
  | { type: "alert"; kind: "firing" | "resolved"; alert: ActiveAlert };
```
`country` 有两个来源，都搭在已有的写入里（不额外增加写入）：Agent 每次建立连接时，Worker 读取 `request.cf.country` 随上线那次 UPDATE 写入；随后 Hello 若带有 `country`，随 Hello 的 UPDATE 覆盖它。Agent 走代理或隧道时 Cloudflare 看到的是代理出口，因此以 Agent 上报为准。`XX`（未知）和 `T1`（Tor）会被忽略，保留上一次的值。服务端从不保存 IP。

`traffic`：在线服务器的本月流量由 Hub 在连接 attachment 中增量维护（连接建立或跨月时做一次 SUM 重算，之后每次写入新 Rollup 时累加），因此推送不产生额外的 SQLite 读取。
连接建立后会立即收到一条 `snapshot`。断线重连后，同样用 snapshot 整体替换本地状态。

### 5.1 公开视图（未登录）

未登录连接只会收到脱敏后的事件：
- `ServerStatus` / `online` 中的 `host.hostname`、`host.kernel` 置为空字符串，`agent_version` 置为 `null`，`alerts_firing` 置为 `0`；
- `snapshot.alerts` 恒为 `[]`，`alert` 事件不推送（规则名称和阈值属于运维配置）；
- 其余事件（`metrics`、`traffic`、`offline`、`server_removed`）与管理员视图相同。
管理员会话的 Cookie 如果搭配了不一致的 `Origin`，仍返回 `403`，不会降级成公开视图。

## 6. Agent WebSocket

`GET /ws/agent`，Header 为 `Authorization: Bearer mn_<server_id>_<secret>`。消息格式见 `docs/design.md` §2.1。
关闭码：`4000` 连接失活，`4001` 协议不兼容，`4002` 被新连接替换，`4003` token 被轮换或服务器被删除。

### 6.1 动态上报周期

Agent 与 Hub 使用协议 v3，不保留旧协议或能力协商。Hub 校验 Hello 并成功写入元数据后发送 Welcome，`Welcome.report_interval_s` 直接使用当前目标周期：有人查看时为 `REPORT_INTERVAL_S`（默认 2 秒），无人查看时为 `REPORT_IDLE_INTERVAL_S`（默认 30 秒）。

后续周期变化时 Hub 发送以下命令：

```json
{"type":"set_report_interval","report_interval_s":30}
```

Hello 完成后，以及看板连接数量变化时，Hub 根据当前 Dashboard WebSocket 选择周期：至少一个管理员或公开只读连接存在时使用 `REPORT_INTERVAL_S`（默认 2 秒）；最后一个连接关闭后使用 `REPORT_IDLE_INTERVAL_S`（默认 30 秒，可配置更长，但有效值至少为查看时周期）。多个窗口共同计数；隐藏标签页只要仍保持 WebSocket，也算有人查看。本次不增加浏览器可见性协议。

Agent 切换到更快周期时丢弃旧的实时聚合窗口，在下一个新样本到来后尽快发送，避免先展示整个空闲周期的平均值。1 秒采样、60 秒 `MinuteRollup`、ACK 和离线待确认队列不受周期切换影响。失活判定使用各连接实际周期，并保留切换宽限；即使空闲周期超过 60 秒，每分钟 Rollup 仍用于维持活性。`PROTOCOL_VERSION = 3`，不同版本以关闭码 `4001` 拒绝连接。

### 6.2 签名升级

只有本机已安装更新 helper、固定可信仓库及公钥，并使用 `wss://` 连接的 Agent，才在 Hello 中发送 `update_repo: "owner/repo"`。缺失或 `null` 表示未启用升级。可选的 `country`（ISO 3166-1 alpha-2）是 Agent 用本机网卡上的公网地址查询得到的地区，或 `MONI_COUNTRY` 手动指定的值；缺失表示交给 Cloudflare 判断。Hub 不向本机未启用升级的 Agent 投递升级命令。每连接仅接受一次 Hello；消息最大 16 KiB。

```ts
// Hub → Agent
type Update = { type: "update"; job_id: string; version: string; repo: string };
// Agent → Hub；只接受 accepted / failed，不能自行声称 succeeded
type UpdateStatus = {
  type: "update_status"; job_id: string; version: string;
  state: "accepted" | "failed"; error: UpdateError | null;
};
```

命令不能携带 URL、路径或 shell 参数；仓库必须与本机固定值一致。`accepted` 仅表示版本请求已经原子写入本地固定请求文件，由独立 root helper 执行验签、安装及回退。Hub 仅在后续新连接的 Hello 报告目标版本时确认成功；若随后连接报告更低版本，则把该任务改为 `failed/request_failed`，反映启动后回退。具体安装与签名设置见 [agent-updates.md](agent-updates.md)。

## 7. 管理端统一升级

以下接口只允许管理员 Cookie / Bearer，沿用 §1 的 Origin、JSON 检查，不对公开页面或 Agent token 开放。本次提供后端接口和生成的 TS 类型，页面可轮询状态；Dashboard 事件不变。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/agent-updates` | `{"version":"v0.1.1","server_ids":["vps-1"]}` | `202 AgentUpdateStatus[]`；省略 `server_ids` 表示全部服务器 |
| GET | `/api/agent-updates` | — | `200 AgentUpdateStatus[]`，每台只保留最近一次任务，按请求时间倒序 |

只接受稳定版 `vX.Y.Z`，各段无前导零、最多 9 位数字；不支持预发布、`latest`、降级或任意下载源。仓库固定为 Worker 变量 `AGENT_RELEASE_REPO`，缺失或非法返回 `503 not_configured`。显式 `server_ids` 必须包含 1–100 个不重复且存在的 ID，省略时全量也最多 100 台；先验证全部目标，非法请求不会创建部分任务。请求体最多 16 KiB，超出返回 `413`；未知字段和重复 JSON 字段被拒绝。

```ts
type UpdateState = "queued" | "accepted" | "succeeded" | "failed" | "unsupported";
type UpdateError = "disabled" | "repo_mismatch" | "insecure_transport" | "invalid_version"
  | "downgrade" | "busy" | "request_failed" | "timeout" | "unsupported";
type AgentUpdateStatus = {
  server_id: string; job_id: string; repo: string; version: string;
  state: UpdateState; error: UpdateError | null;
  requested_ms: number; updated_ms: number;
};
```

同一目标版本的进行中请求复用 `job_id`，另一目标版本返回 `409 conflict`；终态可显式重试。离线任务保留为 `queued`，重连确认本机配置后投递；24 小时未接受则失败。在线投递每连接最多 3 次、间隔至少 60 秒，计数在 attachment 中保存。接受后 10 分钟未通过新 Hello 确认则 `failed/timeout`。本机未启用升级时返回 `unsupported`；仓库不匹配、降级按服务器返回失败状态。服务端忽略伪造成功、跨服务器、错误任务 ID 或版本的状态消息。删除服务器同时删除其任务。

管理员密码变更会撤销已有 Cookie；Agent token 的 HMAC 仍只使用 `AUTH_SECRET`，不受密码变更影响。
