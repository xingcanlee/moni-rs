import { LayoutGridIcon, LogOutIcon, PaletteIcon, SlidersHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import { lazy, type ReactElement, type ReactNode, Suspense, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLive } from "@/lib/live";
import { href, type Route } from "@/lib/router";
import { cn } from "@/lib/utils";
import { GitHubMark, Logo } from "@/components/brand";

const ThemePicker = lazy(() => import("@/components/ThemePicker").then((m) => ({ default: m.ThemePicker })));

/** Tooltips replace `title`, which phones never show and screen readers announce twice. */
function Tip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ConnIndicator() {
  const { conn } = useLive();
  const open = conn === "open";
  return (
    <Tip label={open ? "实时连接正常" : "实时连接断开，正在重连"}>
      <span className="inline-flex h-8 items-center gap-1.5 px-2 text-xs leading-none text-muted-foreground">
        <span aria-hidden className={cn("size-1.5 rounded-full", open ? "bg-good" : "animate-pulse bg-warn")} />
        {open ? "实时" : "重连中"}
      </span>
    </Tip>
  );
}

const REPO = "https://github.com/xingcanlee/moni-rs";
const AUTHOR = { name: "xingcanlee", url: "https://github.com/xingcanlee" };
const SINCE = 2026;

function Footer({ tabBar }: { tabBar: boolean }) {
  const year = new Date().getFullYear();
  const link = "underline-offset-4 transition-colors hover:text-foreground hover:underline";
  return (
    // The phone tab bar is fixed; pad the footer so the last line clears it.
    <footer className={cn(tabBar && "pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:pb-0")}>
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <div className="flex items-center justify-between gap-4 border-t pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-xs leading-5 text-muted-foreground sm:py-6">
          <p className="tabular truncate">
            © {year > SINCE ? `${SINCE}–${year}` : SINCE}{" "}
            <a className={link} href={AUTHOR.url} target="_blank" rel="noreferrer">
              {AUTHOR.name}
            </a>
          </p>
          <a className={cn(link, "inline-flex shrink-0 items-center gap-1.5")} href={REPO} target="_blank" rel="noreferrer">
            <GitHubMark size={14} />
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}

export function Layout({
  route,
  admin,
  onLogout,
  children,
}: {
  route: Route;
  admin: boolean;
  onLogout: () => void;
  children: ReactNode;
}) {
  const { alerts } = useLive();
  const [picker, setPicker] = useState(false);
  // Mounted on first open only, so its chunk stays off the landing page.
  const [pickerUsed, setPickerUsed] = useState(false);
  const nav = [
    { label: "总览", icon: <LayoutGridIcon />, to: href({ page: "overview" }), active: route.page === "overview" || route.page === "server" },
    ...(admin
      ? [{ label: "管理", icon: <SlidersHorizontalIcon />, to: href({ page: "settings", tab: "servers" }), active: route.page === "settings" }]
      : []),
  ];
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="site-header sticky top-0 z-30 border-b bg-background/90 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <a href="#/" className="flex h-8 items-center gap-2 font-semibold tracking-tight">
            <Logo className="size-6" />
            <span className="text-[15px] leading-none">moni</span>
          </a>
          {nav.length > 1 && (
            <nav className="ml-6 hidden gap-1 sm:flex">
              {nav.map((n) => (
                <a
                  key={n.label}
                  href={n.to}
                  aria-current={n.active ? "page" : undefined}
                  className={cn(buttonVariants({ variant: "ghost" }), n.active ? "text-foreground" : "font-normal text-muted-foreground")}
                >
                  {n.label}
                </a>
              ))}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-1">
            {admin && alerts.length > 0 && (
              <a
                href={href({ page: "settings", tab: "events" })}
                className="tabular inline-flex h-8 items-center gap-1.5 rounded-pill bg-crit-soft px-3 text-xs leading-none font-medium text-crit"
              >
                <TriangleAlertIcon className="size-3.5" />
                {alerts.length}
                <span className="hidden sm:inline"> 个告警</span>
              </a>
            )}
            <ConnIndicator />
            <Tip label="外观">
              <Button size="icon" variant="ghost" aria-label="外观" onClick={() => (setPickerUsed(true), setPicker(true))}>
                <PaletteIcon />
              </Button>
            </Tip>
            {admin ? (
              <Tip label="退出">
                <Button size="icon" variant="ghost" aria-label="退出" onClick={onLogout}>
                  <LogOutIcon />
                </Button>
              </Tip>
            ) : (
              <a href={href({ page: "login" })} className={cn(buttonVariants(), "ml-1 rounded-pill px-4")}>
                登录
              </a>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6 sm:py-8">{children}</main>
      <Footer tabBar={nav.length > 1} />
      {pickerUsed && (
        <Suspense>
          <ThemePicker open={picker} onOpenChange={setPicker} />
        </Suspense>
      )}
      {nav.length > 1 && (
        // Thumb-reachable tab bar on phones; the header nav takes over from sm up.
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden">
          <div className="mx-auto grid h-14 max-w-md grid-cols-2">
            {nav.map((n) => (
              <a
                key={n.label}
                href={n.to}
                aria-current={n.active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 text-[11px] leading-none font-medium [&_svg]:size-4",
                  n.active ? "text-primary" : "text-muted-foreground",
                )}
              >
                {n.icon}
                {n.label}
              </a>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
