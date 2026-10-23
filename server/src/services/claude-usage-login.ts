import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { PYTHON_PTY_BRIDGE } from "./local-ai-browser-login.js";

/**
 * A usage-only Claude login per AI connection.
 *
 * Paperclip connects Claude subscriptions with `claude setup-token`. That token never expires and
 * runs agents, but Anthropic refuses it on /api/oauth/usage, so session and weekly limits never show.
 * A normal `claude auth login` token can read usage but expires within hours. This module keeps such
 * a login for a connection, made from the connector's Usage panel ("Sign in for usage") with the
 * official CLI into <instance root>/ai-usage-logins/<connection id>/.credentials.json, and renews it
 * the way the CLI does. Only usage reads use it: agent runs keep the connection's own credential.
 */

// Claude Code's public OAuth client and token endpoint (the CLI's own refresh request).
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type OAuth = { accessToken?: string; refreshToken?: string; expiresAt?: number; scopes?: string[]; subscriptionType?: string };

export function claudeUsageLoginDir(connectionId: string): string {
  if (!UUID.test(connectionId)) throw new Error("invalid connection id");
  return path.join(resolvePaperclipInstanceRoot(), "ai-usage-logins", connectionId);
}

async function readOAuth(directory: string): Promise<{ stored: { claudeAiOauth?: OAuth } & Record<string, unknown>; oauth: OAuth } | null> {
  let stored: { claudeAiOauth?: OAuth } & Record<string, unknown>;
  try {
    stored = JSON.parse(await readFile(path.join(directory, ".credentials.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw new Error("usage login file unreadable");
  }
  return stored.claudeAiOauth ? { stored, oauth: stored.claudeAiOauth } : null;
}

/** Usable for usage reads: renewable, and allowed to read the account's profile and limits. */
const canReadUsage = (oauth: OAuth) =>
  Boolean(oauth.accessToken && oauth.refreshToken && oauth.scopes?.includes("user:profile"));

export async function claudeUsageLoginStatus(connectionId: string): Promise<{ connected: boolean; plan: string | null }> {
  const login = await readOAuth(claudeUsageLoginDir(connectionId));
  return { connected: Boolean(login && canReadUsage(login.oauth)), plan: login?.oauth.subscriptionType ?? null };
}

export async function removeClaudeUsageLogin(connectionId: string): Promise<void> {
  stopSignIn(connectionId);
  await rm(claudeUsageLoginDir(connectionId), { recursive: true, force: true });
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
  const directory = claudeUsageLoginDir(connectionId);
  const login = await readOAuth(directory);
  const accessToken = login?.oauth.accessToken;
  if (!login || !accessToken) return null;
  const { stored, oauth } = login;
  if (!oauth.refreshToken || typeof oauth.expiresAt !== "number" || oauth.expiresAt - Date.now() > RENEW_BEFORE_MS) {
    return accessToken;
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
  const file = path.join(directory, ".credentials.json");
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...stored, claudeAiOauth: renewed }), { mode: 0o600 });
  await rename(temporary, file);
  return renewed.accessToken!;
}

// ---------------------------------------------------------------------------------------------
// Sign-in: `claude auth login --claudeai` in a terminal (the PTY bridge the setup-token sign-in uses)
// prints an authorization link and waits for the code claude.ai shows after approval. The person
// opens the link from the Usage panel and pastes the code there. The new login is written to a
// separate folder and replaces the old one only once it is verified.
// ---------------------------------------------------------------------------------------------

const SIGN_IN_MS = 10 * 60 * 1000;
const AUTHORIZE_URL = /https:\/\/[^\s\x07\x1b"'<>]+\/oauth\/authorize\?[^\s\x07\x1b"'<>]+/;
const CODE = /^[\x21-\x7e]{8,1024}$/;

type SignIn = {
  id: string;
  userId: string;
  child: ChildProcessWithoutNullStreams;
  directory: string;
  output: string;
  url?: string;
  exited: boolean;
  timer: NodeJS.Timeout;
};
const signIns = new Map<string, SignIn>(); // by connection id: one sign-in at a time per connection

function stopSignIn(connectionId: string) {
  const signIn = signIns.get(connectionId);
  if (!signIn) return;
  signIns.delete(connectionId);
  clearTimeout(signIn.timer);
  if (!signIn.exited) signIn.child.kill("SIGTERM");
  void rm(signIn.directory, { recursive: true, force: true });
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Start a usage sign-in for the connection; returns the claude.ai link the person opens. */
export async function startClaudeUsageLogin(connectionId: string, userId: string): Promise<{ sessionId: string; authorizationUrl: string }> {
  stopSignIn(connectionId);
  const directory = `${claudeUsageLoginDir(connectionId)}.new`;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_CONFIG_DIR: directory,
    BROWSER: "true",
  };
  const child = spawn("python3", ["-u", "-c", PYTHON_PTY_BRIDGE, "claude", "auth", "login", "--claudeai"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const signIn: SignIn = {
    id: randomUUID(), userId, child, directory, output: "", exited: false,
    timer: setTimeout(() => stopSignIn(connectionId), SIGN_IN_MS),
  };
  signIns.set(connectionId, signIn);
  // The CLI's output holds the link; it is kept in memory only, never logged.
  child.stdout.on("data", (bytes: Buffer) => {
    signIn.output = (signIn.output + bytes.toString("utf8")).slice(-20_000);
    signIn.url ??= AUTHORIZE_URL.exec(signIn.output)?.[0];
  });
  child.stderr.resume();
  child.once("error", () => { signIn.exited = true; });
  child.once("close", () => { signIn.exited = true; });
  const url = await waitFor(() => signIn.url ?? (signIn.exited ? "" : undefined), 30_000);
  if (!url) {
    stopSignIn(connectionId);
    throw new Error("Claude's sign-in didn't start. Try again.");
  }
  return { sessionId: signIn.id, authorizationUrl: url };
}

/** Finish the sign-in with the code claude.ai showed; keeps the login only if it can read usage. */
export async function completeClaudeUsageLogin(connectionId: string, sessionId: string, userId: string, code: string): Promise<{ plan: string | null }> {
  const signIn = signIns.get(connectionId);
  if (!signIn || signIn.id !== sessionId || signIn.userId !== userId || signIn.exited) {
    throw new Error("This sign-in has ended. Start it again.");
  }
  const trimmed = code.trim();
  if (!CODE.test(trimmed)) throw new Error("That doesn't look like the code claude.ai showed. Copy it again.");
  signIn.child.stdin.write(`${trimmed}\r`);
  const login = await waitFor(async () => {
    const found = await readOAuth(signIn.directory).catch(() => null);
    if (found?.oauth.accessToken && found.oauth.refreshToken) return found;
    return signIn.exited ? null : undefined;
  }, 60_000);
  try {
    if (!login) throw new Error("Claude didn't accept that code. Start the sign-in again.");
    if (!canReadUsage(login.oauth)) throw new Error("That sign-in can't read usage. Start the sign-in again.");
    // Let the CLI finish writing, then take its folder.
    await waitFor(() => (signIn.exited ? true : undefined), 3_000);
    if (!signIn.exited) signIn.child.kill("SIGTERM");
    const directory = claudeUsageLoginDir(connectionId);
    await rm(directory, { recursive: true, force: true });
    await rename(signIn.directory, directory);
    return { plan: login.oauth.subscriptionType ?? null };
  } finally {
    stopSignIn(connectionId);
  }
}
