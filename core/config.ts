/**
 * Per-project publish config: `.gdrive-publish.json` next to the docs.
 *
 * Raw uploads are opt-in per pattern: a file whose type has no native Drive
 * conversion (no markdown -> Doc, no csv/xlsx -> Sheet) publishes as a raw
 * binary upload only when it matches a `rawPatterns` glob. Without a config
 * (or with no matching pattern) nothing new ever leaves the machine - the
 * default stays "skip with a warning".
 *
 * Glob semantics follow .gitignore intuition:
 *   - a pattern without `/` matches the basename at any depth (`*.zip`)
 *   - a pattern with `/` is anchored to the publish root (`data/*.json`)
 *   - `**` spans segments (`archives/**`), `*` and `?` work within one
 */

import fs from "node:fs";
import path from "node:path";

export const CONFIG_FILENAME = ".gdrive-publish.json";

/** How the Drive Doc name is derived for a markdown file. */
export type NamingStrategy = "auto" | "frontmatter" | "heading" | "filename";
export const NAMING_STRATEGIES: readonly NamingStrategy[] = [
  "auto",
  "frontmatter",
  "heading",
  "filename",
];

/** One naming rule: a source plus optional post-processing. */
export interface NamingRule {
  strategy: NamingStrategy;
  /** Capitalise each lowercase word ("olzhas nurpeisov" -> "Olzhas Nurpeisov"); words that already contain capitals ("SQL", "iOS") stay untouched. */
  titleCase?: boolean;
  /** Regular expressions removed from the chosen name, applied in order. */
  strip?: string[];
}

/** A naming rule scoped to paths matching a gitignore-style glob. */
export interface NamingOverride extends NamingRule {
  pattern: string;
}

/** Top-level `naming` config object. Defaults reproduce the historical behaviour. */
export interface NamingConfig {
  strategy?: NamingStrategy;
  titleCase?: boolean;
  strip?: string[];
  /** First matching override wins; unmatched paths use the global settings. */
  overrides?: NamingOverride[];
}

export interface PublishConfig {
  rawPatterns: string[];
  /**
   * Gitignore-style exclusion: matching files never publish (native types
   * included), and a matching directory is pruned whole. Default: none.
   */
  ignorePatterns?: string[];
  /**
   * Max parallel Drive requests for publish (1–10). Absent means the
   * caller's default; the CLI resolves flag > env > this file > 3.
   */
  concurrency?: number;
  /**
   * Drive naming rules for markdown documents (strategy, transforms,
   * per-path overrides). Absent = the historical behaviour: front-matter
   * title -> first H1 -> filename stem.
   */
  naming?: NamingConfig;
}

/** Default concurrency: mid-band of Google's documented 2–5 recommendation. */
export const DEFAULT_CONCURRENCY = 3;
/** Hard ceiling: beyond this there is no throughput win, only 429 provocation. */
export const MAX_CONCURRENCY = 10;

/** Strict parse of a user-supplied concurrency value (flag or env). */
export function parseConcurrency(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) return null;
  return n;
}

/** Extensions that look like credentials: covered only with a loud caution. */
const CREDENTIAL_ADJACENT = [".env", ".pem", ".key", "id_rsa", "secret", "token", "credential"];

function globToRegex(pattern: string): RegExp {
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*"; // ** spans segments
        i += 2;
        // swallow a following slash so `archives/**` also matches the dir root
        if (pattern[i] === "/") i++;
        continue;
      }
      source += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      i++;
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${source}$`);
}

/** Does `relPath` (forward slashes, never starts with "./") match a pattern? */
export function matchesPattern(pattern: string, relPath: string): boolean {
  if (pattern === "") return false;
  if (!pattern.includes("/")) {
    const base = relPath.split("/").pop() ?? relPath;
    return globToRegex(pattern).test(base);
  }
  return globToRegex(pattern).test(relPath);
}

export function matchesAnyPattern(patterns: string[], relPath: string): boolean {
  return patterns.some((p) => matchesPattern(p, relPath));
}

/** Load the config; null when absent. Invalid content is a hard error. */
export function loadConfig(root: string): PublishConfig | null {
  const p = path.join(root, CONFIG_FILENAME);
  if (!fs.existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(
      `${CONFIG_FILENAME} is not valid JSON: ${String(e instanceof SyntaxError ? e.message : e).slice(0, 120)}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILENAME} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (
      key !== "rawPatterns" &&
      key !== "ignorePatterns" &&
      key !== "concurrency" &&
      key !== "naming"
    ) {
      throw new Error(
        `${CONFIG_FILENAME}: unknown key "${key}" (only rawPatterns, ignorePatterns, concurrency and naming are supported)`,
      );
    }
  }
  const concurrency = obj.concurrency;
  if (
    concurrency !== undefined &&
    (!Number.isInteger(concurrency) ||
      (concurrency as number) < 1 ||
      (concurrency as number) > MAX_CONCURRENCY)
  ) {
    throw new Error(
      `${CONFIG_FILENAME}: "concurrency" must be an integer between 1 and ${MAX_CONCURRENCY}`,
    );
  }
  const patterns = obj.rawPatterns;
  if (
    patterns !== undefined &&
    (!Array.isArray(patterns) || !patterns.every((x) => typeof x === "string"))
  ) {
    throw new Error(`${CONFIG_FILENAME}: rawPatterns must be an array of strings`);
  }
  const ignore = obj.ignorePatterns;
  if (
    ignore !== undefined &&
    (!Array.isArray(ignore) || !ignore.every((x) => typeof x === "string"))
  ) {
    throw new Error(`${CONFIG_FILENAME}: ignorePatterns must be an array of strings`);
  }
  const naming = obj.naming === undefined ? undefined : validateNaming(obj.naming);
  return {
    rawPatterns: (patterns as string[] | undefined) ?? [],
    ...(ignore !== undefined ? { ignorePatterns: ignore as string[] } : {}),
    ...(concurrency !== undefined ? { concurrency: concurrency as number } : {}),
    ...(naming !== undefined ? { naming } : {}),
  };
}

/** Validate a strip-regex list: every entry must compile. Returns it typed. */
function validateStripList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
    throw new Error(
      `${CONFIG_FILENAME}: ${where} must be an array of strings (regular expressions)`,
    );
  }
  for (const pattern of value as string[]) {
    try {
      new RegExp(pattern);
    } catch (e) {
      throw new Error(
        `${CONFIG_FILENAME}: ${where} contains an invalid regular expression "${pattern}": ${String(
          e instanceof Error ? e.message : e,
        ).slice(0, 120)}`,
      );
    }
  }
  return value as string[];
}

/** Validate a naming rule's shared fields (strategy, titleCase, strip). */
function validateRuleFields(
  value: Record<string, unknown>,
  where: string,
  requireStrategy: boolean,
  allowPattern: boolean,
): Partial<NamingRule> {
  const allowedKeys = allowPattern
    ? ["strategy", "titleCase", "strip", "pattern"]
    : ["strategy", "titleCase", "strip"];
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(
        `${CONFIG_FILENAME}: ${where}: unknown key "${key}" (only ${allowedKeys.join(", ")} ${
          allowPattern ? "and pattern " : ""
        }are supported)`,
      );
    }
  }
  let strategy: NamingStrategy | undefined;
  if (value.strategy !== undefined || requireStrategy) {
    if (
      typeof value.strategy !== "string" ||
      !NAMING_STRATEGIES.includes(value.strategy as NamingStrategy)
    ) {
      throw new Error(
        `${CONFIG_FILENAME}: ${where}: "strategy" must be one of ${NAMING_STRATEGIES.map((s) => `"${s}"`).join(", ")}`,
      );
    }
    strategy = value.strategy as NamingStrategy;
  }
  if (value.titleCase !== undefined && typeof value.titleCase !== "boolean") {
    throw new Error(`${CONFIG_FILENAME}: ${where}: "titleCase" must be a boolean`);
  }
  const strip =
    value.strip === undefined ? undefined : validateStripList(value.strip, `${where}.strip`);
  return {
    ...(strategy !== undefined ? { strategy } : {}),
    ...(value.titleCase !== undefined ? { titleCase: value.titleCase as boolean } : {}),
    ...(strip !== undefined ? { strip } : {}),
  };
}

/** Strict parse of the `naming` config object. Invalid content is a hard error. */
function validateNaming(value: unknown): NamingConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${CONFIG_FILENAME}: "naming" must be an object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "strategy" && key !== "titleCase" && key !== "strip" && key !== "overrides") {
      throw new Error(
        `${CONFIG_FILENAME}: naming: unknown key "${key}" (only strategy, titleCase, strip and overrides are supported)`,
      );
    }
  }
  const { overrides, ...shared } = obj;
  const global = validateRuleFields(shared, "naming", false, false) as NamingConfig;
  if (overrides !== undefined) {
    if (!Array.isArray(overrides)) {
      throw new Error(`${CONFIG_FILENAME}: naming.overrides must be an array of objects`);
    }
    global.overrides = overrides.map((entry, i) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`${CONFIG_FILENAME}: naming.overrides[${i}] must be an object`);
      }
      const o = entry as Record<string, unknown>;
      if (typeof o.pattern !== "string" || o.pattern === "") {
        throw new Error(
          `${CONFIG_FILENAME}: naming.overrides[${i}]: "pattern" must be a non-empty string`,
        );
      }
      const rule = validateRuleFields(o, `naming.overrides[${i}]`, true, true);
      return { pattern: o.pattern, ...rule } as NamingOverride;
    });
  }
  return global;
}

/** Atomic write (temp file + rename, same discipline as the manifest). */
export function saveConfig(root: string, config: PublishConfig): string {
  const dest = path.join(root, CONFIG_FILENAME);
  const tmp = path.join(root, `.${CONFIG_FILENAME}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, dest);
  return dest;
}

/** Union, deduped and sorted. Existing entries are never removed. */
export function mergePatterns(existing: string[], added: string[]): string[] {
  return [...new Set([...existing, ...added])].sort();
}

export interface DerivedPatterns {
  /** One `*.ext` pattern per distinct extension found. */
  patterns: string[];
  /** Files without an extension - no automatic pattern can cover them. */
  extensionless: string[];
}

/** Derive covering patterns from unsupported file paths. */
export function derivePatterns(unsupported: string[]): DerivedPatterns {
  const extensions = new Set<string>();
  const extensionless: string[] = [];
  for (const rel of unsupported) {
    const base = rel.split("/").pop() ?? rel;
    const ext = path.extname(base).toLowerCase();
    if (ext === "") {
      extensionless.push(rel);
    } else {
      extensions.add(ext);
    }
  }
  return {
    patterns: [...extensions].sort().map((ext) => `*${ext}`),
    extensionless: extensionless.sort(),
  };
}

/** Patterns (or underlying extensions) that look credential-adjacent. */
export function cautionPatterns(patterns: string[]): string[] {
  return patterns.filter((p) => CREDENTIAL_ADJACENT.some((frag) => p.toLowerCase().includes(frag)));
}
