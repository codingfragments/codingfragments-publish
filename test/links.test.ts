/**
 * Link rewriting tests.
 *
 * The spike's naive regex rewrote links inside code fences and matched targets
 * by string equality; both are regressions this file guards against.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTarget, collectLinks, rewriteLinks, splitAnchor } from "../core/links.ts";

test("classifyTarget distinguishes external, absolute and relative targets", () => {
  assert.equal(classifyTarget("https://example.com"), "external");
  assert.equal(classifyTarget("mailto:a@b.c"), "external");
  assert.equal(classifyTarget("data:image/png;base64,AAA"), "external");
  assert.equal(classifyTarget("//cdn.example.com/x.png"), "external");
  assert.equal(classifyTarget("/abs/path.md"), "absolute");
  assert.equal(classifyTarget("./details.md"), "relative");
  assert.equal(classifyTarget("details.md"), "relative");
  assert.equal(classifyTarget(""), "anchor-only");
});

test("splitAnchor separates the fragment", () => {
  assert.deepEqual(splitAnchor("details.md#section"), { target: "details.md", anchor: "#section" });
  assert.deepEqual(splitAnchor("details.md"), { target: "details.md", anchor: "" });
  assert.deepEqual(splitAnchor("#local"), { target: "", anchor: "#local" });
});

test("rewrites inline links and images, preserving titles", () => {
  const md = 'see [x](./a.md) and ![img](./b.png "Title")';
  const out = rewriteLinks(md, (l) => (l.target === "./a.md" ? "URL_A" : "URL_B"));
  assert.equal(out, 'see [x](URL_A) and ![img](URL_B "Title")');
});

test("never rewrites inside fenced code blocks", () => {
  const md = ["text [a](./a.md)", "```md", "[b](./b.md)", "```", "[c](./c.md)"].join("\n");
  const out = rewriteLinks(md, () => "REWRITTEN");
  assert.equal(
    out,
    ["text [a](REWRITTEN)", "```md", "[b](./b.md)", "```", "[c](REWRITTEN)"].join("\n"),
  );
});

test("handles tilde fences and longer backtick runs", () => {
  const md = ["~~~", "[a](./a.md)", "~~~", "````", "[b](./b.md)", "````", "[c](./c.md)"].join("\n");
  const out = rewriteLinks(md, () => "X");
  assert.match(out, /~~~\n\[a\]\(\.\/a\.md\)/);
  assert.match(out, /````\n\[b\]\(\.\/b\.md\)/);
  assert.match(out, /\[c\]\(X\)/);
});

test("never rewrites inside inline code spans", () => {
  const md = "use `[a](./a.md)` but rewrite [b](./b.md)";
  const out = rewriteLinks(md, () => "X");
  assert.equal(out, "use `[a](./a.md)` but rewrite [b](X)");
});

test("handles double-backtick code spans containing backticks", () => {
  const md = "``code with ` tick [a](./a.md)`` and [b](./b.md)";
  const out = rewriteLinks(md, () => "X");
  assert.equal(out, "``code with ` tick [a](./a.md)`` and [b](X)");
});

test("rewrites reference-style definitions", () => {
  const md = ["see [x][ref]", "", "[ref]: ./a.md"].join("\n");
  const out = rewriteLinks(md, () => "URL_A");
  assert.equal(out, ["see [x][ref]", "", "[ref]: URL_A"].join("\n"));
});

test("returning null leaves a link untouched", () => {
  const md = "[a](./a.md) [b](https://x.test)";
  const out = rewriteLinks(md, (l) => (l.target.startsWith("http") ? null : "X"));
  assert.equal(out, "[a](X) [b](https://x.test)");
});

test("collectLinks finds links but not code-fenced ones", () => {
  const md = ["[a](./a.md)", "```", "[b](./b.md)", "```", "![i](./i.png)"].join("\n");
  const links = collectLinks(md);
  assert.deepEqual(
    links.map((l) => l.raw),
    ["./a.md", "./i.png"],
  );
  assert.equal(links[1]?.isImage, true);
});
