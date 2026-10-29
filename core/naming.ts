/**
 * Front matter handling and Drive naming.
 *
 * The spike proved the Drive markdown importer turns YAML front matter into a
 * mangled heading, so stripping it is mandatory rather than cosmetic. The
 * stripped `title:` still feeds the Drive file name.
 */

import { matchesPattern } from "./config.ts";
import type { NamingConfig, NamingRule } from "./config.ts";

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

/** Raw filename stem: extension removed, separators preserved ("a/b-slug.md" -> "b-slug"). */
function stemRaw(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.[^.]+$/, "");
}

/**
 * The stem-based name under a rule: `strip` runs against the raw slug (hyphens
 * and underscores intact, so filename-oriented patterns like
 * "-[0-9a-f]{8}$" match), then separators become spaces, then title-casing.
 */
function stemName(relPath: string, rule: NamingRule): string {
  let out = stemRaw(relPath);
  for (const pattern of rule.strip ?? []) {
    out = out.replace(new RegExp(pattern, "g"), "");
  }
  out = out.replace(/[_-]+/g, " ").trim();
  if (rule.titleCase) out = titleCase(out);
  return out;
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

/** Which source a resolved name came from. */
export type NameSource = "frontmatter" | "heading" | "stem";

export interface ResolvedName {
  name: string;
  source: NameSource;
  /**
   * For an explicit strategy: the configured source that was unavailable or
   * stripped to nothing, so a lower-priority source had to be used instead.
   */
  missing?: NameSource;
}

/**
 * Effective rule for one path: the first matching override wins (its unset
 * fields inherit the global settings), else the global settings, else
 * `auto` with no transforms - the historical behaviour.
 */
export function resolveRule(relPath: string, config?: NamingConfig): NamingRule {
  const global: NamingRule = {
    strategy: config?.strategy ?? "auto",
    ...(config?.titleCase !== undefined ? { titleCase: config.titleCase } : {}),
    ...(config?.strip !== undefined ? { strip: config.strip } : {}),
  };
  for (const override of config?.overrides ?? []) {
    if (!matchesPattern(override.pattern, relPath)) continue;
    // Unset transform fields inherit the global settings, so a tree can set
    // `titleCase` once and override only the strategy per path.
    return {
      strategy: override.strategy,
      ...(override.titleCase !== undefined
        ? { titleCase: override.titleCase }
        : global.titleCase !== undefined
          ? { titleCase: global.titleCase }
          : {}),
      ...(override.strip !== undefined
        ? { strip: override.strip }
        : global.strip !== undefined
          ? { strip: global.strip }
          : {}),
    };
  }
  return global;
}

/** Capitalise each lowercase word at word and separator boundaries. */
function titleCaseWord(token: string): string {
  // A word that already contains capitals (SQL, iOS, UI) is deliberate - leave it.
  if (token !== token.toLowerCase()) return token;
  return token.replace(
    /(^|[-_.])([a-z])/g,
    (_, prefix: string, ch: string) => prefix + ch.toUpperCase(),
  );
}

/** Title-case a name without touching words that already carry capitals. */
export function titleCase(name: string): string {
  return name.split(/\s+/).map(titleCaseWord).join(" ").trim();
}

/** Apply a rule's post-processing: strip regexes in order, then title-casing. */
export function applyNameTransforms(name: string, rule: NamingRule): string {
  let out = name;
  for (const pattern of rule.strip ?? []) {
    out = out.replace(new RegExp(pattern, "g"), "");
  }
  if (rule.titleCase) out = titleCase(out);
  return out.trim();
}

/**
 * Resolve a markdown document's Drive name under a naming rule.
 *
 * Source order per strategy (a missing or stripped-empty source falls back
 * along the auto chain):
 *   auto       frontmatter -> heading -> stem (the historical chain)
 *   frontmatter frontmatter -> heading -> stem, reported when the title is missing
 *   heading    heading -> stem
 *   filename   stem only
 *
 * A source that is absent, or stripped to nothing by `strip`, is skipped in
 * favour of the next one; the raw stem is the final guard so the result is
 * never empty. Explicit strategies report the skipped source via `missing`
 * so callers can warn.
 */
export function resolveDocumentName(
  relPath: string,
  markdown: string,
  rule: NamingRule = { strategy: "auto" },
): ResolvedName {
  const fm = splitFrontMatter(markdown);
  const sources: Record<NameSource, () => string | null> = {
    frontmatter: () => fm.fields.title?.trim() || null,
    heading: () => firstHeading(fm.body),
    stem: () => stemName(relPath, rule) || null,
  };
  const order: NameSource[] =
    rule.strategy === "auto" || rule.strategy === "frontmatter"
      ? ["frontmatter", "heading", "stem"]
      : rule.strategy === "heading"
        ? ["heading", "stem"]
        : ["stem"];
  const primary = order[0] as NameSource;
  for (const source of order) {
    const raw = sources[source]();
    if (raw === null) continue;
    const transformed = applyNameTransforms(raw, rule);
    if (transformed === "") continue; // stripped to nothing - try the next source
    // Only an explicit strategy that lost its configured source is a
    // fallback; `auto` walking its chain is the defined behaviour.
    const missing = rule.strategy !== "auto" && source !== primary ? primary : undefined;
    return { name: transformed, source, ...(missing ? { missing } : {}) };
  }
  // Ultimate guard: never publish an empty name, even if `strip` emptied
  // every candidate - fall back to the raw stem, untransformed.
  const missing = rule.strategy !== "auto" ? primary : undefined;
  return { name: stemToName(relPath), source: "stem", ...(missing ? { missing } : {}) };
}

/** Drive name for tabular sources: always the filename stem. */
export function tabularName(relPath: string): string {
  return stemToName(relPath);
}
