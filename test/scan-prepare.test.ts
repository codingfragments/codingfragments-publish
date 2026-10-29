/**
 * Scanning, classification and document preparation tests.
 *
 * Covers the two size guardrails agreed for images (warn per image, hard error
 * per document) and `resolveRelative`'s escape handling, which is the only
 * thing preventing a `../../../etc/passwd`-style link from resolving outside
 * the publish root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  DOC_MAX_BYTES,
  IMAGE_WARN_BYTES,
  fmtBytes,
  prepareMarkdown,
  resolveRelative,
} from "../core/prepare.ts";
import type { ResolvedTarget } from "../core/prepare.ts";
import { classify, folderPaths, imageMimeType, rawMimeType, scan } from "../core/scan.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-scan-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// scan.ts
// ---------------------------------------------------------------------------

test("Office lock files (~$foo.xlsx) are ignored silently", () => {
  write("report.xlsx", "x");
  // `~$` files exist exactly while the real workbook is open in Excel and
  // are never content - they must not be published, skipped or warned about.
  write("~$report.xlsx", Buffer.from("lock file, not a spreadsheet"));
  const result = scan(root);
  assert.deepEqual(
    result.files.map((f) => f.relPath),
    ["report.xlsx"],
  );
  assert.deepEqual(result.skipped, [], "not reported as unsupported either");
});

test("classify maps extensions to kinds", () => {
  assert.equal(classify("a.md"), "markdown");
  assert.equal(classify("a.markdown"), "markdown");
  assert.equal(classify("a.csv"), "csv");
  assert.equal(classify("a.tsv"), "csv");
  assert.equal(classify("a.xlsx"), "xlsx");
  assert.equal(classify("a.xls"), "xlsx");
  assert.equal(classify("a.PNG"), "image", "extension matching must be case-insensitive");
  assert.equal(classify("a.txt"), null);
  assert.equal(classify("noext"), null);
});

test("imageMimeType covers the supported formats", () => {
  assert.equal(imageMimeType("a.png"), "image/png");
  assert.equal(imageMimeType("a.JPG"), "image/jpeg");
  assert.equal(imageMimeType("a.svg"), "image/svg+xml");
  assert.equal(imageMimeType("a.tiff"), null);
});

test("scan finds supported files and reports the rest as skipped", () => {
  write("a.md", "# A");
  write("data.csv", "a,b");
  write("notes.txt", "x");
  write("img/p.png", "fake");
  const result = scan(root);
  assert.deepEqual(result.files.map((f) => f.relPath).sort(), ["a.md", "data.csv", "img/p.png"]);
  assert.deepEqual(result.skipped, ["notes.txt"]);
});

test("scan ignores noise directories and hidden entries", () => {
  write("keep.md", "# keep");
  write("node_modules/pkg/readme.md", "# no");
  write(".git/config", "no");
  write("dist/out.md", "# no");
  write(".hidden/secret.md", "# no");
  write(".hidden.md", "# no");
  const files = scan(root).files.map((f) => f.relPath);
  assert.deepEqual(files, ["keep.md"]);
});

test("scan never includes the manifest itself", () => {
  write("a.md", "# A");
  write(".gdrive-manifest.json", "{}");
  const result = scan(root);
  assert.deepEqual(
    result.files.map((f) => f.relPath),
    ["a.md"],
  );
  assert.deepEqual(result.skipped, []);
});

test("rawPatterns turn matched unsupported files into raw uploads", () => {
  write("a.md", "# A");
  write("data.zip", "PK\u0003\u0004fake");
  write("spec.json", "{}");
  write("Makefile", "all:");
  const result = scan(root, { rawPatterns: ["*.zip"] });
  const kinds = new Map(result.files.map((f) => [f.relPath, f.kind]));
  assert.equal(kinds.get("a.md"), "markdown", "native types untouched");
  assert.equal(kinds.get("data.zip"), "file", "pattern-matched file goes raw");
  assert.ok(!result.files.some((f) => f.relPath === "spec.json"), "unmatched stays skipped");
  assert.ok(result.skipped.includes("spec.json"));
  assert.ok(result.skipped.includes("Makefile"));
});

test("a pattern can never hijack a native type", () => {
  write("data.csv", "a,b");
  const result = scan(root, { rawPatterns: ["*.csv"] });
  assert.equal(
    result.files.find((f) => f.relPath === "data.csv")?.kind,
    "csv",
    "csv converts to a Sheet even when a raw pattern matches",
  );
});

test("hidden files never become raw uploads, whatever the pattern", () => {
  write(".env", "SECRET=1");
  const result = scan(root, { rawPatterns: ["*.env", "**"] });
  assert.ok(!result.files.some((f) => f.relPath === ".env"));
  assert.ok(!result.skipped.includes(".env"), "hidden files are not even scanned");
});

test("rawMimeType maps common types and falls back to octet-stream", () => {
  assert.equal(rawMimeType("a.zip"), "application/zip");
  assert.equal(rawMimeType("a.json"), "application/json");
  assert.equal(rawMimeType("x/y.yaml"), "application/yaml");
  assert.equal(rawMimeType("weird.foo"), "application/octet-stream");
});

test("scan records sizes and is deterministically ordered", () => {
  write("b.md", "bb");
  write("a.md", "a");
  const files = scan(root).files;
  assert.deepEqual(
    files.map((f) => f.relPath),
    ["a.md", "b.md"],
  );
  assert.equal(files[0]?.size, 1);
  assert.equal(files[1]?.size, 2);
});

test("folderPaths lists parents before children, without duplicates", () => {
  const files = [
    { relPath: "a/b/c/deep.md", absPath: "", kind: "markdown" as const, size: 0 },
    { relPath: "a/b/other.md", absPath: "", kind: "markdown" as const, size: 0 },
    { relPath: "top.md", absPath: "", kind: "markdown" as const, size: 0 },
  ];
  assert.deepEqual(folderPaths(files), ["a", "a/b", "a/b/c"]);
});

// ---------------------------------------------------------------------------
// resolveRelative
// ---------------------------------------------------------------------------

test("an image pattern claims images as raw files; native types stay native", () => {
  write("a.md", "# A");
  write("pic.png", "PNG");
  write("data.csv", "a,b");
  const claimed = scan(root, { rawPatterns: ["*.png"] });
  assert.equal(
    claimed.files.find((f) => f.relPath === "pic.png")?.kind,
    "file",
    "image claimed as raw",
  );
  assert.equal(
    claimed.files.find((f) => f.relPath === "data.csv")?.kind,
    "csv",
    "csv still native",
  );
  const unclaimed = scan(root, { rawPatterns: [] });
  assert.equal(
    unclaimed.files.find((f) => f.relPath === "pic.png")?.kind,
    "image",
    "unclaimed image stays embed material",
  );
});

test("resolveRelative normalises against the linking file's directory", () => {
  assert.equal(resolveRelative("toc.md", "./details.md"), "details.md");
  assert.equal(resolveRelative("toc.md", "details.md"), "details.md");
  assert.equal(resolveRelative("guide/intro.md", "../toc.md"), "toc.md");
  assert.equal(resolveRelative("guide/intro.md", "./deep/x.md"), "guide/deep/x.md");
  assert.equal(resolveRelative("a/b/c.md", "../../top.md"), "top.md");
});

test("resolveRelative refuses to escape the publish root", () => {
  assert.equal(resolveRelative("toc.md", "../outside.md"), null);
  assert.equal(resolveRelative("guide/intro.md", "../../outside.md"), null);
  assert.equal(resolveRelative("a.md", "../../../etc/passwd"), null);
});

test("resolveRelative decodes percent-encoded targets", () => {
  assert.equal(resolveRelative("toc.md", "./my%20file.md"), "my file.md");
  // A malformed escape must not throw
  assert.equal(resolveRelative("toc.md", "./bad%zz.md"), "bad%zz.md");
});

// ---------------------------------------------------------------------------
// prepareMarkdown
// ---------------------------------------------------------------------------

function resolvedMap(entries: Record<string, string>): Map<string, ResolvedTarget> {
  const map = new Map<string, ResolvedTarget>();
  for (const [rel, id] of Object.entries(entries)) {
    map.set(rel, {
      fileId: id,
      url: `https://docs.google.com/document/d/${id}/edit`,
      kind: "markdown",
    });
  }
  return map;
}

test("prepareMarkdown rewrites in-set links and strips front matter", () => {
  write("details.md", "# D");
  const result = prepareMarkdown({
    relPath: "toc.md",
    markdown: ["---", "title: T", "---", "", "[d](./details.md)"].join("\n"),
    resolved: resolvedMap({ "details.md": "ID1" }),
    root,
    known: new Set(["toc.md", "details.md"]),
  });
  assert.match(result.content, /\[d\]\(https:\/\/docs\.google\.com\/document\/d\/ID1\/edit\)/);
  assert.doesNotMatch(result.content, /title: T/);
  assert.ok(result.diagnostics.some((d) => d.code === "FRONTMATTER_STRIPPED"));
});

test("a link to a known but unpublished file is distinguished from a missing one", () => {
  write("notes.txt", "x");
  const result = prepareMarkdown({
    relPath: "a.md",
    markdown: "[t](./notes.txt) [m](./gone.md)",
    resolved: resolvedMap({}),
    root,
    known: new Set(["a.md", "notes.txt"]),
  });
  const codes = result.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("LINK_TO_UNSUPPORTED"), "unsupported-but-present target");
  assert.ok(codes.includes("LINK_TARGET_MISSING"), "absent target");
});

test("images are inlined as data URIs with the right mime type", () => {
  write("img/p.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const result = prepareMarkdown({
    relPath: "a.md",
    markdown: "![p](./img/p.png)",
    resolved: resolvedMap({}),
    root,
    known: new Set(["a.md", "img/p.png"]),
  });
  assert.equal(result.inlinedImages, 1);
  assert.match(result.content, /!\[p\]\(data:image\/png;base64,iVBORw==\)/);
});

test("a missing or unsupported image is left verbatim with a warning", () => {
  write("img/x.tiff", "x");
  const result = prepareMarkdown({
    relPath: "a.md",
    markdown: "![gone](./img/gone.png) ![bad](./img/x.tiff)",
    resolved: resolvedMap({}),
    root,
    known: new Set(["a.md"]),
  });
  const codes = result.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("IMAGE_MISSING"));
  assert.ok(codes.includes("IMAGE_UNSUPPORTED"));
  assert.match(result.content, /!\[gone\]\(\.\/img\/gone\.png\)/);
  assert.equal(result.inlinedImages, 0);
});

test("an image over the warn threshold is still inlined but reported", () => {
  write("big.png", Buffer.alloc(IMAGE_WARN_BYTES + 1024, 1));
  const result = prepareMarkdown({
    relPath: "a.md",
    markdown: "![big](./big.png)",
    resolved: resolvedMap({}),
    root,
    known: new Set(["a.md", "big.png"]),
  });
  const warn = result.diagnostics.find((d) => d.code === "IMAGE_LARGE");
  assert.ok(warn, "expected IMAGE_LARGE");
  assert.match(warn?.message ?? "", /base64/);
  assert.equal(result.inlinedImages, 1);
});

test("a document over the payload cap produces a hard error", () => {
  // One image big enough that base64 pushes the document past the cap.
  const size = Math.ceil((DOC_MAX_BYTES * 3) / 4) + 1024;
  write("huge.png", Buffer.alloc(size, 7));
  const result = prepareMarkdown({
    relPath: "a.md",
    markdown: "![huge](./huge.png)",
    resolved: resolvedMap({}),
    root,
    known: new Set(["a.md", "huge.png"]),
  });
  const error = result.diagnostics.find((d) => d.code === "DOC_PAYLOAD_TOO_LARGE");
  assert.ok(error, "expected DOC_PAYLOAD_TOO_LARGE");
  assert.equal(error?.severity, "error");
});

test("external, absolute and anchor-only links behave as agreed", () => {
  const result = prepareMarkdown({
    relPath: "a.md",
    markdown: "[e](https://x.test) [abs](/rooted.md) [local](#section) [m](mailto:a@b.c)",
    resolved: resolvedMap({}),
    root,
    known: new Set(["a.md"]),
  });
  assert.match(result.content, /\[e\]\(https:\/\/x\.test\)/);
  assert.match(result.content, /\[abs\]\(\/rooted\.md\)/);
  assert.match(result.content, /\[local\]\(#section\)/);
  assert.match(result.content, /\[m\]\(mailto:a@b\.c\)/);
  const codes = result.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("LINK_OUTSIDE_ROOT"), "absolute path is flagged");
  assert.equal(codes.filter((c) => c === "LINK_OUTSIDE_ROOT").length, 1, "only the absolute one");
});

test("fmtBytes renders human units", () => {
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2048), "2.0 KB");
  assert.equal(fmtBytes(5 * 1024 * 1024), "5.0 MB");
});

// ---------------------------------------------------------------------------
// analyzeOnly mode (used by `plan`)
// ---------------------------------------------------------------------------

test("analyzeOnly produces the same diagnostics without encoding the payload", () => {
  write("img/p.png", Buffer.alloc(3000, 9));
  const input = {
    relPath: "a.md",
    markdown: "![p](./img/p.png)\n[missing](./nope.md)\n",
    resolved: resolvedMap({}),
    root,
    known: new Set(["a.md", "img/p.png"]),
  };
  const real = prepareMarkdown(input);
  const analyzed = prepareMarkdown({ ...input, analyzeOnly: true });

  assert.deepEqual(
    analyzed.diagnostics.map((d) => d.code),
    real.diagnostics.map((d) => d.code),
    "analysis must not change which diagnostics are produced",
  );
  assert.equal(analyzed.inlinedImages, real.inlinedImages);
  // The real payload embeds base64; the analysis only records its size.
  assert.match(real.content, /base64,[A-Za-z0-9+/]{40}/);
  assert.doesNotMatch(analyzed.content, /base64,[A-Za-z0-9+/]{40}/);
  assert.match(analyzed.content, /<3000 bytes>/);
});

test("analyzeOnly still measures the payload accurately enough to trip the cap", () => {
  const size = Math.ceil((DOC_MAX_BYTES * 3) / 4) + 4096;
  write("huge.png", Buffer.alloc(size, 1));
  const input = {
    relPath: "a.md",
    markdown: "![huge](./huge.png)",
    resolved: resolvedMap({}),
    root,
    known: new Set(["a.md", "huge.png"]),
  };
  const analyzed = prepareMarkdown({ ...input, analyzeOnly: true });
  const real = prepareMarkdown(input);
  for (const result of [analyzed, real]) {
    assert.ok(
      result.diagnostics.some((d) => d.code === "DOC_PAYLOAD_TOO_LARGE" && d.severity === "error"),
    );
  }
  // Estimated size must be within a few bytes of the real payload.
  assert.ok(
    Math.abs(analyzed.payloadBytes - real.payloadBytes) < 64,
    `estimate ${analyzed.payloadBytes} vs real ${real.payloadBytes}`,
  );
});

// ---- ignorePatterns ---------------------------------------------------------

test("a basename pattern ignores matching directories at any depth, whole subtree", () => {
  write("keep.md", "# Keep");
  write("_drafts/old.md", "# Old");
  write("sub/keep.md", "# Sub");
  write("sub/_secret/hidden.md", "# Hidden");
  const result = scan(root, { ignorePatterns: ["_*"] });
  assert.deepEqual(
    result.files.map((f) => f.relPath).sort(),
    ["keep.md", "sub/keep.md"],
    "underscore subtrees gone at both depths, the rest untouched",
  );
  assert.deepEqual(result.skipped, [], "ignored content never warns as unsupported");
});

test("ignorePatterns suppress native types, not just unsupported files", () => {
  write("toc.md", "# Toc");
  write("secret.md", "# Secret");
  write("data.csv", "a,b\n");
  const result = scan(root, { ignorePatterns: ["secret.md", "data.csv"] });
  assert.deepEqual(
    result.files.map((f) => f.relPath),
    ["toc.md"],
  );
});

test("ignore beats raw: an ignored file never uploads as raw either", () => {
  write("a.log", "x");
  write("special.log", "x");
  const result = scan(root, { rawPatterns: ["*.log"], ignorePatterns: ["special.log"] });
  const rels = result.files.map((f) => f.relPath);
  assert.deepEqual(rels, ["a.log"], "special.log is gone entirely, not claimed as raw");
  assert.ok(result.files[0]?.kind === "file", "a.log still claims its raw upload");
});

test("a slash pattern is anchored to the publish root", () => {
  write("data/x.md", "# X");
  write("sub/data/x.md", "# X sub");
  const result = scan(root, { ignorePatterns: ["data/**"] });
  assert.deepEqual(
    result.files.map((f) => f.relPath),
    ["sub/data/x.md"],
  );
});

test("ignorePatterns are read from .gdrive-publish.json when not overridden", () => {
  write("_drafts/a.md", "# A");
  write("keep.md", "# K");
  write(".gdrive-publish.json", JSON.stringify({ ignorePatterns: ["_*"] }));
  assert.deepEqual(
    scan(root).files.map((f) => f.relPath),
    ["keep.md"],
  );
});
