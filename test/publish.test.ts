/**
 * End-to-end publish tests against the fake Drive client.
 *
 * These assert the properties the spike identified as load-bearing:
 * two-phase ordering, update-in-place (never recreate), stable ids across
 * re-runs, pending-entry recovery, inline images, and trash-not-delete.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as manifestIo from "../core/manifest.ts";
import type { ProgressEvent } from "../core/progress.ts";
import { buildPlan, publish } from "../core/publish.ts";
import type { Manifest } from "../core/types.ts";
import { FakeDrive } from "./fake-drive.ts";

function fixture(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function freshManifest(): Manifest {
  return manifestIo.emptyManifest("fldROOT", "Test Docs");
}

async function run(
  root: string,
  manifest: Manifest,
  opts: {
    prune?: boolean;
    repair?: boolean;
    drive?: FakeDrive;
    events?: ProgressEvent[];
    concurrency?: number;
    rateLimitOn?: string;
    failNames?: string[];
    failFileIds?: string[];
  } = {},
) {
  const drive = opts.drive ?? new FakeDrive();
  drive.files.set("fldROOT", { id: "fldROOT", name: "Test Docs", mimeType: "folder" });
  if (opts.rateLimitOn) drive.rateLimitOn = opts.rateLimitOn;
  if (opts.failNames) for (const n of opts.failNames) drive.failNames.add(n);
  if (opts.failFileIds) for (const id of opts.failFileIds) drive.failFileIds.add(id);
  const plan = buildPlan({ root, manifest });
  const summary = await publish({
    root,
    drive,
    manifest,
    plan,
    prune: opts.prune ?? false,
    repair: opts.repair ?? false,
    // 1 pins the historical sequential order so existing call-sequence
    // assertions stay deterministic; parallel behaviour has its own tests.
    concurrency: opts.concurrency ?? 1,
    now: () => new Date("2024-01-01T00:00:00.000Z"),
    ...(opts.events ? { onProgress: (e: ProgressEvent) => opts.events?.push(e) } : {}),
  });
  return { drive, plan, summary };
}

test("rewrites a relative link to the sibling Doc URL (the core requirement)", async () => {
  const root = fixture({
    "toc.md": "# TOC\n\nSee [the details](./details.md) and [again](details.md).\n",
    "details.md": "# Details\n\nBack to [toc](./toc.md).\n",
  });
  const manifest = freshManifest();
  const { drive, summary } = await run(root, manifest);

  const detailsId = manifest.entries["details.md"]?.fileId as string;
  const tocId = manifest.entries["toc.md"]?.fileId as string;
  assert.ok(detailsId && tocId);
  const tocBody = drive.contentOf(tocId);
  assert.match(tocBody, new RegExp(`/document/d/${detailsId}/edit`));
  // both link forms rewritten
  assert.equal(tocBody.split(detailsId).length - 1, 2);
  assert.match(drive.contentOf(detailsId), new RegExp(`/document/d/${tocId}/edit`));
  assert.equal(summary.created, 2);
});

test("phase 1 reserves every id before any content is filled", async () => {
  const root = fixture({
    "a.md": "# A\n[b](./b.md)\n",
    "b.md": "# B\n[a](./a.md)\n",
  });
  const { drive } = await run(root, freshManifest());
  const lastCreate = Math.max(
    ...drive.calls.map((c, i) => (c.startsWith("createEmptyDoc") ? i : -1)),
  );
  const firstFill = drive.calls.findIndex((c) => c.startsWith("updateMedia"));
  assert.ok(
    lastCreate < firstFill,
    `expected all shells before the first fill, got: ${drive.calls.join(" ")}`,
  );
});

test("re-publishing updates in place and keeps fileIds stable", async () => {
  const root = fixture({ "a.md": "# A\nv1\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const idAfterFirst = manifest.entries["a.md"]?.fileId as string;

  fs.writeFileSync(path.join(root, "a.md"), "# A\nv2\n");
  const second = await run(root, manifest, { drive: first.drive });

  assert.equal(manifest.entries["a.md"]?.fileId, idAfterFirst, "fileId must not change");
  assert.equal(second.summary.created, 0);
  assert.equal(second.summary.updated, 1);
  assert.match(first.drive.contentOf(idAfterFirst), /v2/);
  // exactly one Doc was ever created
  assert.equal(first.drive.calls.filter((c) => c.startsWith("createEmptyDoc")).length, 1);
});

test("unchanged files are skipped on re-run", async () => {
  const root = fixture({ "a.md": "# A\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const second = await run(root, manifest, { drive: first.drive });
  assert.equal(second.summary.unchanged, 1);
  assert.equal(second.summary.updated, 0);
  assert.equal(second.summary.created, 0);
});

test("a crash after phase 1 is recovered without creating duplicates", async () => {
  const root = fixture({ "a.md": "# A\n" });
  const manifest = freshManifest();
  // Simulate the checkpointed state: id reserved, content never filled.
  const drive = new FakeDrive();
  drive.files.set("fldROOT", { id: "fldROOT", name: "Test Docs", mimeType: "folder" });
  const shell = await drive.createEmptyDoc("A", "fldROOT");
  manifest.entries["a.md"] = {
    fileId: shell.id,
    kind: "markdown",
    name: "A",
    url: `https://docs.google.com/document/d/${shell.id}/edit`,
    contentHash: "",
    publishedAt: "2024-01-01T00:00:00.000Z",
    pending: true,
  };

  const { plan, summary } = await run(root, manifest, { drive });
  assert.ok(plan.diagnostics.some((d) => d.code === "PENDING_RESUMED"));
  assert.equal(summary.created, 0, "must not create a second Doc");
  assert.equal(manifest.entries["a.md"]?.fileId, shell.id);
  assert.equal(manifest.entries["a.md"]?.pending, undefined, "pending flag must be cleared");
  assert.match(drive.contentOf(shell.id), /# A/);
});

test("images are inlined as data URIs, not published as files", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const root = fixture({
    "doc.md": "# Doc\n\n![pixel](./img/pixel.png)\n",
    "img/pixel.png": png,
  });
  const manifest = freshManifest();
  const { drive, summary } = await run(root, manifest);
  const id = manifest.entries["doc.md"]?.fileId as string;
  assert.match(drive.contentOf(id), /!\[pixel\]\(data:image\/png;base64,iVBOR/);
  assert.equal(summary.created, 1, "the image must not become its own Drive file");
  assert.equal(manifest.entries["img/pixel.png"], undefined);
  assert.equal(
    drive.calls.filter((c) => c.includes("pixel.png")).length,
    0,
    "no upload call for the image itself",
  );
});

test("links inside code fences are never rewritten", async () => {
  const root = fixture({
    "a.md": ["# A", "", "```md", "[b](./b.md)", "```", "", "[b](./b.md)"].join("\n"),
    "b.md": "# B\n",
  });
  const manifest = freshManifest();
  const { drive } = await run(root, manifest);
  const body = drive.contentOf(manifest.entries["a.md"]?.fileId as string);
  assert.match(body, /```md\n\[b\]\(\.\/b\.md\)\n```/, "fenced link must stay literal");
  const bId = manifest.entries["b.md"]?.fileId as string;
  assert.equal(body.split(bId).length - 1, 1, "only the real link is rewritten");
});

test("diagnostics cover anchors, escapes, missing targets and unsupported files", async () => {
  const root = fixture({
    "a.md": [
      "# A",
      "[anchor](./b.md#section)",
      "[escape](../outside.md)",
      "[missing](./nope.md)",
      "[external](https://example.test)",
    ].join("\n"),
    "b.md": "# B\n",
    "notes.txt": "not published",
  });
  const manifest = freshManifest();
  const { drive, summary } = await run(root, manifest);
  const codes = summary.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("ANCHOR_DROPPED"));
  assert.ok(codes.includes("LINK_OUTSIDE_ROOT"));
  assert.ok(codes.includes("LINK_TARGET_MISSING"));
  assert.ok(codes.includes("UNSUPPORTED_FILE"));
  const body = drive.contentOf(manifest.entries["a.md"]?.fileId as string);
  assert.match(body, /\[external\]\(https:\/\/example\.test\)/, "external links untouched");
  assert.match(body, /\[escape\]\(\.\.\/outside\.md\)/, "escaping link left verbatim");
});

test("front matter is stripped and its title becomes the Doc name", async () => {
  const root = fixture({
    "a.md": ["---", "title: Real Title", "---", "", "# Heading", "body"].join("\n"),
  });
  const manifest = freshManifest();
  const { drive, summary } = await run(root, manifest);
  const entry = manifest.entries["a.md"];
  assert.equal(entry?.name, "Real Title");
  const body = drive.contentOf(entry?.fileId as string);
  assert.doesNotMatch(body, /title: Real Title/, "front matter must not reach Drive");
  assert.match(body, /# Heading/);
  assert.ok(summary.diagnostics.some((d) => d.code === "FRONTMATTER_STRIPPED"));
});

test("CSV is normalised and uploaded as a Sheet; xlsx is passed through", async () => {
  const root = fixture({
    "data.csv": Buffer.from("Spalte 1;Spalte 2\nWert 1;Wert 2\n", "latin1"),
    "book.xlsx": Buffer.from("PK\u0003\u0004fake-xlsx"),
  });
  const manifest = freshManifest();
  const { drive, summary } = await run(root, manifest);
  const csvId = manifest.entries["data.csv"]?.fileId as string;
  assert.match(drive.contentOf(csvId), /Spalte 1,Spalte 2/, "normalised to comma");
  const codes = summary.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("CSV_NORMALISED"));
  assert.ok(codes.includes("XLSX_LOSSY"));
  assert.ok(
    drive.calls.some((c) => c.startsWith("convertUpload") && c.includes("spreadsheet")),
    "must convert to a native Sheet",
  );
});

test("an existing-but-unpublished target is distinguished from a broken link", async () => {
  // Regression: `known` was built from scan *results*, which exclude skipped
  // files, so a link to notes.txt was misreported as LINK_TARGET_MISSING.
  const root = fixture({
    "a.md": "[unsupported](./notes.txt)\n[broken](./nope.md)\n",
    "notes.txt": "exists but is not published",
  });
  const manifest = freshManifest();
  const { summary } = await run(root, manifest);
  const byCode = new Map(summary.diagnostics.map((d) => [d.code, d.message]));
  assert.ok(byCode.has("LINK_TO_UNSUPPORTED"), "notes.txt exists, so it is not 'missing'");
  assert.match(byCode.get("LINK_TO_UNSUPPORTED") ?? "", /notes\.txt/);
  assert.ok(byCode.has("LINK_TARGET_MISSING"), "nope.md really is missing");
  assert.match(byCode.get("LINK_TARGET_MISSING") ?? "", /nope\.md/);
});

test("a gone Drive file without repair is skipped, reported, and never crashes", async () => {
  const root = fixture({ "a.md": "# A\nv1\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const id = manifest.entries["a.md"]?.fileId as string;
  first.drive.missing.add(id); // simulate trashed/inaccessible
  const callsBefore = first.drive.calls.length;

  fs.writeFileSync(path.join(root, "a.md"), "# A\nv2\n");
  const second = await run(root, manifest, { drive: first.drive });

  const gone = second.summary.diagnostics.find((d) => d.code === "DRIVE_FILE_GONE");
  assert.ok(gone, "DRIVE_FILE_GONE reported");
  assert.equal(gone?.severity, "error");
  assert.equal(second.summary.updated, 0, "nothing was updated");
  assert.equal(second.summary.repaired, 0);
  assert.ok(
    !first.drive.calls.slice(callsBefore).some((c) => c.startsWith(`updateMedia(${id}`)),
    "no update attempt on the dead id",
  );
  assert.equal(manifest.entries["a.md"]?.fileId, id, "manifest keeps the old id");
});

test("with repair the gone file is recreated under a new id, loudly", async () => {
  const root = fixture({ "a.md": "# A\nv1\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const oldId = manifest.entries["a.md"]?.fileId as string;
  first.drive.missing.add(oldId);
  const callsBefore = first.drive.calls.length;

  fs.writeFileSync(path.join(root, "a.md"), "# A\nv2\n");
  const second = await run(root, manifest, { drive: first.drive, repair: true });

  assert.equal(second.summary.repaired, 1);
  const newId = manifest.entries["a.md"]?.fileId as string;
  assert.notEqual(newId, oldId, "a fresh Drive id was recorded");
  assert.match(first.drive.contentOf(newId), /v2/, "the recreated Doc has the new content");
  assert.ok(
    !first.drive.calls.slice(callsBefore).some((c) => c.startsWith(`updateMedia(${oldId}`)),
    "the dead id is never written to",
  );
  const repaired = second.summary.diagnostics.find((d) => d.code === "DRIVE_REPAIRED");
  assert.ok(repaired, "DRIVE_REPAIRED warning present");
  assert.match(repaired?.message ?? "", /no longer work/, "warns that shared URLs die");
  assert.equal(manifest.entries["a.md"]?.pending, undefined, "recreated Doc was filled");
  assert.equal(second.summary.updated, 0, "repair is its own category, not 'updated'");
});

test("an unchanged file whose Drive copy is gone is caught without a local edit", async () => {
  // Regression for the gap found live: divergence was only checked for
  // update items, so a trashed Doc with an unchanged local source sailed
  // through as "unchanged" while its shared URL was already dead.
  const root = fixture({ "a.md": "# A\nv1\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const id = manifest.entries["a.md"]?.fileId as string;
  first.drive.missing.add(id);
  const callsBefore = first.drive.calls.length;

  const second = await run(root, manifest, { drive: first.drive });
  const gone = second.summary.diagnostics.find((d) => d.code === "DRIVE_FILE_GONE");
  assert.ok(gone, "a gone file must be reported even when the local source is unchanged");
  assert.equal(gone?.severity, "error");
  assert.ok(
    !first.drive.calls.slice(callsBefore).some((c) => c.startsWith(`updateMedia(${id}`)),
    "nothing written to the dead id",
  );
  assert.equal(manifest.entries["a.md"]?.fileId, id, "manifest keeps the id without repair");
});

test("repair recreates an unchanged file whose Drive copy is gone", async () => {
  const root = fixture({ "a.md": "# A\nv1\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const oldId = manifest.entries["a.md"]?.fileId as string;
  first.drive.missing.add(oldId);

  const second = await run(root, manifest, { drive: first.drive, repair: true });
  assert.equal(second.summary.repaired, 1);
  const newId = manifest.entries["a.md"]?.fileId as string;
  assert.notEqual(newId, oldId);
  assert.match(first.drive.contentOf(newId), /# A/, "recreated from the unchanged source");
});

test("repair also recreates gone sheets", async () => {
  const root = fixture({ "data.csv": "a,b\n1,2\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const oldId = manifest.entries["data.csv"]?.fileId as string;
  first.drive.missing.add(oldId);

  fs.writeFileSync(path.join(root, "data.csv"), "a,b\n9,9\n");
  const second = await run(root, manifest, { drive: first.drive, repair: true });
  assert.equal(second.summary.repaired, 1);
  const newId = manifest.entries["data.csv"]?.fileId as string;
  assert.notEqual(newId, oldId);
  assert.match(first.drive.contentOf(newId), /9,9/, "new sheet has the new content");
});

test("raw files upload as-is with their full filename, update in place", async () => {
  const root = fixture({
    "toc.md": "# TOC\n[zip](./bundle.zip)\n",
    "bundle.zip": Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x05]),
  });
  fs.writeFileSync(
    path.join(root, ".gdrive-publish.json"),
    JSON.stringify({ rawPatterns: ["*.zip"] }),
  );
  const manifest = freshManifest();
  const { drive } = await run(root, manifest);

  const id = manifest.entries["bundle.zip"]?.fileId as string;
  assert.ok(id, "raw file has a manifest entry");
  assert.equal(manifest.entries["bundle.zip"]?.name, "bundle.zip", "full filename kept");
  assert.equal(
    manifest.entries["bundle.zip"]?.url,
    `https://drive.google.com/file/d/${id}/view`,
    "raw files get the file view URL",
  );
  const uploadCall = drive.calls.find((c) => c.startsWith("convertUpload(bundle.zip"));
  assert.ok(uploadCall, "raw upload happened");
  assert.match(uploadCall as string, /application\/zip,application\/zip/, "no conversion");

  const tocBody = drive.contentOf(manifest.entries["toc.md"]?.fileId as string);
  assert.match(tocBody, new RegExp(`file/d/${id}/view`), "md link rewritten to view url");

  fs.writeFileSync(path.join(root, "bundle.zip"), Buffer.from([0x50, 0x4b, 0x09]));
  const second = await run(root, manifest, { drive });
  assert.equal(second.summary.updated, 1);
  assert.equal(manifest.entries["bundle.zip"]?.fileId, id, "id stable across raw updates");
  const updateCall = drive.calls.find((c) => c.startsWith(`updateMedia(${id},application/zip)`));
  assert.ok(updateCall, "raw update shipped the new bytes");
});

test("unreferenced unclaimed images warn; referenced ones stay silent", async () => {
  const root = fixture({
    "doc.md": "# Doc\n\n![used](./used.png)\n",
    "used.png": "PNG",
    "orphan.png": "PNG",
  });
  const manifest = freshManifest();
  const { summary } = await run(root, manifest);
  const warn = summary.diagnostics.find((d) => d.code === "IMAGE_UNREFERENCED");
  assert.ok(warn, "unreferenced image warns");
  assert.equal(warn?.relPath, "orphan.png");
  assert.ok(!summary.diagnostics.some((d) => d.relPath === "used.png"));
});
test("a claimed image uploads as a raw file AND still embeds in markdown", async () => {
  const root = fixture({
    "doc.md": "# Doc\n\n![pic](./pic.png)\n",
    "pic.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  fs.writeFileSync(
    path.join(root, ".gdrive-publish.json"),
    JSON.stringify({ rawPatterns: ["*.png"] }),
  );
  const manifest = freshManifest();
  const { drive } = await run(root, manifest);

  // standalone raw file with the full filename
  const id = manifest.entries["pic.png"]?.fileId as string;
  assert.ok(id, "claimed image has a manifest entry");
  assert.equal(manifest.entries["pic.png"]?.name, "pic.png");
  assert.match(manifest.entries["pic.png"]?.url ?? "", /file\/d\/.+\/view/);
  const uploadCall = drive.calls.find((c) => c.startsWith("convertUpload(pic.png"));
  assert.ok(uploadCall, "raw upload happened");
  assert.match(uploadCall as string, /image\/png,image\/png/, "stored as-is");

  // AND the doc still embeds it from disk as a data URI
  const docBody = drive.contentOf(manifest.entries["doc.md"]?.fileId as string);
  assert.match(docBody, /data:image\/png;base64/, "still embedded");

  // no unreferenced warning for the claimed image even though it IS referenced
  const second = await run(root, manifest, { drive });
  assert.ok(!second.summary.diagnostics.some((d) => d.code === "IMAGE_UNREFERENCED"));
});

test("an image referenced only inside a code fence counts as unreferenced", () => {
  const root = fixture({
    "doc.md": "```md\n![fenced](./ghost.png)\n```\n",
    "ghost.png": "PNG",
  });
  const plan = buildPlan({ root, manifest: null });
  const warn = plan.diagnostics.find(
    (d) => d.code === "IMAGE_UNREFERENCED" && d.relPath === "ghost.png",
  );
  assert.ok(warn, "fence-referenced image is unreferenced for publishing");
});

test("progress events are monotonic and reach the exact total", async () => {
  const root = fixture({
    "toc.md": "# TOC\n[d](./details.md)\n",
    "details.md": "# Details\n",
    "data.csv": "a,b\n1,2\n",
    "guide/nested.md": "# Nested\n",
  });
  const manifest = freshManifest();
  const events: ProgressEvent[] = [];
  await run(root, manifest, { events });

  assert.ok(events.length > 0, "events were emitted");
  // folders(1: guide) + items(4) + fills(3 markdown) + prunes(0) = 8 steps
  assert.equal(events[0]?.total, 8, `expected total 8, got ${events[0]?.total}`);
  const last = events[events.length - 1] as ProgressEvent;
  assert.equal(last.completed, events[0]?.total, "the run finishes at exactly the total");
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1] as ProgressEvent;
    const cur = events[i] as ProgressEvent;
    assert.ok(cur.completed > prev.completed, "completed must strictly increase");
    assert.ok(cur.bytes >= prev.bytes, "bytes never decrease");
  }
  assert.ok(last.bytes > 0, "payload bytes were counted (markdown fills ship content)");
});

test("diagnostics are not duplicated between plan and publish", async () => {
  // publish() seeds its list from the plan and re-derives the analysis from
  // real content; without dedupe every finding would be reported twice.
  const root = fixture({
    "a.md": ["---", "title: T", "---", "[x](./b.md#sec)"].join("\n"),
    "b.md": "# B\n",
  });
  const manifest = freshManifest();
  const { summary } = await run(root, manifest);
  const counts = new Map<string, number>();
  for (const d of summary.diagnostics) {
    const key = `${d.code}|${d.relPath ?? ""}|${d.message}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicated = [...counts.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(duplicated, [], "each diagnostic must appear exactly once");
  assert.ok(summary.diagnostics.some((d) => d.code === "ANCHOR_DROPPED"));
});

test("orphans are reported but never removed without --prune", async () => {
  const root = fixture({ "a.md": "# A\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const orphanId = manifest.entries["a.md"]?.fileId as string;
  fs.rmSync(path.join(root, "a.md"));
  fs.writeFileSync(path.join(root, "b.md"), "# B\n");

  const second = await run(root, manifest, { drive: first.drive });
  assert.equal(second.summary.orphans, 1);
  assert.equal(second.summary.pruned, 0);
  assert.ok(second.summary.diagnostics.some((d) => d.code === "ORPHAN"));
  assert.equal(first.drive.files.get(orphanId)?.trashed, undefined, "must not be trashed");
  assert.ok(manifest.entries["a.md"], "manifest entry kept");
});

test("--prune trashes orphans (never deletes) and drops the manifest entry", async () => {
  const root = fixture({ "a.md": "# A\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const orphanId = manifest.entries["a.md"]?.fileId as string;
  fs.rmSync(path.join(root, "a.md"));

  const second = await run(root, manifest, { drive: first.drive, prune: true });
  assert.equal(second.summary.pruned, 1);
  assert.equal(first.drive.files.get(orphanId)?.trashed, true);
  assert.equal(manifest.entries["a.md"], undefined);
  assert.ok(first.drive.calls.some((c) => c === `trash(${orphanId})`));
});

test("Drive-side modification warns loudly but local content still wins", async () => {
  const root = fixture({ "a.md": "# A\nv1\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const id = manifest.entries["a.md"]?.fileId as string;
  first.drive.modifiedTimes.set(id, "2099-01-01T00:00:00.000Z");
  const driveFile = first.drive.files.get(id);
  assert.ok(driveFile);
  driveFile.lastModifyingUser = { displayName: "Someone Else" };

  fs.writeFileSync(path.join(root, "a.md"), "# A\nv2-local\n");
  const second = await run(root, manifest, { drive: first.drive });
  const warning = second.summary.diagnostics.find((d) => d.code === "DRIVE_MODIFIED");
  assert.ok(warning, "expected a DRIVE_MODIFIED warning");
  assert.match(warning?.message ?? "", /Someone Else/);
  assert.match(first.drive.contentOf(id), /v2-local/, "local content wins");
});

test("nested folders are created parents-first and mirrored in Drive", async () => {
  const root = fixture({
    "guide/deep/nested.md": "# Nested\n",
    "guide/top.md": "# Top\n[n](./deep/nested.md)\n",
  });
  const manifest = freshManifest();
  const { drive } = await run(root, manifest);
  assert.ok(manifest.folders.guide);
  assert.ok(manifest.folders["guide/deep"]);
  const guideIdx = drive.calls.findIndex((c) => c === "createFolder(guide,fldROOT)");
  const deepIdx = drive.calls.findIndex((c) =>
    c.startsWith(`createFolder(deep,${manifest.folders.guide as string}`),
  );
  assert.ok(guideIdx >= 0 && deepIdx > guideIdx, "parent folder must be created first");
  const topBody = drive.contentOf(manifest.entries["guide/top.md"]?.fileId as string);
  assert.match(topBody, new RegExp(manifest.entries["guide/deep/nested.md"]?.fileId as string));
});

test("the manifest is written atomically, sorted and with pending cleared", async () => {
  const root = fixture({ "b.md": "# B\n", "a.md": "# A\n" });
  const manifest = freshManifest();
  await run(root, manifest);
  const written = fs.readFileSync(path.join(root, ".gdrive-manifest.json"), "utf8");
  assert.match(written, /\n$/, "trailing newline for diff friendliness");
  const keys = Object.keys((JSON.parse(written) as Manifest).entries);
  assert.deepEqual(keys, ["a.md", "b.md"], "entries sorted for reviewable diffs");
  assert.equal(manifestIo.pendingEntries(JSON.parse(written) as Manifest).length, 0);
  assert.equal(
    fs.readdirSync(root).filter((f) => f.includes(".tmp")).length,
    0,
    "no temp files left behind",
  );
});

// ---- parallel publish (design: docs/parallel-publish.md, slice 2) ---------

test("parallel publish converges to the same manifest and content as sequential", async () => {
  const files = {
    "toc.md": "# TOC\n\nSee [the details](./details.md), [nested](./sub/nested.md).\n",
    "details.md": "# Details\n\nBack to [toc](./toc.md).\n",
    "sub/nested.md": "# Nested\n\nAlso [details](../details.md).\n",
    "table.csv": "a,b\n1,2\n",
    "raw.zip": "fake",
  };
  const seqRoot = fixture({
    ...files,
    ".gdrive-publish.json": JSON.stringify({ rawPatterns: ["*.zip"] }),
  });
  const parRoot = fixture({
    ...files,
    ".gdrive-publish.json": JSON.stringify({ rawPatterns: ["*.zip"] }),
  });

  const seqManifest = freshManifest();
  const seq = await run(seqRoot, seqManifest);
  const parManifest = freshManifest();
  const par = await run(parRoot, parManifest, { concurrency: 4 });

  // Same work happened: same op counts and the same multiset of Drive calls.
  assert.equal(par.summary.created, seq.summary.created);
  assert.equal(par.summary.updated, seq.summary.updated);
  assert.deepEqual([...par.drive.calls].sort(), [...seq.drive.calls].sort());

  // Same manifest identity per file: kind, name, hash, nothing left pending.
  const shape = (m: Manifest) =>
    Object.keys(m.entries)
      .sort()
      .map((k) => {
        const e = m.entries[k] as {
          kind: string;
          name: string;
          contentHash: string;
          pending?: boolean;
        };
        return `${k}|${e.kind}|${e.name}|${e.contentHash ? "hashed" : "shell"}|${e.pending ?? false}`;
      });
  assert.deepEqual(shape(parManifest), shape(seqManifest));

  // Same rendered content in Drive (match fake files by name, not by id).
  const contents = (d: FakeDrive) =>
    [...d.files.values()]
      .filter((f) => f.content !== undefined && f.content !== "")
      .map((f) => `${f.name}|${f.content}`)
      .sort();
  assert.deepEqual(contents(par.drive), contents(seq.drive));
});

test("the phase barrier holds under parallelism: all reservations before any fill", async () => {
  const root = fixture({
    "a.md": "# A\n\n[b](./b.md)\n",
    "b.md": "# B\n\n[a](./a.md)\n",
    "c.md": "# C\n\n[a](./a.md) [b](./b.md)\n",
  });
  const { drive } = await run(root, freshManifest(), { concurrency: 4 });
  const shells = drive.calls.filter((c) => c.startsWith("createEmptyDoc")).length;
  const firstFill = drive.calls.findIndex((c) => c.startsWith("updateMedia"));
  // Phase 2 link rewriting needs every reserved id, so all shells must exist
  // before the first fill - the barrier is load-bearing, not an optimization.
  assert.ok(firstFill >= 0, "expected fills to run");
  assert.equal(
    drive.calls.slice(0, firstFill).filter((c) => !c.startsWith("createEmptyDoc")).length,
    0,
    `expected ${shells} shell creations before the first updateMedia`,
  );
});

test("a Drive rate limit halves the pool and the run still completes", async () => {
  const root = fixture({
    "a.md": "# A\n\n[b](./b.md)\n",
    "b.md": "# B\n\n[a](./a.md)\n",
    "c.md": "# C\n",
    "d.md": "# D\n",
  });
  const manifest = freshManifest();
  const { summary } = await run(root, manifest, {
    concurrency: 4,
    rateLimitOn: "A", // fires the listener while reserving the first shell
  });
  assert.deepEqual(summary.concurrency, {
    requested: 4,
    effective: 2,
    rateLimitEvents: 1,
  });
  // Throttling degrades, never stalls: every entry is filled, none pending.
  assert.ok(
    Object.values(manifest.entries).every((e) => !e.pending),
    "all files published despite throttling",
  );
  assert.equal(summary.created, 4);
});

test("summary reports the requested concurrency even when nothing throttled", async () => {
  const root = fixture({ "solo.md": "# Solo\n" });
  const { summary } = await run(root, freshManifest(), { concurrency: 2 });
  assert.deepEqual(summary.concurrency, { requested: 2, effective: 2, rateLimitEvents: 0 });
});

// ---- per-item failure isolation (recreated on the parallel publish) --------

test("a Drive-side rejection fails that item, not the run", async () => {
  const root = fixture({
    "bad.md": "# Bad\n\nnobody references this\n",
    "good.md": "# Good\n\nsee [bad](./bad.md)\n",
  });
  const manifest = freshManifest();
  const { drive, summary } = await run(root, manifest, {
    concurrency: 4,
    failNames: ["Bad"], // rejected when reserving the Doc shell
  });
  assert.equal(summary.failed, 1);
  const failure = summary.diagnostics.find((d) => d.code === "PUBLISH_FAILED");
  assert.ok(failure, "expected a PUBLISH_FAILED error");
  assert.equal(failure.relPath, "bad.md", "the diagnostic names the file");
  assert.match(failure.message, /fake drive: rejected/, "the reason is carried");
  assert.equal(summary.created, 1, "the sibling still published");
  const goodId = manifest.entries["good.md"]?.fileId;
  assert.ok(goodId);
  assert.match(drive.contentOf(goodId), /see \[bad\]/, "link left verbatim");
  assert.ok(!manifest.entries["bad.md"], "no manifest entry for the failed item");
  assert.ok(
    !Object.values(manifest.entries).some((e) => e.pending),
    "nothing left pending: the failed create recorded nothing",
  );
});

test("under parallelism a rejected item never stops its siblings", async () => {
  const files = Object.fromEntries(
    ["a", "b", "c", "d", "e", "f"].map((n) => [`${n}.md`, `# ${n.toUpperCase()}\n`]),
  );
  const root = fixture(files);
  const manifest = freshManifest();
  const { summary } = await run(root, manifest, {
    concurrency: 4,
    failNames: ["C"], // mid-batch rejection
  });
  assert.equal(summary.created, 5, "five of six published");
  assert.equal(summary.failed, 1);
  assert.equal(Object.keys(manifest.entries).length, 5);
});

test("a rejected fill keeps the Doc pending and the next run fills it in place", async () => {
  const root = fixture({ "a.md": "# A\ncontent\n" });
  const manifest = freshManifest();
  const drive = new FakeDrive();
  const first = await run(root, manifest, {
    drive,
    concurrency: 1,
    failFileIds: ["doc0001"], // the first reserved shell's fill is rejected
  });
  assert.equal(first.summary.failed, 1);
  assert.deepEqual(manifestIo.pendingEntries(manifest), ["a.md"], "entry stays pending");
  assert.equal(manifest.entries["a.md"]?.fileId, "doc0001");
  assert.equal(drive.contentOf("doc0001"), "", "shell exists but was never filled");

  // The Drive-side fault was transient: the next run's fill must succeed.
  drive.failFileIds.clear();
  const second = await run(root, manifest, { drive, concurrency: 1 });
  assert.equal(second.summary.failed, 0);
  // Same id - the resume filled the existing shell instead of duplicating.
  assert.equal(manifest.entries["a.md"]?.fileId, "doc0001");
  assert.match(drive.contentOf("doc0001"), /content/);
  assert.equal(manifestIo.pendingEntries(manifest).length, 0);
});

test("each phase-1 reservation is checkpointed to disk immediately", async () => {
  const root = fixture({ "a.md": "# A\n", "b.md": "# B\n" });
  const manifest = freshManifest();
  const drive = new FakeDrive();
  drive.failNames.add("B"); // b.md's reservation is rejected by Drive
  // The `as` widening matters: the assignment happens inside the onProgress
  // callback, which TS does not track, so a plain `null` initializer would
  // keep this narrowed to null/never at the assertions below.
  let observed: Manifest | null = null as Manifest | null;
  const plan = buildPlan({ root, manifest });
  await publish({
    root,
    drive,
    manifest,
    plan,
    prune: false,
    repair: false,
    concurrency: 1,
    now: () => new Date("2024-01-01T00:00:00.000Z"),
    onProgress: (e) => {
      if (e.label === "reserved Doc for a.md" && !observed) {
        observed = manifestIo.load(root);
      }
    },
  });

  assert.ok(observed, "expected to observe the manifest after a.md's reservation");
  assert.ok(
    observed.entries["a.md"]?.pending,
    "a.md hit the disk as pending before b.md was even attempted",
  );
  assert.ok(!observed.entries["b.md"]);
  const final = manifestIo.load(root) as Manifest;
  assert.ok(!final.entries["b.md"], "b.md never recorded (its create failed)");
  assert.ok(final.entries["a.md"], "a.md survived the run on disk");
});

// ---- ignorePatterns interplay ------------------------------------------------

test("ignored content never publishes, in a full parallel run", async () => {
  const root = fixture({
    "toc.md": "# Toc\n",
    "_drafts/old.md": "# Old draft\n",
    "sub/_tmp/note.md": "# Note\n",
    ".gdrive-publish.json": JSON.stringify({ ignorePatterns: ["_*"] }),
  });
  const manifest = freshManifest();
  const { summary, drive } = await run(root, manifest, { concurrency: 4 });
  assert.equal(summary.created, 1, "only toc.md");
  assert.deepEqual(Object.keys(manifest.entries), ["toc.md"]);
  assert.equal(
    drive.calls.filter((c) => c.startsWith("createEmptyDoc")).length,
    1,
    "exactly one Doc shell was ever reserved",
  );
});

test("a previously published file that falls under a pattern becomes an orphan", async () => {
  const root = fixture({
    "toc.md": "# Toc\n",
    "_drafts/old.md": "# Old draft\n",
    ".gdrive-publish.json": JSON.stringify({ ignorePatterns: ["_*"] }),
  });
  const manifest = freshManifest();
  // old.md was published in a previous run, before the ignore existed.
  manifest.entries["_drafts/old.md"] = {
    fileId: "docOLD",
    kind: "markdown",
    name: "Old draft",
    url: "https://docs.google.com/document/d/docOLD/edit",
    contentHash: "deadbeef",
    publishedAt: "2023-01-01T00:00:00.000Z",
  };
  const plan = buildPlan({ root, manifest });
  assert.ok(
    plan.orphans.some((o) => o.relPath === "_drafts/old.md"),
    "the ignored file is a visible orphan",
  );

  // The old Doc must exist in Drive for the prune to trash it.
  const drive = new FakeDrive();
  drive.files.set("docOLD", {
    id: "docOLD",
    name: "Old draft",
    mimeType: "application/vnd.google-apps.document",
  });
  const { summary } = await run(root, manifest, { drive, prune: true, concurrency: 2 });
  assert.equal(summary.pruned, 1, "the orphan left Drive via the explicit prune");
  assert.ok(!manifest.entries["_drafts/old.md"], "and its manifest entry is gone");
  assert.ok(drive.files.get("docOLD")?.trashed, "trashed, never hard-deleted");
});
