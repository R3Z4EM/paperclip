import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * Each board user's Dashboard layout (which cards show, and in what order), set with the
 * Dashboard's Customize button. Kept in <instance root>/dashboard-layouts/<company id>.json as
 * { [userId]: { order, hidden } }. No database tables: the file is the store. Card ids are
 * owned by the UI; unknown ids are kept so a newer card list never loses someone's choices.
 */

export type DashboardLayout = { order: string[]; hidden: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CARD_ID = /^[a-z0-9-]{1,64}$/;
const MAX_CARDS = 50;

function storeFile(companyId: string) {
  if (!UUID.test(companyId)) throw new Error("invalid company id");
  return path.join(resolvePaperclipInstanceRoot(), "dashboard-layouts", `${companyId}.json`);
}

async function readStore(companyId: string): Promise<Record<string, DashboardLayout>> {
  try {
    const parsed = JSON.parse(await readFile(storeFile(companyId), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStore(companyId: string, store: Record<string, DashboardLayout>) {
  const file = storeFile(companyId);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(store), { mode: 0o600 });
  await rename(temporary, file);
}

function cardIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_CARDS) return null;
  if (!value.every((id) => typeof id === "string" && CARD_ID.test(id))) return null;
  return [...new Set(value as string[])];
}

/** Checks a PUT body; null when it is not { order: string[], hidden: string[] } of card ids. */
export function parseDashboardLayout(body: unknown): DashboardLayout | null {
  if (!body || typeof body !== "object") return null;
  const order = cardIds((body as Record<string, unknown>).order);
  const hidden = cardIds((body as Record<string, unknown>).hidden);
  return order && hidden ? { order, hidden } : null;
}

/** The saved layout, or null when this person has never customized the Dashboard. */
export async function getDashboardLayout(companyId: string, userId: string): Promise<DashboardLayout | null> {
  const store = await readStore(companyId);
  return Object.prototype.hasOwnProperty.call(store, userId) ? parseDashboardLayout(store[userId]) : null;
}

// Writes are chained per company so two people saving at once never overwrite each other.
const pending = new Map<string, Promise<unknown>>();

export function saveDashboardLayout(companyId: string, userId: string, layout: DashboardLayout | null) {
  const run = (pending.get(companyId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const store = await readStore(companyId);
    if (layout) store[userId] = layout;
    else delete store[userId];
    await writeStore(companyId, store);
    return layout;
  });
  pending.set(companyId, run);
  return run;
}
