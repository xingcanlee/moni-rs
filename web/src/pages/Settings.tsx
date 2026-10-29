import {
  ArrowUpCircleIcon,
  BellIcon,
  CheckIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  ServerIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import type {
  AgentUpdateStatus,
  AlertEvent,
  AlertMetric,
  AlertOp,
  AlertRule,
  AlertRuleInput,
  AlertTestResponse,
  AppConfig,
  Appearance,
  ServerStatus,
  UpdateError,
} from "@/api/generated";
import { ConfirmAction, CopyButton, EmptyState, ErrorText, PageSpinner, ResponsiveDialog, Segmented, StatusDot, toastError } from "@/components/common";
import { Flag } from "@/components/Flag";
import { MODE_OPTIONS, ThemeList } from "@/components/ThemePicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { api, errorText } from "@/lib/api";
import { ago, dateTime } from "@/lib/format";
import { useLive } from "@/lib/live";
import { href, navigate, type SettingsTab } from "@/lib/router";
import { setSiteAppearance, useTheme, useThemeKey } from "@/lib/theme";
import { findTheme } from "@/lib/themes";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/utils";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "servers", label: "服务器" },
  { id: "alerts", label: "告警规则" },
  { id: "events", label: "告警事件" },
  { id: "notify", label: "通知" },
  { id: "appearance", label: "外观" },
];

export function Settings({ tab, config }: { tab: SettingsTab; config: AppConfig | null }) {
  const themeKey = useThemeKey();
  return (
    <div className="space-y-5 sm:space-y-6">
      <h1 className="text-xl leading-7 font-semibold tracking-tight sm:text-2xl sm:leading-8">管理</h1>
      {/* The route owns the tab, so deep links and Back work; the tabs only navigate. */}
      <Tabs value={tab} onValueChange={(t) => navigate({ page: "settings", tab: t as SettingsTab })} className="gap-5 sm:gap-6">
        <div className="no-scrollbar -mx-4 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0">
          <TabsList key={themeKey} variant="line">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="px-3">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={tab}>
          {tab === "servers" && <ServersTab config={config} />}
          {tab === "alerts" && <AlertsTab />}
          {tab === "events" && <EventsTab />}
          {tab === "notify" && <NotifyTab config={config} />}
          {tab === "appearance" && <AppearanceTab />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Toolbar({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  );
}

/** Cancel / submit row closing every form dialog. */
function FormActions({ busy, disabled, label, onCancel }: { busy: boolean; disabled: boolean; label: string; onCancel: () => void }) {
  return (
    <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
      <Button type="button" variant="outline" size="lg" onClick={onCancel}>
        取消
      </Button>
      <Button type="submit" size="lg" disabled={busy || disabled}>
        {busy && <Spinner data-icon="inline-start" />}
        {label}
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- servers */

function installCommand(config: AppConfig | null, token: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const server = `${proto}://${location.host}/ws/agent`;
  const repo = config?.agent_release_repo ?? "<owner>/moni-rs";
  return [
    `curl -fsSL https://github.com/${repo}/releases/latest/download/install-agent.sh \\`,
    `  | sudo sh -s -- --repo ${repo} \\`,
    `      --server ${server} \\`,
    `      --token ${token}`,
  ].join("\n");
}

function TokenReveal({ config, token }: { config: AppConfig | null; token: string }) {
  const cmd = installCommand(config, token);
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 rounded-lg bg-[color-mix(in_oklab,var(--status-warning)_14%,transparent)] px-3 py-2 text-sm">
        <TriangleAlertIcon className="size-4 shrink-0 text-warn" />
        Token 只显示这一次，请立即保存。
      </p>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Token</span>
          <CopyButton text={token} />
        </div>
        <code data-token className="block rounded-md bg-muted px-2.5 py-2 font-mono text-xs leading-5 break-all">
          {token}
        </code>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">安装命令（在 VPS 上以 root 运行）</span>
          <CopyButton text={cmd} />
        </div>
        {/* Wrapped rather than scrolled so the whole token is visible; copying goes through the button. */}
        <pre className="rounded-xl bg-[#1b1a19] p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-[#f4f3ee] sm:p-4">{cmd}</pre>
      </div>
      {!config?.agent_release_repo && (
        <p className="text-xs text-muted-foreground">未配置 AGENT_RELEASE_REPO，请把命令中的 &lt;owner&gt; 替换为你的 GitHub 仓库。</p>
      )}
    </div>
  );
}

function AddServerForm({ onCreated, onCancel }: { onCreated: (server: string, token: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [customId, setCustomId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.createServer(name.trim(), customId.trim() || undefined);
      onCreated(res.server.name, res.token);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="server-name">名称</FieldLabel>
          <Input id="server-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 香港 01" />
        </Field>
        <Field>
          <FieldLabel htmlFor="server-id">ID（可选）</FieldLabel>
          <Input id="server-id" value={customId} onChange={(e) => setCustomId(e.target.value)} placeholder="hk-01" />
          <FieldDescription>小写字母、数字和 -，最长 32 位；留空则根据名称生成</FieldDescription>
        </Field>
        {error && <FieldError>{error}</FieldError>}
        <FormActions busy={busy} disabled={!name.trim()} label="创建" onCancel={onCancel} />
      </FieldGroup>
    </form>
  );
}

function RenameForm({ server, onDone }: { server: ServerStatus; onDone: () => void }) {
  const [name, setName] = useState(server.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.renameServer(server.id, name.trim());
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="rename">名称</FieldLabel>
          <Input id="rename" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {error && <FieldError>{error}</FieldError>}
        <FormActions busy={busy} disabled={!name.trim()} label="保存" onCancel={onDone} />
      </FieldGroup>
    </form>
  );
}

/* ---------------------------------------------------------------- updates */

/** Zero-padded parts compare as strings; release versions have at most 9 digits per part. */
function versionKey(v: string | null): string | null {
  const m = v && /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(v);
  return m ? m.slice(1).map((p) => p.padStart(9, "0")).join(".") : null;
}

function olderThan(current: string | null, target: string): boolean {
  const a = versionKey(current);
  const b = versionKey(target);
  return a != null && b != null && a < b;
}

const UPDATE_ERRORS: Record<UpdateError, string> = {
  disabled: "主机未启用升级",
  repo_mismatch: "主机固定的发布仓库与面板不一致，需在主机上用 --repo 重新安装一次（见 docs/agent-updates.md）",
  insecure_transport: "仅 wss:// 连接支持升级",
  invalid_version: "版本号无效",
  downgrade: "不支持降级",
  busy: "主机正在执行另一项升级",
  request_failed: "升级失败，主机已回退到原版本",
  timeout: "超时未完成，请查看主机 journalctl -u moni-agent-update",
  unsupported: "主机未安装签名升级组件，请在主机上重新运行安装命令",
};

function updateNote(job: AgentUpdateStatus): { text: string; tone: "busy" | "error" } | null {
  if (job.state === "queued") return { text: `等待升级到 ${job.version}`, tone: "busy" };
  if (job.state === "accepted") return { text: `正在升级到 ${job.version}`, tone: "busy" };
  if (job.state === "failed" || job.state === "unsupported")
    return { text: UPDATE_ERRORS[job.error ?? "unsupported"], tone: "error" };
  return null;
}

/** Latest job per server. Polls only while one is in flight; success arrives as a new agent_version. */
function useAgentUpdates(enabled: boolean) {
  const [jobs, setJobs] = useState<Map<string, AgentUpdateStatus>>(new Map());
  const merge = useCallback((list: AgentUpdateStatus[]) => {
    setJobs((old) => {
      const next = new Map(old);
      for (const j of list) next.set(j.server_id, j);
      return next;
    });
  }, []);
  const refresh = useCallback(() => {
    api.agentUpdates().then(merge, () => {});
  }, [merge]);
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);
  const inFlight = [...jobs.values()].some((j) => j.state === "queued" || j.state === "accepted");
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [inFlight, refresh]);
  return { jobs, merge };
}

function ServersTab({ config }: { config: AppConfig | null }) {
  const { servers, ready } = useLive();
  const now = useNow();
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState<{ server: string; token: string } | null>(null);
  const [editing, setEditing] = useState<ServerStatus | null>(null);
  // Worker and Agent release from the same tag, so the dashboard's version is the target.
  const target = config?.agent_release_repo ? `v${config.version}` : null;
  const { jobs, merge } = useAgentUpdates(target != null);

  const list = [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
  const pending = (id: string) => {
    const state = jobs.get(id)?.state;
    return state === "queued" || state === "accepted";
  };
  const outdated = target ? list.filter((s) => olderThan(s.agent_version, target) && !pending(s.id)) : [];

  const upgrade = async (ids: string[]) => {
    if (!target) return;
    try {
      merge(await api.updateAgents(target, ids));
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className="space-y-4">
      <Toolbar text="每台服务器使用独立 token；轮换或删除会立即断开对应 Agent。">
        <div className="flex flex-col gap-2 sm:flex-row">
          {target && outdated.length > 1 && (
            <ConfirmAction
              title={`把 ${outdated.length} 台服务器的 Agent 升级到 ${target}？`}
              description="主机下载并验证签名后替换程序，期间会短暂离线；新版本启动失败会自动回退。"
              action="全部升级"
              destructive={false}
              onConfirm={() => upgrade(outdated.map((s) => s.id))}
              trigger={
                <Button size="lg" variant="outline">
                  <ArrowUpCircleIcon data-icon="inline-start" />
                  全部升级到 {target}
                </Button>
              }
            />
          )}
          <Button size="lg" onClick={() => setAdding(true)}>
            <PlusIcon data-icon="inline-start" />
            添加服务器
          </Button>
        </div>
      </Toolbar>

      {!ready ? (
        <PageSpinner />
      ) : list.length === 0 ? (
        <EmptyState title="还没有服务器" icon={<ServerIcon />} />
      ) : (
        <Card className="gap-0 divide-y py-0">
          {list.map((s) => (
            <div key={s.id} data-server-row className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Flag code={s.country} className="text-base" />
                <div className="min-w-0 flex-1">
                  <a href={href({ page: "server", id: s.id })} className="block truncate leading-5 font-medium underline-offset-2 hover:underline">
                    {s.name}
                  </a>
                  <div className="mt-0.5 flex min-h-4 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-4 text-muted-foreground">
                    <span className="truncate font-mono">{s.id}</span>
                    {s.agent_version && (
                      <Badge variant="outline" className="h-4 px-1.5 font-mono text-[11px]">
                        v{s.agent_version}
                      </Badge>
                    )}
                    <UpdateHint job={jobs.get(s.id)} />
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusDot online={s.online} />
                  {!s.online && <span className="hidden sm:inline">· {s.last_seen_ms ? ago(s.last_seen_ms, now) : "从未连接"}</span>}
                </div>
              </div>
              <div className="-mx-2 flex gap-1 sm:mx-0">
                {target && olderThan(s.agent_version, target) && !pending(s.id) && (
                  <Button size="sm" variant="ghost" className="text-primary hover:text-primary" onClick={() => void upgrade([s.id])}>
                    <ArrowUpCircleIcon data-icon="inline-start" />
                    {/* Short labels keep all four actions on one line at phone width. */}
                    <span className="sm:hidden">升级</span>
                    <span className="hidden sm:inline">升级到 {target}</span>
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                  <PencilIcon data-icon="inline-start" />
                  重命名
                </Button>
                <ConfirmAction
                  title={`轮换「${s.name}」的 Token？`}
                  description="当前 Agent 将被断开，需要用新 token 重新安装。"
                  action="轮换"
                  destructive={false}
                  onConfirm={async () => {
                    const res = await api.rotateToken(s.id);
                    setToken({ server: s.name, token: res.token });
                  }}
                  trigger={
                    <Button size="sm" variant="ghost">
                      <KeyRoundIcon data-icon="inline-start" />
                      <span className="hidden sm:inline">轮换</span> Token
                    </Button>
                  }
                />
                <ConfirmAction
                  title={`删除「${s.name}」？`}
                  description="服务器及其全部历史数据都会被删除，此操作不可撤销。"
                  action="删除"
                  onConfirm={() => api.deleteServer(s.id)}
                  trigger={
                    <Button size="sm" variant="ghost" className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive sm:ml-0">
                      <Trash2Icon data-icon="inline-start" />
                      删除
                    </Button>
                  }
                />
              </div>
            </div>
          ))}
        </Card>
      )}

      <ResponsiveDialog open={adding} onOpenChange={setAdding} title="添加服务器">
        <AddServerForm
          onCancel={() => setAdding(false)}
          onCreated={(server, t) => {
            setAdding(false);
            setToken({ server, token: t });
          }}
        />
      </ResponsiveDialog>

      <ResponsiveDialog open={token != null} onOpenChange={(o) => !o && setToken(null)} title={`${token?.server ?? ""} 的安装信息`}>
        {token && <TokenReveal config={config} token={token.token} />}
        <div className="flex justify-end pt-4 sm:pt-1">
          <Button size="lg" className="w-full sm:w-auto" onClick={() => setToken(null)}>
            我已保存
          </Button>
        </div>
      </ResponsiveDialog>

      <ResponsiveDialog open={editing != null} onOpenChange={(o) => !o && setEditing(null)} title="重命名">
        {editing && <RenameForm server={editing} onDone={() => setEditing(null)} />}
      </ResponsiveDialog>
    </div>
  );
}

function UpdateHint({ job }: { job: AgentUpdateStatus | undefined }) {
  const note = job && updateNote(job);
  if (!note) return null;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", note.tone === "error" ? "text-destructive" : "text-foreground")}>
      {note.tone === "busy" && <Spinner className="size-3" />}
      <span className="truncate" title={note.text}>
        {note.text}
      </span>
    </span>
  );
}

/* ----------------------------------------------------------------- alerts */

const METRICS: { id: AlertMetric; label: string; unit: string }[] = [
  { id: "cpu", label: "CPU 使用率", unit: "%" },
  { id: "mem", label: "内存使用率", unit: "%" },
  { id: "swap", label: "Swap 使用率", unit: "%" },
  { id: "disk", label: "磁盘使用率", unit: "%" },
  { id: "load1", label: "1 分钟负载", unit: "" },
  { id: "net_rx", label: "下载速率", unit: "B/s" },
  { id: "net_tx", label: "上传速率", unit: "B/s" },
  { id: "offline", label: "离线", unit: "" },
];
const metricInfo = (m: AlertMetric) => METRICS.find((x) => x.id === m) ?? { id: m, label: m, unit: "" };

const OPS: { value: AlertOp; label: string }[] = [
  { value: "gt", label: "大于" },
  { value: "lt", label: "小于" },
];

/** Select has no empty value; this id stands for "every server" (server_id = null). */
const ALL_SERVERS = "*";

function describeRule(r: AlertRule): string {
  if (r.metric === "offline") return `离线超过 ${r.duration_s} 秒`;
  const { label, unit } = metricInfo(r.metric);
  const op = r.op === "gt" ? ">" : "<";
  const dur = r.duration_s > 0 ? `，持续 ${r.duration_s} 秒` : "";
  return `${label} ${op} ${r.threshold}${unit}${dur}`;
}

const EMPTY_RULE: AlertRuleInput = {
  name: "",
  server_id: null,
  metric: "cpu",
  op: "gt",
  threshold: 90,
  recover_threshold: null,
  duration_s: 300,
  enabled: true,
};

/** A labelled single-choice select over a fixed item list. */
function SelectField<T extends string>({
  id,
  label,
  value,
  items,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  items: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select items={items} value={value} onValueChange={(v) => v != null && onChange(v)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function RuleForm({
  initial,
  servers,
  onSubmit,
  onCancel,
}: {
  initial: AlertRuleInput;
  servers: ServerStatus[];
  onSubmit: (r: AlertRuleInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [r, setR] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const offline = r.metric === "offline";
  const unit = metricInfo(r.metric).unit;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit(r);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const serverItems = [{ value: ALL_SERVERS, label: "全部服务器" }, ...servers.map((s) => ({ value: s.id, label: s.name }))];

  return (
    <form onSubmit={submit}>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="rule-name">名称</FieldLabel>
          <Input id="rule-name" autoFocus value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="CPU 过高" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            id="rule-server"
            label="服务器"
            value={r.server_id ?? ALL_SERVERS}
            items={serverItems}
            onChange={(v) => setR({ ...r, server_id: v === ALL_SERVERS ? null : v })}
          />
          <SelectField
            id="rule-metric"
            label="指标"
            value={r.metric}
            items={METRICS.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(metric) => setR({ ...r, metric })}
          />
        </div>
        {!offline && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <SelectField id="rule-op" label="条件" value={r.op} items={OPS} onChange={(op) => setR({ ...r, op })} />
            <Field>
              <FieldLabel htmlFor="rule-threshold">阈值{unit && `（${unit}）`}</FieldLabel>
              <Input
                id="rule-threshold"
                type="number"
                step="any"
                required
                value={r.threshold}
                onChange={(e) => setR({ ...r, threshold: Number(e.target.value) })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="rule-recover">恢复阈值</FieldLabel>
              <Input
                id="rule-recover"
                type="number"
                step="any"
                placeholder="默认 ±10%"
                value={r.recover_threshold ?? ""}
                onChange={(e) => setR({ ...r, recover_threshold: num(e.target.value) })}
              />
            </Field>
          </div>
        )}
        <Field>
          <FieldLabel htmlFor="rule-duration">{offline ? "离线多久后告警（秒）" : "持续时间（秒）"}</FieldLabel>
          <Input
            id="rule-duration"
            type="number"
            min={0}
            required
            value={r.duration_s}
            onChange={(e) => setR({ ...r, duration_s: Math.max(0, Math.round(Number(e.target.value))) })}
          />
          {!offline && <FieldDescription>超过阈值并持续该时长才触发；0 表示立即触发</FieldDescription>}
        </Field>
        <Field orientation="horizontal">
          <Switch id="rule-enabled" checked={r.enabled} onCheckedChange={(enabled) => setR({ ...r, enabled })} />
          <FieldLabel htmlFor="rule-enabled" className="font-normal">
            启用
          </FieldLabel>
        </Field>
        {error && <FieldError>{error}</FieldError>}
        <FormActions busy={busy} disabled={!r.name.trim()} label="保存" onCancel={onCancel} />
      </FieldGroup>
    </form>
  );
}

function AlertsTab() {
  const { servers } = useLive();
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<AlertRule | "new" | null>(null);
  const serverList = [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));

  const load = useCallback(() => {
    api.rules().then(setRules, (e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  const save = async (input: AlertRuleInput) => {
    if (editing === "new") await api.createRule(input);
    else if (editing) await api.updateRule(editing.id, input);
    setEditing(null);
    load();
  };

  const toggle = async (r: AlertRule, enabled: boolean) => {
    try {
      // Send the whole rule: for nullable fields an explicit null means "clear", not "unchanged".
      const { id, created_ms: _created, ...input } = r;
      await api.updateRule(id, { ...input, enabled });
      load();
    } catch (e) {
      toastError(e);
    }
  };

  const serverName = (id: string | null) => (id == null ? "全部服务器" : (servers.get(id)?.name ?? id));

  return (
    <div className="space-y-4">
      <Toolbar text="规则对实时数据求值，状态变化时发送通知。">
        <Button size="lg" onClick={() => setEditing("new")}>
          <PlusIcon data-icon="inline-start" />
          添加规则
        </Button>
      </Toolbar>
      <ErrorText>{error}</ErrorText>
      {rules == null ? (
        !error && <PageSpinner />
      ) : rules.length === 0 ? (
        <EmptyState title="没有告警规则" icon={<BellIcon />} />
      ) : (
        <Card className="gap-0 divide-y py-0">
          {rules.map((r) => (
            <div key={r.id} data-rule-row className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
              <Switch checked={r.enabled} onCheckedChange={(on) => void toggle(r, on)} aria-label={`启用「${r.name}」`} />
              <div className="min-w-0 flex-1">
                <div className="flex h-5 items-center gap-2 text-sm leading-5 font-medium">
                  <span className="truncate">{r.name}</span>
                  {!r.enabled && <Badge variant="secondary">已停用</Badge>}
                </div>
                <div className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
                  {describeRule(r)} · {serverName(r.server_id)}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="icon-sm" variant="ghost" aria-label="编辑" onClick={() => setEditing(r)}>
                  <PencilIcon />
                </Button>
                <ConfirmAction
                  title={`删除规则「${r.name}」？`}
                  description="正在告警的事件会一并结束。"
                  action="删除"
                  onConfirm={async () => {
                    await api.deleteRule(r.id);
                    load();
                  }}
                  trigger={
                    <Button size="icon-sm" variant="ghost" aria-label="删除" className="text-destructive hover:bg-destructive/10 hover:text-destructive">
                      <Trash2Icon />
                    </Button>
                  }
                />
              </div>
            </div>
          ))}
        </Card>
      )}
      <ResponsiveDialog open={editing != null} onOpenChange={(o) => !o && setEditing(null)} title={editing === "new" ? "添加规则" : "编辑规则"}>
        {editing != null && (
          <RuleForm initial={editing === "new" ? EMPTY_RULE : editing} servers={serverList} onSubmit={save} onCancel={() => setEditing(null)} />
        )}
      </ResponsiveDialog>
    </div>
  );
}

/* ----------------------------------------------------------------- events */

function EventsTab() {
  const { alerts } = useLive();
  const now = useNow();
  const [events, setEvents] = useState<AlertEvent[] | null>(null);
  const [more, setMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const PAGE = 50;

  useEffect(() => {
    api.events(PAGE).then(
      (e) => (setEvents(e), setMore(e.length === PAGE)),
      (e) => setError(errorText(e)),
    );
  }, [alerts.length]);

  const loadMore = async () => {
    const last = events?.at(-1);
    if (!last) return;
    setLoadingMore(true);
    try {
      const next = await api.events(PAGE, last.id);
      setEvents([...(events ?? []), ...next]);
      setMore(next.length === PAGE);
    } catch (e) {
      toastError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">当前告警</h2>
        {alerts.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckIcon className="size-4 text-good" />
            一切正常。
          </p>
        ) : (
          <Card className="gap-0 divide-y py-0">
            {alerts.map((a) => (
              <div key={`${a.rule_id}-${a.server_id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm sm:px-5">
                <Badge variant="destructive">
                  <TriangleAlertIcon data-icon="inline-start" />
                  告警中
                </Badge>
                <a className="font-medium underline-offset-2 hover:underline" href={href({ page: "server", id: a.server_id })}>
                  {a.server_name}
                </a>
                <span>{a.rule_name}</span>
                {a.value != null && <span className="tabular text-xs text-muted-foreground">当前 {a.value.toFixed(1)}</span>}
                <span className="text-xs text-muted-foreground sm:ml-auto">开始于 {ago(a.since_ms, now)}</span>
              </div>
            ))}
          </Card>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">历史事件</h2>
        <ErrorText>{error}</ErrorText>
        {events == null ? (
          !error && <PageSpinner />
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无事件。</p>
        ) : (
          <Card className="gap-0 divide-y py-0">
            {events.map((e) => (
              <div
                key={e.id}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm sm:grid-cols-[10.5rem_5rem_minmax(0,12rem)_1fr_4rem] sm:px-5"
              >
                <span className="tabular col-span-3 text-xs text-muted-foreground sm:col-span-1">{dateTime(e.ts_ms)}</span>
                <span>
                  {e.kind === "firing" ? (
                    <Badge variant="destructive">
                      <TriangleAlertIcon data-icon="inline-start" />
                      触发
                    </Badge>
                  ) : (
                    <Badge className="bg-good-soft text-good">
                      <CheckIcon data-icon="inline-start" />
                      恢复
                    </Badge>
                  )}
                </span>
                <span className="min-w-0 truncate">
                  <span className="font-medium">{e.server_name}</span>
                  <span className="text-muted-foreground sm:hidden"> · {e.rule_name}</span>
                </span>
                <span className="hidden min-w-0 truncate text-ink-2 sm:block">{e.rule_name}</span>
                <span className="tabular text-right text-xs text-muted-foreground">{e.value?.toFixed(1) ?? ""}</span>
              </div>
            ))}
          </Card>
        )}
        {events && more && (
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <Spinner data-icon="inline-start" />}
            加载更多
          </Button>
        )}
      </section>
    </div>
  );
}

/* ----------------------------------------------------------------- notify */

function NotifyTab({ config }: { config: AppConfig | null }) {
  const [result, setResult] = useState<AlertTestResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const test = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await api.testNotify());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const channels = [
    { name: "Telegram", enabled: config?.notifications.telegram ?? false, secrets: "TG_BOT_TOKEN、TG_CHAT_ID", res: result?.telegram },
    { name: "Webhook", enabled: config?.notifications.webhook ?? false, secrets: "WEBHOOK_URL", res: result?.webhook },
  ];

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">
        通知渠道通过 Worker Secret 配置（GitHub Secrets → 重新运行 Deploy，或{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-ink-2">wrangler secret put</code>）。
      </p>
      <Card className="gap-0 divide-y py-0">
        {channels.map((c) => (
          <div key={c.name} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3.5 text-sm sm:px-5">
            <span className="w-24 leading-5 font-medium">{c.name}</span>
            {c.enabled ? (
              <Badge className="bg-good-soft text-good">
                <CheckIcon data-icon="inline-start" />
                已配置
              </Badge>
            ) : (
              <Badge variant="secondary">未配置</Badge>
            )}
            <code className="w-full font-mono text-xs leading-5 text-muted-foreground sm:w-auto">{c.secrets}</code>
            {c.res && (
              <span className={cn("text-xs sm:ml-auto", c.res === "ok" ? "text-good" : c.res === "disabled" ? "text-muted-foreground" : "text-destructive")}>
                {c.res === "ok" ? "发送成功" : c.res === "disabled" ? "未启用" : c.res}
              </span>
            )}
          </div>
        ))}
      </Card>
      <ErrorText>{error}</ErrorText>
      <Button variant="outline" size="lg" onClick={() => void test()} disabled={busy}>
        {busy ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
        {busy ? "发送中…" : "发送测试通知"}
      </Button>
      {config && (
        <p className="text-xs text-muted-foreground">
          上报间隔 {config.report_interval_s} 秒 · 分钟数据保留 {config.retention.minute_days} 天 · 小时数据保留 {config.retention.hour_days} 天
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- appearance */

function AppearanceTab() {
  const { dark } = useTheme();
  const [a, setA] = useState<Appearance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.appearance().then(setA, (e: unknown) => setError(errorText(e)));
  }, []);

  if (!a) return error ? <ErrorText>{error}</ErrorText> : <PageSpinner />;
  const darkOnly = !!findTheme(a.theme)?.darkOnly;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setSiteAppearance(await api.setAppearance(a));
      toast.add({ title: "已保存", description: "其他访客最多 1 分钟后生效。", type: "success" });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="max-w-2xl">
      <FieldGroup className="gap-6">
        <FieldSet>
          <FieldLegend>站点默认主题</FieldLegend>
          <FieldDescription>访客首次打开时使用；访客在顶栏「外观」里的选择只保存在他们自己的浏览器。</FieldDescription>
          <ThemeList value={a.theme} dark={darkOnly || a.mode === "dark" || (a.mode === "system" && dark)} onChange={(theme) => setA({ ...a, theme })} />
        </FieldSet>
        <Field orientation="horizontal" className="flex-wrap justify-between">
          <FieldContent>
            <FieldLabel>默认明暗</FieldLabel>
            <FieldDescription>{darkOnly ? "该主题仅有暗色。" : "跟随系统会按访客设备自动切换。"}</FieldDescription>
          </FieldContent>
          {!darkOnly && <Segmented label="默认明暗" value={a.mode} options={MODE_OPTIONS} onChange={(mode) => setA({ ...a, mode })} />}
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="lock-theme">锁定站点主题</FieldLabel>
            <FieldDescription>访客不能换主题，只能切换明暗。</FieldDescription>
          </FieldContent>
          <Switch id="lock-theme" checked={a.locked} onCheckedChange={(locked) => setA({ ...a, locked })} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center gap-3">
          <Button type="submit" size="lg" disabled={busy}>
            {busy && <Spinner data-icon="inline-start" />}
            保存
          </Button>
          <span className="text-xs text-muted-foreground">保存到服务器，对所有访客生效。</span>
        </div>
      </FieldGroup>
    </form>
  );
}
