/**
 * markdownMode: config plumbing, manifest stamping and the MODE_MISMATCH
 * guard (design: docs/native-markdown-mode.md, slice 1). The native publish
 * behaviour (raw .md files, no image inlining, kept anchors) lives in
 * publish.test.ts and scan-prepare.test.ts.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  effectiveMode,
  loadConfig,
  parseMarkdownMode,
  resolveTreeMode,
  saveConfig,
} from "../core/config.ts";
import * as manifestIo from "../core/manifest.ts";
import { prepareMarkdown } from "../core/prepare.ts";
import { buildPlan, publish } from "../core/publish.ts";
import type { Manifest } from "../core/types.ts";
import { FakeDrive } from "./fake-drive.ts";

const CLI = path.join(import.meta.dirname, "..", "cli.ts");

let root: string;
let home: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-mode-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-home-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// config parsing
// ---------------------------------------------------------------------------

test("markdownMode: accepted in the config file, round-trips through saveConfig", () => {
  saveConfig(root, { rawPatterns: [], markdownMode: "native" });
  const loaded = loadConfig(root);
  assert.equal(loaded?.markdownMode, "native");
  assert.equal(effectiveMode(loaded), "native");
});

test("markdownMode: absent key and absent config both mean doc", () => {
  saveConfig(root, { rawPatterns: [] });
  assert.equal(loadConfig(root)?.markdownMode, undefined);
  assert.equal(effectiveMode(loadConfig(root)), "doc");
  assert.equal(effectiveMode(null), "doc");
});

test("markdownMode: anything but doc|native is a hard error", () => {
  fs.writeFileSync(path.join(root, ".gdrive-publish.json"), '{"markdownMode": "raw"}');
  assert.throws(() => loadConfig(root), /markdownMode.*must be one of "doc", "native"/);
});

test("parseMarkdownMode: strict doc|native for flags", () => {
  assert.equal(parseMarkdownMode("doc"), "doc");
  assert.equal(parseMarkdownMode("native"), "native");
  for (const bad of ["", "Doc", "docs", "markdown", "raw", "doc ", "native-mode"]) {
    assert.equal(parseMarkdownMode(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// resolveTreeMode: the stamp wins, disagreements refuse
// ---------------------------------------------------------------------------

test("resolveTreeMode: without a manifest the config's wish applies", () => {
  assert.deepEqual(resolveTreeMode(null, null), { mode: "doc" });
  assert.deepEqual(resolveTreeMode(null, { rawPatterns: [] }), { mode: "doc" });
  assert.deepEqual(resolveTreeMode(null, { rawPatterns: [], markdownMode: "native" }), {
    mode: "native",
  });
});

test("resolveTreeMode: a stamped manifest wins over a silent config", () => {
  const manifest = manifestIo.emptyManifest("fld", "D");
  manifest.markdownMode = "native";
  // config absent (a machine that only has the manifest) stays native
  assert.deepEqual(resolveTreeMode(manifest, null), { mode: "native" });
  // config present but without the key: still native, no mismatch
  assert.deepEqual(resolveTreeMode(manifest, { rawPatterns: [] }), { mode: "native" });
});

test("resolveTreeMode: manifest and config agreeing is fine in both modes", () => {
  for (const mode of ["doc", "native"] as const) {
    const manifest = manifestIo.emptyManifest("fld", "D");
    manifest.markdownMode = mode;
    const resolution = resolveTreeMode(manifest, { rawPatterns: [], markdownMode: mode });
    assert.equal(resolution.mode, mode);
    assert.equal(resolution.mismatchMessage, undefined);
  }
});

test("resolveTreeMode: config contradicting the stamp is a mismatch", () => {
  const manifest = manifestIo.emptyManifest("fld", "D");
  manifest.markdownMode = "doc";
  const resolution = resolveTreeMode(manifest, { rawPatterns: [], markdownMode: "native" });
  assert.equal(resolution.mode, "doc");
  assert.match(resolution.mismatchMessage ?? "", /MODE_MISMATCH.*native/);
  assert.match(resolution.mismatchMessage ?? "", /delete .*manifest.*re-run init/);
});

test("resolveTreeMode: an unstamped (legacy) tree asking for native is a mismatch", () => {
  const manifest = manifestIo.emptyManifest("fld", "D");
  const resolution = resolveTreeMode(manifest, { rawPatterns: [], markdownMode: "native" });
  assert.equal(resolution.mode, "doc");
  assert.match(resolution.mismatchMessage ?? "", /MODE_MISMATCH/);
  // ... while a legacy tree without the key keeps the historical doc mode
  const quiet = resolveTreeMode(manifest, { rawPatterns: [] });
  assert.deepEqual(quiet, { mode: "doc" });
});

// ---------------------------------------------------------------------------
// manifest stamping and serialisation
// ---------------------------------------------------------------------------

test("the mode stamp round-trips through the manifest", () => {
  const manifest = manifestIo.emptyManifest("fld", "D");
  manifest.markdownMode = "native";
  manifestIo.save(root, manifest);
  const loaded = manifestIo.load(root);
  assert.equal(loaded?.markdownMode, "native");
  assert.match(manifestIo.serialize(manifest), /"markdownMode": "native"/);
  // unstamped manifests serialise without the key (legacy files stay byte-identical)
  const legacy = manifestIo.emptyManifest("fld", "D");
  assert.ok(!manifestIo.serialize(legacy).includes("markdownMode"));
});

// ---------------------------------------------------------------------------
// plan and publish enforcement
// ---------------------------------------------------------------------------

test("plan reports MODE_MISMATCH as an error and keeps the manifest's mode", () => {
  fs.writeFileSync(path.join(root, "a.md"), "# A\n");
  const manifest = manifestIo.emptyManifest("fldROOT", "D");
  manifest.markdownMode = "doc";
  manifestIo.save(root, manifest);
  saveConfig(root, { rawPatterns: [], markdownMode: "native" });
  const plan = buildPlan({ root, manifest });
  assert.equal(plan.markdownMode, "doc");
  const mismatch = plan.diagnostics.find((d) => d.code === "MODE_MISMATCH");
  assert.ok(mismatch, "plan must carry a MODE_MISMATCH diagnostic");
  assert.equal(mismatch.severity, "error");
});

test("plan defaults to doc mode and never stamps legacy trees", () => {
  fs.writeFileSync(path.join(root, "a.md"), "# A\n");
  const manifest = manifestIo.emptyManifest("fldROOT", "D");
  const plan = buildPlan({ root, manifest });
  assert.equal(plan.markdownMode, "doc");
  assert.equal(manifest.markdownMode, undefined, "planning never mutates the manifest");
});

test("publish refuses a mode mismatch before touching Drive", async () => {
  fs.writeFileSync(path.join(root, "a.md"), "# A\n");
  const manifest = manifestIo.emptyManifest("fldROOT", "D");
  manifestIo.save(root, manifest);
  saveConfig(root, { rawPatterns: [], markdownMode: "native" });
  const plan = buildPlan({ root, manifest });
  const drive = new FakeDrive();
  await assert.rejects(
    publish({ root, drive, manifest, plan, prune: false, repair: false, concurrency: 1 }),
    /MODE_MISMATCH/,
  );
  assert.equal(drive.calls.length, 0, "no Drive call may happen on refusal");
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      GDRIVE_PUBLISH_CLIENT_ID: "test-client-id",
      GDRIVE_PUBLISH_CLIENT_SECRET: "test-secret",
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("init rejects an invalid --markdown-mode value as a usage error (exit 2)", () => {
  const out = runCli(["init", root, "--name", "D", "--markdown-mode", "raw"]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--markdown-mode expects doc or native/);
});

test("plan output shows the markdown mode", () => {
  fs.writeFileSync(path.join(root, "a.md"), "# A\n");
  const out = runCli(["plan", root]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /markdown mode: doc \(converted to Google Docs\)/);
});

// ---------------------------------------------------------------------------
// prepareMarkdown: the native preparation rules
// ---------------------------------------------------------------------------

function nativePrepare(markdown: string, relPath = "a.md"): ReturnType<typeof prepareMarkdown> {
  return prepareMarkdown({
    relPath,
    markdown,
    resolved: new Map([
      [
        "other.md",
        { fileId: "f2", url: "https://drive.google.com/file/d/f2/view", kind: "markdown" },
      ],
    ]),
    root,
    known: new Set(["a.md", "other.md"]),
    mode: "native",
  });
}

test("native mode rewrites links to the file view URL and keeps anchors", () => {
  const out = nativePrepare("[see](./other.md#section)\n");
  assert.equal(out.content, "[see](https://drive.google.com/file/d/f2/view#section)\n");
  const unverified = out.diagnostics.filter((d) => d.code === "ANCHOR_UNVERIFIED");
  assert.equal(unverified.length, 1);
  assert.equal(unverified[0]?.severity, "info");
  assert.equal(out.diagnostics.filter((d) => d.code === "ANCHOR_DROPPED").length, 0);
});

test("native mode leaves local images verbatim with a warn naming the options", () => {
  fs.writeFileSync(path.join(root, "img.png"), Buffer.from("fake"));
  const out = nativePrepare("![alt](./img.png)\n");
  assert.equal(out.content, "![alt](./img.png)\n");
  const warn = out.diagnostics.find((d) => d.code === "MD_NATIVE_IMAGE_LOCAL");
  assert.ok(warn, "local image must warn in native mode");
  assert.match(warn.message, /remote https URL.*doc mode/);
  assert.equal(out.inlinedImages, 0, "native mode never inlines");
  // remote images stay untouched and unremarked
  const remote = nativePrepare("![alt](https://example.com/i.png)\n");
  assert.equal(remote.content, "![alt](https://example.com/i.png)\n");
  assert.equal(remote.diagnostics.filter((d) => d.code === "MD_NATIVE_IMAGE_LOCAL").length, 0);
});

test("native mode strips front matter with Markdown-Mode-specific wording", () => {
  const out = nativePrepare("---\ntitle: The Title\n---\n# Body\n");
  assert.ok(!out.content.includes("title:"));
  const warn = out.diagnostics.find((d) => d.code === "FRONTMATTER_STRIPPED");
  assert.ok(warn);
  assert.match(warn.message, /Markdown Mode viewer/);
  assert.match(warn.message, /"The Title" used as the file name/);
});

test("native mode has no 10 MB Docs payload cap", () => {
  const big = `${"# Heading\n"}${"x".repeat(10 * 1024 * 1024 + 1024)}`;
  const out = nativePrepare(big);
  assert.equal(out.diagnostics.filter((d) => d.code === "DOC_PAYLOAD_TOO_LARGE").length, 0);
  // ... while the same document in doc mode still trips the cap
  const docMode = prepareMarkdown({
    relPath: "a.md",
    markdown: big,
    resolved: new Map(),
    root,
    known: new Set(["a.md"]),
    mode: "doc",
  });
  assert.equal(docMode.diagnostics.filter((d) => d.code === "DOC_PAYLOAD_TOO_LARGE").length, 1);
});

// ---------------------------------------------------------------------------
// the native publish run (end to end against the fake Drive)
// ---------------------------------------------------------------------------

function fixture(files: Record<string, string | Buffer>): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function nativeManifest(): Manifest {
  const manifest = manifestIo.emptyManifest("fldROOT", "Test Docs");
  manifest.markdownMode = "native";
  return manifest;
}

async function runNative(
  manifest: Manifest,
  drive = new FakeDrive(),
): Promise<ReturnType<typeof publish>> {
  drive.files.set("fldROOT", { id: "fldROOT", name: "Test Docs", mimeType: "folder" });
  const plan = buildPlan({ root, manifest });
  const summary = await publish({
    root,
    drive,
    manifest,
    plan,
    prune: false,
    repair: false,
    concurrency: 1,
    now: () => new Date("2024-01-01T00:00:00.000Z"),
  });
  return summary;
}

test("native publish reserves raw .md shells, fills them, and links to file view URLs", async () => {
  fixture({
    "toc.md": "# TOC\n\nSee [the details](./details.md).\n",
    "details.md": "# Details\n\nBack to [toc](./toc.md).\n",
  });
  const manifest = nativeManifest();
  const drive = new FakeDrive();
  const summary = await runNative(manifest, drive);

  assert.equal(summary.markdownMode, "native");
  assert.equal(
    drive.calls.filter((c) => c.startsWith("createEmptyDoc")).length,
    0,
    "native mode never creates Docs",
  );
  const reserves = drive.calls.filter((c) => c.startsWith("createEmptyFile"));
  assert.equal(reserves.length, 2);
  for (const call of reserves) {
    assert.match(call, /createEmptyFile\((TOC|Details),text\/markdown,fldROOT\)/);
  }

  const detailsId = manifest.entries["details.md"]?.fileId as string;
  assert.equal(drive.files.get(detailsId)?.mimeType, "text/markdown");
  const filled = drive.contentOf(detailsId);
  assert.match(filled, /Back to \[toc\]\(https:\/\/drive\.google\.com\/file\/d\/[^/]+\/view\)/);
  // the manifest entry points at the file view URL, not a Docs edit URL
  assert.match(manifest.entries["details.md"]?.url ?? "", /drive\.google\.com\/file\/d\/\w+\/view/);
  assert.equal(summary.created, 2);
});

test("native publish leaves local images unuploaded and un-inlined", async () => {
  fixture({
    "a.md": "# A\n\n![pic](./pic.png)\n",
    "pic.png": Buffer.from("fake png bytes"),
  });
  const manifest = nativeManifest();
  const drive = new FakeDrive();
  const summary = await runNative(manifest, drive);

  const content = drive.contentOf(manifest.entries["a.md"]?.fileId as string);
  assert.ok(content.includes("![pic](./pic.png)"), "image link stays verbatim");
  assert.ok(!content.includes("data:"), "no data URI is ever produced");
  assert.equal(
    drive.calls.filter((c) => c.startsWith("convertUpload")).length,
    0,
    "the image is not uploaded as a file either",
  );
  assert.equal(summary.diagnostics.filter((d) => d.code === "MD_NATIVE_IMAGE_LOCAL").length, 1);
});

test("native publish reports ANCHOR_UNVERIFIED once per run, not per link", async () => {
  fixture({
    "a.md": "[one](./b.md#x) and [two](./b.md#y)\n",
    "b.md": "# B\n",
  });
  const manifest = nativeManifest();
  const summary = await runNative(manifest);
  const unverified = summary.diagnostics.filter((d) => d.code === "ANCHOR_UNVERIFIED");
  assert.equal(unverified.length, 1, "deduped to one info per publish");
  const dropped = summary.diagnostics.filter((d) => d.code === "ANCHOR_DROPPED");
  assert.equal(dropped.length, 0, "native mode never drops anchors");
});

test("native publish updates in place: fileIds and file view URLs stay stable", async () => {
  fixture({ "a.md": "# A\nv1\n" });
  const manifest = nativeManifest();
  const drive = new FakeDrive();
  await runNative(manifest, drive);
  const id = manifest.entries["a.md"]?.fileId as string;
  const url = manifest.entries["a.md"]?.url;

  fs.writeFileSync(path.join(root, "a.md"), "# A\nv2\n");
  const second = await runNative(manifest, drive);
  assert.equal(manifest.entries["a.md"]?.fileId, id);
  assert.equal(manifest.entries["a.md"]?.url, url);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  assert.match(drive.contentOf(id), /v2/);
  assert.equal(
    drive.calls.filter((c) => c.startsWith("createEmptyFile")).length,
    1,
    "an update never re-reserves a shell",
  );
});

test("native publish repairs a gone file as a raw .md shell", async () => {
  fixture({ "a.md": "# A\n" });
  const manifest = nativeManifest();
  const drive = new FakeDrive();
  await runNative(manifest, drive);
  const id = manifest.entries["a.md"]?.fileId as string;
  drive.missing.add(id);

  const plan = buildPlan({ root, manifest });
  const summary = await publish({
    root,
    drive,
    manifest,
    plan,
    prune: false,
    repair: true,
    concurrency: 1,
    now: () => new Date("2024-01-01T00:00:00.000Z"),
  });
  assert.equal(summary.repaired, 1);
  assert.equal(
    drive.calls.filter((c) => c.startsWith("createEmptyFile")).length,
    2,
    "the repair re-reserved a raw .md shell",
  );
  assert.notEqual(manifest.entries["a.md"]?.fileId, id, "the old id is replaced");
});

test("plan analysis for a native tree matches what publish reports", async () => {
  fixture({
    "a.md": "[b](./b.md#sec) ![pic](./pic.png)\n",
    "b.md": "# B\n",
    "pic.png": Buffer.from("fake"),
  });
  const manifest = nativeManifest();
  const plan = buildPlan({ root, manifest });
  const summary = await runNative(manifest);

  const planCodes = plan.diagnostics.map((d) => d.code).sort();
  const runCodes = summary.diagnostics.map((d) => d.code).sort();
  assert.deepEqual(runCodes, planCodes);
  assert.ok(planCodes.includes("MD_NATIVE_IMAGE_LOCAL"));
  assert.ok(planCodes.includes("ANCHOR_UNVERIFIED"));
  assert.equal(plan.markdownMode, "native");
});
