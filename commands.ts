/**
 * Declarative command table for the CLI.
 *
 * Everything the user sees - the overview, per-command help, flag validation,
 * and the error message for a bad flag - is derived from this table, so help
 * text cannot drift from behaviour. A meta-test asserts every command is fully
 * documented.
 *
 * This module is CLI-only (no pi imports, no Drive access) and is kept out of
 * `core/` because it describes the command-line surface rather than the
 * publishing logic.
 */

/** Tool version, independent of the monorepo's package version. */
export const VERSION = "0.10.0";

export const BIN = "gdrive-publish";

export interface FlagSpec {
  /** Long name without dashes, e.g. "dry-run". */
  name: string;
  summary: string;
  /** Flag takes a value: `--name "Docs"` or `--name=Docs`. */
  takesValue?: boolean;
  valueLabel?: string;
  required?: boolean;
}

export interface CommandSpec {
  name: string;
  /** One-line summary used in the overview. */
  summary: string;
  /** Positional argument spec for help output, e.g. "<dir>". */
  args: string;
  /** Command needs a directory argument. */
  needsTarget: boolean;
  /** Longer explanation shown by `help <command>`. */
  details: string;
  flags: FlagSpec[];
  examples: string[];
}

const JSON_FLAG: FlagSpec = {
  name: "json",
  summary: "machine-readable output on stdout",
};

const REMOTE_FLAG: FlagSpec = {
  name: "remote",
  summary: "rclone remote to take client credentials from",
  takesValue: true,
  valueLabel: "<name>",
};

const CONCURRENCY_FLAG: FlagSpec = {
  name: "concurrency",
  summary: "max parallel Drive requests, 1–10 (default 3; 1 = sequential)",
  takesValue: true,
  valueLabel: "<n>",
};

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "help", summary: "show help for a command and exit" },
  { name: "version", summary: "print the version and exit" },
];

export const COMMANDS: CommandSpec[] = [
  {
    name: "login",
    summary: "authorise once via the browser (scope: drive.file)",
    args: "",
    needsTarget: false,
    details:
      "Opens a Google consent screen and caches a refresh token per OAuth client\n" +
      "identity in ~/.config/gdrive-publish/token-<hash>.json (mode 0600).\n\n" +
      "This is the only interactive command: every other command works headless,\n" +
      "so the CLI stays usable from CI and git hooks.",
    flags: [REMOTE_FLAG],
    examples: [`${BIN} login`, `${BIN} login --remote gdriveDD`],
  },
  {
    name: "init",
    summary: "create the Drive folder and the manifest for a directory",
    args: "<dir>",
    needsTarget: true,
    details:
      "Creates a Drive folder owned by this tool and writes .gdrive-manifest.json\n" +
      "into <dir>. Commit that manifest: it maps source files to Drive fileIds and\n" +
      "is the reason shared URLs stay stable for everyone.\n\n" +
      "You can move and share the created folder freely in Drive afterwards;\n" +
      "access survives the move.\n\n" +
      "With --into, an existing folder becomes the publish root instead: publishing\n" +
      "creates its subfolders inside it. The folder must be visible under the\n" +
      "drive.file scope - i.e. created by the same OAuth project. Folders made\n" +
      "in the Drive web UI are NOT visible to this tool; init your own folder and\n" +
      "move it into place instead (moves are always supported).",
    flags: [
      {
        name: "name",
        summary: "name of the Drive folder to create (not needed with --into)",
        takesValue: true,
        valueLabel: "<name>",
      },
      {
        name: "into",
        summary: "adopt an existing Drive folder as the publish root instead of creating one",
        takesValue: true,
        valueLabel: "<url|id>",
      },
      {
        name: "force",
        summary: "allow init inside a tree that already has a publish root (nested roots)",
      },
      REMOTE_FLAG,
    ],
    examples: [
      `${BIN} init docs/ --name "Project X Docs"`,
      `${BIN} init docs/ --into https://drive.google.com/drive/folders/<id>`,
    ],
  },
  {
    name: "plan",
    summary: "show what publishing would do, without writing anything",
    args: "<dir>",
    needsTarget: true,
    details:
      "Fully offline: no network, no writes. Reports every diagnostic a real publish\n" +
      "would report, including broken links, dropped anchors, oversized documents\n" +
      "and CSV dialect normalisation, so the preview never understates the outcome.",
    flags: [
      JSON_FLAG,
      {
        name: "suggest-config",
        summary: "create/extend .gdrive-publish.json covering unsupported files",
      },
    ],
    examples: [
      `${BIN} plan docs/`,
      `${BIN} plan docs/ --json | jq .diagnostics`,
      `${BIN} plan docs/ --suggest-config`,
    ],
  },
  {
    name: "publish",
    summary: "publish to Drive; local content always wins",
    args: "<dir>",
    needsTarget: true,
    details:
      "Creates or updates Google Docs and Sheets, rewriting relative links between\n" +
      "your files into real Doc/Sheet URLs. Existing files are updated in place, so\n" +
      "fileIds - and any URL you shared - stay the same.\n\n" +
      "Drive-side edits are reported loudly but overwritten; the previous version\n" +
      "remains in Drive's revision history. Files whose local source disappeared are\n" +
      "reported as orphans and never removed unless --prune is given.\n\n" +
      "A file that is trashed or inaccessible in Drive is skipped with an error\n" +
      "unless --repair is given, which recreates it under a new id - any URL\n" +
      "previously shared for that file stops working.\n\n" +
      "Items upload in parallel (bounded by --concurrency; folders stay\n" +
      "sequential). Transient rate limits (429, 5xx) are retried with\n" +
      "exponential backoff, and concurrency is halved automatically when\n" +
      "Drive throttles.\n\n" +
      "Progress: a live bar (position, elapsed, ETA, bytes sent) when stdout is\n" +
      "a terminal; [n/m]-prefixed lines when piped; nothing in --json.",
    flags: [
      { name: "dry-run", summary: "plan only; write nothing (same as `plan`)" },
      {
        name: "prune",
        summary: "move orphaned Drive files to trash (never hard-deleted)",
      },
      {
        name: "repair",
        summary: "recreate Drive files that are trashed or inaccessible; their old URLs die",
      },
      CONCURRENCY_FLAG,
      JSON_FLAG,
      REMOTE_FLAG,
    ],
    examples: [
      `${BIN} publish docs/`,
      `${BIN} publish docs/ --dry-run`,
      `${BIN} publish docs/ --prune`,
      `${BIN} publish docs/ --concurrency 5`,
      `${BIN} publish docs/ --json`,
    ],
  },
  {
    name: "status",
    summary: "show manifest state and which credentials are in use",
    args: "<dir>",
    needsTarget: true,
    details:
      "Read-only. Reports the resolved credential source by name (never by value),\n" +
      "the client identity hash, the Drive folder, how many files are published,\n" +
      "and any entries left pending by an interrupted run.",
    flags: [JSON_FLAG, REMOTE_FLAG],
    examples: [`${BIN} status docs/`, `${BIN} status docs/ --json`],
  },
  {
    name: "browse",
    summary: "print (and open) the real Drive URL of a published file or folder",
    args: "<path>",
    needsTarget: true,
    details:
      "Resolves a local file or folder to its stable Drive URL via the manifest\n" +
      "and opens it in the browser. Walks up from the path to find the\n" +
      "manifest; the path may be the root, a file in it, or a subfolder.\n\n" +
      "Fully offline: no login, no Drive round trip - the manifest already\n" +
      "knows every URL. Files deleted locally still resolve while their\n" +
      "manifest entry exists.",
    flags: [{ name: "no-open", summary: "print the URL without opening a browser" }, JSON_FLAG],
    examples: [
      `${BIN} browse docs/`,
      `${BIN} browse docs/someDocument.md`,
      `${BIN} browse docs/report.csv --no-open`,
      `${BIN} browse docs/report.csv --json | jq -r .url`,
    ],
  },
  {
    name: "help",
    summary: "show this overview, or help for one command",
    args: "[command]",
    needsTarget: false,
    details: "",
    flags: [],
    examples: [`${BIN} help`, `${BIN} help publish`],
  },
];

export const EXIT_CODES: [number, string][] = [
  [0, "success"],
  [1, "runtime failure (auth, network, Drive error)"],
  [2, "usage error (bad command, missing argument, unknown flag)"],
  [3, "completed, but the report contains errors"],
];

export const ENVIRONMENT: [string, string][] = [
  ["GDRIVE_PUBLISH_CLIENT_ID", "OAuth client id (with _CLIENT_SECRET, highest priority)"],
  ["GDRIVE_PUBLISH_CLIENT_SECRET", "OAuth client secret"],
  ["GDRIVE_PUBLISH_CLIENT_SECRET_FILE", "path to a Google client_secret.json"],
  ["GDRIVE_PUBLISH_RCLONE_REMOTE", "rclone remote to borrow client credentials from"],
  ["GDRIVE_PUBLISH_CONCURRENCY", "publish concurrency (1–10) when --concurrency is not given"],
];

/**
 * Accept a Drive folder URL (any /folders/<id> form) or a bare file id.
 * Returns the id, or null when the input is neither.
 */
export function parseFolderRef(input: string): string | null {
  const trimmed = input.trim();
  const url = trimmed.match(
    /^https:\/\/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\/([A-Za-z0-9_-]+)/,
  );
  if (url?.[1]) return url[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Flags a command accepts, including the global ones. */
export function flagsFor(spec: CommandSpec): FlagSpec[] {
  return [...spec.flags, ...GLOBAL_FLAGS];
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function renderFlag(flag: FlagSpec): string {
  const invocation = flag.takesValue
    ? `--${flag.name} ${flag.valueLabel ?? "<value>"}`
    : `--${flag.name}`;
  const required = flag.required ? " (required)" : "";
  return `  ${pad(invocation, 24)}${flag.summary}${required}`;
}

export function renderOverview(): string {
  const lines: string[] = [];
  lines.push(`${BIN} ${VERSION} - publish markdown/CSV/XLSX to Google Drive as native types`);
  lines.push("");
  lines.push("Markdown becomes Google Docs and CSV/XLSX become Google Sheets, with");
  lines.push("relative links between your files rewritten to the real Doc URLs.");
  lines.push("");
  lines.push("Usage");
  lines.push(`  ${BIN} <command> [<dir>] [options]`);
  lines.push("");
  lines.push("Commands");
  for (const command of COMMANDS) {
    lines.push(`  ${pad(`${command.name} ${command.args}`.trim(), 24)}${command.summary}`);
  }
  lines.push("");
  lines.push("Global options");
  for (const flag of GLOBAL_FLAGS) lines.push(renderFlag(flag));
  lines.push("");
  lines.push(`Run \`${BIN} help <command>\` for details and examples.`);
  lines.push("");
  lines.push("Environment");
  for (const [name, summary] of ENVIRONMENT) lines.push(`  ${pad(name, 36)}${summary}`);
  lines.push("");
  lines.push("Exit codes");
  for (const [code, meaning] of EXIT_CODES) lines.push(`  ${pad(String(code), 24)}${meaning}`);
  return `${lines.join("\n")}\n`;
}

export function renderCommand(spec: CommandSpec): string {
  const lines: string[] = [];
  const invocation = `${BIN} ${spec.name} ${spec.args}`.trim();
  lines.push(`${invocation} - ${spec.summary}`);
  if (spec.details) {
    lines.push("");
    for (const paragraph of spec.details.split("\n")) lines.push(paragraph);
  }
  if (spec.flags.length > 0) {
    lines.push("");
    lines.push("Options");
    for (const flag of spec.flags) lines.push(renderFlag(flag));
  }
  if (spec.examples.length > 0) {
    lines.push("");
    lines.push("Examples");
    for (const example of spec.examples) lines.push(`  ${example}`);
  }
  lines.push("");
  lines.push("Exit codes");
  for (const [code, meaning] of EXIT_CODES) {
    lines.push(`  ${pad(String(code), 24)}${meaning}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface ParsedArgv {
  /** Command name as typed, or undefined when none was given. */
  command?: string;
  target?: string;
  flags: Set<string>;
  options: Map<string, string>;
  wantsHelp: boolean;
  wantsVersion: boolean;
  /** Extra positionals beyond the directory argument. */
  extras: string[];
}

/**
 * Parse argv using the command table so value-taking flags are known.
 *
 * `--help`/`-h` and `--version`/`-V` are recognised anywhere, including after a
 * destructive command: `publish docs/ --help` must print help rather than
 * publish.
 */
export function parseArgv(argv: string[]): ParsedArgv {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];
  let wantsHelp = false;
  let wantsVersion = false;

  // Locate the command first: the table tells us which flags take values.
  const commandName = argv.find((arg) => !arg.startsWith("-"));
  const spec = commandName ? findCommand(commandName) : undefined;
  const valueFlags = new Set(
    (spec ? flagsFor(spec) : [...COMMANDS.flatMap((c) => c.flags), ...GLOBAL_FLAGS])
      .filter((f) => f.takesValue)
      .map((f) => f.name),
  );

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--help" || arg === "-h") {
      wantsHelp = true;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      wantsVersion = true;
      continue;
    }
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        options.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      if (valueFlags.has(name)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          // Record it with an empty value; validation reports the problem.
          options.set(name, "");
        } else {
          options.set(name, next);
          i++;
        }
        continue;
      }
      flags.add(name);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      flags.add(arg.slice(1)); // unknown short flag; validation rejects it
      continue;
    }
    positional.push(arg);
  }

  return {
    ...(positional[0] !== undefined ? { command: positional[0] } : {}),
    ...(positional[1] !== undefined ? { target: positional[1] } : {}),
    flags,
    options,
    wantsHelp,
    wantsVersion,
    extras: positional.slice(2),
  };
}

/**
 * Validate parsed arguments against a command spec.
 * Returns human-readable error messages; empty means valid.
 */
export function validate(spec: CommandSpec, parsed: ParsedArgv): string[] {
  const errors: string[] = [];
  const allowed = flagsFor(spec);
  const allowedNames = new Set(allowed.map((f) => f.name));
  const valid = allowed.map((f) => `--${f.name}`).join(" ");

  for (const flag of parsed.flags) {
    if (!allowedNames.has(flag)) {
      errors.push(`unknown flag --${flag} for '${spec.name}'\n  valid: ${valid}`);
    }
  }
  for (const [option, value] of parsed.options) {
    if (!allowedNames.has(option)) {
      errors.push(`unknown option --${option} for '${spec.name}'\n  valid: ${valid}`);
      continue;
    }
    const flagSpec = allowed.find((f) => f.name === option);
    if (flagSpec?.takesValue && value === "") {
      errors.push(`--${option} requires a value (${flagSpec.valueLabel ?? "<value>"})`);
    }
    if (flagSpec && !flagSpec.takesValue) {
      errors.push(`--${option} does not take a value`);
    }
  }
  for (const flagSpec of allowed) {
    if (flagSpec.required && !parsed.options.has(flagSpec.name)) {
      errors.push(`${spec.name} requires --${flagSpec.name} ${flagSpec.valueLabel ?? "<value>"}`);
    }
  }
  if (spec.needsTarget && parsed.target === undefined) {
    errors.push(`${spec.name} requires a directory argument: ${BIN} ${spec.name} ${spec.args}`);
  }
  if (parsed.extras.length > 0) {
    errors.push(`unexpected argument: ${parsed.extras[0] as string}`);
  }
  return errors;
}

/** Suggest the closest command for a typo (single edit-distance pass). */
export function suggestCommand(input: string): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const command of COMMANDS) {
    const distance = editDistance(input, command.name);
    if (best === null || distance < best.distance) best = { name: command.name, distance };
  }
  return best && best.distance <= 2 ? best.name : null;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) (matrix[i] as number[])[0] = i;
  for (let j = 0; j < cols; j++) (matrix[0] as number[])[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = matrix[i] as number[];
      const previous = matrix[i - 1] as number[];
      row[j] = Math.min(
        (previous[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
  }
  return (matrix[a.length] as number[])[b.length] as number;
}
