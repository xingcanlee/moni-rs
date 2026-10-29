import { type ReactNode, useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import { Card } from "@/components/ui/card";
import { useTheme } from "@/lib/theme";

export type ChartSeries = {
  label: string;
  /** CSS custom property holding the colour, e.g. "--series-1". */
  color: "--series-1" | "--series-2";
  values: (number | null)[];
};

type Props = {
  title: string;
  icon?: ReactNode;
  /** Unix seconds, ascending. */
  xs: number[];
  series: ChartSeries[];
  format: (v: number) => string;
  /** Shorter tick labels for the y axis; defaults to `format`. */
  axisFormat?: (v: number) => string;
  /** Fixed y max (e.g. 100 for percentages). */
  yMax?: number;
  /** Visible time window in Unix seconds, so sparse data sits where it happened. */
  window?: [number, number];
  height?: number;
};

type Hover = { left: number; top: number; idx: number; width: number };

const pad = (n: number) => String(n).padStart(2, "0");

/** Axis tick label: clock time for short spans, month-day for multi-day spans. */
function timeLabel(sec: number, spanSec: number): string {
  const d = new Date(sec * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  if (spanSec <= 2 * 86400) return d.getHours() === 0 && d.getMinutes() === 0 ? md : hm;
  return md;
}

const tooltipTime = (sec: number) => {
  const d = new Date(sec * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * `color` at `alpha`. The canvas normalises any opaque CSS colour to `#rrggbb`, so this holds
 * even when the CSS minifier has shortened a theme's `#33ff66` to `#3f6`.
 */
function withAlpha(ctx: CanvasRenderingContext2D, color: string, alpha: number): string {
  ctx.fillStyle = color;
  const hex = String(ctx.fillStyle);
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex + Math.round(alpha * 255).toString(16).padStart(2, "0") : hex;
}

/** Same hue as the line, fading to nothing: the area reads as a wash under the curve, never a block. */
function areaFill(color: string, strength: number): uPlot.Series.Fill {
  return (u) => {
    const { top, height } = u.bbox;
    const g = u.ctx.createLinearGradient(0, top, 0, top + height);
    g.addColorStop(0, withAlpha(u.ctx, color, strength));
    g.addColorStop(1, withAlpha(u.ctx, color, 0));
    return g;
  };
}

/** Time-series panel: one y-axis, ≤2 smoothed series, synced crosshair and a value tooltip. */
export function Chart({ title, icon, xs, series, format, axisFormat, yMax, window: win, height = 180 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const { theme, dark } = useTheme();
  const [hover, setHover] = useState<Hover | null>(null);
  // uPlot callbacks are created once per build; read live data through refs.
  const data = useRef({ xs, series, win });
  data.current = { xs, series, win };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const axis = cssVar("--chart-axis");
    const grid = cssVar("--chart-grid");
    const surface = cssVar("--surface");
    const font = `11px ${getComputedStyle(document.body).fontFamily}`;
    const spline = uPlot.paths.spline?.();
    const tick = axisFormat ?? format;
    const opts: uPlot.Options = {
      width: el.clientWidth || 300,
      height,
      padding: [10, 6, 0, 0],
      legend: { show: false },
      cursor: {
        sync: { key: "moni-history" },
        points: { size: 9, width: 2, fill: surface },
        drag: { x: false, y: false },
        y: false,
      },
      scales: {
        x: {
          time: true,
          range: (_u, min, max) => data.current.win ?? (min === max ? [min - 60, max + 60] : [min, max]),
        },
        y: { range: (_u, min, max) => [Math.min(0, min), yMax ?? (max > 0 ? max * 1.15 : 1)] },
      },
      axes: [
        {
          stroke: axis,
          grid: { show: false },
          ticks: { show: false },
          font,
          gap: 6,
          // uPlot's default 50px band leaves a blank strip under the labels.
          size: 24,
          space: 64,
          values: (u, splits) => {
            const span = (u.scales.x?.max ?? 0) - (u.scales.x?.min ?? 0);
            return splits.map((v) => timeLabel(v, span));
          },
        },
        {
          stroke: axis,
          grid: { stroke: grid, width: 1, dash: [3, 4] },
          ticks: { show: false },
          font,
          gap: 4,
          size: 46,
          space: 36,
          splits: yMax ? () => [0, yMax / 2, yMax] : undefined,
          values: (_u, splits) => splits.map((v) => tick(v)),
        },
      ],
      series: [
        {},
        ...series.map((s, i) => {
          const color = cssVar(s.color);
          return {
            label: s.label,
            stroke: color,
            width: 1.75,
            paths: spline,
            fill: i === 0 ? areaFill(color, dark ? 0.2 : 0.12) : undefined,
            // A line needs two neighbours; isolated samples would otherwise be invisible.
            points: { show: (u: uPlot) => u.data[0].length < 6, size: 5, fill: color },
            spanGaps: false,
          } satisfies uPlot.Series;
        }),
      ],
      hooks: {
        setCursor: [
          (u) => {
            const { idx, left, top } = u.cursor;
            setHover(idx == null || left == null || left < 0 ? null : { idx, left, top: top ?? 0, width: u.over.clientWidth });
          },
        ],
      },
    };
    const u = new uPlot(opts, [data.current.xs, ...data.current.series.map((s) => s.values)] as uPlot.AlignedData, el);
    plot.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
    // Rebuild when the shape or theme changes; data-only updates go through setData below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, dark, series.length, height, yMax, title]);

  useEffect(() => {
    plot.current?.setData([xs, ...series.map((s) => s.values)] as uPlot.AlignedData);
  }, [xs, series]);

  const last = (vals: (number | null)[]) => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return vals[i];
    return null;
  };
  const tipX = hover ? xs[hover.idx] : undefined;
  const flip = hover != null && hover.left > hover.width / 2;
  const overLeft = plot.current ? plot.current.over.offsetLeft : 0;

  return (
    <Card className="gap-0 p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <h3 className="flex h-5 items-center gap-2 text-sm leading-5 font-semibold whitespace-nowrap">
          {icon && <span className="text-muted-foreground">{icon}</span>}
          {title}
        </h3>
        <div className="flex flex-wrap justify-end gap-x-4 gap-y-1">
          {series.map((s) => (
            <span key={s.label} className="inline-flex h-5 items-center gap-1.5 text-xs leading-none text-muted-foreground">
              <span aria-hidden className="h-0.5 w-3" style={{ background: `var(${s.color})` }} />
              {s.label}
              <span className="tabular font-medium text-foreground">{(() => {
                const v = last(s.values);
                return v == null ? "–" : format(v);
              })()}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="relative">
        <div ref={box} className="w-full" />
        {hover && tipX != null && (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-1 z-10 min-w-32 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-[0_8px_24px_-8px_rgb(0_0_0/0.25)]"
            style={
              flip
                ? { right: `calc(100% - ${overLeft + hover.left - 12}px)` }
                : { left: overLeft + hover.left + 12 }
            }
          >
            <div className="tabular mb-1 text-muted-foreground">{tooltipTime(tipX)}</div>
            {series.map((s) => {
              const v = s.values[hover.idx];
              return (
                <div key={s.label} className="flex items-center justify-between gap-4">
                  <span className="inline-flex items-center gap-1.5 text-ink-2">
                    <span aria-hidden className="h-0.5 w-2.5" style={{ background: `var(${s.color})` }} />
                    {s.label}
                  </span>
                  <span className="tabular font-medium text-foreground">{v == null ? "–" : format(v)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
