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
import { buildPlan, publish } from "../core/publish.ts";
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
