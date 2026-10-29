/**
 * Credential resolution and OAuth token handling (decisions 4, 17, 18).
 *
 * Resolution chain, first match wins, source reported by NAME and never by
 * value:
 *   1. GDRIVE_PUBLISH_CLIENT_ID + GDRIVE_PUBLISH_CLIENT_SECRET
 *   2. GDRIVE_PUBLISH_CLIENT_SECRET_FILE
 *   3. ~/.config/gdrive-publish/client_secret.json
 *   4. rclone drive remote (GDRIVE_PUBLISH_RCLONE_REMOTE, or the only one)
 *
 * Tokens are cached per client identity as token-<sha256(client_id)[0:8]>.json
 * with 0600, so switching sources costs one consent instead of an opaque
 * invalid_client failure.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const SCOPE = "https://www.googleapis.com/auth/drive.file";
/**
 * Config directory, resolved per call rather than cached at module load.
 *
 * A module-level constant would freeze `$HOME` at first import, which makes
 * the credential/token logic untestable and wrong if HOME changes at runtime.
 */
export function configDir(): string {
  return path.join(os.homedir(), ".config", "gdrive-publish");
}

export interface Credentials {
  /** Human-readable source, e.g. `rclone remote "gdriveDD"`. Safe to print. */
  source: string;
  clientId: string;
  clientSecret: string;
}

export interface StoredToken {
  clientHash: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

export class AuthError extends Error {}

export function clientHash(clientId: string): string {
  return crypto.createHash("sha256").update(clientId).digest("hex").slice(0, 8);
}

export function tokenPath(clientId: string): string {
  return path.join(configDir(), `token-${clientHash(clientId)}.json`);
}

function fromSecretFile(p: string): Credentials | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const holder = raw as Record<string, unknown>;
    const inst = (holder.installed ?? holder.web) as Record<string, unknown> | undefined;
    if (
      inst &&
      typeof inst.client_id === "string" &&
      typeof inst.client_secret === "string" &&
      inst.client_id !== "" &&
      inst.client_secret !== ""
    ) {
      return { source: `file ${p}`, clientId: inst.client_id, clientSecret: inst.client_secret };
    }
  } catch {
    return null;
  }
  return null;
}

function fromRclone(wanted?: string): Credentials {
  let dump: Record<string, Record<string, unknown>>;
  try {
    const out = execFileSync("rclone", ["config", "dump"], { encoding: "utf8" });
    dump = JSON.parse(out) as Record<string, Record<string, unknown>>;
  } catch (e) {
    throw new AuthError(
      `no credentials found and rclone is unavailable (${String(e).slice(0, 120)}). Set GDRIVE_PUBLISH_CLIENT_ID/GDRIVE_PUBLISH_CLIENT_SECRET, or place a client_secret.json at ${path.join(configDir(), "client_secret.json")}.`,
    );
  }
  const candidates = Object.entries(dump).filter(
    ([, v]) =>
      v.type === "drive" && typeof v.client_id === "string" && typeof v.client_secret === "string",
  );
  let chosen: [string, Record<string, unknown>] | undefined;
  if (wanted) {
    chosen = candidates.find(([name]) => name === wanted);
    if (!chosen) {
      throw new AuthError(
        `rclone remote "${wanted}" not found, or it has no client_id/client_secret of its own`,
      );
    }
  } else if (candidates.length === 0) {
    throw new AuthError(
      `no credential source found. Provide GDRIVE_PUBLISH_CLIENT_ID + GDRIVE_PUBLISH_CLIENT_SECRET, GDRIVE_PUBLISH_CLIENT_SECRET_FILE, ${path.join(configDir(), "client_secret.json")}, or an rclone drive remote.`,
    );
  } else if (candidates.length > 1) {
    throw new AuthError(
      `ambiguous rclone remotes (${candidates
        .map(([n]) => n)
        .join(", ")}) - set GDRIVE_PUBLISH_RCLONE_REMOTE=<name>`,
    );
  } else {
    chosen = candidates[0];
  }
  const [name, cfg] = chosen as [string, Record<string, unknown>];
  const clientId = cfg.client_id as string;
  let clientSecret = cfg.client_secret as string;
  // `rclone config dump` usually returns plaintext (GOCSPX-...). Running
  // `rclone reveal` on plaintext returns GARBAGE with exit code 0, which cost
  // the spike a confusing invalid_client failure - only reveal when needed.
  if (!clientSecret.startsWith("GOCSPX-")) {
    try {
      const revealed = execFileSync("rclone", ["reveal", clientSecret], {
        encoding: "utf8",
      }).trim();
      if (revealed) clientSecret = revealed;
    } catch {
      // keep the raw value
    }
  }
  return { source: `rclone remote "${name}"`, clientId, clientSecret };
}

export function resolveCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  const id = env.GDRIVE_PUBLISH_CLIENT_ID;
  const secret = env.GDRIVE_PUBLISH_CLIENT_SECRET;
  if (id && secret) return { source: "env pair", clientId: id, clientSecret: secret };
  const candidates: string[] = [];
  if (env.GDRIVE_PUBLISH_CLIENT_SECRET_FILE) candidates.push(env.GDRIVE_PUBLISH_CLIENT_SECRET_FILE);
  candidates.push(path.join(configDir(), "client_secret.json"));
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const creds = fromSecretFile(p);
      if (creds) return creds;
    }
  }
  return fromRclone(env.GDRIVE_PUBLISH_RCLONE_REMOTE);
}

async function postForm(params: Record<string, string>): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new AuthError(`token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in: number };
}

export function readToken(clientId: string): StoredToken | null {
  const p = tokenPath(clientId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as StoredToken;
  } catch {
    return null;
  }
}

export function writeToken(token: StoredToken): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, `token-${token.clientHash}.json`);
  fs.writeFileSync(p, JSON.stringify(token, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return p;
}

/** Interactive loopback consent. Only ever called by `login`. */
export async function consent(
  creds: Credentials,
  openBrowser: (url: string) => void,
  host: "127.0.0.1" | "localhost" = "127.0.0.1",
): Promise<StoredToken> {
  return new Promise<StoredToken>((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, host, () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new AuthError("could not bind a loopback port for the consent flow"));
        return;
      }
      const redirectUri = `http://${host}:${addr.port}/`;
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
      }).toString()}`;
      const timer = setTimeout(() => {
        server.close();
        reject(new AuthError("timed out waiting for consent (5 minutes)"));
      }, 300_000);
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirectUri);
        const code = url.searchParams.get("code");
        const err = url.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (err) {
          res.end(`<h1>Consent failed: ${err}</h1>`);
          clearTimeout(timer);
          server.close();
          reject(new AuthError(`consent returned error: ${err}`));
          return;
        }
        if (!code) {
          res.end("<h1>gdrive-publish</h1><p>Waiting for the consent code…</p>");
          return;
        }
        res.end("<h1>gdrive-publish</h1><p>Authorised. You can close this tab.</p>");
        clearTimeout(timer);
        server.close();
        postForm({
          grant_type: "authorization_code",
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: redirectUri,
        })
          .then((t) =>
            resolve({
              clientHash: clientHash(creds.clientId),
              access_token: t.access_token,
              refresh_token: t.refresh_token,
              expires_at: Date.now() + t.expires_in * 1000,
            }),
          )
          .catch(reject);
      });
      openBrowser(authUrl);
    });
  });
}

/**
 * Non-interactive token provider: uses the cached token, refreshing it when
 * expired. Never prompts - `login` is the only interactive entry point, which
 * keeps every other command usable headless (decision 6).
 */
export class CachedTokenProvider {
  private readonly creds: Credentials;
  private token: StoredToken | null;

  constructor(creds: Credentials) {
    this.creds = creds;
    this.token = readToken(creds.clientId);
  }

  get credentials(): Credentials {
    return this.creds;
  }

  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires_at - 30_000) {
      return this.token.access_token;
    }
    if (!this.token?.refresh_token) {
      throw new AuthError(
        `not authenticated for ${this.creds.source} (client ${clientHash(
          this.creds.clientId,
        )}). Run: gdrive-publish login`,
      );
    }
    const t = await postForm({
      grant_type: "refresh_token",
      refresh_token: this.token.refresh_token,
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
    });
    this.token = {
      clientHash: clientHash(this.creds.clientId),
      access_token: t.access_token,
      refresh_token: this.token.refresh_token,
      expires_at: Date.now() + t.expires_in * 1000,
    };
    writeToken(this.token);
    return this.token.access_token;
  }
}
