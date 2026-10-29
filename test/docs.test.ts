/**
 * Documentation drift guard.
 *
 * The CLI reference in MANUAL.md is generated from `commands.ts`
 * (`npm run docs:cli`). This test regenerates the section in memory and
 * compares it with what is committed, so a manual that lags behind a flag
 * change fails CI instead of lying to a reader.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { VERSION } from "../commands.ts";
import { BEGIN_MARKER, END_MARKER, injectSection, renderCliReference } from "../generate-docs.ts";

const MANUAL = path.join(import.meta.dirname, "..", "MANUAL.md");
const PACKAGE = path.join(import.meta.dirname, "..", "package.json");

test("the npm package version matches the CLI's VERSION constant", () => {
  // `gdrive-publish --version` and the npm registry must never disagree; the
  // generated docs reference renders from the same constant, so this also
  // pins the manual.
  const pkg = JSON.parse(fs.readFileSync(PACKAGE, "utf8")) as { version: string };
  assert.equal(
    pkg.version,
    VERSION,
    `package.json says ${pkg.version} but commands.ts VERSION says ${VERSION} - bump both together`,
  );
});

test("the committed CLI reference is current", () => {
  const committed = fs.readFileSync(MANUAL, "utf8");
  assert.ok(committed.includes(BEGIN_MARKER), "MANUAL.md contains the begin marker");
  assert.ok(committed.includes(END_MARKER), "MANUAL.md contains the end marker");

  const expected = injectSection(committed, renderCliReference());
  if (committed !== expected) {
    // Show the first diverging line so the failure is actionable in CI logs.
    const committedLines = committed.split("\n");
    const expectedLines = expected.split("\n");
    let i = 0;
    while (
      i < Math.min(committedLines.length, expectedLines.length) &&
      committedLines[i] === expectedLines[i]
    ) {
      i++;
    }
    assert.fail(
      `extensions/gdrive-publish/MANUAL.md cli-reference is stale (first difference at line ${
        i + 1
      }:\n  committed: ${JSON.stringify(committedLines[i])}\n  expected:  ${JSON.stringify(
        expectedLines[i],
      )})\nrun: npm run docs:cli`,
    );
  }
});

test("the generated section documents every command and flag", () => {
  const section = renderCliReference();
  // imports the table indirectly through renderCliReference; assert coverage via markers
  const committed = fs.readFileSync(MANUAL, "utf8");
  const between = committed.slice(
    committed.indexOf(BEGIN_MARKER) + BEGIN_MARKER.length,
    committed.indexOf(END_MARKER),
  );
  for (const heading of section.split("\n")) {
    if (heading.startsWith("### ")) {
      assert.ok(between.includes(heading), `generated section must contain the ${heading} heading`);
    }
  }
});
