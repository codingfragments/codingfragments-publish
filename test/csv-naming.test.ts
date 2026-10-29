/**
 * CSV sniffing/normalisation and naming tests.
 *
 * The German-Excel case (semicolon + latin1 + BOM) is the silent-failure mode
 * that motivated decision 12.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectDelimiter,
  detectEncoding,
  normaliseCsv,
  parseRows,
  serializeRows,
} from "../core/csv.ts";
import { documentName, firstHeading, splitFrontMatter, stemToName } from "../core/naming.ts";

test("detects UTF-8 BOM, UTF-16 and latin1", () => {
  assert.equal(detectEncoding(Buffer.from("a,b\n", "utf8")), "utf-8");
  assert.equal(
    detectEncoding(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b")])),
    "utf-8-bom",
  );
  assert.equal(
    detectEncoding(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a", "utf16le")])),
    "utf-16le",
  );
  assert.equal(detectEncoding(Buffer.from([0x57, 0x65, 0x72, 0x74, 0xe4])), "latin1");
});

test("detects the delimiter, ignoring separators inside quotes", () => {
  assert.equal(detectDelimiter("a,b\n1,2\n"), ",");
  assert.equal(detectDelimiter("a;b\n1;2\n"), ";");
  assert.equal(detectDelimiter("a\tb\n1\t2\n"), "\t");
  assert.equal(detectDelimiter('"a;b;c",x\n1,2\n'), ",");
});

test("single-column CSV falls back to comma", () => {
  assert.equal(detectDelimiter("header\nvalue\n"), ",");
});

test("normalises the German-Excel case to UTF-8 comma CSV", () => {
  const raw = Buffer.from("\uFEFFSpalte 1;Spalte 2\r\nWert ä;Wert ö\r\n", "latin1");
  const result = normaliseCsv(raw);
  assert.equal(result.delimiter, ";");
  assert.equal(result.encoding, "latin1");
  assert.equal(result.normalised, true);
  assert.match(result.text, /Spalte 1,Spalte 2/);
  assert.match(result.text, /Wert ä,Wert ö/);
});

test("clean comma CSV is reported as not normalised", () => {
  const result = normaliseCsv(Buffer.from("a,b\n1,2\n", "utf8"));
  assert.equal(result.normalised, false);
  assert.equal(result.text, "a,b\n1,2\n");
});

test("quoted fields with embedded delimiters and quotes survive a round trip", () => {
  const rows = parseRows('a;"b;c";"say ""hi"""\n', ";");
  assert.deepEqual(rows, [["a", "b;c", 'say "hi"']]);
  assert.equal(serializeRows(rows), 'a,"b;c","say ""hi"""\n');
});

test("normalised output cannot be re-sniffed as another dialect", () => {
  // Regression: fields containing semicolons used to be emitted bare, so a
  // re-sniffing reader (Drive sniffs) counted more ';' than ',' and split the
  // rows into extra columns.
  const raw = Buffer.from("name;note\nAlice;loves a,b\nBob;x,y\nCarol;p,q\n", "utf8");
  const { text } = normaliseCsv(raw);
  assert.equal(detectDelimiter(text), ",", `re-sniffed the wrong delimiter in: ${text}`);
  // and the data must survive unchanged
  assert.deepEqual(parseRows(text, ","), [
    ["name", "note"],
    ["Alice", "loves a,b"],
    ["Bob", "x,y"],
    ["Carol", "p,q"],
  ]);
});

test("semicolon-heavy field content stays in one column after normalisation", () => {
  const raw = Buffer.from("name,note\nAlice,loves a;b;c\nBob,x;y;z\nCarol,p;q;r\n", "utf8");
  const { text } = normaliseCsv(raw);
  assert.equal(detectDelimiter(text), ",");
  const rows = parseRows(text, ",");
  assert.equal(rows[1]?.length, 2);
  assert.equal(rows[1]?.[1], "loves a;b;c");
});

test("front matter is split and parsed", () => {
  const md = ["---", 'title: "My Doc"', "author: me", "---", "", "# Heading", "body"].join("\n");
  const fm = splitFrontMatter(md);
  assert.equal(fm.present, true);
  assert.equal(fm.fields.title, "My Doc");
  assert.equal(fm.fields.author, "me");
  assert.equal(fm.body, "# Heading\nbody");
});

test("unterminated front matter is left alone", () => {
  const md = ["---", "title: x", "# Heading"].join("\n");
  const fm = splitFrontMatter(md);
  assert.equal(fm.present, false);
  assert.equal(fm.body, md);
});

test("firstHeading ignores headings inside code fences", () => {
  const md = ["```", "# not a heading", "```", "# Real Heading"].join("\n");
  assert.equal(firstHeading(md), "Real Heading");
});

test("documentName prefers title, then H1, then the filename stem", () => {
  assert.equal(
    documentName("a/b.md", ["---", "title: From Front", "---", "# H1"].join("\n")),
    "From Front",
  );
  assert.equal(documentName("a/b.md", "# From Heading\n"), "From Heading");
  assert.equal(documentName("a/getting-started.md", "no heading here"), "getting started");
  assert.equal(stemToName("docs/my_file.md"), "my file");
});
