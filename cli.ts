#!/usr/bin/env node
/**
 * gdrive-publish CLI.
 *
 * Fully non-interactive except for `login`: every other command works headless
 * with flags, `--json`, and meaningful exit codes, so the same binary is usable
 * from CI, git hooks, and the pi extension.
 *
 * Command surface, flags and help text are defined once in ./commands.ts and
 * derived everywhere else (overview, `help <command>`, `<command> --help`,
 * flag validation, and the generated CLI reference in MANUAL.md), so the help
 * cannot drift from the behaviour.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  BIN,
  VERSION,
  findCommand,
  parseArgv,
  parseFolderRef,
  renderCommand,
  renderOverview,
  suggestCommand,
  validate,
} from "./commands.ts";
import type { CommandSpec, ParsedArgv } from "./commands.ts";
import {
  AuthError,
  CachedTokenProvider,
  clientHash,
  consent,
  resolveCredentials,
  writeToken,
} from "./core/auth.ts";
import {
  CONFIG_FILENAME,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  cautionPatterns,
  loadConfig,
  mergePatterns,
  parseConcurrency,
  saveConfig,
} from "./core/config.ts";
import { DriveError, RestDriveClient } from "./core/drive.ts";
import type { DriveFile } from "./core/drive.ts";
import * as manifestIo from "./core/manifest.ts";
import { fmtDuration, renderBarLine } from "./core/progress.ts";
import type { ProgressEvent } from "./core/progress.ts";
import { buildPlan, publish } from "./core/publish.ts";
import { planJson, renderPlan, renderSummary, summaryJson } from "./core/report.ts";
import { classify } from "./core/scan.ts";
import { GOOGLE_FOLDER, MANIFEST_FILENAME, folderUrl } from "./core/types.ts";
import type { Manifest } from "./core/types.ts";

/** Arguments as validated against the command table. */
interface Args {
  target?: string;
  flags: Set<string>;
  options: Map<string, string>;
}

function fail(code: number, message: string): never {
  process.stderr.write(`gdrive-publish: ${message}\n`);
  process.exit(code);
}

function resolveRoot(target: string | undefined): string {
  if (!target) fail(2, "a directory argument is required");
  const root = path.resolve(target as string);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(2, `not a directory: ${root}`);
  }
  return root;
}

function credentialsOrFail(args: Args): ReturnType<typeof resolveCredentials> {
  const env = { ...process.env };
  const remote = args.options.get("remote");
  if (remote) env.GDRIVE_PUBLISH_RCLONE_REMOTE = remote;
  try {
    return resolveCredentials(env);
  } catch (e) {
    if (e instanceof AuthError) fail(1, e.message);
    throw e;
  }
}

/**
 * Concurrency precedence: --concurrency flag > GDRIVE_PUBLISH_CONCURRENCY
 * env > .gdrive-publish.json "concurrency" > default. Strict validation,
 * each error names its layer (design: docs/parallel-publish.md).
 */
function resolveConcurrency(args: Args, env: NodeJS.ProcessEnv, configValue?: number): number {
  const flagValue = args.options.get("concurrency");
  if (flagValue !== undefined) {
    const n = parseConcurrency(flagValue);
    if (n === null) {
      fail(
        2,
        `--concurrency expects an integer between 1 and ${MAX_CONCURRENCY} (got: ${flagValue})`,
      );
    }
    return n;
  }
  const envValue = env.GDRIVE_PUBLISH_CONCURRENCY;
  if (envValue !== undefined && envValue !== "") {
    const n = parseConcurrency(envValue);
    if (n === null) {
      fail(
        1,
        `GDRIVE_PUBLISH_CONCURRENCY must be an integer between 1 and ${MAX_CONCURRENCY} (got: ${envValue})`,
      );
    }
    return n;
  }
  // The config file was already strictly validated by loadConfig.
  if (configValue !== undefined) return configValue;
  return DEFAULT_CONCURRENCY;
}

async function cmdLogin(args: Args): Promise<void> {
  const creds = credentialsOrFail(args);
  process.stdout.write(`credentials: ${creds.source} (client ${clientHash(creds.clientId)})\n`);
  process.stdout.write("opening a browser for Google consent (scope: drive.file)…\n");
  const token = await consent(creds, (url) => {
    try {
      execFileSync("open", [url], { stdio: "ignore" });
    } catch {
      process.stdout.write(`open this URL manually:\n\n${url}\n\n`);
    }
  });
  const p = writeToken(token);
  process.stdout.write(`authorised; token cached at ${p}\n`);
}

async function cmdInit(args: Args): Promise<void> {
  const root = resolveRoot(args.target);
  // Guard before touching credentials: a nested manifest is almost never
  // intended (it splits the tree's identity map into a second Drive root)
  // and usually results from following an old error message.
  const ancestor = findManifestDir(path.dirname(root));
  if (ancestor && ancestor !== root && !args.flags.has("force")) {
    fail(
      1,
      `${ancestor} already has a ${MANIFEST_FILENAME} - creating one here would nest publish roots.
  to publish this tree under the existing root instead: gdrive-publish publish ${args.target}
  to create a separate nested root anyway: add --force`,
    );
  }
  const name = args.options.get("name");
  const into = args.options.get("into");

  // Validate the folder reference before touching credentials so a typo is a
  // cheap usage error, not a network round trip.
  let folderId: string | null = null;
  if (into) {
    folderId = parseFolderRef(into);
    if (!folderId) {
      fail(
        2,
        `--into expects a Drive folder URL or id (got: ${into.slice(0, 60)})\n  e.g. https://drive.google.com/drive/folders/<id>`,
      );
    }
  }
  if (!name && !folderId) fail(2, 'init requires --name "Folder Name" (or --into <folder url/id>)');
  if (manifestIo.load(root)) fail(1, `${root} already has a manifest`);

  const creds = credentialsOrFail(args);
  const drive = new RestDriveClient(new CachedTokenProvider(creds));

  let folderIdFinal: string;
  let folderName: string;
  if (folderId) {
    let meta: DriveFile;
    try {
      meta = await drive.get(folderId);
    } catch (e) {
      const status = e instanceof DriveError ? e.status : 0;
      if (status === 404 || status === 403) {
        fail(
          1,
          `folder not visible: ${folderId}
  Under the drive.file scope this tool only sees folders created by
  the same OAuth project. Folders from the Drive web UI are not adoptable.
  Instead: init a new folder and move it into place in Drive - publishing
  keeps working after the move.`,
        );
      }
      throw e;
    }
    if (meta.mimeType !== GOOGLE_FOLDER) {
      fail(1, `${folderId} is a ${meta.mimeType}, not a Drive folder`);
    }
    if (meta.trashed) fail(1, `${folderId} is in the trash - restore it first`);
    folderIdFinal = meta.id;
    folderName = meta.name;
    if (name && name !== folderName) {
      process.stdout.write(
        `note: --into keeps the existing folder name "${folderName}" (--name ignored)\n`,
      );
    }
  } else {
    const folder = await drive.createFolder(name as string);
    folderIdFinal = folder.id;
    folderName = folder.name;
  }

  const manifest = manifestIo.emptyManifest(folderIdFinal, folderName);
  manifest.credentialSource = creds.source;
  manifest.clientIdHash = clientHash(creds.clientId);
  const p = manifestIo.save(root, manifest);
  const url = folderUrl(folderIdFinal);
  const how = folderId ? "using existing Drive folder" : "created Drive folder";
  process.stdout.write(`${how} "${folderName}"\n  ${url}\n`);
  process.stdout.write(
    `manifest: ${p}\n  -> commit it; move/share the folder in Drive as you like\n`,
  );
}

function cmdPlan(args: Args): void {
  const requestedRoot = resolveRoot(args.target);
  const discovery = discoverManifestRoot(requestedRoot);
  const root = discovery.root;
  let manifest = discovery.manifest;
  if (discovery.discoveredAbove && !args.flags.has("json")) {
    process.stdout.write(discoveryNote(root));
  }
  let plan = buildPlan({ root, manifest });
  let configCreated: string | null = null;
  let patternsAdded: string[] = [];

  // --suggest-config: create or extend .gdrive-publish.json so the
  // unsupported files publish as raw uploads. Merges, never removes.
  if (args.flags.has("suggest-config")) {
    if (!plan.rawSuggestion || plan.rawSuggestion.coverable.length === 0) {
      const manual = plan.rawSuggestion?.extensionless ?? [];
      process.stdout.write(
        manual.length > 0
          ? `nothing to cover automatically; no extension pattern can match:\n  ${manual.join("\n  ")}\n  add rawPatterns entries manually in ${CONFIG_FILENAME}\n`
          : "no unsupported files found - nothing to suggest\n",
      );
    } else {
      const existing = loadConfig(root);
      const current = existing?.rawPatterns ?? [];
      const merged = mergePatterns(current, plan.rawSuggestion.patterns);
      const added = merged.filter((p) => !current.includes(p));
      if (added.length === 0) {
        process.stdout.write("config already covers all unsupported files - nothing added\n");
      } else {
        configCreated = saveConfig(root, {
          rawPatterns: merged,
          ...(existing?.ignorePatterns !== undefined
            ? { ignorePatterns: existing.ignorePatterns }
            : {}),
          ...(existing?.concurrency !== undefined ? { concurrency: existing.concurrency } : {}),
        });
        patternsAdded = added;
        manifest = manifestIo.load(root);
        plan = buildPlan({ root, manifest });
        if (!args.flags.has("json")) {
          const body = JSON.stringify({ rawPatterns: merged }, null, 2);
          process.stdout.write(
            `created ${configCreated}:\n${body
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n")}\n`,
          );
          const risky = cautionPatterns(added);
          if (risky.length > 0) {
            process.stdout.write(
              `  CAUTION: ${risky.join(", ")} look(s) credential-adjacent - double-check before publishing\n`,
            );
          }
          const still = plan.rawSuggestion?.extensionless ?? [];
          if (still.length > 0) {
            process.stdout.write(
              `  note: no automatic pattern can cover (add manually):\n    ${still.join("\n    ")}\n`,
            );
          }
          process.stdout.write("  -> verify the patterns before running plan or publish\n");
        }
      }
    }
  }

  if (args.flags.has("json")) {
    const payload: Record<string, unknown> = {
      ...(planJson(plan) as Record<string, unknown>),
      ...(configCreated ? { configCreated, patternsAdded } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderPlan(plan, root)}\n`);
  }
  if (plan.diagnostics.some((d) => d.severity === "error")) process.exit(3);
}

async function cmdPublish(args: Args): Promise<void> {
  const requestedRoot = resolveRoot(args.target);
  const discovery = discoverManifestRoot(requestedRoot);
  const root = discovery.root;
  const manifest = discovery.manifest;
  if (!manifest) {
    fail(
      1,
      `no ${MANIFEST_FILENAME} in or above ${requestedRoot}
  - new tree: gdrive-publish init <dir> --name "Docs"
  - existing tree: run from, or point at, the directory holding the manifest`,
    );
  }
  if (discovery.discoveredAbove && !args.flags.has("json")) {
    process.stdout.write(discoveryNote(root));
  }
  const plan = buildPlan({ root, manifest });
  const json = args.flags.has("json");

  if (args.flags.has("dry-run")) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ dryRun: true, ...(planJson(plan) as object) }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${renderPlan(plan, root)}\n\n  dry run: nothing was written\n`);
    }
    return;
  }

  // Credential identity mismatch is informational but important: drive.file
  // access is per-client, so a different client cannot see existing Docs.
  const creds = credentialsOrFail(args);
  const hash = clientHash(creds.clientId);
  if (manifest.clientIdHash && manifest.clientIdHash !== hash) {
    process.stderr.write(
      `gdrive-publish: WARN credential identity changed (manifest ${manifest.clientIdHash}, now ${hash}); drive.file access is per-client, so existing Docs may be invisible and would be recreated\n`,
    );
  }

  const drive = new RestDriveClient(new CachedTokenProvider(creds));

  // Concurrency knob: flag > env > config file > default (design:
  // docs/parallel-publish.md). The config was strictly validated on load.
  let configConcurrency: number | undefined;
  try {
    configConcurrency = loadConfig(root)?.concurrency;
  } catch (e) {
    fail(1, String(e instanceof Error ? e.message : e));
  }
  const concurrency = resolveConcurrency(args, process.env, configConcurrency);

  // Progress rendering: a live bar when stdout is a terminal (position,
  // elapsed, ETA, bytes - operation-based, since request latency dominates),
  // `[n/m]`-prefixed lines when piped, nothing in --json.
  const interactive = process.stdout.isTTY === true;
  const startedAt = Date.now();
  const printer = (event: ProgressEvent): void => {
    if (interactive) {
      // Some ptys report 0 columns; floor the width so the bar still renders.
      const width = Math.min(Math.max(process.stdout.columns ?? 80, 40), 120);
      process.stdout.write(`\r\x1b[2K${renderBarLine(event, Date.now() - startedAt, width)}`);
    } else {
      process.stdout.write(`  [${event.completed}/${event.total}] ${event.label}\n`);
    }
  };

  const summary = await publish({
    root,
    drive,
    manifest,
    plan,
    prune: args.flags.has("prune"),
    repair: args.flags.has("repair"),
    concurrency,
    onProgress: json ? undefined : printer,
  });
  const elapsedMs = Date.now() - startedAt;
  if (interactive) process.stdout.write("\r\x1b[2K\n");
  if (json) {
    const payload: Record<string, unknown> = {
      ...(summaryJson(summary) as Record<string, unknown>),
      elapsedMs,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderSummary(summary)}\n  ✻ finished in ${fmtDuration(elapsedMs)}\n`);
  }
  if (summary.diagnostics.some((d) => d.severity === "error")) process.exit(3);
}

/**
 * Walk up from a path to the nearest .gdrive-manifest.json (bounded, stops at
 * the filesystem root).
 */
function findManifestDir(start: string): string | null {
  let dir = fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : path.dirname(start);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, MANIFEST_FILENAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Manifest discovery for dir-taking commands: the manifest in the exact
 * directory if present, else the nearest one above it (the git model - run
 * from anywhere inside the tree). `discoveredAbove` is true when the caller
 * pointed at a subdirectory and the root was found by walking up.
 */
function discoverManifestRoot(dir: string): {
  manifest: Manifest | null;
  root: string;
  discoveredAbove: boolean;
} {
  const direct = manifestIo.load(dir);
  if (direct) return { manifest: direct, root: dir, discoveredAbove: false };
  const found = findManifestDir(dir);
  if (found && found !== dir) {
    return { manifest: manifestIo.load(found), root: found, discoveredAbove: true };
  }
  return { manifest: null, root: dir, discoveredAbove: false };
}

/** Human note when the caller pointed at a subdirectory of the publish root. */
function discoveryNote(dir: string): string {
  const shown = path.relative(process.cwd(), dir) || dir;
  return `manifest found at ${shown} - operating on that publish root
`;
}

/** Best-effort browser open; degrades to printing the URL if no opener exists. */
function openInBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {
    process.stdout.write(`(no browser opener found - open manually: ${url})\n`);
  }
}

/**
 * Print (and open) the real Drive URL for a published file or folder.
 * Manifest-first: locally-deleted files still resolve while their entry
 * exists, because the manifest is the identity map.
 */
function cmdBrowse(args: Args): void {
  const target = args.target as string;
  const resolved = path.resolve(target);

  const manifestDir = findManifestDir(resolved);
  if (!manifestDir) {
    fail(
      1,
      `no ${MANIFEST_FILENAME} in or above ${target} - run: gdrive-publish init <dir> --name "Docs"`,
    );
  }
  const manifest = manifestIo.load(manifestDir);
  if (!manifest) fail(1, `unreadable ${MANIFEST_FILENAME} in ${manifestDir}`);

  const relPath = path
    .relative(manifestDir, resolved)
    .split(path.sep)
    .join("/")
    .replace(/\/+$/, "");
  if (relPath.startsWith("..")) {
    fail(1, `${target} is outside the publish root ${manifestDir}`);
  }

  let url: string;
  let fileId: string;
  let kind: string;
  if (relPath === "") {
    url = folderUrl(manifest.rootFolderId);
    fileId = manifest.rootFolderId;
    kind = "folder";
  } else {
    const entry = manifest.entries[relPath];
    const folderId = manifest.folders[relPath];
    if (entry) {
      url = entry.url;
      fileId = entry.fileId;
      kind = entry.kind;
    } else if (folderId) {
      url = folderUrl(folderId);
      fileId = folderId;
      kind = "folder";
    } else if (fs.existsSync(resolved) && classify(relPath) === "image") {
      fail(
        1,
        `${relPath} is not published as a standalone file - images publish only as embeds unless claimed via rawPatterns`,
      );
    } else if (fs.existsSync(resolved)) {
      fail(1, `${relPath} exists but is not published yet - publish first`);
    } else {
      fail(2, `no such file or directory: ${target}`);
    }
  }

  const json = args.flags.has("json");
  if (json) {
    process.stdout.write(`${JSON.stringify({ url, fileId, kind, relPath }, null, 2)}\n`);
  } else {
    process.stdout.write(`${url}\n`);
  }
  if (!json && !args.flags.has("no-open")) {
    openInBrowser(url);
  }
}

function cmdStatus(args: Args): void {
  const requestedRoot = resolveRoot(args.target);
  const discovery = discoverManifestRoot(requestedRoot);
  const root = discovery.root;
  const manifest = discovery.manifest;
  if (discovery.discoveredAbove && !args.flags.has("json")) {
    process.stdout.write(discoveryNote(root));
  }
  const creds = credentialsOrFail(args);
  const info = {
    root,
    manifest: manifest
      ? {
          rootFolderId: manifest.rootFolderId,
          rootFolderName: manifest.rootFolderName,
          rootFolderUrl: folderUrl(manifest.rootFolderId),
          entries: Object.keys(manifest.entries).length,
          pending: manifestIo.pendingEntries(manifest),
          credentialSource: manifest.credentialSource ?? null,
          clientIdHash: manifest.clientIdHash ?? null,
        }
      : null,
    credentials: { source: creds.source, clientIdHash: clientHash(creds.clientId) },
  };
  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }
  process.stdout.write(`root: ${root}\n`);
  process.stdout.write(`credentials: ${creds.source} (client ${info.credentials.clientIdHash})\n`);
  if (!info.manifest) {
    process.stdout.write("manifest: none (run init)\n");
    return;
  }
  process.stdout.write(
    `manifest: ${info.manifest.entries} entr(ies), folder "${info.manifest.rootFolderName}"\n  ${info.manifest.rootFolderUrl}\n`,
  );
  if (info.manifest.pending.length) {
    process.stdout.write(`pending (unfilled) Docs: ${info.manifest.pending.join(", ")}\n`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));

  try {
    // `--version` wins anywhere and never touches Drive.
    if (parsed.wantsVersion) {
      process.stdout.write(`${BIN} ${VERSION}\n`);
      return;
    }

    if (parsed.command === undefined || parsed.command === "help") {
      if (parsed.wantsHelp && parsed.command !== undefined) {
        process.stdout.write(renderOverview());
        return;
      }
      if (parsed.target !== undefined) {
        const spec = findCommand(parsed.target);
        if (!spec) {
          const suggestion = suggestCommand(parsed.target);
          fail(
            2,
            `unknown command: ${parsed.target}${
              suggestion ? ` (did you mean "${suggestion}"?)` : ""
            }\ntry: ${BIN} help`,
          );
        }
        process.stdout.write(renderCommand(spec));
        return;
      }
      process.stdout.write(renderOverview());
      return;
    }

    const spec = findCommand(parsed.command);
    if (!spec) {
      const suggestion = suggestCommand(parsed.command);
      process.stderr.write(renderOverview());
      fail(
        2,
        `unknown command: ${parsed.command}${
          suggestion ? ` (did you mean "${suggestion}"?)` : ""
        }\ntry: ${BIN} help`,
      );
    }
    const commandSpec = spec as CommandSpec;

    // `--help` wins over execution - critically on destructive commands:
    // `publish <dir> --help` must print help, never publish.
    if (parsed.wantsHelp) {
      process.stdout.write(renderCommand(commandSpec));
      return;
    }

    const errors = validate(commandSpec, parsed);
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`${BIN}: ${error}\n`);
      process.stderr.write(`\ntry: ${BIN} help ${commandSpec.name}\n`);
      process.exit(2);
    }

    const args: Args = {
      ...(parsed.target !== undefined ? { target: parsed.target } : {}),
      flags: parsed.flags,
      options: parsed.options,
    };

    switch (commandSpec.name) {
      case "login":
        await cmdLogin(args);
        break;
      case "init":
        await cmdInit(args);
        break;
      case "plan":
        cmdPlan(args);
        break;
      case "publish":
        await cmdPublish(args);
        break;
      case "status":
        cmdStatus(args);
        break;
      case "browse":
        cmdBrowse(args);
        break;
      default:
        fail(2, `unhandled command: ${commandSpec.name}`);
    }
  } catch (e) {
    if (e instanceof AuthError) fail(1, e.message);
    fail(1, String(e instanceof Error ? e.message : e));
  }
}

await main();
