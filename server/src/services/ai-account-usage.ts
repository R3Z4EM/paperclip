import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { companyMemberships, toolConnections, type Db } from "@paperclipai/db";
import { aiConnectionMetadataSchema, type AiConnectionUsageLimit } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { probeAiConnectionUsage } from "./ai-connection-usage.js";
import { claudeUsageToken } from "./claude-usage-login.js";
import { aiConnectionService } from "./ai-connections.js";
import { issueService } from "./issues.js";

/**
 * Background usage sync for every Claude subscription account (the Dashboard's "AI accounts" card
 * and the Costs page). Every 10 minutes each connection's session (5 hour) and weekly limits are
 * read with its usage-only login (claude-usage-login.ts) and kept, with 30 days of history, in
 * <instance root>/ai-account-usage/<company id>.json. No database tables: the file is the store.
 * Crossing 80% or 95% of a window raises one Inbox notice per threshold per window.
 */

export const AI_ACCOUNT_USAGE_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const THRESHOLDS = [80, 95] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AiAccountUsageWindow = { usedPercent: number | null; resetsAt: string | null };
export type AiAccountUsageSample = { at: string; session: number | null; weekly: number | null };
export type AiAccountUsageAccount = {
  connectionId: string;
  name: string;
  status: "ok" | "needs_sign_in" | "unavailable" | "error";
  message: string | null;
  plan: string | null;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  session: AiAccountUsageWindow | null;
  weekly: AiAccountUsageWindow | null;
  history: AiAccountUsageSample[];
};
type Notified = { resetsAt: string | null; thresholds: number[] };
type Store = {
  accounts: Record<string, AiAccountUsageAccount>;
  // Per connection and window kind: the window last seen and which thresholds already raised a notice.
  notified: Record<string, Partial<Record<"session" | "weekly", Notified>>>;
};

function storeFile(companyId: string) {
  if (!UUID.test(companyId)) throw new Error("invalid company id");
  return path.join(resolvePaperclipInstanceRoot(), "ai-account-usage", `${companyId}.json`);
}

async function readStore(companyId: string): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(storeFile(companyId), "utf8")) as Partial<Store>;
    return { accounts: parsed.accounts ?? {}, notified: parsed.notified ?? {} };
  } catch {
    return { accounts: {}, notified: {} };
  }
}

async function writeStore(companyId: string, store: Store) {
  const file = storeFile(companyId);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(store), { mode: 0o600 });
  await rename(temporary, file);
}

const windowOf = (limits: AiConnectionUsageLimit[], id: string): AiAccountUsageWindow | null => {
  const entry = limits.find((limit) => limit.id === id);
  return entry ? { usedPercent: entry.usedPercent, resetsAt: entry.resetsAt } : null;
};

// The provider's reset time can drift by seconds between reads; a new window starts once it moves
// by more than half an hour.
const sameWindow = (a: string | null, b: string | null) =>
  a === b || (a != null && b != null && Math.abs(Date.parse(a) - Date.parse(b)) < 30 * 60 * 1000);

export type AiAccountUsageNotice = {
  companyId: string;
  connectionId: string;
  accountName: string;
  kind: "session" | "weekly";
  threshold: number;
  usedPercent: number;
  resetsAt: string | null;
};

/** The thresholds this observation newly crosses; records them so a window raises each once. */
function newlyCrossed(store: Store, connectionId: string, kind: "session" | "weekly", window: AiAccountUsageWindow | null): number[] {
  if (window?.usedPercent == null) return [];
  const byKind = (store.notified[connectionId] ??= {});
  let seen = byKind[kind];
  if (!seen || !sameWindow(seen.resetsAt, window.resetsAt)) seen = { resetsAt: window.resetsAt, thresholds: [] };
  const crossed = THRESHOLDS.filter((threshold) => window.usedPercent! >= threshold && !seen!.thresholds.includes(threshold));
  // Only the highest new threshold is worth a notice; the lower one is recorded as passed too.
  seen.thresholds = [...seen.thresholds, ...crossed];
  byKind[kind] = seen;
  return crossed.length ? [Math.max(...crossed)] : [];
}

const syncing = new Map<string, Promise<void>>();

/** Reads every Claude subscription account of the company once and saves the result. */
export function syncCompanyAiAccountUsage(
  db: Db,
  companyId: string,
  notify: (notice: AiAccountUsageNotice) => Promise<void>,
  request: typeof fetch = fetch,
): Promise<void> {
  const running = syncing.get(companyId);
  if (running) return running;
  const work = (async () => {
    const connections = await db.select().from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.connectionPurpose, "ai")));
    const claude = connections.flatMap((connection) => {
      const metadata = aiConnectionMetadataSchema.safeParse(connection.config.ai);
      return metadata.success && metadata.data.provider === "anthropic" && metadata.data.method === "subscription"
        ? [{ connection, metadata: metadata.data }] : [];
    });
    const store = await readStore(companyId);
    const now = new Date();
    const notices: AiAccountUsageNotice[] = [];
    const accounts: Record<string, AiAccountUsageAccount> = {};
    for (const { connection, metadata } of claude) {
      const previous = store.accounts[connection.id];
      const account: AiAccountUsageAccount = {
        connectionId: connection.id, name: connection.name, plan: previous?.plan ?? null,
        status: "ok", message: null, lastSyncedAt: previous?.lastSyncedAt ?? null, lastAttemptAt: now.toISOString(),
        session: previous?.session ?? null, weekly: previous?.weekly ?? null,
        history: (previous?.history ?? []).filter((sample) => now.getTime() - Date.parse(sample.at) <= HISTORY_MS),
      };
      accounts[connection.id] = account;
      if (!connection.enabled || connection.status !== "active") {
        Object.assign(account, { status: "unavailable", message: "This account is turned off or needs reconnecting." });
        continue;
      }
      // Only the usage-only login is used: the connection's own setup token can't read usage.
      const token = await claudeUsageToken(connection.id, request);
      if (!token) {
        Object.assign(account, { status: "needs_sign_in", message: "Sign in for usage: open this Claude connection in Apps and use \"Sign in for usage\" on its Usage panel." });
        continue;
      }
      const usage = await probeAiConnectionUsage(metadata, token, { request });
      if (usage.status !== "ok") {
        Object.assign(account, { status: usage.status === "unavailable" ? "needs_sign_in" : "error", message: usage.message ?? null });
        continue;
      }
      account.session = windowOf(usage.limits, "five_hour");
      account.weekly = windowOf(usage.limits, "seven_day");
      account.plan = usage.planType ?? account.plan;
      account.lastSyncedAt = usage.checkedAt;
      account.history.push({ at: usage.checkedAt, session: account.session?.usedPercent ?? null, weekly: account.weekly?.usedPercent ?? null });
      for (const kind of ["session", "weekly"] as const) {
        const window = account[kind];
        for (const threshold of newlyCrossed(store, connection.id, kind, window)) {
          notices.push({ companyId, connectionId: connection.id, accountName: connection.name, kind, threshold,
            usedPercent: window!.usedPercent!, resetsAt: window!.resetsAt });
        }
      }
    }
    store.accounts = accounts;
    for (const connectionId of Object.keys(store.notified)) if (!accounts[connectionId]) delete store.notified[connectionId];
    // Save before notifying: a failed notice is not retried, so a window never repeats one.
    await writeStore(companyId, store);
    for (const notice of notices) {
      await notify(notice).catch((error: unknown) => {
        logger.warn({ companyId, connectionId: notice.connectionId, reason: error instanceof Error ? error.message : "unknown" },
          "AI account usage notice failed");
      });
    }
  })().finally(() => syncing.delete(companyId));
  syncing.set(companyId, work);
  return work;
}

/** The Inbox notice: a task assigned to each owner of the company (no agent is woken). */
export function aiAccountUsageInboxNotice(db: Db) {
  return async (notice: AiAccountUsageNotice) => {
    const owners = await db.select({ userId: companyMemberships.principalId }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, notice.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"), eq(companyMemberships.membershipRole, "owner"),
    ));
    const limit = notice.kind === "session" ? "session (5 hour) limit" : "weekly limit";
    const resets = notice.resetsAt
      ? new Date(notice.resetsAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC"
      : "an unknown time";
    // The window's reset hour keeps a retry from creating a second notice for the same window.
    const window = notice.resetsAt ? new Date(Math.round(Date.parse(notice.resetsAt) / 3_600_000) * 3_600_000).toISOString() : "unknown";
    for (const { userId } of owners) {
      await issueService(db).create(notice.companyId, {
        title: `Claude account "${notice.accountName}" passed ${notice.threshold}% of its ${limit}`,
        description: [
          `The Claude account **${notice.accountName}** has used ${Math.round(notice.usedPercent)}% of its ${limit}.`,
          `It resets at ${resets}.`,
          notice.threshold >= 95 ? "Agents on this account may stop soon. Consider moving work to another account until it resets." : "",
          "Live numbers: Dashboard, \"AI accounts\" card, or the Costs page. Close this task when you've seen it.",
        ].filter(Boolean).join("\n\n"),
        status: "todo",
        priority: notice.threshold >= 95 ? "high" : "medium",
        assigneeUserId: userId,
        idempotencyKey: `ai-account-usage:${notice.connectionId}:${notice.kind}:${notice.threshold}:${window}:${userId}`,
      });
    }
  };
}

/** One background pass over every company with a Claude subscription account. */
export async function syncAllAiAccountUsage(db: Db, notify: (notice: AiAccountUsageNotice) => Promise<void>): Promise<void> {
  const companies = await db.selectDistinct({ companyId: toolConnections.companyId }).from(toolConnections)
    .where(eq(toolConnections.connectionPurpose, "ai"));
  for (const { companyId } of companies) {
    await syncCompanyAiAccountUsage(db, companyId, notify).catch((error: unknown) => {
      logger.warn({ companyId, reason: error instanceof Error ? error.message : "unknown" }, "AI account usage sync failed");
    });
  }
}

/** The saved usage of the Claude subscription accounts this user may use. */
export async function listAiAccountUsage(db: Db, companyId: string, userId: string): Promise<AiAccountUsageAccount[]> {
  const visible = (await aiConnectionService(db).list(companyId, userId))
    .filter((summary) => summary.provider === "anthropic" && summary.method === "subscription");
  const store = await readStore(companyId);
  const ids = [...new Set(visible.map((summary) => summary.id))];
  return ids.map((id) => store.accounts[id] ?? {
    connectionId: id, name: visible.find((summary) => summary.id === id)!.name, status: "ok" as const,
    message: "Not synced yet. Usage is read every 10 minutes.", plan: null, lastSyncedAt: null, lastAttemptAt: null,
    session: null, weekly: null, history: [],
  });
}
