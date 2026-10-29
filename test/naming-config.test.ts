/**
 * Naming-config tests: strategy precedence, transforms (strip/titleCase),
 * per-path overrides, and the fallback reporting that drives NAMING_FALLBACK.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyNameTransforms,
  documentName,
  resolveDocumentName,
  resolveRule,
  titleCase,
} from "../core/naming.ts";

const FRONT = ["---", "title: Front Title", "---"].join("\n");

test("titleCase capitalises lowercase words, leaves deliberate caps alone", () => {
  assert.equal(titleCase("olzhas nurpeisov"), "Olzhas Nurpeisov");
  assert.equal(titleCase("getting-started"), "Getting-Started");
  assert.equal(titleCase("the SQL editor"), "The SQL Editor");
  assert.equal(titleCase("an iOS app"), "An iOS App");
  assert.equal(titleCase("Already Capitalised"), "Already Capitalised");
});

test("applyNameTransforms strips in order, then title-cases", () => {
  const rule = {
    strategy: "auto" as const,
    strip: ["\\s+\\(internal\\)", "-59f99572$"],
    titleCase: true,
  };
  // Two independent strips, applied in order, then title-casing.
  assert.equal(applyNameTransforms("guide (internal)-59f99572", rule), "Guide");
  assert.equal(
    applyNameTransforms("guide (internal)-59f99572", { strategy: "auto", strip: rule.strip }),
    "guide",
  );
});

test("resolveRule: default is the historical auto behaviour", () => {
  assert.deepEqual(resolveRule("a/b.md", undefined), { strategy: "auto" });
  assert.deepEqual(resolveRule("a/b.md", {}), { strategy: "auto" });
  assert.deepEqual(resolveRule("a/b.md", { titleCase: true }), {
    strategy: "auto",
    titleCase: true,
  });
});

test("resolveRule: first matching override wins, and its unset fields inherit the global", () => {
  const config = {
    strategy: "heading" as const,
    titleCase: true,
    strip: ["draft"],
    overrides: [
      { pattern: "author/*.md", strategy: "filename" as const, strip: ["-[0-9a-f]{8}$"] },
      { pattern: "*.md", strategy: "frontmatter" as const },
    ],
  };
  // Match: override 1, strategy its own, strip its own, titleCase inherited.
  assert.deepEqual(resolveRule("author/olzhas-nurpeisov-59f99572.md", config), {
    strategy: "filename",
    strip: ["-[0-9a-f]{8}$"],
    titleCase: true,
  });
  // Match: override 2, nothing of its own beyond strategy - both global
  // transforms inherited.
  assert.deepEqual(resolveRule("notes/readme.md", config), {
    strategy: "frontmatter",
    titleCase: true,
    strip: ["draft"],
  });
  // No match: the global rule.
  assert.deepEqual(resolveRule("notes/readme.txt", config), {
    strategy: "heading",
    titleCase: true,
    strip: ["draft"],
  });
});

test("auto keeps the historical chain: front matter -> first H1 -> stem", () => {
  assert.equal(documentName("a/b.md", `${FRONT}\n# Heading Name`).trim(), "Front Title");
  assert.equal(documentName("a/b.md", "# Heading Name"), "Heading Name");
  assert.equal(documentName("a/getting-started.md", "no heading"), "getting started");
});

test("resolveDocumentName under auto: transforms apply to whichever source wins", () => {
  const rule = { strategy: "auto" as const, titleCase: true };
  assert.equal(resolveDocumentName("a/x.md", "# the SQL editor", rule).name, "The SQL Editor");
  assert.equal(resolveDocumentName("a/getting-started.md", "plain", rule).name, "Getting Started");
});

test("filename strategy: strip runs against the raw slug, separators become spaces", () => {
  const rule = {
    strategy: "filename" as const,
    strip: ["-[0-9a-f]{8}$"],
    titleCase: true,
  };
  const r = resolveDocumentName("author/olzhas-nurpeisov-59f99572.md", `${FRONT}\n# Nice H1`, rule);
  assert.equal(r.name, "Olzhas Nurpeisov");
  assert.equal(r.source, "stem");
  assert.equal(r.missing, undefined);
  // Without titleCase the stem stays lowercase, as on disk.
  const plain = resolveDocumentName("author/olzhas-nurpeisov.md", "# H1", {
    strategy: "filename",
  });
  assert.equal(plain.name, "olzhas nurpeisov");
});

test("heading strategy: the first H1 wins even when a front-matter title exists", () => {
  const rule = { strategy: "heading" as const };
  const r = resolveDocumentName("a/b.md", `${FRONT}\n# Heading Name`, rule);
  assert.equal(r.name, "Heading Name");
  assert.equal(r.missing, undefined);
});

test("explicit strategy with its source absent falls back and reports it", () => {
  const heading = resolveDocumentName("a/plain-file.md", "no heading at all", {
    strategy: "heading",
  });
  assert.equal(heading.name, "plain file");
  assert.equal(heading.source, "stem");
  assert.equal(heading.missing, "heading");

  const front = resolveDocumentName("a/b.md", "# Just a heading", {
    strategy: "frontmatter",
  });
  assert.equal(front.name, "Just a heading");
  assert.equal(front.source, "heading");
  assert.equal(front.missing, "frontmatter");
});

test("a source stripped to nothing counts as missing, the next one is used", () => {
  const rule = { strategy: "frontmatter" as const, strip: ["^Front.*$"] };
  const r = resolveDocumentName("a/b.md", `${FRONT}\n# Heading Name`, rule);
  assert.equal(r.name, "Heading Name");
  assert.equal(r.missing, "frontmatter");
});

test("filename strategy whose strip empties the stem guards with the raw stem", () => {
  const rule = { strategy: "filename" as const, strip: ["^olzhas.*$"] };
  const r = resolveDocumentName("author/olzhas-nurpeisov.md", "# Anything", rule);
  assert.equal(r.name, "olzhas nurpeisov");
  assert.equal(r.missing, "stem");
});

test("auto never reports a fallback - its chain is the defined behaviour", () => {
  const r = resolveDocumentName("a/b.md", "# Just a heading", { strategy: "auto" });
  assert.equal(r.missing, undefined);
});
