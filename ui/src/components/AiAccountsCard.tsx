import { useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { Link } from "@/lib/router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { costsApi, type AiAccountUsage, type AiAccountUsageWindow } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

/**
 * Claude subscription usage, synced by the server every 10 minutes (server/src/services/ai-account-usage.ts).
 * The Dashboard shows the compact card; the Costs page adds a 7 and 30 day chart per account.
 */

// Status colors, as elsewhere on the Dashboard: green under 80%, amber from 80%, red from 95%.
function levelClass(percent: number) {
  return percent >= 95 ? "bg-destructive" : percent >= 80 ? "bg-amber-500" : "bg-emerald-500";
}

// Two series on one 0-100% axis; validated for color vision deficiency (dataviz validator).
const SERIES = {
  session: { label: "Session", color: "#0284c7" },
  weekly: { label: "Weekly", color: "#9333ea" },
} as const;

function formatReset(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay ? { timeStyle: "short" } : { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function UsageBar({ label, window }: { label: string; window: AiAccountUsageWindow | null }) {
  const percent = window?.usedPercent;
  const reset = formatReset(window?.resetsAt ?? null);
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{percent == null ? "—" : `${Math.round(percent)}%`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label={`${label} limit used`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent == null ? undefined : Math.round(percent)}>
        {percent != null ? (
          <div className={cn("h-full rounded-full", levelClass(percent))} style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} />
        ) : null}
      </div>
      <div className="text-(length:--text-nano) text-muted-foreground">{reset ? `Resets ${reset}` : " "}</div>
    </div>
  );
}

function AccountRow({ account }: { account: AiAccountUsage }) {
  const synced = account.lastSyncedAt ? `Synced ${timeAgo(account.lastSyncedAt)}` : "Not synced yet";
  return (
    <div className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium">{account.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground" title={account.lastAttemptAt ? `Last tried ${new Date(account.lastAttemptAt).toLocaleString()}` : undefined}>
          {synced}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <UsageBar label="Session (5 h)" window={account.session} />
        <UsageBar label="Weekly" window={account.weekly} />
      </div>
      {account.status !== "ok" || (!account.lastSyncedAt && account.message) ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {account.message}{" "}
          {account.status === "needs_sign_in" ? <Link to="/apps" className="underline underline-offset-2">Open Apps</Link> : null}
        </p>
      ) : null}
    </div>
  );
}

function useAiAccounts(companyId: string) {
  return useQuery({
    queryKey: queryKeys.aiAccountUsage(companyId),
    queryFn: () => costsApi.aiAccounts(companyId),
    // The server syncs every 10 minutes; re-read its saved numbers every minute.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** Dashboard: one row per Claude account. */
export function AiAccountsCard({ companyId }: { companyId: string }) {
  const { data, error } = useAiAccounts(companyId);
  if (!data?.length && !error) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><Gauge className="h-4 w-4 text-muted-foreground" />AI accounts</CardTitle>
        <CardDescription>
          Claude usage limits, synced every 10 minutes. <Link to="/costs" className="underline underline-offset-2">History on Costs</Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        {error ? <p className="text-sm text-destructive">Could not load account usage.</p> : null}
        {data?.map((account) => <AccountRow key={account.connectionId} account={account} />)}
      </CardContent>
    </Card>
  );
}

const CHART_W = 600;
const CHART_H = 140;

function UsageChart({ account, days }: { account: AiAccountUsage; days: 7 | 30 }) {
  const [hover, setHover] = useState<number | null>(null);
  const end = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;
  const samples = account.history.filter((sample) => Date.parse(sample.at) >= start);
  const x = (at: string) => ((Date.parse(at) - start) / (end - start)) * CHART_W;
  const y = (percent: number) => CHART_H - (Math.min(100, Math.max(0, percent)) / 100) * CHART_H;
  // Gaps over 30 minutes (missed syncs) break the line instead of drawing across them.
  const path = (key: "session" | "weekly") => {
    let d = "";
    let previous: number | null = null;
    for (const sample of samples) {
      const value = sample[key];
      const t = Date.parse(sample.at);
      if (value == null) { previous = null; continue; }
      d += `${previous == null || t - previous > 30 * 60 * 1000 ? "M" : "L"}${x(sample.at).toFixed(1)},${y(value).toFixed(1)}`;
      previous = t;
    }
    return d;
  };
  if (!samples.length) {
    return <p className="py-6 text-center text-xs text-muted-foreground">No history yet. It builds up as usage syncs every 10 minutes.</p>;
  }
  const hovered = hover == null ? null : samples[hover];
  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = start + ((event.clientX - box.left) / box.width) * (end - start);
    let best = 0;
    samples.forEach((sample, index) => {
      if (Math.abs(Date.parse(sample.at) - at) < Math.abs(Date.parse(samples[best].at) - at)) best = index;
    });
    setHover(best);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-3">
          {(["session", "weekly"] as const).map((key) => (
            <span key={key} className="flex items-center gap-1 text-muted-foreground">
              <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: SERIES[key].color }} />
              {SERIES[key].label}
            </span>
          ))}
        </div>
        <span className="tabular-nums text-muted-foreground">
          {hovered
            ? `${new Date(hovered.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · Session ${hovered.session == null ? "—" : `${Math.round(hovered.session)}%`} · Weekly ${hovered.weekly == null ? "—" : `${Math.round(hovered.weekly)}%`}`
            : "Hover for values"}
        </span>
      </div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="h-36 w-full overflow-visible"
        role="img" aria-label={`${account.name}: session and weekly limit used, last ${days} days`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {[0, 50, 80, 95, 100].map((line) => (
          <line key={line} x1={0} x2={CHART_W} y1={y(line)} y2={y(line)} stroke="currentColor"
            className={line === 80 || line === 95 ? "text-amber-500/40" : "text-border"} strokeDasharray={line === 80 || line === 95 ? "4 4" : undefined}
            vectorEffect="non-scaling-stroke" strokeWidth={1} />
        ))}
        {(["session", "weekly"] as const).map((key) => (
          <path key={key} d={path(key)} fill="none" stroke={SERIES[key].color} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
        {hovered ? (
          <line x1={x(hovered.at)} x2={x(hovered.at)} y1={0} y2={CHART_H} stroke="currentColor" className="text-muted-foreground/60"
            vectorEffect="non-scaling-stroke" strokeWidth={1} />
        ) : null}
      </svg>
      <div className="flex justify-between text-(length:--text-nano) text-muted-foreground tabular-nums">
        <span>{new Date(start).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}</span>
        <span>0–100% of limit · dashed lines at 80% and 95%</span>
        <span>Now</span>
      </div>
    </div>
  );
}

/** Costs page: the same numbers plus a 7 or 30 day chart per account. */
export function AiAccountsUsageSection({ companyId }: { companyId: string }) {
  const { data, error, isLoading } = useAiAccounts(companyId);
  const [days, setDays] = useState<7 | 30>(7);
  if (isLoading) return null;
  if (!data?.length && !error) return null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base"><Gauge className="h-4 w-4 text-muted-foreground" />AI accounts</CardTitle>
          <CardDescription>Claude session and weekly limits per account, synced every 10 minutes. History is kept for 30 days.</CardDescription>
        </div>
        <div className="flex shrink-0 rounded-md border border-border p-0.5 text-xs">
          {([7, 30] as const).map((value) => (
            <button key={value} type="button" onClick={() => setDays(value)} aria-pressed={days === value}
              className={cn("rounded px-2 py-1", days === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {value} days
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? <p className="text-sm text-destructive">Could not load account usage.</p> : null}
        {data?.map((account) => (
          <div key={account.connectionId} className="space-y-3">
            <AccountRow account={account} />
            <UsageChart account={account} days={days} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
