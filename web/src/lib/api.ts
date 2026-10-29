import type {
  AgentUpdateStatus,
  AlertEvent,
  AlertRule,
  AlertRuleInput,
  AlertRulePatch,
  AlertTestResponse,
  ActiveAlert,
  AppConfig,
  CreateServerResponse,
  History,
  HistoryRange,
  Appearance,
  PublicInfo,
  ServerStatus,
  TokenResponse,
} from "@/api/generated";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Fired when any request comes back 401 so the app can drop back to the public or login view. */
export const UNAUTHORIZED_EVENT = "moni:unauthorized";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let code = "internal";
    let message = res.statusText;
    try {
      const err = (await res.json()) as { error?: string; message?: string };
      code = err.error ?? code;
      message = err.message ?? message;
    } catch {
      // non-JSON error body
    }
    // Login and the session probe report 401 to their caller instead of resetting the app.
    if (res.status === 401 && path !== "/api/auth/login" && path !== "/api/auth/me")
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Public info never changes within a page's life; one request serves the theme and the role check.
let publicInfo: Promise<PublicInfo> | undefined;

export const api = {
  login: (password: string) => request<void>("POST", "/api/auth/login", { password }),
  logout: () => request<void>("POST", "/api/auth/logout"),
  me: () => request<{ authenticated: boolean }>("GET", "/api/auth/me"),
  publicInfo: () =>
    (publicInfo ??= request<PublicInfo>("GET", "/api/public").catch((e: unknown) => {
      publicInfo = undefined;
      throw e;
    })),
  appearance: () => request<Appearance>("GET", "/api/appearance"),
  setAppearance: (a: Appearance) => request<Appearance>("PUT", "/api/appearance", a),
  config: () => request<AppConfig>("GET", "/api/config"),

  servers: () => request<ServerStatus[]>("GET", "/api/servers"),
  createServer: (name: string, id?: string) =>
    request<CreateServerResponse>("POST", "/api/servers", id ? { name, id } : { name }),
  renameServer: (id: string, name: string) =>
    request<ServerStatus>("PATCH", `/api/servers/${encodeURIComponent(id)}`, { name }),
  deleteServer: (id: string) => request<void>("DELETE", `/api/servers/${encodeURIComponent(id)}`),
  rotateToken: (id: string) => request<TokenResponse>("POST", `/api/servers/${encodeURIComponent(id)}/token`),
  agentUpdates: () => request<AgentUpdateStatus[]>("GET", "/api/agent-updates"),
  updateAgents: (version: string, serverIds: string[]) =>
    request<AgentUpdateStatus[]>("POST", "/api/agent-updates", { version, server_ids: serverIds }),
  history: (id: string, range: HistoryRange) =>
    request<History>("GET", `/api/servers/${encodeURIComponent(id)}/history?range=${range}`),

  rules: () => request<AlertRule[]>("GET", "/api/alerts/rules"),
  createRule: (input: AlertRuleInput) => request<AlertRule>("POST", "/api/alerts/rules", input),
  updateRule: (id: string, patch: AlertRulePatch) =>
    request<AlertRule>("PATCH", `/api/alerts/rules/${encodeURIComponent(id)}`, patch),
  deleteRule: (id: string) => request<void>("DELETE", `/api/alerts/rules/${encodeURIComponent(id)}`),
  activeAlerts: () => request<ActiveAlert[]>("GET", "/api/alerts/active"),
  events: (limit = 50, beforeId?: number) =>
    request<AlertEvent[]>(
      "GET",
      `/api/alerts/events?limit=${limit}${beforeId == null ? "" : `&before_id=${beforeId}`}`,
    ),
  testNotify: () => request<AlertTestResponse>("POST", "/api/alerts/test"),
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message || e.code;
  if (e instanceof Error) return e.message;
  return String(e);
}
