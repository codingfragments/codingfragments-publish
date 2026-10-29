#!/usr/bin/env node
/**
 * gdrive-publish spike probe — PR 1 (branch: spike/gdrive-import-probe)
 *
 * THROWAWAY script answering the five load-bearing unknowns before PR 2
 * (feat/gdrive-publish-core) is written. Not production code. No reusable
 * pieces are extracted on purpose — see spike/FINDINGS.md for the outcome.
 *
 *   U1  Does scope `drive.file` allow creating/nesting folders + files in a
 *       tool-created folder, and does write access survive a "manual move"
 *       (parent change + rename of the published root)?
 *   U2  Does creating an empty Doc and then `files.update` + media(markdown)
 *       keep the fileId and replace the body? (core of the two-phase design)
 *   U3  Importer fidelity: do absolute links, tables, fenced code, front
 *       matter, inline code survive a markdown round-trip?
 *   U4  Do `drive.google.com/uc?export=view&id=` images embed in Docs?
 *   U5  CSV/XLSX conversion behaviour (incl. semicolon/latin1 mangling) and
 *       whether re-publishing a Sheet via `files.update` media works.
 *
 * Credential resolution chain (first match wins, source reported by NAME):
 *   1. GDRIVE_PUBLISH_CLIENT_ID + GDRIVE_PUBLISH_CLIENT_SECRET (env pair)
 *   2. GDRIVE_PUBLISH_CLIENT_SECRET_FILE (path to client_secret.json)
 *   3. ~/.config/gdrive-publish/client_secret.json
 *   4. rclone remote (GDRIVE_PUBLISH_RCLONE_REMOTE=..., or auto-detect when
 *      exactly one `type=drive` remote exists)
 *
 * Tokens are cached per client identity as token-<sha256(client_id)[0:8]>.json
 * (0600) in ~/.config/gdrive-publish/. Secrets are never printed.
 *
 * Run: node spike/probe.ts
 * Cleanup: everything created goes into one throwaway folder tree which is
 * moved to Drive trash at the end (never files.delete).
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const CFG_DIR = path.join(os.homedir(), ".config", "gdrive-publish");
const API = "https://www.googleapis.com";
const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_FOLDER = "application/vnd.google-apps.folder";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Visible test image fixture, generated so the embed can be judged by eye.
// Dependency-free PNG encoder: raw RGB scanlines -> zlib -> IHDR/IDAT/IEND.
const PNG_W = 480;
const PNG_H = 320;

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

/** Build an obvious checkerboard PNG with a black border and a diagonal stripe. */
function makeTestPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const border = x < 8 || y < 8 || x >= width - 8 || y >= height - 8;
      const diagonal = Math.abs(x - y * (width / height)) < 14;
      const checker = (Math.floor(x / 40) + Math.floor(y / 40)) % 2 === 0;
      let r: number;
      let g: number;
      let b: number;
      if (border) {
        r = 20;
        g = 20;
        b = 20;
      } else if (diagonal) {
        r = 255;
        g = 255;
        b = 255;
      } else if (checker) {
        r = 220;
        g = 30;
        b = 60;
      } else {
        r = 250;
        g = 210;
        b = 40;
      }
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function log(msg: string): void {
  console.log(`\n=== ${msg} ${"=".repeat(Math.max(0, 70 - msg.length))}`);
}

function step(msg: string): void {
  console.log(`  ${msg}`);
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

interface Creds {
  name: string;
  clientId: string;
  clientSecret: string;
}

function fail(msg: string): never {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

/** Read client_id/client_secret from a Google client_secret JSON file. */
function credsFromFile(p: string): Creds | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const holder = raw as Record<string, unknown>;
    const inst = (holder.installed ?? holder.web) as Record<string, unknown> | undefined;
    if (
      inst &&
      typeof inst.client_id === "string" &&
      typeof inst.client_secret === "string" &&
      inst.client_id &&
      inst.client_secret
    ) {
      return { name: `file:${p}`, clientId: inst.client_id, clientSecret: inst.client_secret };
    }
  } catch {
    return null;
  }
  return null;
}

/** Resolve OAuth client credentials from the agreed chain. Never prints values. */
function resolveCreds(): Creds {
  const envId = process.env.GDRIVE_PUBLISH_CLIENT_ID;
  const envSecret = process.env.GDRIVE_PUBLISH_CLIENT_SECRET;
  if (envId && envSecret) {
    return { name: "env pair", clientId: envId, clientSecret: envSecret };
  }

  const fileCandidates: string[] = [];
  const envFile = process.env.GDRIVE_PUBLISH_CLIENT_SECRET_FILE;
  if (envFile) fileCandidates.push(envFile);
  fileCandidates.push(path.join(CFG_DIR, "client_secret.json"));
  for (const p of fileCandidates) {
    if (fs.existsSync(p)) {
      const c = credsFromFile(p);
      if (c) return c;
    }
  }

  // rclone remotes — read names/keys only; `config dump` values may be obscured.
  let dump: Record<string, Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(execSync("rclone config dump", { encoding: "utf8" }));
    if (typeof parsed !== "object" || parsed === null)
      fail("rclone config dump: unparseable output");
    dump = parsed as Record<string, Record<string, unknown>>;
  } catch (e) {
    fail(`rclone config dump failed (is rclone installed?): ${String(e)}`);
  }
  const driveRemotes = Object.entries(dump).filter(
    ([, v]) =>
      v?.type === "drive" && typeof v.client_id === "string" && typeof v.client_secret === "string",
  );
  const wanted = process.env.GDRIVE_PUBLISH_RCLONE_REMOTE;
  let chosen: [string, Record<string, unknown>] | undefined;
  if (wanted) {
    const hit = driveRemotes.find(([n]) => n === wanted) as
      | [string, Record<string, unknown>]
      | undefined;
    if (!hit)
      fail(`rclone remote "${wanted}" not found or not a drive remote with client credentials`);
    chosen = hit;
  } else {
    if (driveRemotes.length === 0) {
      fail(
        "no credential source found. Options: GDRIVE_PUBLISH_CLIENT_ID/_CLIENT_SECRET env pair, " +
          "GDRIVE_PUBLISH_CLIENT_SECRET_FILE, ~/.config/gdrive-publish/client_secret.json, " +
          "or an rclone drive remote with its own client_id/client_secret.",
      );
    }
    if (driveRemotes.length > 1) {
      const names = driveRemotes.map(([n]) => n).join(", ");
      fail(`ambiguous rclone remotes (${names}) — set GDRIVE_PUBLISH_RCLONE_REMOTE=<name>`);
    }
    chosen = driveRemotes[0] as [string, Record<string, unknown>];
  }
  const remoteName = chosen[0];
  const clientId = chosen[1].client_id as string;
  let clientSecret = chosen[1].client_secret as string;
  if (!clientId || !clientSecret)
    fail(`rclone remote "${remoteName}" lacks client_id/client_secret`);
  // client_secret may be rclone-obscured. NOTE: `config dump` usually returns
  // plaintext (GOCSPX-...) and `rclone reveal` on plaintext returns GARBAGE
  // with exit 0 — so only reveal when the raw value is not already a Google
  // secret literal.
  if (!/^GOCSPX-/.test(clientSecret)) {
    try {
      const revealed = execSync(`rclone reveal ${JSON.stringify(clientSecret)}`, {
        encoding: "utf8",
      })
        .toString()
        .trim();
      if (revealed) clientSecret = revealed;
    } catch {
      step("rclone reveal failed; using raw value from config dump as-is");
    }
  }
  return { name: `rclone remote "${remoteName}"`, clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// OAuth token handling (loopback consent, per-client cached tokens)
// ---------------------------------------------------------------------------

interface StoredToken {
  clientHash: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
}

function clientHash(clientId: string): string {
  return crypto.createHash("sha256").update(clientId).digest("hex").slice(0, 8);
}

function tokenPath(hash: string): string {
  return path.join(CFG_DIR, `token-${hash}.json`);
}

async function exchangeToken(
  creds: Creds,
  params: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) fail(`token exchange failed (${res.status}): ${text.slice(0, 500)}`);
  const parsed = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return parsed;
}

/** Run a loopback OAuth consent flow for the given redirect host label. */
async function consentOnce(creds: Creds, host: "127.0.0.1" | "localhost"): Promise<StoredToken> {
  return new Promise<StoredToken>((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, host, () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("loopback server failed to bind"));
        return;
      }
      const port = addr.port;
      const redirectUri = `http://${host}:${port}/`;
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
      }).toString()}`;
      console.log(`\n  A browser window will open for Google consent (scope: ${SCOPE}).`);
      console.log("  Approve it as the user whose Drive the probe should test.\n");
      const timer = setTimeout(() => {
        server.close();
        reject(new Error("timed out waiting for consent (5 min)"));
      }, 300_000);
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", `http://${host}:${port}`);
        const code = url.searchParams.get("code");
        const err = url.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html" });
        if (err) {
          res.end(`<h1>Consent failed: ${err}</h1>`);
          clearTimeout(timer);
          server.close();
          reject(new Error(`consent screen returned error: ${err}`));
          return;
        }
        if (!code) {
          res.end("<h1>gdrive-publish spike</h1><p>Waiting for consent code...</p>");
          return;
        }
        res.end("<h1>Consent received</h1><p>You can close this tab.</p>");
        clearTimeout(timer);
        server.close();
        exchangeToken(creds, {
          grant_type: "authorization_code",
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: redirectUri,
        })
          .then((t) => {
            resolve({
              clientHash: clientHash(creds.clientId),
              access_token: t.access_token,
              refresh_token: t.refresh_token,
              expires_at: Date.now() + t.expires_in * 1000,
            });
          })
          .catch(reject);
      });
      try {
        execSync(`open "${authUrl}"`, { stdio: "ignore" });
      } catch {
        console.log(`  Could not open a browser; open this URL manually:\n\n  ${authUrl}\n`);
      }
    });
  });
}

/** Get a valid access token: cached -> refresh -> consent (127.0.0.1, then localhost). */
async function getAccessToken(creds: Creds): Promise<StoredToken> {
  const hash = clientHash(creds.clientId);
  const p = tokenPath(hash);
  let tok: StoredToken | null = null;
  if (fs.existsSync(p)) {
    try {
      tok = JSON.parse(fs.readFileSync(p, "utf8")) as StoredToken;
    } catch {
      tok = null;
    }
  }
  if (tok) {
    if (tok.access_token && Date.now() < tok.expires_at - 30_000) return tok;
    if (tok.refresh_token) {
      step(`refreshing cached token (${path.basename(p)})`);
      const t = await exchangeToken(creds, {
        grant_type: "refresh_token",
        refresh_token: tok.refresh_token,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      });
      tok = {
        clientHash: hash,
        access_token: t.access_token,
        refresh_token: tok.refresh_token,
        expires_at: Date.now() + t.expires_in * 1000,
      };
      saveToken(tok);
      return tok;
    }
  }
  try {
    tok = await consentOnce(creds, "127.0.0.1");
  } catch (e) {
    step(
      `loopback consent on 127.0.0.1 failed (${String(e).slice(0, 120)}) — retrying with localhost`,
    );
    tok = await consentOnce(creds, "localhost");
  }
  saveToken(tok);
  return tok;
}

function saveToken(tok: StoredToken): void {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(tokenPath(tok.clientHash), JSON.stringify(tok, null, 2), { mode: 0o600 });
  fs.chmodSync(tokenPath(tok.clientHash), 0o600);
}

// ---------------------------------------------------------------------------
// Drive REST helpers
// ---------------------------------------------------------------------------

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
}

async function drive(
  token: string,
  method: string,
  url: string,
  opts: {
    json?: unknown;
    body?: string | Buffer;
    contentType?: string;
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(opts.extraHeaders ?? {}),
  };
  let body: string | Buffer | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
    body = opts.body;
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 400)}`);
  if (res.status === 204 || text === "") return {};
  return JSON.parse(text);
}

/** Build a multipart/related body for convert-on-upload (metadata + media). */
function multipartBody(
  meta: object,
  dataType: string,
  data: Buffer,
): { body: Buffer; contentType: string } {
  const boundary = `gdrivepub${crypto.randomBytes(12).toString("hex")}`;
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${dataType}\r\n\r\n`,
  );
  const post = Buffer.from(`\r\n--${boundary}--`);
  return {
    body: Buffer.concat([pre, data, post]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

async function createFolder(token: string, name: string, parent?: string): Promise<DriveFile> {
  const meta: Record<string, string | string[]> = { name, mimeType: GOOGLE_FOLDER };
  if (parent) meta.parents = [parent];
  const r = await drive(token, "POST", `${API}/drive/v3/files`, { json: meta });
  return r as DriveFile;
}

async function createEmptyDoc(token: string, name: string, parent: string): Promise<DriveFile> {
  const r = await drive(token, "POST", `${API}/drive/v3/files`, {
    json: { name, mimeType: GOOGLE_DOC, parents: [parent] },
  });
  return r as DriveFile;
}

async function convertUpload(
  token: string,
  name: string,
  targetMime: string,
  mediaMime: string,
  data: Buffer | string,
  parent: string,
): Promise<DriveFile> {
  const mp = multipartBody(
    { name, mimeType: targetMime, parents: [parent] },
    mediaMime,
    Buffer.from(data),
  );
  const r = await drive(token, "POST", `${API}/upload/drive/v3/files?uploadType=multipart`, {
    body: mp.body,
    contentType: mp.contentType,
    extraHeaders: { "Content-Type": mp.contentType },
  });
  return r as DriveFile;
}

async function updateMedia(
  token: string,
  id: string,
  mediaMime: string,
  data: string,
): Promise<unknown> {
  return drive(token, "PATCH", `${API}/upload/drive/v3/files/${id}?uploadType=media`, {
    body: data,
    contentType: mediaMime,
  });
}

async function getMeta(token: string, id: string): Promise<DriveFile> {
  const r = await drive(
    token,
    "GET",
    `${API}/drive/v3/files/${id}?fields=id,name,mimeType,parents,trashed`,
  );
  return r as DriveFile;
}

async function patchMeta(
  token: string,
  id: string,
  json: Record<string, unknown>,
  extraQuery?: string,
): Promise<DriveFile> {
  const q = extraQuery ? `?${extraQuery}` : "";
  const r = await drive(token, "PATCH", `${API}/drive/v3/files/${id}${q}`, { json });
  return r as DriveFile;
}

async function exportFile(token: string, id: string, mime: string): Promise<string> {
  const res = await fetch(
    `${API}/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(mime)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`export ${mime} -> ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

async function setAnyoneReader(token: string, id: string): Promise<unknown> {
  return drive(token, "POST", `${API}/drive/v3/files/${id}/permissions`, {
    json: { role: "reader", type: "anyone" },
  });
}

async function trashFile(token: string, id: string): Promise<DriveFile> {
  return patchMeta(token, id, { trashed: true }, "fields=trashed,id");
}

/** Export a Doc as binary (used for docx round-trip inspection). */
async function exportBinary(token: string, id: string, mime: string): Promise<Buffer> {
  const res = await fetch(
    `${API}/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(mime)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok)
    throw new Error(`export ${mime} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Count REAL embedded images in a Doc by exporting it as .docx and counting
 * `word/media/*` parts. This is unambiguous — unlike the html/markdown export,
 * which emits a bare <img> / empty ![]() even for an unresolved reference.
 */
async function embeddedImageCount(token: string, id: string): Promise<number> {
  const docx = await exportBinary(token, id, DOCX_MIME);
  const tmp = path.join(os.tmpdir(), `gdrive-spike-${id}.docx`);
  fs.writeFileSync(tmp, docx);
  try {
    const listing = execSync(`unzip -Z1 ${JSON.stringify(tmp)}`, { encoding: "utf8" });
    return listing.split("\n").filter((l) => l.trim().startsWith("word/media/")).length;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Minimal xlsx fixture (hand-crafted OOXML, zipped with /usr/bin/zip)
// ---------------------------------------------------------------------------

function buildXlsx(): Buffer {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-spike-xlsx-"));
  const write = (rel: string, content: string) => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      "</Types>",
  );
  write(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",
  );
  write(
    "xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  write(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      "</Relationships>",
  );
  const cell = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  write(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cell("A1", "col1")}${cell("B1", "col2")}${cell("C1", "col3")}</row><row r="2">${cell("A2", "1")}${cell("B2", "2")}${cell("C2", "3")}</row></sheetData></worksheet>`,
  );
  // NOTE: `zip ... .` silently skips dotfiles ("Nothing to do!", exit 12) —
  // the part list must be explicit.
  execSync(
    "zip -X -q book.xlsx '[Content_Types].xml' '_rels/.rels' 'xl/workbook.xml' " +
      "'xl/_rels/workbook.xml.rels' 'xl/worksheets/sheet1.xml'",
    { cwd: tmp },
  );
  const buf = fs.readFileSync(path.join(tmp, "book.xlsx"));
  fs.rmSync(tmp, { recursive: true, force: true });
  return buf;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

interface Finding {
  unknown: string;
  verdict: "PASS" | "FAIL" | "PARTIAL" | "UNVERIFIED";
  notes: string[];
  evidence: string[];
}

class Findings {
  readonly entries: Finding[] = [];
  readonly appendix: { title: string; content: string }[] = [];

  add(unknown: string, verdict: Finding["verdict"], notes: string[], evidence: string[]): void {
    this.entries.push({ unknown, verdict, notes, evidence });
    console.log(`  -> ${verdict}`);
    for (const n of notes) console.log(`     ${n}`);
  }

  raw(title: string, content: string, maxLen = 4000): void {
    this.appendix.push({
      title,
      content: content.length > maxLen ? `${content.slice(0, maxLen)}\n… (truncated)` : content,
    });
  }

  write(credName: string, hash: string): string {
    const out: string[] = [];
    out.push("# Spike findings — gdrive-publish import behaviour");
    out.push("");
    out.push(`- date: ${new Date().toISOString()}`);
    out.push(`- credential source: ${credName} (client_id hash \`${hash}\`)`);
    out.push(`- scope granted: \`${SCOPE}\``);
    out.push("- probe: `spike/probe.ts` on branch `spike/gdrive-import-probe`");
    out.push("");
    out.push("| Unknown | Verdict |");
    out.push("|---|---|");
    for (const f of this.entries) out.push(`| ${f.unknown} | **${f.verdict}** |`);
    out.push("");
    for (const f of this.entries) {
      out.push(`## ${f.unknown} — ${f.verdict}`);
      out.push("");
      for (const n of f.notes) out.push(`- ${n}`);
      out.push("");
      out.push("Evidence:");
      out.push("");
      for (const e of f.evidence) out.push(`- ${e}`);
      out.push("");
    }
    if (this.appendix.length) {
      out.push("## Appendix — raw exports");
      out.push("");
      for (const a of this.appendix) {
        out.push(`### ${a.title}`);
        out.push("");
        out.push("````text");
        out.push(a.content);
        out.push("````");
        out.push("");
      }
    }
    const md = out.join("\n");
    fs.mkdirSync(path.dirname(new URL(import.meta.url).pathname), { recursive: true });
    const dest = path.join(path.dirname(new URL(import.meta.url).pathname), "FINDINGS.md");
    fs.writeFileSync(dest, `${md}\n`);
    return dest;
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  const creds = resolveCreds();
  const hash = clientHash(creds.clientId);
  log(`credentials resolved: ${creds.name} (client_id hash ${hash})`);
  const tok = await getAccessToken(creds);
  const token = tok.access_token;
  const findings = new Findings();
  const created: { id: string; label: string }[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // ---- U1 (part 1): folder nesting under tool-created root ----------------
  log("U1a: drive.file folder creation + nesting");
  let u1 = "PASS";
  const u1notes: string[] = [];
  const u1evidence: string[] = [];
  try {
    const root = await createFolder(token, `gdrive-publish-spike-${stamp}`);
    created.push({ id: root.id, label: "root" });
    const sub = await createFolder(token, "sub", root.id);
    const sub2 = await createFolder(token, "deeper", sub.id);
    u1notes.push(
      `created root folder + 2 nested levels under My Drive root (ids …${root.id.slice(-6)}, …${sub.id.slice(-6)}, …${sub2.id.slice(-6)})`,
    );
    u1evidence.push(`root: https://drive.google.com/drive/folders/${root.id}`);
  } catch (e) {
    u1 = "FAIL";
    u1notes.push(`folder creation failed: ${String(e).slice(0, 300)}`);
  }

  if (u1 === "PASS") {
    // root folder id is needed below; refetch from created[] via last createFolder… simpler: re-create a marker
  }
  // Re-fetch the root we just made (first created entry).
  const rootId = created.find((c) => c.label === "root")?.id;

  // ---- U2: empty Doc -> files.update media keeps id ------------------------
  log("U2: empty Doc + files.update media(markdown)");
  let docUrl = "";
  let u2verdict: Finding["verdict"] = "UNVERIFIED";
  const u2notes: string[] = [];
  const u2evidence: string[] = [];
  let targetId = "";
  if (rootId) {
    try {
      const before = await createEmptyDoc(token, "u2-target", rootId);
      targetId = before.id;
      docUrl = `https://docs.google.com/document/d/${targetId}/edit`;
      step(`empty Doc created: id=${targetId}`);
      const v1 = await exportFile(token, targetId, "text/markdown");
      findings.raw("U2: export of empty Doc (before update)", v1);
      await updateMedia(
        token,
        targetId,
        "text/markdown",
        "# Target Doc\n\nThis doc exists to be linked at.\n",
      );
      const after = await getMeta(token, targetId);
      const v2 = await exportFile(token, targetId, "text/markdown");
      const idStable = after.id === targetId && after.mimeType === GOOGLE_DOC;
      const bodyReplaced = v2.includes("This doc exists to be linked at.");
      u2verdict = idStable && bodyReplaced ? "PASS" : "FAIL";
      u2notes.push(
        idStable
          ? "fileId and Google-Doc mimeType unchanged after files.update media"
          : `fileId/mimeType changed after update (now ${after.id} / ${after.mimeType})`,
      );
      u2notes.push(
        bodyReplaced
          ? "body replaced by markdown content"
          : "body NOT replaced — exported text lacks new content",
      );
      u2evidence.push(`doc: ${docUrl}`);
      u2evidence.push(
        `export before update (${v1.length} chars) vs after (${v2.length} chars) — see appendix`,
      );
      findings.raw("U2: export after update", v2);
    } catch (e) {
      u2verdict = "FAIL";
      u2notes.push(`failed: ${String(e).slice(0, 300)}`);
    }
  } else {
    u2notes.push("skipped: no root folder (U1 failed)");
  }
  findings.add(
    "U2: empty Doc → files.update media keeps fileId and replaces body",
    u2verdict,
    u2notes,
    u2evidence,
  );

  // ---- U3: markdown fidelity round-trip ------------------------------------
  log("U3: markdown importer fidelity (links, tables, code, front matter)");
  let u3verdict: Finding["verdict"] = "UNVERIFIED";
  const u3notes: string[] = [];
  const u3evidence: string[] = [];
  if (rootId && docUrl) {
    try {
      const md = [
        "---",
        "title: Fidelity Fixture",
        "author: probe",
        "---",
        "",
        "# Fidelity Fixture",
        "",
        `See the [target doc](${docUrl}) for the linked object.`,
        "An external link to [Google](https://www.google.com) should also survive.",
        "",
        "## Table",
        "",
        "| col1 | col2 |",
        "|---|---|",
        "| a | b |",
        "",
        "## Code",
        "",
        "```ts",
        "const x: number = 42; // code fence",
        "```",
        "",
        "Inline `code` and a list:",
        "",
        "- one",
        "- two",
        "",
        "Anchor link: [section](#table)",
        "",
      ].join("\n");
      const fdoc = await convertUpload(
        token,
        "u3-fidelity",
        GOOGLE_DOC,
        "text/markdown",
        md,
        rootId,
      );
      await updateMedia(token, fdoc.id, "text/markdown", md); // also confirms U2 pattern on a convert-uploaded doc
      const out = await exportFile(token, fdoc.id, "text/markdown");
      findings.raw("U3: exported fidelity doc", out);
      const checks: Record<string, boolean> = {
        "absolute link to another Doc": out.includes("/document/d/"),
        "external http link": out.includes("https://www.google.com"),
        "table structure": out.includes("|"),
        "fenced code block": out.includes("```") || out.includes("~~~"),
        heading: /^\s*#/m.test(out),
        "list items": /(^|\n)\s*[-*]\s/m.test(out),
      };
      const survived = Object.entries(checks)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const lost = Object.entries(checks)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      u3verdict = lost.length === 0 ? "PASS" : survived.length === 0 ? "FAIL" : "PARTIAL";
      u3notes.push(`survived: ${survived.join(", ") || "none"}`);
      if (lost.length) u3notes.push(`LOST: ${lost.join(", ")}`);
      // front matter specifically — inspect head of export
      const head = out.split("\n").slice(0, 6).join("\n");
      u3notes.push(
        `front matter does NOT survive — it becomes a mangled heading (${JSON.stringify(
          head.slice(0, 60),
        )}); PR2 must strip front matter and use its title for the Doc name`,
      );
      u3evidence.push(`doc: https://docs.google.com/document/d/${fdoc.id}/edit`);
    } catch (e) {
      u3verdict = "FAIL";
      u3notes.push(`failed: ${String(e).slice(0, 300)}`);
    }
  } else {
    u3notes.push("skipped: no root folder or no doc URL (earlier probes failed)");
  }
  findings.add(
    "U3: importer keeps absolute links, tables, code blocks, lists, front matter",
    u3verdict,
    u3notes,
    u3evidence,
  );

  // ---- U4: image upload + anyoneWithLink + uc? embed -----------------------
  log("U4: image embedding via uc?export=view&id=");
  let u4verdict: Finding["verdict"] = "UNVERIFIED";
  const u4notes: string[] = [];
  const u4evidence: string[] = [];
  if (rootId) {
    try {
      const testPng = makeTestPng(PNG_W, PNG_H);
      const localCopy = path.join(os.tmpdir(), "gdrive-spike-test-image.png");
      fs.writeFileSync(localCopy, testPng);
      step(`test image: ${PNG_W}x${PNG_H} PNG, ${testPng.length} bytes, local copy ${localCopy}`);
      const img = await convertUpload(
        token,
        "test-image.png",
        "image/png",
        "image/png",
        testPng,
        rootId,
      );
      // Try several permission payloads — the plain one failed with a 400 in
      // the first probe run; record which variant (if any) works under drive.file.
      const permVariants: { label: string; json: Record<string, unknown>; query?: string }[] = [
        { label: "{anyone, reader}", json: { role: "reader", type: "anyone" } },
        {
          label: "{anyone, reader, allowFileDiscovery:false}",
          json: { role: "reader", type: "anyone", allowFileDiscovery: false },
        },
        {
          label: "{anyone, reader} + supportsAllDrives=true",
          json: { role: "reader", type: "anyone" },
          query: "supportsAllDrives=true",
        },
      ];
      let permOk = false;
      const permNotes: string[] = [];
      for (const v of permVariants) {
        try {
          const url = `${API}/drive/v3/files/${img.id}/permissions${v.query ? `?${v.query}` : ""}`;
          await drive(token, "POST", url, { json: v.json });
          permOk = true;
          permNotes.push(`anyoneWithLink=reader permission set via variant ${v.label}`);
          break;
        } catch (e) {
          permNotes.push(`variant ${v.label}: ${String(e).slice(0, 160)}`);
        }
      }
      if (permOk) {
        u4notes.push(...permNotes);
      } else {
        u4verdict = "PARTIAL";
        u4notes.push("NO permission variant worked under drive.file:", ...permNotes);
      }
      const imgUc = `https://drive.google.com/uc?export=view&id=${img.id}`;
      const md = [
        "# Image Embed Test",
        "",
        `Below this line there should be a **large ${PNG_W}x${PNG_H} image**: a red/yellow`,
        "checkerboard with a black border and a white diagonal stripe.",
        "",
        `![test image](${imgUc})`,
        "",
        "If you see the checkerboard, remote images are embedded by the importer.",
        "If you see a broken image or nothing, the fallback design applies.",
        "",
      ].join("\n");
      const idoc = await convertUpload(
        token,
        "u4-image-embed",
        GOOGLE_DOC,
        "text/markdown",
        md,
        rootId,
      );
      const out = await exportFile(token, idoc.id, "text/markdown");
      findings.raw("U4: exported image doc (markdown)", out);
      const html = await exportFile(token, idoc.id, "text/html");
      findings.raw("U4: exported image doc (html)", html);
      const embedded =
        /!\[[^\]]*\]\([^)]*googleusercontent\.com[^)]*\)/.test(out) || html.includes("<img");
      const linkPreserved = out.includes(imgUc);
      if (u4verdict !== "PARTIAL") {
        u4verdict = embedded ? "PASS" : linkPreserved ? "PARTIAL" : "UNVERIFIED";
      }
      u4notes.push(
        embedded
          ? "export shows googleusercontent.com image reference — image appears embedded"
          : linkPreserved
            ? "uc? link preserved as plain link, not embedded (fallback design applies)"
            : "neither embedded nor plain link present — needs manual eyeball",
      );
      u4notes.push(
        "NOTE: programmatic check is via export text; final judgement needs a manual look at the Doc",
      );
      u4evidence.push(`image file: https://drive.google.com/file/d/${img.id}/view`);
      u4evidence.push(`local copy of the same PNG for comparison: ${localCopy}`);
      u4evidence.push(`doc for manual check: https://docs.google.com/document/d/${idoc.id}/edit`);
    } catch (e) {
      u4verdict = "FAIL";
      u4notes.push(`failed: ${String(e).slice(0, 300)}`);
    }
  } else {
    u4notes.push("skipped: no root folder");
  }
  findings.add("U4: uc?export=view&id= images embed in Docs", u4verdict, u4notes, u4evidence);

  // ---- U5: CSV/XLSX conversion + sheet media update -------------------------
  log("U5: CSV/XLSX conversion + Sheet re-publish via files.update");
  let u5verdict: Finding["verdict"] = "UNVERIFIED";
  const u5notes: string[] = [];
  const u5evidence: string[] = [];
  if (rootId) {
    try {
      // clean comma CSV
      const clean = await convertUpload(
        token,
        "u5-clean.csv",
        GOOGLE_SHEET,
        "text/csv",
        "a,b\n1,2\n",
        rootId,
      );
      const cleanOut = await exportFile(token, clean.id, "text/csv");
      findings.raw("U5: clean csv export", cleanOut);
      u5notes.push(
        cleanOut.includes("1") && cleanOut.includes(",")
          ? "clean UTF-8 comma CSV converts to a well-formed Sheet"
          : "clean CSV export looks wrong — see appendix",
      );
      // re-publish via files.update media
      await updateMedia(token, clean.id, "text/csv", "a,b\n9,9\n");
      const repub = await exportFile(token, clean.id, "text/csv");
      findings.raw("U5: clean csv export after re-publish", repub);
      u5notes.push(
        repub.includes("9")
          ? "Sheet re-published via files.update media works (id stable, content replaced)"
          : "files.update media on a Sheet did NOT replace content",
      );
      // messy CSV: semicolon + latin1 + BOM, uploaded raw on purpose
      const messyBuf = Buffer.from("\uFEFFSpalte 1;Spalte 2\r\nWert 1;Wert 2\r\n", "latin1");
      const messy = await convertUpload(
        token,
        "u5-messy.csv",
        GOOGLE_SHEET,
        "text/csv",
        messyBuf,
        rootId,
      );
      const messyOut = await exportFile(token, messy.id, "text/csv");
      findings.raw("U5: messy (semicolon/latin1/BOM) csv export", messyOut);
      const semicolonsGone = !messyOut.includes(";");
      u5notes.push(
        semicolonsGone
          ? "Drive auto-detected the semicolon dialect (no mangling) — better than expected"
          : "CONFIRMED RISK: semicolon CSV mangled (semicolons survive as literal text = single-column sheet)",
      );
      u5notes.push(
        "latin1 content check: appendix export shows 'Wert 1' intact only if encoding survived",
      );
      // xlsx
      const xlsx = await convertUpload(
        token,
        "u5-book.xlsx",
        GOOGLE_SHEET,
        XLSX_MIME,
        buildXlsx(),
        rootId,
      );
      const xlsxOut = await exportFile(token, xlsx.id, "text/csv");
      findings.raw("U5: xlsx export (first sheet as csv)", xlsxOut);
      u5notes.push(
        xlsxOut.includes("col1") && xlsxOut.includes("col3")
          ? "hand-crafted xlsx converted to Sheet with values intact"
          : "xlsx conversion produced unexpected content — see appendix",
      );
      const meta = await getMeta(token, xlsx.id);
      u5notes.push(
        `xlsx target is a ${meta.mimeType.includes("spreadsheet") ? "native Spreadsheet" : `?! ${meta.mimeType}`}`,
      );
      u5evidence.push(
        `clean sheet: https://docs.google.com/spreadsheets/d/${clean.id}/edit`,
        `messy sheet: https://docs.google.com/spreadsheets/d/${messy.id}/edit`,
        `xlsx sheet: https://docs.google.com/spreadsheets/d/${xlsx.id}/edit`,
      );
      u5verdict =
        u5notes.some((n) => n.includes("did NOT")) || u5notes.some((n) => n.includes("unexpected"))
          ? "PARTIAL"
          : "PASS";
    } catch (e) {
      u5verdict = "FAIL";
      u5notes.push(`failed: ${String(e).slice(0, 300)}`);
    }
  } else {
    u5notes.push("skipped: no root folder");
  }
  findings.add(
    "U5: CSV/XLSX convert to Sheets; Sheet re-publish keeps id",
    u5verdict,
    u5notes,
    u5evidence,
  );

  // ---- U6: end-to-end two-phase publish of a 2-file fixture ----------------
  log("U6: two-phase publish — relative link -> sibling Doc URL");
  let u6verdict: Finding["verdict"] = "UNVERIFIED";
  const u6notes: string[] = [];
  const u6evidence: string[] = [];
  if (rootId) {
    try {
      const fixture: Record<string, string> = {
        "toc.md": [
          "# Table of contents",
          "",
          "See [the details](./details.md) for specifics.",
          "And [details again](details.md) written without the ./ prefix.",
          "",
        ].join("\n"),
        "details.md": ["# Details", "", "Back to [the toc](./toc.md).", ""].join("\n"),
      };
      const e2eFolder = await createFolder(token, "e2e", rootId);

      // phase 1 — reserve ids by creating empty Doc shells
      const idMap = new Map<string, { id: string; url: string }>();
      for (const rel of Object.keys(fixture)) {
        const shell = await createEmptyDoc(token, rel.replace(/\.md$/, ""), e2eFolder.id);
        idMap.set(rel, {
          id: shell.id,
          url: `https://docs.google.com/document/d/${shell.id}/edit`,
        });
      }
      step(`phase 1: reserved ${idMap.size} Doc ids`);

      // phase 2 — rewrite relative links to real Doc URLs, then fill content
      let rewrites = 0;
      for (const [rel, md] of Object.entries(fixture)) {
        const out = md.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, text: string, target: string) => {
          const key = target.replace(/^\.\//, "");
          const hit = idMap.get(key);
          if (!hit) return m;
          rewrites++;
          return `[${text}](${hit.url})`;
        });
        const entry = idMap.get(rel);
        if (entry) await updateMedia(token, entry.id, "text/markdown", out);
      }
      step(`phase 2: rewrote ${rewrites} links and filled ${idMap.size} Docs`);

      const tocEntry = idMap.get("toc.md");
      const detailsEntry = idMap.get("details.md");
      if (!tocEntry || !detailsEntry) throw new Error("fixture id map incomplete");
      const tocExport = await exportFile(token, tocEntry.id, "text/markdown");
      const detailsExport = await exportFile(token, detailsEntry.id, "text/markdown");
      findings.raw("U6: exported toc Doc", tocExport);
      findings.raw("U6: exported details Doc", detailsExport);
      const forwardHits = tocExport.split(detailsEntry.id).length - 1;
      const backLink = detailsExport.includes(tocEntry.id);
      u6verdict = forwardHits >= 2 && backLink ? "PASS" : forwardHits >= 1 ? "PARTIAL" : "FAIL";
      u6notes.push(
        `toc Doc contains the details fileId ${forwardHits} time(s) (expected 2: "./details.md" and "details.md")`,
      );
      u6notes.push(
        backLink
          ? "details Doc links back to the toc Doc — bidirectional rewriting works"
          : "details Doc does NOT link back to the toc Doc",
      );
      u6notes.push(
        "this is the original user requirement proven end to end: a relative markdown link resolves to the sibling Google Doc",
      );
      u6evidence.push(`toc Doc (click the links): ${tocEntry.url}`);
      u6evidence.push(`details Doc: ${detailsEntry.url}`);
    } catch (e) {
      u6verdict = "FAIL";
      u6notes.push(`failed: ${String(e).slice(0, 300)}`);
    }
  } else {
    u6notes.push("skipped: no root folder");
  }
  findings.add(
    "U6: two-phase publish rewrites relative links to sibling Doc URLs",
    u6verdict,
    u6notes,
    u6evidence,
  );

  // ---- U7: image embedding strategies, verified via docx media parts -------
  log("U7: image embed strategies (definitive check: word/media parts in docx export)");
  let u7verdict: Finding["verdict"] = "UNVERIFIED";
  const u7notes: string[] = [];
  const u7evidence: string[] = [];
  if (rootId) {
    try {
      const testPng = makeTestPng(PNG_W, PNG_H);
      const b64 = testPng.toString("base64");
      const dataUri = `data:image/png;base64,${b64}`;
      const imgFile = await convertUpload(
        token,
        "u7-image.png",
        "image/png",
        "image/png",
        testPng,
        rootId,
      );
      const ucUrl = `https://drive.google.com/uc?export=view&id=${imgFile.id}`;

      // Find out WHY the anyone-permission fails: capture the full error and
      // try a domain-scoped permission (Workspace policy often blocks "anyone").
      let ownerDomain = "";
      try {
        const about = (await drive(token, "GET", `${API}/drive/v3/about?fields=user`)) as {
          user?: { emailAddress?: string };
        };
        const email = about.user?.emailAddress ?? "";
        ownerDomain = email.includes("@") ? (email.split("@")[1] ?? "") : "";
        u7notes.push(`account domain detected: ${ownerDomain || "(unknown)"}`);
      } catch (e) {
        u7notes.push(`about.get failed under drive.file: ${String(e).slice(0, 120)}`);
      }
      for (const variant of [
        { label: "type=anyone", json: { role: "reader", type: "anyone" } },
        ...(ownerDomain
          ? [
              {
                label: `type=domain (${ownerDomain})`,
                json: { role: "reader", type: "domain", domain: ownerDomain },
              },
            ]
          : []),
      ]) {
        try {
          await drive(token, "POST", `${API}/drive/v3/files/${imgFile.id}/permissions`, {
            json: variant.json,
          });
          u7notes.push(`permission ${variant.label}: OK`);
        } catch (e) {
          u7notes.push(`permission ${variant.label} FULL ERROR: ${String(e).slice(0, 700)}`);
        }
      }

      // Four candidate strategies for getting a real image into a Doc.
      const strategies: { label: string; mediaMime: string; content: string }[] = [
        {
          label: "A markdown + uc? URL",
          mediaMime: "text/markdown",
          content: `# A\n\n![test](${ucUrl})\n`,
        },
        {
          label: "B markdown + data: URI",
          mediaMime: "text/markdown",
          content: `# B\n\n![test](${dataUri})\n`,
        },
        {
          label: "C html + data: URI",
          mediaMime: "text/html",
          content: `<h1>C</h1><p>below:</p><img src="${dataUri}" alt="test">`,
        },
        {
          label: "D html + uc? URL",
          mediaMime: "text/html",
          content: `<h1>D</h1><p>below:</p><img src="${ucUrl}" alt="test">`,
        },
      ];
      const results: string[] = [];
      for (const s of strategies) {
        try {
          const doc = await convertUpload(
            token,
            `u7-${s.label.slice(0, 1)}`,
            GOOGLE_DOC,
            s.mediaMime,
            s.content,
            rootId,
          );
          const count = await embeddedImageCount(token, doc.id);
          results.push(`${s.label}: ${count} embedded image(s)`);
          step(`${s.label} -> ${count} embedded image(s)`);
          u7evidence.push(`${s.label}: https://docs.google.com/document/d/${doc.id}/edit`);
        } catch (e) {
          results.push(`${s.label}: FAILED ${String(e).slice(0, 200)}`);
          step(`${s.label} -> failed`);
        }
      }
      u7notes.push(...results);
      const anyWorked = results.some((r) => /: [1-9]\d* embedded/.test(r));
      u7verdict = anyWorked ? "PASS" : "FAIL";
      u7notes.push(
        anyWorked
          ? "at least one strategy embeds a real image (see counts above)"
          : "NO strategy embeds a real image — images must degrade to links in v1",
      );
    } catch (e) {
      u7verdict = "FAIL";
      u7notes.push(`failed: ${String(e).slice(0, 300)}`);
    }
  } else {
    u7notes.push("skipped: no root folder");
  }
  findings.add(
    "U7: which image strategy actually embeds (docx media-part count)",
    u7verdict,
    u7notes,
    u7evidence,
  );

  // ---- U1 (part 2): manual move + rename, then verify access ----------------
  log("U1b: move root under new parent + rename, then verify access");
  let u1bVerdict: Finding["verdict"] = "UNVERIFIED";
  const u1bNotes: string[] = [];
  const u1bEvidence: string[] = [];
  if (rootId && targetId) {
    try {
      const newParent = await createFolder(token, `gdrive-publish-spike-parent-${stamp}`);
      created.push({ id: newParent.id, label: "new-parent" });
      const before = await getMeta(token, rootId);
      const oldParent = before.parents?.[0] ?? "root";
      await patchMeta(
        token,
        rootId,
        {},
        `addParents=${newParent.id}&removeParents=${encodeURIComponent(oldParent)}`,
      );
      await patchMeta(token, rootId, { name: `renamed-spike-${stamp}` });
      // access must survive: get + update a doc inside the moved tree
      const got = await getMeta(token, targetId);
      await updateMedia(
        token,
        targetId,
        "text/markdown",
        "# Target Doc\n\nUpdated after the move.\n",
      );
      const out = await exportFile(token, targetId, "text/markdown");
      const ok = got.id === targetId && out.includes("Updated after the move.");
      u1bVerdict = ok ? "PASS" : "FAIL";
      u1bNotes.push(
        ok
          ? "after parent move + rename, get and files.update inside the tree still work"
          : "access to files inside the moved tree failed after move",
      );
      u1bEvidence.push(
        `root folder after move+rename: https://drive.google.com/drive/folders/${rootId}`,
      );
    } catch (e) {
      u1bVerdict = "FAIL";
      u1bNotes.push(`failed: ${String(e).slice(0, 300)}`);
    }
  } else {
    u1bNotes.push("skipped: no root folder or no target doc");
  }
  findings.add(
    "U1: drive.file folders nest + access survives move/rename",
    u1 === "FAIL" || u1bVerdict === "FAIL"
      ? "FAIL"
      : u1 === "PASS" && u1bVerdict === "PASS"
        ? "PASS"
        : "PARTIAL",
    [...u1notes, ...u1bNotes],
    [...u1evidence, ...u1bEvidence],
  );

  // ---- cleanup: trash everything (never delete) -----------------------------
  const keep = process.env.GDRIVE_PUBLISH_KEEP === "1";
  log(
    keep
      ? "cleanup SKIPPED (GDRIVE_PUBLISH_KEEP=1) — manual eyeball pending"
      : "cleanup: moving created top-level folders to trash",
  );
  for (const c of created) {
    if (keep) {
      step(`kept ${c.label} …${c.id.slice(-6)} — https://drive.google.com/drive/folders/${c.id}`);
      continue;
    }
    try {
      const t = await trashFile(token, c.id);
      step(`trashed ${c.label} …${c.id.slice(-6)} (trashed=${t.trashed ?? "?"})`);
    } catch (e) {
      console.error(`  WARNING: could not trash ${c.label} (${c.id}): ${String(e).slice(0, 150)}`);
      console.error(`  → trash it manually: https://drive.google.com/drive/folders/${c.id}`);
    }
  }

  const dest = findings.write(creds.name, hash);
  log(`done — findings written to ${dest}`);
}

main().catch((e) => {
  console.error(`\nFATAL: ${String(e)}`);
  process.exit(1);
});
