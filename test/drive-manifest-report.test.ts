/**
 * REST client, manifest IO and report rendering tests.
 *
 * The Drive client is exercised by swapping `globalThis.fetch`, so the exact
 * request shapes are asserted without network access: convert-on-upload must
 * send metadata mimeType = Google type with media mimeType = source type, and
 * content updates must use `uploadType=media` on the existing fileId (the
 * mechanic that keeps URLs stable).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DriveError, RestDriveClient } from "../core/drive.ts";
import * as manifestIo from "../core/manifest.ts";
import { planJson, renderDiagnostics, renderPlan, renderSummary } from "../core/report.ts";
import { GOOGLE_DOC, GOOGLE_SHEET, driveUrl, folderUrl } from "../core/types.ts";
import type { Diagnostic, Manifest, Plan, PublishSummary } from "../core/types.ts";

interface Captured {
  method: string;
  url: string;
  contentType: string | undefined;
  auth: string | undefined;
  body: string;
}

let captured: Captured[];
const realFetch = globalThis.fetch;

function stubFetch(response: unknown, status = 200): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body = "";
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body) body = Buffer.from(init.body as Uint8Array).toString("utf8");
    captured.push({
      method: init?.method ?? "GET",
      url: String(url),
      contentType: headers["Content-Type"],
      auth: headers.Authorization,
      body,
    });
    return new Response(typeof response === "string" ? response : JSON.stringify(response), {
      status,
    });
  }) as typeof fetch;
}

const tokens = { accessToken: async () => "TEST_TOKEN" };

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("createFolder posts folder metadata with the parent", async () => {
  stubFetch({ id: "fld1", name: "Docs", mimeType: "application/vnd.google-apps.folder" });
  const client = new RestDriveClient(tokens);
  const folder = await client.createFolder("Docs", "parent1");
  assert.equal(folder.id, "fld1");
  const call = captured[0];
  assert.equal(call?.method, "POST");
  assert.match(call?.url ?? "", /drive\/v3\/files\?fields=/);
  assert.equal(call?.auth, "Bearer TEST_TOKEN");
  const sent = JSON.parse(call?.body ?? "{}") as Record<string, unknown>;
  assert.equal(sent.mimeType, "application/vnd.google-apps.folder");
  assert.deepEqual(sent.parents, ["parent1"]);
});

test("createEmptyDoc requests a native Google Doc with no media", async () => {
  stubFetch({ id: "doc1", name: "A", mimeType: GOOGLE_DOC });
  await new RestDriveClient(tokens).createEmptyDoc("A", "fld1");
  const sent = JSON.parse(captured[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(sent.mimeType, GOOGLE_DOC, "phase 1 must create a real Doc shell");
  assert.equal(captured[0]?.contentType, "application/json");
});

test("convertUpload sends metadata mime + media mime as multipart/related", async () => {
  stubFetch({ id: "sht1", name: "data", mimeType: GOOGLE_SHEET });
  await new RestDriveClient(tokens).convertUpload(
    "data",
    GOOGLE_SHEET,
    "text/csv",
    "a,b\n1,2\n",
    "fld1",
  );
  const call = captured[0];
  assert.match(call?.url ?? "", /uploadType=multipart/);
  assert.match(call?.contentType ?? "", /^multipart\/related; boundary=/);
  // metadata part declares the Google type, media part the source type
  assert.match(call?.body ?? "", new RegExp(`"mimeType":"${GOOGLE_SHEET.replace(/\./g, "\\.")}"`));
  assert.match(call?.body ?? "", /Content-Type: text\/csv/);
  assert.match(call?.body ?? "", /a,b/);
});

test("updateMedia patches the existing fileId with uploadType=media", async () => {
  stubFetch({});
  await new RestDriveClient(tokens).updateMedia("doc1", "text/markdown", "# hi\n");
  const call = captured[0];
  assert.equal(call?.method, "PATCH");
  assert.match(call?.url ?? "", /upload\/drive\/v3\/files\/doc1\?uploadType=media/);
  assert.equal(call?.contentType, "text/markdown");
  assert.equal(call?.body, "# hi\n");
});

test("trash sets trashed:true and never issues a DELETE", async () => {
  stubFetch({ id: "doc1", trashed: true });
  await new RestDriveClient(tokens).trash("doc1");
  assert.equal(captured[0]?.method, "PATCH");
  assert.deepEqual(JSON.parse(captured[0]?.body ?? "{}"), { trashed: true });
  assert.ok(!captured.some((c) => c.method === "DELETE"), "hard deletion must never happen");
});

test("errors surface the Google reason code", async () => {
  stubFetch(
    {
      error: {
        code: 400,
        message: 'Bad Request. User message: ""',
        errors: [{ reason: "publishOutNotPermitted" }],
      },
    },
    400,
  );
  await assert.rejects(
    () => new RestDriveClient(tokens).get("doc1"),
    (e: unknown) =>
      e instanceof DriveError && e.status === 400 && e.reason === "publishOutNotPermitted",
  );
});

test("a non-JSON error body still yields a DriveError", async () => {
  stubFetch("<html>gateway timeout</html>", 504);
  await assert.rejects(
    () => new RestDriveClient(tokens).get("doc1"),
    (e: unknown) => e instanceof DriveError && e.status === 504 && e.reason === "",
  );
});

test("exportText requests the right export mime type", async () => {
  stubFetch("# exported\n");
  const text = await new RestDriveClient(tokens).exportText("doc1", "text/markdown");
  assert.equal(text, "# exported\n");
  assert.match(captured[0]?.url ?? "", /export\?mimeType=text%2Fmarkdown/);
});

// ---------------------------------------------------------------------------
// manifest IO
// ---------------------------------------------------------------------------

test("manifest round-trips and rejects a future version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-man-"));
  try {
    const manifest = manifestIo.emptyManifest("fld1", "Docs");
    manifest.entries["a.md"] = {
      fileId: "doc1",
      kind: "markdown",
      name: "A",
      url: driveUrl("markdown", "doc1"),
      contentHash: "hash",
      publishedAt: "2024-01-01T00:00:00.000Z",
    };
    manifestIo.save(root, manifest);
    const loaded = manifestIo.load(root);
    assert.equal(loaded?.entries["a.md"]?.fileId, "doc1");

    fs.writeFileSync(
      path.join(root, ".gdrive-manifest.json"),
      JSON.stringify({ version: 99, rootFolderId: "x" }),
    );
    assert.throws(() => manifestIo.load(root), /version 99/);

    fs.writeFileSync(path.join(root, ".gdrive-manifest.json"), JSON.stringify({ version: 1 }));
    assert.throws(() => manifestIo.load(root), /rootFolderId/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("load returns null when there is no manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-man-"));
  try {
    assert.equal(manifestIo.load(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("serialisation is stable and diff-friendly", () => {
  const manifest = manifestIo.emptyManifest("fld1", "Docs");
  manifest.folders = { "z/deep": "f2", a: "f1" };
  for (const rel of ["z.md", "a.md", "m.md"]) {
    manifest.entries[rel] = {
      fileId: `id-${rel}`,
      kind: "markdown",
      name: rel,
      url: driveUrl("markdown", `id-${rel}`),
      contentHash: "h",
      publishedAt: "2024-01-01T00:00:00.000Z",
    };
  }
  const text = manifestIo.serialize(manifest);
  assert.deepEqual(Object.keys((JSON.parse(text) as Manifest).entries), ["a.md", "m.md", "z.md"]);
  assert.deepEqual(Object.keys((JSON.parse(text) as Manifest).folders), ["a", "z/deep"]);
  assert.equal(text, manifestIo.serialize(manifest), "serialisation must be deterministic");
  assert.match(text, /\n$/);
});

test("pendingEntries lists only unfilled Docs", () => {
  const manifest = manifestIo.emptyManifest("fld1", "Docs");
  manifest.entries["done.md"] = {
    fileId: "1",
    kind: "markdown",
    name: "done",
    url: "u",
    contentHash: "h",
    publishedAt: "t",
  };
  manifest.entries["pending.md"] = {
    fileId: "2",
    kind: "markdown",
    name: "pending",
    url: "u",
    contentHash: "",
    publishedAt: "t",
    pending: true,
  };
  assert.deepEqual(manifestIo.pendingEntries(manifest), ["pending.md"]);
});

test("contentHash is stable and differs per content", () => {
  assert.equal(manifestIo.contentHash("abc"), manifestIo.contentHash(Buffer.from("abc")));
  assert.notEqual(manifestIo.contentHash("abc"), manifestIo.contentHash("abd"));
});

// ---------------------------------------------------------------------------
// report rendering
// ---------------------------------------------------------------------------

function samplePlan(): Plan {
  return {
    root: "/docs",
    rootFolderId: "fld1",
    folders: ["guide"],
    items: [
      { relPath: "new.md", kind: "markdown", action: "create", name: "New", folder: "" },
      {
        relPath: "upd.md",
        kind: "markdown",
        action: "update",
        name: "Upd",
        fileId: "d2",
        folder: "",
      },
      {
        relPath: "same.md",
        kind: "markdown",
        action: "unchanged",
        name: "Same",
        fileId: "d3",
        folder: "",
      },
    ],
    orphans: [{ relPath: "gone.md", fileId: "d4", name: "Gone" }],
    rawSuggestion: null,
    diagnostics: [
      { code: "ANCHOR_DROPPED", severity: "warn", relPath: "upd.md", message: "anchor dropped" },
      { code: "DOC_PAYLOAD_TOO_LARGE", severity: "error", relPath: "new.md", message: "too big" },
    ],
  };
}

test("renderPlan marks actions, orphans and counts", () => {
  const out = renderPlan(samplePlan(), "/docs");
  assert.match(out, /\+ new\.md/);
  assert.match(out, /~ upd\.md/);
  assert.match(out, /= same\.md/);
  assert.match(out, /! gone\.md.*orphan/);
  assert.match(out, /1 to create, 1 to update, 1 unchanged, 1 orphan/);
});

test("renderDiagnostics puts errors before warnings", () => {
  const out = renderDiagnostics(samplePlan().diagnostics);
  assert.ok(out.indexOf("ERROR") < out.indexOf("WARN"), "errors first");
  assert.match(out, /ERROR DOC_PAYLOAD_TOO_LARGE new\.md/);
  assert.match(out, /WARN {2}ANCHOR_DROPPED upd\.md/);
  assert.equal(renderDiagnostics([]), "");
});

test("renderSummary always reminds the user to commit the manifest", () => {
  const summary: PublishSummary = {
    created: 1,
    updated: 2,
    repaired: 1,
    failed: 0,
    unchanged: 3,
    pruned: 0,
    orphans: 1,
    diagnostics: [] as Diagnostic[],
    manifestPath: "/docs/.gdrive-manifest.json",
    rootFolderUrl: folderUrl("fld1"),
  };
  const out = renderSummary(summary);
  assert.match(out, /1 created, 2 updated, 1 repaired, 3 unchanged, 0 pruned, 0 failed, 1 orphan/);
  assert.match(out, /commit the manifest/);
  assert.match(out, /drive\.google\.com\/drive\/folders\/fld1/);
});

test("planJson is serialisable and preserves diagnostics", () => {
  const json = planJson(samplePlan()) as { diagnostics: Diagnostic[] };
  const round = JSON.parse(JSON.stringify(json)) as { diagnostics: Diagnostic[] };
  assert.equal(round.diagnostics.length, 2);
  assert.equal(round.diagnostics[1]?.severity, "error");
});

test("driveUrl points Docs and Sheets at the right product", () => {
  assert.match(driveUrl("markdown", "x"), /docs\.google\.com\/document\/d\/x\/edit/);
  assert.match(driveUrl("csv", "x"), /docs\.google\.com\/spreadsheets\/d\/x\/edit/);
  assert.match(driveUrl("xlsx", "x"), /spreadsheets/);
});
