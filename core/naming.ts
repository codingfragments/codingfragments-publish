/**
 * Front matter handling and Drive naming.
 *
 * The spike proved the Drive markdown importer turns YAML front matter into a
 * mangled heading, so stripping it is mandatory rather than cosmetic. The
 * stripped `title:` still feeds the Drive file name.
 */

export interface FrontMatter {
  /** Document body with the front-matter block removed. */
  body: string;
  /** Raw front-matter text, or "" when absent. */
  raw: string;
  /** Shallow key/value pairs parsed from simple `key: value` lines. */
  fields: Record<string, string>;
  present: boolean;
}

const FENCE = /^---\s*$/;

/**
 * Split leading YAML front matter from a markdown document.
 * Only a block starting on line 1 counts (per CommonMark-ish convention).
 */
export function splitFrontMatter(markdown: string): FrontMatter {
  const lines = markdown.split("\n");
  if (lines.length === 0 || !FENCE.test(lines[0] ?? "")) {
    return { body: markdown, raw: "", fields: {}, present: false };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    // Unterminated block: treat the document as having no front matter rather
    // than swallowing the whole file.
    return { body: markdown, raw: "", fields: {}, present: false };
  }
  const raw = lines.slice(1, end).join("\n");
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "");
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = (m[1] ?? "").trim();
    let value = (m[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }
  return { body, raw, fields, present: true };
}

/** First ATX H1 (`# Title`) in a document body, ignoring fenced code. */
export function firstHeading(markdown: string): string | null {
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && (fenceMatch[1] as string)[0] === fence[0]) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] as string;
      continue;
    }
    const h1 = line.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/);
    if (h1) return (h1[1] ?? "").trim();
  }
  return null;
}

/** Filename stem, with separators turned into spaces: "getting-started" -> "getting started". */
export function stemToName(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const stem = base.replace(/\.[^.]+$/, "");
  return stem.replace(/[_-]+/g, " ").trim() || stem;
}

/**
 * Drive name for a markdown document: front-matter `title` -> first H1 ->
 * filename stem (decision 12; identity is the manifest fileId, so renames are
 * safe).
 */
export function documentName(relPath: string, markdown: string): string {
  const fm = splitFrontMatter(markdown);
  const title = fm.fields.title?.trim();
  if (title) return title;
  const heading = firstHeading(fm.body);
  if (heading) return heading;
  return stemToName(relPath);
}

/** Drive name for tabular sources: always the filename stem. */
export function tabularName(relPath: string): string {
  return stemToName(relPath);
}
