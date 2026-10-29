/**
 * Credential resolution and token identity tests.
 *
 * `auth.ts` was the largest untested module, and it encodes two rules learned
 * the hard way in the spike:
 *   - `rclone config dump` returns plaintext secrets, and `rclone reveal` on
 *     plaintext returns garbage with exit code 0 (cost an invalid_client
 *     debugging session), so only non-`GOCSPX-` values may be revealed
 *   - tokens must be keyed per client_id, because `drive.file` access is
 *     per-client and a mismatched cached token fails opaquely
 *
 * The rclone branch is exercised through a stub `rclone` executable placed on
 * PATH, so no real rclone config is touched.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { AuthError, clientHash, resolveCredentials, tokenPath } from "../core/auth.ts";

let tmp: string;
let home: string;
const ORIGINAL_PATH = process.env.PATH ?? "";
const ORIGINAL_HOME = process.env.HOME ?? "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-auth-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-authhome-"));
  // Isolate HOME: a real ~/.config/gdrive-publish/client_secret.json on the
  // developer's machine would otherwise win over the sources under test.
  process.env.HOME = home;
});

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/** Put a fake `rclone` on PATH that prints the given config dump. */
function stubRclone(dump: unknown, revealOutput = "revealed-garbage"): void {
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh
if [ "$1" = "config" ]; then
  cat <<'JSON'
${JSON.stringify(dump)}
JSON
  exit 0
fi
if [ "$1" = "reveal" ]; then
  printf '%s' '${revealOutput}'
  exit 0
fi
exit 1
`;
  fs.writeFileSync(path.join(bin, "rclone"), script, { mode: 0o755 });
  process.env.PATH = `${bin}:${ORIGINAL_PATH}`;
}

function clientSecretFile(dir: string, id: string, secret: string): string {
  const p = path.join(dir, "client_secret.json");
  fs.writeFileSync(p, JSON.stringify({ installed: { client_id: id, client_secret: secret } }));
  return p;
}

test("env pair wins over every other source", () => {
  const file = clientSecretFile(tmp, "file-id", "GOCSPX-file");
  stubRclone({ r1: { type: "drive", client_id: "rclone-id", client_secret: "GOCSPX-rclone" } });
  const creds = resolveCredentials({
    GDRIVE_PUBLISH_CLIENT_ID: "env-id",
    GDRIVE_PUBLISH_CLIENT_SECRET: "env-secret",
    GDRIVE_PUBLISH_CLIENT_SECRET_FILE: file,
  });
  assert.equal(creds.clientId, "env-id");
  assert.equal(creds.source, "env pair");
});

test("explicit secret-file path wins over rclone", () => {
  const file = clientSecretFile(tmp, "file-id", "GOCSPX-file");
  stubRclone({ r1: { type: "drive", client_id: "rclone-id", client_secret: "GOCSPX-rclone" } });
  const creds = resolveCredentials({ GDRIVE_PUBLISH_CLIENT_SECRET_FILE: file });
  assert.equal(creds.clientId, "file-id");
  assert.match(creds.source, /^file /);
});

test("a `web` shaped client_secret.json is also accepted", () => {
  const p = path.join(tmp, "web.json");
  fs.writeFileSync(p, JSON.stringify({ web: { client_id: "web-id", client_secret: "s" } }));
  const creds = resolveCredentials({ GDRIVE_PUBLISH_CLIENT_SECRET_FILE: p });
  assert.equal(creds.clientId, "web-id");
});

test("a malformed secret file is skipped in favour of the next source", () => {
  const p = path.join(tmp, "broken.json");
  fs.writeFileSync(p, "{ not json");
  stubRclone({ r1: { type: "drive", client_id: "rclone-id", client_secret: "GOCSPX-rclone" } });
  const creds = resolveCredentials({ GDRIVE_PUBLISH_CLIENT_SECRET_FILE: p });
  assert.equal(creds.clientId, "rclone-id");
});

test("falls back to the only rclone drive remote", () => {
  stubRclone({
    other: { type: "s3" },
    gdrive: { type: "drive", client_id: "rclone-id", client_secret: "GOCSPX-plain" },
  });
  const creds = resolveCredentials({});
  assert.equal(creds.clientId, "rclone-id");
  assert.equal(creds.source, 'rclone remote "gdrive"');
});

test("a plaintext GOCSPX- secret is NOT passed through rclone reveal", () => {
  // Regression: reveal on plaintext returns garbage with exit 0, which produced
  // an opaque invalid_client failure during the spike.
  stubRclone(
    { gdrive: { type: "drive", client_id: "id", client_secret: "GOCSPX-real-secret" } },
    "GARBAGE",
  );
  const creds = resolveCredentials({});
  assert.equal(creds.clientSecret, "GOCSPX-real-secret");
});

test("an obscured secret IS passed through rclone reveal", () => {
  stubRclone(
    { gdrive: { type: "drive", client_id: "id", client_secret: "obscured-blob-xyz" } },
    "GOCSPX-revealed",
  );
  const creds = resolveCredentials({});
  assert.equal(creds.clientSecret, "GOCSPX-revealed");
});

test("ambiguous rclone remotes produce an actionable error", () => {
  stubRclone({
    a: { type: "drive", client_id: "1", client_secret: "GOCSPX-1" },
    b: { type: "drive", client_id: "2", client_secret: "GOCSPX-2" },
  });
  assert.throws(
    () => resolveCredentials({}),
    (e: unknown) =>
      e instanceof AuthError &&
      /ambiguous/.test(e.message) &&
      /GDRIVE_PUBLISH_RCLONE_REMOTE/.test(e.message),
  );
});

test("an explicit remote name disambiguates", () => {
  stubRclone({
    a: { type: "drive", client_id: "1", client_secret: "GOCSPX-1" },
    b: { type: "drive", client_id: "2", client_secret: "GOCSPX-2" },
  });
  const creds = resolveCredentials({ GDRIVE_PUBLISH_RCLONE_REMOTE: "b" });
  assert.equal(creds.clientId, "2");
});

test("an unknown explicit remote name errors instead of guessing", () => {
  stubRclone({ a: { type: "drive", client_id: "1", client_secret: "GOCSPX-1" } });
  assert.throws(
    () => resolveCredentials({ GDRIVE_PUBLISH_RCLONE_REMOTE: "nope" }),
    (e: unknown) => e instanceof AuthError && /not found/.test(e.message),
  );
});

test("remotes without their own client credentials are ignored", () => {
  stubRclone({ shared: { type: "drive" } });
  assert.throws(
    () => resolveCredentials({}),
    (e: unknown) => e instanceof AuthError && /no credential source found/.test(e.message),
  );
});

test("a missing rclone binary yields a message naming every option", () => {
  const bin = path.join(tmp, "empty-bin");
  fs.mkdirSync(bin, { recursive: true });
  process.env.PATH = bin; // no rclone at all
  assert.throws(
    () => resolveCredentials({}),
    (e: unknown) =>
      e instanceof AuthError &&
      /GDRIVE_PUBLISH_CLIENT_ID/.test(e.message) &&
      /client_secret\.json/.test(e.message),
  );
});

test("token paths are keyed by client_id hash, not shared", () => {
  const a = tokenPath("client-a.apps.googleusercontent.com");
  const b = tokenPath("client-b.apps.googleusercontent.com");
  assert.notEqual(a, b, "different clients must not share a token file");
  assert.match(path.basename(a), /^token-[0-9a-f]{8}\.json$/);
  assert.equal(clientHash("client-a.apps.googleusercontent.com").length, 8);
  // stable across calls
  assert.equal(tokenPath("client-a.apps.googleusercontent.com"), a);
});
