/**
 * CLI contract tests.
 *
 * These spawn the real CLI as a subprocess, because the exit code and stream
 * discipline *are* the contract for CI and git-hook use: 0 success, 1 runtime
 * failure, 2 usage error, 3 completed with errors. Credentials are forced to a
 * bogus env pair and HOME is redirected, so nothing can reach Google - any
 * command that would need the network fails before making a request.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as manifestIo from "../core/manifest.ts";

const CLI = path.join(import.meta.dirname, "..", "cli.ts");

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-cli-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-home-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function run(
  args: string[],
  envExtra: Record<string, string> = {},
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      // Deterministic credentials that cannot be used against Google.
      GDRIVE_PUBLISH_CLIENT_ID: "test-client-id",
      GDRIVE_PUBLISH_CLIENT_SECRET: "test-secret",
      ...envExtra,
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function write(rel: string, content: string): void {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function seedManifest(): void {
  const manifest = manifestIo.emptyManifest("fldROOT", "Test Docs");
  manifestIo.save(tmp, manifest);
}

test("help exits 0 and documents every command", () => {
  const { status, stdout } = run(["help"]);
  assert.equal(status, 0);
  for (const cmd of ["login", "init", "plan", "publish", "status"]) {
    assert.match(stdout, new RegExp(`\\b${cmd}\\b`), `usage should mention ${cmd}`);
  }
});

test("an unknown command is a usage error (exit 2)", () => {
  const { status, stderr } = run(["frobnicate"]);
  assert.equal(status, 2);
  assert.match(stderr, /unknown command/);
});

test("a missing directory argument is a usage error (exit 2)", () => {
  assert.equal(run(["plan"]).status, 2);
});

test("a non-existent directory is a usage error (exit 2)", () => {
  const { status, stderr } = run(["plan", path.join(tmp, "nope")]);
  assert.equal(status, 2);
  assert.match(stderr, /not a directory/);
});

test("init without --name is a usage error (exit 2)", () => {
  const { status, stderr } = run(["init", tmp]);
  assert.equal(status, 2);
  assert.match(stderr, /--name/);
});

test("plan works with no manifest and no network", () => {
  write("a.md", "# A\n[b](./b.md)\n");
  write("b.md", "# B\n");
  const { status, stdout } = run(["plan", tmp]);
  assert.equal(status, 0);
  assert.match(stdout, /\+ a\.md/);
  assert.match(stdout, /2 to create/);
});

test("plan --json emits valid, machine-readable output", () => {
  write("a.md", "# A\n");
  write("notes.txt", "x");
  const { status, stdout } = run(["plan", tmp, "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as {
    items: { relPath: string; action: string }[];
    diagnostics: { code: string }[];
  };
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0]?.action, "create");
  assert.ok(parsed.diagnostics.some((d) => d.code === "UNSUPPORTED_FILE"));
});

test("plan surfaces link and image diagnostics offline", () => {
  // Regression guard for the gap where buildPlan() skipped prepareMarkdown(),
  // so `plan`/`--dry-run` silently understated what publish would report.
  write("a.md", "![huge](./huge.png)\n[missing](./nope.md)\n[anchor](./b.md#sec)\n");
  write("b.md", "# B\n");
  fs.writeFileSync(path.join(tmp, "huge.png"), Buffer.alloc(8 * 1024 * 1024, 3));
  const { status, stdout } = run(["plan", tmp, "--json"]);
  const parsed = JSON.parse(stdout) as { diagnostics: { code: string; severity: string }[] };
  const codes = parsed.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("DOC_PAYLOAD_TOO_LARGE"), "payload cap checked at plan time");
  assert.ok(codes.includes("LINK_TARGET_MISSING"), "broken links reported at plan time");
  assert.ok(codes.includes("ANCHOR_DROPPED"), "dropped anchors reported at plan time");
  assert.equal(status, 3, "an error-severity plan must exit 3");
});

test("plan reports nothing alarming for a clean tree and exits 0", () => {
  write("a.md", "# A\n[b](./b.md)\n");
  write("b.md", "# B\n[a](./a.md)\n");
  const { status, stdout } = run(["plan", tmp, "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as { diagnostics: unknown[] };
  assert.deepEqual(parsed.diagnostics, []);
});

test("plan and publish agree on the diagnostics they report", () => {
  // The dry run is the review surface: it must not understate the outcome.
  write("a.md", ["---", "title: T", "---", "[x](./b.md#sec)", "[y](../out.md)"].join("\n"));
  write("b.md", "# B\n");
  seedManifest();
  const planCodes = (
    JSON.parse(run(["plan", tmp, "--json"]).stdout) as { diagnostics: { code: string }[] }
  ).diagnostics
    .map((d) => d.code)
    .sort();
  const dryRunCodes = (
    JSON.parse(run(["publish", tmp, "--dry-run", "--json"]).stdout) as {
      diagnostics: { code: string }[];
    }
  ).diagnostics
    .map((d) => d.code)
    .sort();
  assert.deepEqual(dryRunCodes, planCodes);
  assert.ok(planCodes.includes("ANCHOR_DROPPED"));
  assert.ok(planCodes.includes("LINK_OUTSIDE_ROOT"));
  assert.ok(planCodes.includes("FRONTMATTER_STRIPPED"));
});

test("plan from a subfolder discovers the root manifest and plans the whole tree", () => {
  const manifest = manifestIo.emptyManifest("fldROOT", "Test Docs");
  manifest.entries["toc.md"] = {
    fileId: "DOC1",
    kind: "markdown",
    name: "Toc",
    url: "https://docs.google.com/document/d/DOC1/edit",
    contentHash: "h",
    publishedAt: "t",
  };
  manifestIo.save(tmp, manifest);
  fs.mkdirSync(path.join(tmp, "guide"));
  fs.writeFileSync(path.join(tmp, "toc.md"), "# Toc\n");
  fs.writeFileSync(path.join(tmp, "guide", "new.md"), "# New\n");

  const { status, stdout } = run(["plan", path.join(tmp, "guide")]);
  assert.equal(status, 0);
  assert.match(stdout, /manifest found at .* - operating on that publish root/);
  assert.match(stdout, /[~=] toc\.md/, "root's files appear with root-relative paths");
  assert.match(stdout, /\+ guide\/new\.md/, "the new subfolder file plans as a create");
  // json mode carries no discovery note noise
  const jsonRun = run(["plan", path.join(tmp, "guide"), "--json"]);
  const parsed = JSON.parse(jsonRun.stdout) as { items: { relPath: string }[] };
  assert.ok(parsed.items.some((i) => i.relPath === "guide/new.md"));
  assert.doesNotMatch(jsonRun.stdout, /manifest found at/, "json stays machine-clean");
});

test("status from a subfolder reports the root manifest", () => {
  const manifest = manifestIo.emptyManifest("fldROOT", "Test Docs");
  manifest.entries["toc.md"] = {
    fileId: "DOC1",
    kind: "markdown",
    name: "Toc",
    url: "https://docs.google.com/document/d/DOC1/edit",
    contentHash: "h",
    publishedAt: "t",
  };
  manifestIo.save(tmp, manifest);
  fs.mkdirSync(path.join(tmp, "guide"));

  const { status, stdout } = run(["status", path.join(tmp, "guide")]);
  assert.equal(status, 0);
  assert.match(stdout, /manifest found at .* - operating on that publish root/);
  assert.match(stdout, /manifest: 1 entr/);
});

test("init inside an existing tree is refused without --force (nested roots)", () => {
  manifestIo.save(tmp, manifestIo.emptyManifest("fldROOT", "Test Docs"));
  fs.mkdirSync(path.join(tmp, "guide"));

  const { status, stderr } = run(["init", path.join(tmp, "guide"), "--name", "Oops"]);
  assert.equal(status, 1);
  assert.match(stderr, /nest publish roots/);
  assert.match(stderr, /publish .* instead/);
  assert.match(stderr, /--force/);

  const forced = run(["init", path.join(tmp, "guide"), "--name", "Deliberate", "--force"]);
  assert.doesNotMatch(forced.stderr, /nest publish roots/, "--force overrides the guard");
  // proceeding past the guard reaches the auth stage (offline: no token in HOME)
  assert.match(forced.stderr, /not authenticated|gdrive-publish login/);
});

test("publish --dry-run writes nothing and never contacts Drive", () => {
  write("a.md", "# A\n");
  seedManifest();
  const before = fs.readFileSync(path.join(tmp, ".gdrive-manifest.json"), "utf8");
  const { status, stdout } = run(["publish", tmp, "--dry-run"]);
  assert.equal(status, 0);
  assert.match(stdout, /dry run: nothing was written/);
  assert.equal(
    fs.readFileSync(path.join(tmp, ".gdrive-manifest.json"), "utf8"),
    before,
    "the manifest must be untouched by a dry run",
  );
});

test("publish --dry-run --json is parseable and flagged", () => {
  write("a.md", "# A\n");
  seedManifest();
  const { status, stdout } = run(["publish", tmp, "--dry-run", "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as { dryRun: boolean; items: unknown[] };
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.items.length, 1);
});

test("status reports credentials and manifest state without network access", () => {
  seedManifest();
  const { status, stdout } = run(["status", tmp]);
  assert.equal(status, 0);
  assert.match(stdout, /credentials: env pair/);
  assert.match(stdout, /folder "Test Docs"/);
});

test("status --json exposes the credential identity hash", () => {
  seedManifest();
  const { status, stdout } = run(["status", tmp, "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as {
    credentials: { source: string; clientIdHash: string };
    manifest: { entries: number } | null;
  };
  assert.equal(parsed.credentials.source, "env pair");
  assert.match(parsed.credentials.clientIdHash, /^[0-9a-f]{8}$/);
  assert.equal(parsed.manifest?.entries, 0);
});

test("status without a manifest says so instead of failing", () => {
  const { status, stdout } = run(["status", tmp]);
  assert.equal(status, 0);
  assert.match(stdout, /manifest: none/);
});

test("publish fails cleanly when not authenticated (no token for this client)", () => {
  // HOME is a fresh temp dir, so no cached token exists for the env client.
  write("a.md", "# A\n");
  seedManifest();
  const { status, stderr } = run(["publish", tmp]);
  assert.equal(status, 1);
  assert.match(stderr, /not authenticated|gdrive-publish login/);
});

test("plan suggests --suggest-config when unsupported files exist", () => {
  write("a.md", "# A\n");
  write("notes.txt", "text");
  const { status, stdout } = run(["plan", tmp]);
  assert.equal(status, 0);
  assert.match(stdout, /UNSUPPORTED_FILE notes\.txt/);
  assert.match(stdout, /TIP\s+1 unsupported file\(s\) could be published as raw uploads/);
  assert.match(stdout, /--suggest-config/);
});

test("plan --json carries rawSuggestion", () => {
  write("a.md", "# A\n");
  write("notes.txt", "text");
  const { stdout } = run(["plan", tmp, "--json"]);
  const parsed = JSON.parse(stdout) as { rawSuggestion: { patterns: string[] } | null };
  assert.deepEqual(parsed.rawSuggestion?.patterns, ["*.txt"]);
});

test("plan --suggest-config creates the config and previews the raw files", () => {
  write("a.md", "# A\n");
  write("notes.txt", "text");
  write("cfg.yaml", "k: v");
  const { status, stdout } = run(["plan", tmp, "--suggest-config"]);
  assert.equal(status, 0);
  // the config file was created and shown
  const configPath = path.join(tmp, ".gdrive-publish.json");
  assert.ok(fs.existsSync(configPath), "config file created");
  const created = JSON.parse(fs.readFileSync(configPath, "utf8")) as { rawPatterns: string[] };
  assert.deepEqual(created.rawPatterns, ["*.txt", "*.yaml"]);
  assert.match(stdout, /created .*\.gdrive-publish\.json/);
  assert.match(stdout, /"rawPatterns"/);
  assert.match(stdout, /verify the patterns before running plan or publish/);
  // the re-scanned plan now shows the files as raw uploads
  assert.match(stdout, /\+ notes\.txt.*File "notes\.txt" \(raw upload\)/);
  assert.match(stdout, /\+ cfg\.yaml.*File "cfg\.yaml" \(raw upload\)/);
  assert.doesNotMatch(stdout, /UNSUPPORTED_FILE/);
});

test("plan --suggest-config merges, never overwrites, existing patterns", () => {
  write("a.md", "# A\n");
  write("notes.txt", "text");
  write("bundle.zip", "PK");
  fs.writeFileSync(
    path.join(tmp, ".gdrive-publish.json"),
    JSON.stringify({ rawPatterns: ["archives/**"] }),
  );
  const { stdout } = run(["plan", tmp, "--suggest-config"]);
  const created = JSON.parse(fs.readFileSync(path.join(tmp, ".gdrive-publish.json"), "utf8")) as {
    rawPatterns: string[];
  };
  assert.ok(created.rawPatterns.includes("archives/**"), "existing pattern preserved");
  assert.ok(created.rawPatterns.includes("*.txt"));
  assert.ok(created.rawPatterns.includes("*.zip"));
});

test("plan --suggest-config is a no-op when nothing is uncovered", () => {
  write("a.md", "# A\n");
  fs.writeFileSync(
    path.join(tmp, ".gdrive-publish.json"),
    JSON.stringify({ rawPatterns: ["*.txt"] }),
  );
  const { stdout } = run(["plan", tmp, "--suggest-config"]);
  assert.match(stdout, /no unsupported files found - nothing to suggest/);
});

test("plan --suggest-config lists extensionless files for manual patterns", () => {
  write("a.md", "# A\n");
  write("notes.txt", "x");
  write("Makefile", "all:");
  const { stdout } = run(["plan", tmp, "--suggest-config"]);
  assert.match(stdout, /no automatic pattern can cover/);
  assert.match(stdout, /Makefile/);
  const created = JSON.parse(fs.readFileSync(path.join(tmp, ".gdrive-publish.json"), "utf8")) as {
    rawPatterns: string[];
  };
  assert.deepEqual(created.rawPatterns, ["*.txt"], "no bogus pattern for extensionless files");
});

test("plan --suggest-config --json reports the created config", () => {
  write("a.md", "# A\n");
  write("notes.txt", "text");
  const { stdout } = run(["plan", tmp, "--suggest-config", "--json"]);
  const parsed = JSON.parse(stdout) as {
    configCreated: string;
    patternsAdded: string[];
    items: { relPath: string; kind: string }[];
    rawSuggestion: { patterns: string[] } | null;
  };
  assert.ok(parsed.configCreated.endsWith(".gdrive-publish.json"));
  assert.deepEqual(parsed.patternsAdded, ["*.txt"]);
  assert.ok(parsed.items.some((i) => i.relPath === "notes.txt" && i.kind === "file"));
});

test("browse resolves the publish root to its Drive folder", () => {
  seedManifest();
  const { status, stdout } = run(["browse", tmp, "--no-open"]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "https://drive.google.com/drive/folders/fldROOT");
});

test("browse resolves a file entry to its Doc URL", () => {
  const manifest = manifestIo.emptyManifest("fldROOT", "Test Docs");
  manifest.entries["doc.md"] = {
    fileId: "DOC1",
    kind: "markdown",
    name: "Doc",
    url: "https://docs.google.com/document/d/DOC1/edit",
    contentHash: "h",
    publishedAt: "t",
  };
  manifestIo.save(tmp, manifest);
  fs.writeFileSync(path.join(tmp, "doc.md"), "# Doc\n");

  const { status, stdout } = run(["browse", path.join(tmp, "doc.md"), "--no-open"]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "https://docs.google.com/document/d/DOC1/edit");

  // trailing slash and relative forms behave the same
  const rel = run(["browse", `${tmp}/doc.md`, "--no-open"]);
  assert.equal(rel.status, 0);
  assert.match(rel.stdout, /DOC1/);
});

test("browse resolves a locally-deleted file while its manifest entry exists", () => {
  const manifest = manifestIo.emptyManifest("fldROOT", "Test Docs");
  manifest.entries["gone.md"] = {
    fileId: "DOC2",
    kind: "markdown",
    name: "Gone",
    url: "https://docs.google.com/document/d/DOC2/edit",
    contentHash: "h",
    publishedAt: "t",
  };
  manifestIo.save(tmp, manifest); // gone.md intentionally NOT on disk

  const { status, stdout } = run(["browse", path.join(tmp, "gone.md"), "--no-open"]);
  assert.equal(status, 0, "manifest is the identity map - the URL survives local deletion");
  assert.match(stdout, /DOC2/);
});

test("browse resolves a subfolder from the folders map", () => {
  const manifest = manifestIo.emptyManifest("fldROOT", "Test Docs");
  manifest.folders.guide = "fldGUIDE";
  manifestIo.save(tmp, manifest);

  const { status, stdout } = run(["browse", path.join(tmp, "guide"), "--no-open"]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "https://drive.google.com/drive/folders/fldGUIDE");
});

test("browse --json is machine-readable and includes identity", () => {
  const manifest = manifestIo.emptyManifest("fldROOT", "Test Docs");
  manifest.entries["report.csv"] = {
    fileId: "SHT1",
    kind: "csv",
    name: "report",
    url: "https://docs.google.com/spreadsheets/d/SHT1/edit",
    contentHash: "h",
    publishedAt: "t",
  };
  manifestIo.save(tmp, manifest);

  const { status, stdout } = run(["browse", path.join(tmp, "report.csv"), "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as {
    url: string;
    fileId: string;
    kind: string;
    relPath: string;
  };
  assert.equal(parsed.fileId, "SHT1");
  assert.equal(parsed.kind, "csv");
  assert.equal(parsed.relPath, "report.csv");
  assert.match(parsed.url, /spreadsheets/);
});

test("browse on an unpublished existing file says publish first", () => {
  seedManifest();
  fs.writeFileSync(path.join(tmp, "notes.txt"), "text");
  const { status, stderr } = run(["browse", path.join(tmp, "notes.txt"), "--no-open"]);
  assert.equal(status, 1);
  assert.match(stderr, /not published yet - publish first/);
});

test("browse on an unclaimed image explains the embeds rule", () => {
  seedManifest();
  fs.writeFileSync(path.join(tmp, "pic.png"), "PNG");
  const { status, stderr } = run(["browse", path.join(tmp, "pic.png"), "--no-open"]);
  assert.equal(status, 1);
  assert.match(stderr, /images publish only as embeds/);
});

test("browse without any manifest gives init guidance", () => {
  const { status, stderr } = run(["browse", os.tmpdir(), "--no-open"]);
  assert.equal(status, 1);
  assert.match(stderr, /no \.gdrive-manifest\.json/);
  assert.match(stderr, /gdrive-publish init/);
});

test("browse on a path that never existed under a manifest root is exit 2", () => {
  seedManifest();
  const { status, stderr } = run(["browse", path.join(tmp, "ghost.md"), "--no-open"]);
  assert.equal(status, 2);
  assert.match(stderr, /no such file or directory/);
});

test("secrets never appear in output", () => {
  seedManifest();
  const { stdout, stderr } = run(["status", tmp, "--json"]);
  assert.doesNotMatch(stdout + stderr, /test-secret/, "the client secret must never be printed");
});

// ---- concurrency knob (design: docs/parallel-publish.md) -------------------

test("publish --concurrency out of range is a usage error (exit 2)", () => {
  seedManifest();
  write("doc.md", "# Doc\n");
  const { status, stderr } = run(["publish", tmp, "--concurrency", "11"]);
  assert.equal(status, 2);
  assert.match(stderr, /--concurrency expects an integer between 1 and 10/);
});

test("publish --concurrency rejects non-integers (exit 2)", () => {
  seedManifest();
  write("doc.md", "# Doc\n");
  assert.equal(run(["publish", tmp, "--concurrency", "2.5"]).status, 2);
  assert.equal(run(["publish", tmp, "--concurrency", "fast"]).status, 2);
});

test("publish --concurrency in range is accepted (fails later at auth, not usage)", () => {
  seedManifest();
  write("doc.md", "# Doc\n");
  // No cached token for the bogus env client: the run must get PAST flag
  // validation and fail at authentication instead - proving the value parsed.
  const { status, stderr } = run(["publish", tmp, "--concurrency", "5"]);
  assert.equal(status, 1);
  assert.match(stderr, /not authenticated/);
});

test("an invalid GDRIVE_PUBLISH_CONCURRENCY is a runtime error naming the env var", () => {
  seedManifest();
  write("doc.md", "# Doc\n");
  const { status, stderr } = run(["publish", tmp], { GDRIVE_PUBLISH_CONCURRENCY: "42" });
  assert.equal(status, 1);
  assert.match(stderr, /GDRIVE_PUBLISH_CONCURRENCY must be an integer between 1 and 10/);
});

test("the flag beats the env var (env is ignored when --concurrency is given)", () => {
  seedManifest();
  write("doc.md", "# Doc\n");
  // Invalid env + valid flag: the flag wins, so this reaches auth, not the
  // env validation error.
  const { status, stderr } = run(["publish", tmp, "--concurrency", "2"], {
    GDRIVE_PUBLISH_CONCURRENCY: "banana",
  });
  assert.equal(status, 1);
  assert.match(stderr, /not authenticated/);
});

test("an invalid concurrency in .gdrive-publish.json fails the publish", () => {
  seedManifest();
  write("doc.md", "# Doc\n");
  write(".gdrive-publish.json", JSON.stringify({ concurrency: 99 }));
  const { status, stderr } = run(["publish", tmp]);
  assert.equal(status, 1);
  assert.match(stderr, /concurrency.*integer between 1 and 10/);
});

test("plan respects ignorePatterns from the config file", () => {
  seedManifest();
  write("toc.md", "# Toc\n");
  write("_drafts/secret.md", "# Secret draft\n");
  write(".gdrive-publish.json", JSON.stringify({ ignorePatterns: ["_*"] }));
  const { status, stdout } = run(["plan", tmp]);
  assert.equal(status, 0);
  assert.ok(!stdout.includes("_drafts"), "ignored content is invisible to plan");
});
