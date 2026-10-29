import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, HistoryIcon, ServerIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { History, HistoryPoint, HistoryRange, ServerStatus } from "@/api/generated";
import { Chart, type ChartSeries } from "@/components/Chart";
import { EmptyState, ErrorText, MeterBar, PageSpinner, Segmented, StatusDot } from "@/components/common";
import { Flag, countryName } from "@/components/Flag";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorText } from "@/lib/api";
import { ago, bytes, clockTime, dateTime, duration, pct, pctText, rate } from "@/lib/format";
import { useLive } from "@/lib/live";
import { href, navigate } from "@/lib/router";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/utils";

const RANGES: { id: HistoryRange; label: string; hours: number }[] = [
  { id: "1h", label: "1 小时", hours: 1 },
  { id: "6h", label: "6 小时", hours: 6 },
  { id: "24h", label: "24 小时", hours: 24 },
  { id: "7d", label: "7 天", hours: 168 },
  { id: "30d", label: "30 天", hours: 720 },
  { id: "90d", label: "90 天", hours: 2160 },
];

/** Break lines where buckets are missing instead of drawing across the gap. */
function withGaps(h: History) {
  const xs: number[] = [];
  const rows: (HistoryPoint | null)[] = [];
  let prev: number | null = null;
  for (const p of h.points) {
    if (prev != null && p.ts_ms - prev > h.step_ms * 1.5) {
      xs.push((prev + h.step_ms) / 1000);
      rows.push(null);
    }
    xs.push(p.ts_ms / 1000);
    rows.push(p);
    prev = p.ts_ms;
  }
  return { xs, rows, stepS: h.step_ms / 1000 };
}

/** Identifiers stay monospaced so they copy and compare exactly; prose fields do not. */
const MONO_ROWS = new Set(["主机名", "内核", "ID"]);

/** Axis ticks need to fit 46px: drop the "/s" and decimals the chart legend already carries. */
function shortRate(v: number): string {
  if (v === 0) return "0";
  const units = ["B", "K", "M", "G", "T"];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)}${units[i]}`;
}

/** One cell of the reading strip; utilisation cells carry a hairline meter under the value. */
function Reading({ label, value, sub, level }: { label: string; value: ReactNode; sub?: ReactNode; level?: number | null }) {
  return (
    <div className="min-w-0 bg-card px-5 py-4">
      <div className="text-xs leading-4 text-muted-foreground">{label}</div>
      <div className="hero-num tabular mt-1.5 truncate text-lg leading-7 font-semibold tracking-tight">{value}</div>
      {sub && <div className="tabular text-xs leading-4 text-pretty text-muted-foreground">{sub}</div>}
      {level !== undefined && <MeterBar label={label} value={level} className="mt-2.5 h-1" />}
    </div>
  );
}

/** Previous / next server link; the tooltip names the target and its arrow-key shortcut. */
function StepLink({ to, dir }: { to: ServerStatus; dir: "prev" | "next" }) {
  const label = `${dir === "prev" ? "上一台" : "下一台"}：${to.name}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<a href={href({ page: "server", id: to.id })} aria-label={label} className={buttonVariants({ variant: "outline", size: "icon" })} />}
      >
        {dir === "prev" ? <ChevronLeftIcon /> : <ChevronRightIcon />}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        <Kbd>{dir === "prev" ? "←" : "→"}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** Previous / next server in overview order, so ←/→ walks the board without going back. */
function useNeighbours(id: string, servers: ReadonlyMap<string, ServerStatus>) {
  const order = [...servers.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const i = order.findIndex((s) => s.id === id);
  if (i < 0 || order.length < 2) return { prev: undefined, next: undefined };
  return { prev: order[(i - 1 + order.length) % order.length], next: order[(i + 1) % order.length] };
}

export function ServerDetail({ id, admin }: { id: string; admin: boolean }) {
  const { ready, servers, alerts } = useLive();
  const now = useNow();
  const s = servers.get(id);
  const [range, setRange] = useState<HistoryRange>("24h");
  // Keep the query a result belongs to, so a failed switch never shows another query's data.
  const [loaded, setLoaded] = useState<{ key: string; history: History } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const { prev, next } = useNeighbours(id, servers);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const to = e.key === "ArrowLeft" ? prev : e.key === "ArrowRight" ? next : undefined;
      if (to) navigate({ page: "server", id: to.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next]);

  const queryKey = `${id}\u0000${range}`;
  const history = loaded?.key === queryKey ? loaded.history : null;

  useEffect(() => {
    let alive = true;
    const key = `${id}\u0000${range}`;
    const load = () => {
      setLoading(true);
      api
        .history(id, range)
        .then((h) => {
          if (!alive) return;
          setLoaded({ key, history: h });
          setError("");
        })
        .catch((e) => alive && setError(`${range} 历史加载失败：${errorText(e)}`))
        .finally(() => alive && setLoading(false));
    };
    setError("");
    load();
    // Minute rollups land once a minute; refresh short ranges accordingly.
    const t = range === "1h" || range === "6h" ? window.setInterval(load, 60_000) : undefined;
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [id, range]);

  const charts = useMemo(() => {
    if (!history) return null;
    const { xs, rows, stepS } = withGaps(history);
    const col = (f: (p: HistoryPoint) => number) => rows.map((p) => (p ? f(p) : null));
    const cpu: ChartSeries[] = [
      { label: "平均", color: "--series-1", values: col((p) => p.cpu_avg) },
      { label: "峰值", color: "--series-2", values: col((p) => p.cpu_max) },
    ];
    const mem: ChartSeries[] = [
      { label: "内存", color: "--series-1", values: col((p) => p.mem_pct) },
      { label: "Swap", color: "--series-2", values: col((p) => p.swap_pct) },
    ];
    const net: ChartSeries[] = [
      { label: "下载", color: "--series-1", values: col((p) => p.rx_bytes / stepS) },
      { label: "上传", color: "--series-2", values: col((p) => p.tx_bytes / stepS) },
    ];
    const netPeak: ChartSeries[] = [
      { label: "下载", color: "--series-1", values: col((p) => p.rx_bps_max) },
      { label: "上传", color: "--series-2", values: col((p) => p.tx_bps_max) },
    ];
    const disk: ChartSeries[] = [{ label: "磁盘", color: "--series-1", values: col((p) => p.disk_pct) }];
    const load: ChartSeries[] = [{ label: "Load 1m", color: "--series-1", values: col((p) => p.load1) }];
    const traffic = history.points.reduce((a, p) => ({ rx: a.rx + p.rx_bytes, tx: a.tx + p.tx_bytes }), { rx: 0, tx: 0 });
    const end = Date.now() / 1000;
    const hours = RANGES.find((r) => r.id === history.range)?.hours ?? 24;
    const window: [number, number] = [end - hours * 3600, end];
    return { xs, cpu, mem, net, netPeak, disk, load, traffic, window };
  }, [history]);

  if (!ready) return <PageSpinner />;
  if (!s)
    return (
      <EmptyState title="服务器不存在" icon={<ServerIcon />}>
        <a className="font-medium text-primary underline-offset-4 hover:underline" href="#/">
          返回总览
        </a>
      </EmptyState>
    );

  const m = s.metrics;
  const firing = alerts.filter((a) => a.server_id === id);
  const pctFmt = (v: number) => `${v.toFixed(1)}%`;
  const pctAxis = (v: number) => `${v.toFixed(0)}%`;
  const memPct = m ? pct(m.mem_used, m.mem_total) : null;
  const diskPct = m ? pct(m.disk_used, m.disk_total) : null;

  // Redacted fields arrive empty in the public view; leave them out rather than show blanks.
  const hostRows: [string, string][] = s.host
    ? (
        [
          ["地区", s.country ? `${countryName(s.country)}（${s.country}）` : ""],
          ["主机名", s.host.hostname],
          ["系统", s.host.os],
          ["内核", s.host.kernel],
          ["架构", s.host.arch],
          ["CPU", `${s.host.cpu_model} × ${s.host.cpu_cores}`],
          ["启动时间", dateTime(s.host.boot_time_ms)],
          ["Agent", s.agent_version ?? ""],
          ["ID", s.id],
        ] as [string, string][]
      ).filter(([, v]) => v)
    : [];

  return (
    <div className="space-y-6 sm:space-y-8">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <a href="#/" className={cn(buttonVariants({ variant: "ghost" }), "-ml-2.5 font-normal text-muted-foreground")}>
            <ChevronLeftIcon data-icon="inline-start" />
            总览
          </a>
          <div className="flex items-center gap-1">
            {admin && (
              <a href={href({ page: "settings", tab: "servers" })} className={cn(buttonVariants({ variant: "outline" }), "mr-1")}>
                管理
              </a>
            )}
            {prev && next && (
              <nav aria-label="切换服务器" className="flex items-center gap-1">
                <StepLink to={prev} dir="prev" />
                <StepLink to={next} dir="next" />
              </nav>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-3">
              <h1 className="min-w-0 truncate text-xl leading-7 font-semibold tracking-tight sm:text-2xl sm:leading-8">{s.name}</h1>
              <StatusDot online={s.online} />
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-muted-foreground">
              {s.country && <Flag code={s.country} className="text-[13px]" />}
              <span>
                {[
                  s.country && countryName(s.country),
                  s.host && `${s.host.os} · ${s.host.arch}`,
                  !s.online && (s.last_seen_ms ? `停于 ${clockTime(s.last_seen_ms, now)}（${ago(s.last_seen_ms, now)}）` : "Agent 尚未连接"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {firing.map((a) => (
                <Badge key={a.rule_id} variant="destructive">
                  <TriangleAlertIcon data-icon="inline-start" />
                  {a.rule_name}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border shadow-card md:grid-cols-3 xl:grid-cols-6">
        <Reading label="CPU" value={pctText(m?.cpu_pct)} sub={s.host ? `${s.host.cpu_cores} 核` : undefined} level={m?.cpu_pct ?? null} />
        <Reading
          label="内存"
          value={pctText(memPct)}
          sub={m ? `${bytes(m.mem_used)} / ${bytes(m.mem_total)}` : undefined}
          level={memPct}
        />
        <Reading
          label="磁盘"
          value={pctText(diskPct)}
          sub={m ? `${bytes(m.disk_used)} / ${bytes(m.disk_total)}` : undefined}
          level={diskPct}
        />
        <Reading
          label="网络"
          value={
            <span className="inline-flex items-center gap-1">
              <ArrowDownIcon className="size-4 text-muted-foreground" />
              {rate(m?.net_rx_bps)}
            </span>
          }
          sub={
            <span className="inline-flex items-center gap-1">
              <ArrowUpIcon className="size-3" />
              {rate(m?.net_tx_bps)}
            </span>
          }
        />
        <Reading
          label="本月流量"
          value={bytes(s.traffic_month.rx_bytes + s.traffic_month.tx_bytes)}
          sub={`↓ ${bytes(s.traffic_month.rx_bytes)} · ↑ ${bytes(s.traffic_month.tx_bytes)}`}
        />
        <Reading
          label="负载"
          value={m ? m.load1.toFixed(2) : "–"}
          sub={m ? `运行 ${duration(m.uptime_s)} · ${m.process_count} 进程` : undefined}
        />
      </div>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <h2 className="flex h-7 items-center gap-2 text-base leading-7 font-semibold tracking-tight">
            历史趋势
            {loading && <Spinner className="size-3.5 text-muted-foreground" />}
          </h2>
          <div className="sm:ml-auto">
            <Segmented label="时间范围" value={range} onChange={setRange} options={RANGES} />
          </div>
        </div>
        {charts && (
          <p className="tabular -mt-1 text-xs text-muted-foreground">
            本区间流量 ↓ {bytes(charts.traffic.rx)} · ↑ {bytes(charts.traffic.tx)}
          </p>
        )}
        <ErrorText>{error}</ErrorText>
        {charts && history && history.points.length === 0 && <EmptyState title="该时间范围内暂无数据" icon={<HistoryIcon />} />}
        {charts && history && history.points.length > 0 && (
          <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
            {/* CPU leads at full width; the rest read as its supporting panels. */}
            <div className="lg:col-span-2">
              <Chart title="CPU 使用率" xs={charts.xs} window={charts.window} series={charts.cpu} format={pctFmt} axisFormat={pctAxis} yMax={100} height={240} />
            </div>
            <Chart title="内存使用率" xs={charts.xs} window={charts.window} series={charts.mem} format={pctFmt} axisFormat={pctAxis} yMax={100} />
            <Chart title="网络 · 平均速率" xs={charts.xs} window={charts.window} series={charts.net} format={(v) => rate(v)} axisFormat={shortRate} />
            <Chart title="网络 · 峰值速率" xs={charts.xs} window={charts.window} series={charts.netPeak} format={(v) => rate(v)} axisFormat={shortRate} />
            <Chart title="磁盘使用率" xs={charts.xs} window={charts.window} series={charts.disk} format={pctFmt} axisFormat={pctAxis} yMax={100} />
            <Chart title="负载 · 1 分钟" xs={charts.xs} window={charts.window} series={charts.load} format={(v) => v.toFixed(2)} />
          </div>
        )}
      </section>

      {hostRows.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-base leading-7 font-semibold tracking-tight">主机信息</h2>
          <Card className="py-0">
            <dl className="grid text-sm sm:grid-cols-2">
              {hostRows.map(([k, v], i) => (
                <div key={k} className={cn("flex items-baseline gap-4 border-border px-5 py-3", i > 0 && "border-t", i === 1 && "sm:border-t-0")}>
                  <dt className="w-16 shrink-0 leading-5 text-muted-foreground">{k}</dt>
                  <dd className={cn("min-w-0 leading-5 break-words", MONO_ROWS.has(k) && "font-mono text-[13px]")}>{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </section>
      )}
    </div>
  );
}
