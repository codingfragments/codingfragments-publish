/**
 * Drive access, behind a narrow interface so tests can substitute a fake.
 *
 * Every call here was exercised by the spike (`spike/probe.ts`); notably the
 * two-phase mechanic: create an empty Doc, then `files.update` with media to
 * fill it while keeping the fileId (and therefore the shared URL) stable.
 */

import crypto from "node:crypto";
import { GOOGLE_DOC, GOOGLE_FOLDER } from "./types.ts";

const API = "https://www.googleapis.com";

/** Total fetch attempts per request (1 initial + 7 retries). */
export const MAX_ATTEMPTS = 8;
/** Ceiling for one backoff sleep (truncated exponential backoff). */
export const MAX_BACKOFF_MS = 64_000;

/**
 * Truncated exponential backoff with jitter: 2^n seconds plus up to 1s of
 * jitter, capped at MAX_BACKOFF_MS - Google's documented guidance for
 * rate-limit responses. Pure and injectable so tests stay instant.
 */
export function backoffDelayMs(attempt: number, jitter: () => number = Math.random): number {
  return Math.min(2 ** attempt * 1000 + Math.floor(jitter() * 1000), MAX_BACKOFF_MS);
}

/** Rate limits and transient server errors are worth retrying. */
export function isRetryableStatus(status: number, reason: string): boolean {
  if (status === 429) return true;
  if (status === 403 && (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded")) {
    return true;
  }
  return status === 500 || status === 502 || status === 503 || status === 504;
}

/** Only rate-limit responses count as throttling (not plain 5xx). */
function isRateLimitStatus(status: number, reason: string): boolean {
  return status === 429 || (status === 403 && isRetryableStatus(status, reason));
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  modifiedTime?: string;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
}

/** The only Drive surface core logic is allowed to use. */
export interface DriveClient {
  createFolder(name: string, parentId?: string): Promise<DriveFile>;
  createEmptyDoc(name: string, parentId: string): Promise<DriveFile>;
  /** Convert-on-upload: metadata mimeType is the Google type, media is the source. */
  convertUpload(
    name: string,
    targetMime: string,
    mediaMime: string,
    data: Buffer | string,
    parentId: string,
  ): Promise<DriveFile>;
  /** Replace the content of an existing file, keeping its id. */
  updateMedia(fileId: string, mediaMime: string, data: Buffer | string): Promise<void>;
  rename(fileId: string, name: string): Promise<void>;
  get(fileId: string): Promise<DriveFile>;
  trash(fileId: string): Promise<void>;
  exportText(fileId: string, mimeType: string): Promise<string>;
  /**
   * Fired whenever Drive answers with a rate limit that is being retried
   * (429 or 403 rateLimitExceeded). Optional: lets callers adapt (halve
   * concurrency) without coupling to the REST client.
   */
  setRateLimitListener?(listener: () => void): void;
}

export class DriveError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(message: string, status: number, reason = "") {
    super(message);
    this.name = "DriveError";
    this.status = status;
    this.reason = reason;
  }
}

export interface TokenProvider {
  /** Returns a valid access token, refreshing it when needed. */
  accessToken(): Promise<string>;
}

const FIELDS = "id,name,mimeType,parents,trashed,modifiedTime,lastModifyingUser";

export class RestDriveClient implements DriveClient {
  private readonly tokens: TokenProvider;
  private readonly sleep: (ms: number) => Promise<void>;
  /** How often Drive answered with a rate limit that was retried. */
  rateLimitEvents = 0;
  private rateLimitListener?: () => void;

  constructor(tokens: TokenProvider, opts: { sleepMs?: (ms: number) => Promise<void> } = {}) {
    this.tokens = tokens;
    this.sleep = opts.sleepMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  setRateLimitListener(listener: () => void): void {
    this.rateLimitListener = listener;
  }

  private async request(
    method: string,
    url: string,
    opts: { json?: unknown; body?: Buffer | string; contentType?: string } = {},
  ): Promise<unknown> {
    const token = await this.tokens.accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let body: Buffer | string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
      body = opts.body;
    }
    // Truncated exponential backoff on rate limits and transient 5xx: a
    // parallel publish provokes exactly these, and one 429 used to kill the
    // whole run (design: docs/parallel-publish.md, slice 1).
    let attempt = 0;
    while (true) {
      const res = await fetch(url, { method, headers, body });
      const text = await res.text();
      if (res.ok) return text === "" ? {} : JSON.parse(text);
      let reason = "";
      try {
        const parsed = JSON.parse(text) as { error?: { errors?: { reason?: string }[] } };
        reason = parsed.error?.errors?.[0]?.reason ?? "";
      } catch {
        // non-JSON error body
      }
      if (attempt < MAX_ATTEMPTS - 1 && isRetryableStatus(res.status, reason)) {
        if (isRateLimitStatus(res.status, reason)) {
          this.rateLimitEvents++;
          this.rateLimitListener?.();
        }
        await this.sleep(backoffDelayMs(attempt));
        attempt++;
        continue;
      }
      throw new DriveError(
        `${method} ${url.replace(API, "")} -> ${res.status}${reason ? ` (${reason})` : ""}: ${text.slice(0, 300)}`,
        res.status,
        reason,
      );
    }
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFile> {
    const metadata: Record<string, unknown> = { name, mimeType: GOOGLE_FOLDER };
    if (parentId) metadata.parents = [parentId];
    return (await this.request("POST", `${API}/drive/v3/files?fields=${FIELDS}`, {
      json: metadata,
    })) as DriveFile;
  }

  async createEmptyDoc(name: string, parentId: string): Promise<DriveFile> {
    return (await this.request("POST", `${API}/drive/v3/files?fields=${FIELDS}`, {
      json: { name, mimeType: GOOGLE_DOC, parents: [parentId] },
    })) as DriveFile;
  }

  async convertUpload(
    name: string,
    targetMime: string,
    mediaMime: string,
    data: Buffer | string,
    parentId: string,
  ): Promise<DriveFile> {
    const boundary = `gdp${crypto.randomBytes(12).toString("hex")}`;
    const meta = JSON.stringify({ name, mimeType: targetMime, parents: [parentId] });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mediaMime}\r\n\r\n`,
      ),
      Buffer.isBuffer(data) ? data : Buffer.from(data),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return (await this.request(
      "POST",
      `${API}/upload/drive/v3/files?uploadType=multipart&fields=${FIELDS}`,
      { body, contentType: `multipart/related; boundary=${boundary}` },
    )) as DriveFile;
  }

  async updateMedia(fileId: string, mediaMime: string, data: Buffer | string): Promise<void> {
    await this.request("PATCH", `${API}/upload/drive/v3/files/${fileId}?uploadType=media`, {
      body: data,
      contentType: mediaMime,
    });
  }

  async rename(fileId: string, name: string): Promise<void> {
    await this.request("PATCH", `${API}/drive/v3/files/${fileId}`, { json: { name } });
  }

  async get(fileId: string): Promise<DriveFile> {
    return (await this.request(
      "GET",
      `${API}/drive/v3/files/${fileId}?fields=${FIELDS}`,
    )) as DriveFile;
  }

  async trash(fileId: string): Promise<void> {
    await this.request("PATCH", `${API}/drive/v3/files/${fileId}`, { json: { trashed: true } });
  }

  async exportText(fileId: string, mimeType: string): Promise<string> {
    const token = await this.tokens.accessToken();
    const res = await fetch(
      `${API}/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(mimeType)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const text = await res.text();
    if (!res.ok) throw new DriveError(`export ${mimeType} -> ${res.status}`, res.status);
    return text;
  }
}
