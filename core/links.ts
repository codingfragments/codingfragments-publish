/**
 * Markdown link parsing and rewriting.
 *
 * Deliberately conservative: it finds inline links/images and reference
 * definitions, and it must never touch anything inside fenced code blocks or
 * inline code spans (verified by tests, and a known failure mode of the naive
 * regex used in the spike).
 */

export interface LinkRef {
  /** Raw target as written in the document, e.g. "./details.md#section". */
  raw: string;
  /** Target without the anchor part. */
  target: string;
  /** Anchor including "#", or "" when absent. */
  anchor: string;
  isImage: boolean;
}

export type LinkKind = "external" | "absolute" | "relative" | "anchor-only";

export function classifyTarget(target: string): LinkKind {
  if (target === "") return "anchor-only";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return "external"; // http:, mailto:, data:
  if (target.startsWith("//")) return "external";
  if (target.startsWith("/")) return "absolute";
  return "relative";
}

export function splitAnchor(raw: string): { target: string; anchor: string } {
  const hash = raw.indexOf("#");
  if (hash < 0) return { target: raw, anchor: "" };
  return { target: raw.slice(0, hash), anchor: raw.slice(hash) };
}

/** Strip an optional link title: `path "Title"` -> `path`. */
function splitTitle(inner: string): { target: string; title: string } {
  const m = inner.match(/^(\S*)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))$/);
  if (m) return { target: m[1] ?? "", title: m[2] ?? "" };
  return { target: inner, title: "" };
}

/**
 * Split a line into alternating non-code and inline-code segments.
 * Only non-code segments are eligible for link rewriting.
 */
function splitInlineCode(line: string): { text: string; code: boolean }[] {
  const out: { text: string; code: boolean }[] = [];
  let i = 0;
  while (i < line.length) {
    const tickStart = line.indexOf("`", i);
    if (tickStart < 0) {
      out.push({ text: line.slice(i), code: false });
      break;
    }
    if (tickStart > i) out.push({ text: line.slice(i, tickStart), code: false });
    // Count the opening run length; the closing run must match it (CommonMark).
    let runLen = 0;
    while (line[tickStart + runLen] === "`") runLen++;
    const fence = "`".repeat(runLen);
    const close = line.indexOf(fence, tickStart + runLen);
    if (close < 0) {
      // Unterminated code span: treat the rest as plain text.
      out.push({ text: line.slice(tickStart), code: false });
      break;
    }
    out.push({ text: line.slice(tickStart, close + runLen), code: true });
    i = close + runLen;
  }
  return out;
}

const INLINE_LINK = /(!?)\[([^\]]*)\]\(([^)]*)\)/g;
const REFERENCE_DEF = /^(\s{0,3}\[[^\]]+\]:\s*)(\S+)(.*)$/;

/**
 * Walk a markdown document and rewrite link targets via `replacer`.
 *
 * `replacer` receives the parsed link and returns a replacement target, or
 * `null` to leave the link untouched. Fenced code blocks and inline code spans
 * are never visited.
 */
export function rewriteLinks(markdown: string, replacer: (link: LinkRef) => string | null): string {
  const lines = markdown.split("\n");
  let fence: string | null = null;
  const out: string[] = [];

  for (const line of lines) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      // Inside a fenced block: only a matching closing fence is meaningful.
      if (fenceMatch && (fenceMatch[1] as string).startsWith(fence[0] as string)) {
        if ((fenceMatch[1] as string).length >= fence.length) fence = null;
      }
      out.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] as string;
      out.push(line);
      continue;
    }

    // Reference-style definition lines: [id]: target "title"
    const refDef = line.match(REFERENCE_DEF);
    if (refDef) {
      const { target, anchor } = splitAnchor(refDef[2] as string);
      const replacement = replacer({ raw: refDef[2] as string, target, anchor, isImage: false });
      out.push(replacement === null ? line : `${refDef[1] ?? ""}${replacement}${refDef[3] ?? ""}`);
      continue;
    }

    const segments = splitInlineCode(line);
    const rebuilt = segments
      .map((seg) => {
        if (seg.code) return seg.text;
        return seg.text.replace(INLINE_LINK, (match, bang: string, text: string, inner: string) => {
          const { target: rawTarget, title } = splitTitle(inner.trim());
          const { target, anchor } = splitAnchor(rawTarget);
          const replacement = replacer({
            raw: rawTarget,
            target,
            anchor,
            isImage: bang === "!",
          });
          if (replacement === null) return match;
          return `${bang}[${text}](${replacement}${title})`;
        });
      })
      .join("");
    out.push(rebuilt);
  }

  return out.join("\n");
}

/** Collect every link in a document without modifying it. */
export function collectLinks(markdown: string): LinkRef[] {
  const found: LinkRef[] = [];
  rewriteLinks(markdown, (link) => {
    found.push(link);
    return null;
  });
  return found;
}
