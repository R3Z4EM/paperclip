import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

/**
 * A usage-only Claude login per AI connection.
 *
 * Paperclip connects Claude subscriptions with `claude setup-token`. That token never expires and
 * runs agents, but Anthropic refuses it on /api/oauth/usage, so session and weekly limits never
 * show. A normal `claude auth login` token can read usage but expires within hours. This module
 * keeps such a login for a connection, made once with the official CLI into
 * <instance root>/ai-usage-logins/<connection id>/.credentials.json, and renews it the way the CLI
 * does. Only usage reads use it: agent runs keep the connection's own credential.
 */

// Claude Code's public OAuth client and token endpoint (the CLI's own refresh request).
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type OAuth = { accessToken?: string; refreshToken?: string; expiresAt?: number; scopes?: string[] };

export function claudeUsageLoginDir(connectionId: string): string {
  if (!UUID.test(connectionId)) throw new Error("invalid connection id");
  return path.join(resolvePaperclipInstanceRoot(), "ai-usage-logins", connectionId);
}

// One renewal at a time per connection: the refresh token rotates, so a second concurrent
// renewal would spend a token the first one already replaced.
const renewals = new Map<string, Promise<string | null>>();

/** The connection's usage-only access token, renewed when close to expiry; null when it has none. */
export function claudeUsageToken(connectionId: string, request: typeof fetch = fetch): Promise<string | null> {
  if (!UUID.test(connectionId)) return Promise.resolve(null);
  const running = renewals.get(connectionId);
  if (running) return running;
  const work = readOrRenew(connectionId, request)
    .catch((error: unknown) => {
      // Never log the response body or tokens: only that renewal failed.
      logger.warn({ connectionId, reason: error instanceof Error ? error.message : "unknown" },
        "Claude usage login unavailable; usage falls back to the connection credential");
      return null;
    })
    .finally(() => renewals.delete(connectionId));
  renewals.set(connectionId, work);
  return work;
}

async function readOrRenew(connectionId: string, request: typeof fetch): Promise<string | null> {
  const file = path.join(claudeUsageLoginDir(connectionId), ".credentials.json");
  let stored: { claudeAiOauth?: OAuth } & Record<string, unknown>;
  try {
    stored = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("usage login file unreadable");
  }
  const oauth = stored.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  if (!oauth.refreshToken || typeof oauth.expiresAt !== "number" || oauth.expiresAt - Date.now() > RENEW_BEFORE_MS) {
    return oauth.accessToken;
  }
  const response = await request(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
      ...(oauth.scopes?.length ? { scope: oauth.scopes.join(" ") } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`renewal returned ${response.status}`);
  const body = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!body.access_token || typeof body.expires_in !== "number") throw new Error("renewal response incomplete");
  const renewed: OAuth = {
    ...oauth,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? oauth.refreshToken,
    expiresAt: Date.now() + body.expires_in * 1000,
    ...(body.scope ? { scopes: body.scope.split(" ") } : {}),
  };
  // Written beside the file and renamed over it, so a crash never leaves half a login.
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...stored, claudeAiOauth: renewed }), { mode: 0o600 });
  await rename(temporary, file);
  return renewed.accessToken!;
}
