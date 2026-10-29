/**
 * Planning (offline) and publishing (two-phase, Drive-facing).
 *
 * Phase 1 reserves ids: create folders, create empty Doc shells for markdown,
 * convert-upload tabular sources. The manifest is checkpointed after every
 * reservation (not just once after phase 1) so a crash cannot leak
 * unrecorded Docs (decision 20). A Drive-side rejection of a single item is
 * reported as a PUBLISH_FAILED error diagnostic and the run continues; only
 * non-Drive failures (local fs, bugs) abort it.
 *
 * Phase 2 rewrites links against the now-known ids and fills content via
 * `files.update` + media, which keeps every fileId - and therefore every
 * shared URL - stable (verified in the spike, U2/U6).
 */

import fs from "node:fs";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, derivePatterns } from "./config.ts";
import { describeDialect, normaliseCsv } from "./csv.ts";
import type { DriveClient } from "./drive.ts";
import { DriveError } from "./drive.ts";
import { classifyTarget, collectLinks } from "./links.ts";
import * as manifestIo from "./manifest.ts";
import { documentName, tabularName } from "./naming.ts";
import { AdaptivePool } from "./pool.ts";
import { prepareMarkdown } from "./prepare.ts";
import { resolveRelative } from "./prepare.ts";
import type { ResolvedTarget } from "./prepare.ts";
import type { ProgressEvent } from "./progress.ts";
import { folderPaths, rawMimeType, scan } from "./scan.ts";
import { GOOGLE_DOC, GOOGLE_SHEET, driveUrl, folderUrl } from "./types.ts";
import type { Diagnostic, Manifest, Plan, PlanItem, PublishSummary, SourceFile } from "./types.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Images referenced by any markdown file (resolved to publish-root-relative
 * paths). Code-fence links are not references - they are not rewritten into
 * Docs, so an image "used" only inside a fence is unreferenced for
 * publishing purposes.
 */
function referencedImages(root: string, files: SourceFile[]): Set<string> {
  const referenced = new Set<string>();
  for (const file of files) {
    if (file.kind !== "markdown") continue;
    const markdown = fs.readFileSync(file.absPath, "utf8");
    for (const link of collectLinks(markdown)) {
      if (!link.isImage) continue;
      if (classifyTarget(link.target) !== "relative") continue;
      const resolved = resolveRelative(file.relPath, link.target);
      if (resolved) referenced.add(resolved);
    }
  }
  return referenced;
}

export interface PlanOptions {
  root: string;
  manifest: Manifest | null;
}

function nameFor(file: SourceFile): string {
  if (file.kind === "markdown") {
    return documentName(file.relPath, fs.readFileSync(file.absPath, "utf8"));
  }
  if (file.kind === "file") {
    // Raw uploads keep the full filename - the extension carries meaning.
    return file.relPath.split("/").pop() as string;
  }
  return tabularName(file.relPath);
}

function hashFor(file: SourceFile): string {
  return manifestIo.contentHash(fs.readFileSync(file.absPath));
}

/** Build an offline plan: what would be created, updated, left alone, orphaned. */
export function buildPlan(opts: PlanOptions): Plan {
  const { files, skipped } = scan(opts.root);
  const referenced = referencedImages(opts.root, files);

  // What a `plan --suggest-config` run could automate: patterns derived
  // from the extensions of the files that remain unsupported.
  let rawSuggestion: Plan["rawSuggestion"] = null;
  if (skipped.length > 0) {
    const derived = derivePatterns(skipped);
    rawSuggestion = {
      coverable: skipped.filter((rel) => !derived.extensionless.includes(rel)),
      patterns: derived.patterns,
      extensionless: derived.extensionless,
    };
  }

  const diagnostics: Diagnostic[] = [];
  for (const relPath of skipped) {
    diagnostics.push({
      code: "UNSUPPORTED_FILE",
      severity: "warn",
      relPath,
      message: "unsupported file type, not published",
    });
  }

  const manifest = opts.manifest;
  const items: PlanItem[] = [];
  for (const file of files) {
    if (file.kind === "image") {
      // Images publish only as embeds into Docs (or as raw files when a
      // pattern claims them - those arrive as kind "file"). An image no
      // markdown references is silently dropped otherwise; warn instead.
      if (!referenced.has(file.relPath)) {
        diagnostics.push({
          code: "IMAGE_UNREFERENCED",
          severity: "warn",
          relPath: file.relPath,
          message:
            "not published: reference it in markdown, claim it via rawPatterns, or delete it",
        });
      }
      continue;
    }
    const existing = manifest?.entries[file.relPath];
    const folder = file.relPath.includes("/")
      ? file.relPath.slice(0, file.relPath.lastIndexOf("/"))
      : "";
    const name = nameFor(file);
    if (!existing) {
      items.push({ relPath: file.relPath, kind: file.kind, action: "create", name, folder });
      continue;
    }
    if (existing.pending) {
      diagnostics.push({
        code: "PENDING_RESUMED",
        severity: "warn",
        relPath: file.relPath,
        message: `previous run left this Doc empty; filling it in place (${existing.fileId})`,
      });
      items.push({
        relPath: file.relPath,
        kind: file.kind,
        action: "update",
        name,
        fileId: existing.fileId,
        folder,
      });
      continue;
    }
    const changed = hashFor(file) !== existing.contentHash || existing.name !== name;
    items.push({
      relPath: file.relPath,
      kind: file.kind,
      action: changed ? "update" : "unchanged",
      name,
      fileId: existing.fileId,
      folder,
    });
  }

  const present = new Set(files.map((f) => f.relPath));
  const orphans = Object.entries(manifest?.entries ?? {})
    .filter(([relPath]) => !present.has(relPath))
    .map(([relPath, entry]) => ({ relPath, fileId: entry.fileId, name: entry.name }));
  for (const orphan of orphans) {
    diagnostics.push({
      code: "ORPHAN",
      severity: "warn",
      relPath: orphan.relPath,
      message: `published previously but missing locally; use --prune to move it to Drive trash (${orphan.fileId})`,
    });
  }

  // Offline link/image analysis so `plan` and `--dry-run` report what publish
  // would report. The diagnostics depend only on whether a target *resolves*,
  // never on the Drive URL's value, so placeholder ids are sufficient and the
  // analysis can run before any id has been reserved.
  const placeholder = new Map<string, ResolvedTarget>();
  for (const item of items) {
    const id = item.fileId ?? `PLANNED-${item.relPath}`;
    placeholder.set(item.relPath, { fileId: id, url: driveUrl(item.kind, id), kind: item.kind });
  }
  // "known" means "exists on disk", which must include unsupported files:
  // otherwise a link to notes.txt is misreported as a broken link instead of
  // a link to something we do not publish.
  const known = new Set<string>([...files.map((f) => f.relPath), ...skipped]);
  for (const item of items) {
    if (item.kind !== "markdown") continue;
    try {
      const analysis = prepareMarkdown({
        relPath: item.relPath,
        markdown: fs.readFileSync(`${opts.root}/${item.relPath}`, "utf8"),
        resolved: placeholder,
        root: opts.root,
        known,
        analyzeOnly: true,
      });
      diagnostics.push(...analysis.diagnostics);
    } catch (e) {
      diagnostics.push({
        code: "UNSUPPORTED_FILE",
        severity: "error",
        relPath: item.relPath,
        message: `could not analyse: ${String(e).slice(0, 160)}`,
      });
    }
  }

  return {
    root: opts.root,
    ...(manifest ? { rootFolderId: manifest.rootFolderId } : {}),
    folders: folderPaths(files.filter((f) => f.kind !== "image")),
    items,
    orphans,
    diagnostics: dedupeDiagnostics(diagnostics),
    rawSuggestion,
  };
}

/** Drop duplicate diagnostics (same code, path and message). */
export function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of diagnostics) {
    const key = `${d.code}|${d.relPath ?? ""}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

export interface PublishOptions {
  root: string;
  drive: DriveClient;
  manifest: Manifest;
  plan: Plan;
  prune: boolean;
  /** Recreate files whose Drive copy is gone (old shared URLs die). */
  repair?: boolean;
  /**
   * Max parallel Drive requests for items and fills (1–MAX_CONCURRENCY).
   * Default DEFAULT_CONCURRENCY; 1 is exactly the historical sequential
   * behaviour. Folder creation and the phase barrier stay sequential.
   */
  concurrency?: number;
  /**
   * Progress events, one per completed step. The CLI renders a bar (TTY) or
   * `[n/m]`-prefixed lines (piped); the extension shows status text.
   */
  onProgress?: (event: ProgressEvent) => void;
  /** Wall-clock source, injectable for tests. */
  now?: () => Date;
}

/**
 * Execute a plan. Local content always wins; Drive-side modifications are
 * reported loudly but not merged (decision 3). A Drive error on one item
 * fails that item (PUBLISH_FAILED diagnostic, checkpointed manifest state)
 * and the run continues so the report names every failed file.
 */
export async function publish(opts: PublishOptions): Promise<PublishSummary> {
  const { root, drive, manifest, plan } = opts;
  const now = opts.now ?? (() => new Date());
  // Bounded parallelism with adaptive throttling: the Drive client reports
  // rate limits, the pool halves, surplus workers stop pulling. Folders and
  // the phase-1/2 barrier stay sequential (design: docs/parallel-publish.md).
  const requestedConcurrency = Math.min(
    Math.max(Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY), 1),
    MAX_CONCURRENCY,
  );
  const pool = new AdaptivePool(requestedConcurrency);
  let rateLimitEvents = 0;
  drive.setRateLimitListener?.(() => {
    rateLimitEvents++;
    pool.halve();
  });
  // Step accounting: every meaningful operation increments once; payload
  // bytes are counted at each upload site. Totals are known upfront from the
  // plan, so the bar is determinate.
  const steps = {
    folders: plan.folders.filter((f) => !manifest.folders[f]).length,
    items: plan.items.length,
    fills: plan.items.filter((i) => i.action !== "unchanged" && i.kind === "markdown").length,
    prunes: opts.prune ? plan.orphans.length : 0,
  };
  const total = steps.folders + steps.items + steps.fills + steps.prunes;
  let completed = 0;
  let bytesSent = 0;
  const payloadBytes = (data: Buffer | string): number =>
    Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
  const step = (label: string, byteDelta = 0): void => {
    completed++;
    bytesSent += byteDelta;
    opts.onProgress?.({ label, completed, total, bytes: bytesSent });
  };
  const diagnostics: Diagnostic[] = [...plan.diagnostics];
  let created = 0;
  let updated = 0;
  let repaired = 0;
  let pruned = 0;
  let failed = 0;

  // Checkpoint after every manifest mutation (atomic temp-file + rename in
  // manifest.ts): a crash at any point can then never leak a Drive object
  // the manifest does not record (decision 20 - previously guaranteed only
  // "after phase 1", which a crash inside phase 1 violated). Also safe
  // under the parallel pool: manifestIo.save is a synchronous atomic write.
  const checkpoint = (): void => {
    manifestIo.save(root, manifest);
  };

  // ---- phase 1: folders + id reservation ---------------------------------
  for (const folder of plan.folders) {
    if (manifest.folders[folder]) continue;
    const parentPath = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
    const parentId = parentPath ? manifest.folders[parentPath] : manifest.rootFolderId;
    if (!parentId) throw new Error(`internal: parent folder "${parentPath}" not created yet`);
    const name = folder.split("/").pop() as string;
    const made = await drive.createFolder(name, parentId);
    manifest.folders[folder] = made.id;
    checkpoint();
    step(`created folder ${folder}`);
  }

  const resolved = new Map<string, ResolvedTarget>();
  const toFill: { item: PlanItem; fileId: string }[] = [];

  const reserveItem = async (item: PlanItem): Promise<void> => {
    const parentId = item.folder ? manifest.folders[item.folder] : manifest.rootFolderId;
    if (!parentId) throw new Error(`internal: folder "${item.folder}" missing after phase 1`);

    // One item's Drive failure (a source Drive cannot convert, a quota or
    // rate-limit rejection) must not abort the whole run: it becomes an
    // error diagnostic naming the file, and every other item still
    // publishes. The catch keeps the failure out of the pool, so sibling
    // workers keep pulling; only non-Drive failures (local fs, bugs) abort.
    try {
      if (item.action === "create") {
        if (item.kind === "file") {
          const buf = fs.readFileSync(`${root}/${item.relPath}`);
          const mime = rawMimeType(item.relPath);
          const file = await drive.convertUpload(item.name, mime, mime, buf, parentId);
          manifest.entries[item.relPath] = {
            fileId: file.id,
            kind: item.kind,
            name: item.name,
            url: driveUrl(item.kind, file.id),
            contentHash: manifestIo.contentHash(buf),
            publishedAt: now().toISOString(),
          };
          checkpoint();
          resolved.set(item.relPath, {
            fileId: file.id,
            url: driveUrl(item.kind, file.id),
            kind: item.kind,
          });
          created++;
          step(`uploaded ${item.relPath}`, buf.length);
          return;
        }
        if (item.kind === "markdown") {
          const shell = await drive.createEmptyDoc(item.name, parentId);
          manifest.entries[item.relPath] = {
            fileId: shell.id,
            kind: item.kind,
            name: item.name,
            url: driveUrl(item.kind, shell.id),
            contentHash: "",
            publishedAt: now().toISOString(),
            pending: true,
          };
          checkpoint();
          toFill.push({ item, fileId: shell.id });
          resolved.set(item.relPath, {
            fileId: shell.id,
            url: driveUrl(item.kind, shell.id),
            kind: item.kind,
          });
          created++;
          step(`reserved Doc for ${item.relPath}`);
        } else {
          const { media, mediaMime, note } = tabularPayload(root, item.relPath, item.kind);
          if (note) diagnostics.push(note);
          const file = await drive.convertUpload(
            item.name,
            GOOGLE_SHEET,
            mediaMime,
            media,
            parentId,
          );
          manifest.entries[item.relPath] = {
            fileId: file.id,
            kind: item.kind,
            name: item.name,
            url: driveUrl(item.kind, file.id),
            contentHash: manifestIo.contentHash(fs.readFileSync(`${root}/${item.relPath}`)),
            publishedAt: now().toISOString(),
          };
          checkpoint();
          resolved.set(item.relPath, {
            fileId: file.id,
            url: driveUrl(item.kind, file.id),
            kind: item.kind,
          });
          created++;
          step(`created sheet ${item.relPath}`, payloadBytes(media));
        }
        return;
      }

      // update / unchanged: the id is already known
      const fileId = item.fileId as string;
      resolved.set(item.relPath, { fileId, url: driveUrl(item.kind, fileId), kind: item.kind });
      // Unchanged items are checked too: a trashed or inaccessible Drive file is
      // a hard error regardless of whether the local source changed - the agreed
      // contract is "dead id => error (or --repair)", not "error only if you
      // also edited the file".
      if (item.action === "update" || item.action === "unchanged") {
        const divergence = await checkDivergence(drive, fileId, manifest, item.relPath);
        if (divergence) diagnostics.push(divergence);
        if (divergence?.code === "DRIVE_FILE_GONE") {
          if (opts.repair) {
            // Recreate first, report after: a repair that itself fails is a
            // PUBLISH_FAILED error, never a "repaired" claim.
            if (item.kind === "markdown") {
              const shell = await drive.createEmptyDoc(item.name, parentId);
              manifest.entries[item.relPath] = {
                fileId: shell.id,
                kind: item.kind,
                name: item.name,
                url: driveUrl(item.kind, shell.id),
                contentHash: "",
                publishedAt: now().toISOString(),
                pending: true,
              };
              checkpoint();
              toFill.push({ item: { ...item, action: "create" }, fileId: shell.id });
              resolved.set(item.relPath, {
                fileId: shell.id,
                url: driveUrl(item.kind, shell.id),
                kind: item.kind,
              });
            } else if (item.kind === "file") {
              const buf = fs.readFileSync(`${root}/${item.relPath}`);
              const mime = rawMimeType(item.relPath);
              const file = await drive.convertUpload(item.name, mime, mime, buf, parentId);
              manifest.entries[item.relPath] = {
                fileId: file.id,
                kind: item.kind,
                name: item.name,
                url: driveUrl(item.kind, file.id),
                contentHash: manifestIo.contentHash(buf),
                publishedAt: now().toISOString(),
              };
              checkpoint();
              resolved.set(item.relPath, {
                fileId: file.id,
                url: driveUrl(item.kind, file.id),
                kind: item.kind,
              });
              bytesSent += buf.length;
            } else {
              const { media, mediaMime, note } = tabularPayload(root, item.relPath, item.kind);
              if (note) diagnostics.push(note);
              const file = await drive.convertUpload(
                item.name,
                GOOGLE_SHEET,
                mediaMime,
                media,
                parentId,
              );
              bytesSent += payloadBytes(media);
              manifest.entries[item.relPath] = {
                fileId: file.id,
                kind: item.kind,
                name: item.name,
                url: driveUrl(item.kind, file.id),
                contentHash: manifestIo.contentHash(fs.readFileSync(`${root}/${item.relPath}`)),
                publishedAt: now().toISOString(),
              };
              checkpoint();
              resolved.set(item.relPath, {
                fileId: file.id,
                url: driveUrl(item.kind, file.id),
                kind: item.kind,
              });
            }
            diagnostics.push({
              code: "DRIVE_REPAIRED",
              severity: "warn",
              relPath: item.relPath,
              message: `recreated ${item.relPath} - the old file (${fileId}) was gone, so previously shared URLs no longer work`,
            });
            repaired++;
            step(`repaired ${item.relPath}`);
          } else {
            // Leave the entry alone: the error diagnostic carries the guidance.
            // Skipping instead of crashing on updateMedia lets the run finish
            // and the CLI exit 3 with a complete report.
            step(`SKIPPED ${item.relPath} - Drive file gone; re-run with --repair`);
          }
          return;
        }
        if (item.action === "unchanged") {
          step(`checked ${item.relPath}`);
          return;
        }
        if (item.kind === "file") {
          const buf = fs.readFileSync(`${root}/${item.relPath}`);
          const mime = rawMimeType(item.relPath);
          await drive.updateMedia(fileId, mime, buf);
          const entry = manifest.entries[item.relPath];
          if (entry) {
            entry.name = item.name;
            entry.contentHash = manifestIo.contentHash(buf);
            entry.publishedAt = now().toISOString();
          }
          checkpoint();
          updated++;
          step(`updated ${item.relPath}`, buf.length);
          return;
        }
        if (item.kind === "markdown") {
          step(`updating ${item.relPath}`);
          toFill.push({ item, fileId });
        } else {
          const { media, mediaMime, note } = tabularPayload(root, item.relPath, item.kind);
          if (note) diagnostics.push(note);
          await drive.updateMedia(fileId, mediaMime, media);
          const entry = manifest.entries[item.relPath];
          if (entry) {
            entry.name = item.name;
            entry.contentHash = manifestIo.contentHash(fs.readFileSync(`${root}/${item.relPath}`));
            entry.publishedAt = now().toISOString();
          }
          checkpoint();
          updated++;
          step(`updated sheet ${item.relPath}`, payloadBytes(media));
        }
      }
    } catch (e) {
      if (!(e instanceof DriveError)) throw e;
      // Non-Drive errors (local fs, bugs) still abort the run; only Drive's
      // rejection of one item is a per-item failure. The pool never sees
      // this, so sibling items keep publishing in parallel.
      diagnostics.push({
        code: "PUBLISH_FAILED",
        severity: "error",
        relPath: item.relPath,
        message: `Drive rejected this file: ${e.message.slice(0, 200)}`,
      });
      failed++;
      step(`SKIPPED ${item.relPath} - publish failed (see report)`);
    }
  };

  await pool.run(plan.items, reserveItem);

  // ---- phase 2: rewrite links and fill content ---------------------------
  const scanned = scan(root);
  const known = new Set<string>([...scanned.files.map((f) => f.relPath), ...scanned.skipped]);
  const fillItem = async ({
    item,
    fileId,
  }: {
    item: PlanItem;
    fileId: string;
  }): Promise<void> => {
    const markdown = fs.readFileSync(`${root}/${item.relPath}`, "utf8");
    const prepared = prepareMarkdown({
      relPath: item.relPath,
      markdown,
      resolved,
      root,
      known,
    });
    diagnostics.push(...prepared.diagnostics);
    if (prepared.diagnostics.some((d) => d.severity === "error")) {
      step(`SKIPPED ${item.relPath} (see errors)`);
      return;
    }
    try {
      await drive.updateMedia(fileId, "text/markdown", prepared.content);
    } catch (e) {
      // A failed fill leaves the entry exactly as checkpointed: a `pending`
      // shell (create) or an update whose hash never advanced, so the next
      // run fills this Doc instead of creating a duplicate.
      if (!(e instanceof DriveError)) throw e;
      diagnostics.push({
        code: "PUBLISH_FAILED",
        severity: "error",
        relPath: item.relPath,
        message: `Drive rejected this document's content: ${e.message.slice(0, 200)}`,
      });
      failed++;
      step(`SKIPPED ${item.relPath} - publish failed (see report)`);
      return;
    }
    const entry = manifest.entries[item.relPath];
    if (entry) {
      entry.name = item.name;
      entry.contentHash = manifestIo.contentHash(fs.readFileSync(`${root}/${item.relPath}`));
      entry.publishedAt = now().toISOString();
      // The key must disappear from the serialised manifest: assigning
      // undefined would keep it in Object.keys and inflate `status` counts.
      // biome-ignore lint/performance/noDelete: see comment above
      delete entry.pending;
    }
    checkpoint();
    if (item.action === "update") updated++;
    step(`published ${item.relPath}`, Buffer.byteLength(prepared.content, "utf8"));
  };

  await pool.run(toFill, fillItem);

  // ---- prune (opt-in, trash only) ----------------------------------------
  if (opts.prune) {
    for (const orphan of plan.orphans) {
      try {
        await drive.trash(orphan.fileId);
        // A pruned entry must not survive as an undefined-valued key.
        delete manifest.entries[orphan.relPath];
        checkpoint();
        pruned++;
        step(`trashed ${orphan.relPath}`);
      } catch (e) {
        diagnostics.push({
          code: "DRIVE_FILE_GONE",
          severity: "warn",
          relPath: orphan.relPath,
          message: `could not trash ${orphan.fileId}: ${String(e).slice(0, 160)}`,
        });
      }
    }
  }

  const manifestFile = manifestIo.save(root, manifest);
  // Parallel completion order is meaningless to a reader: report by source
  // path so any concurrency produces identical, diffable reports.
  diagnostics.sort(
    (a, b) => (a.relPath ?? "").localeCompare(b.relPath ?? "") || a.code.localeCompare(b.code),
  );
  return {
    created,
    updated,
    repaired,
    failed,
    unchanged: plan.items.filter((i) => i.action === "unchanged").length,
    pruned,
    orphans: plan.orphans.length - pruned,
    // The plan already carries the offline analysis, and phase 2 re-derives it
    // from the real content; dedupe so each finding is reported once.
    diagnostics: dedupeDiagnostics(diagnostics),
    manifestPath: manifestFile,
    rootFolderUrl: folderUrl(manifest.rootFolderId),
    concurrency: { requested: requestedConcurrency, effective: pool.limit, rateLimitEvents },
  };
}

function tabularPayload(
  root: string,
  relPath: string,
  kind: "csv" | "xlsx" | "markdown" | "image",
): { media: Buffer | string; mediaMime: string; note?: Diagnostic } {
  const buf = fs.readFileSync(`${root}/${relPath}`);
  if (kind === "csv") {
    const sniffed = normaliseCsv(buf);
    return {
      media: sniffed.text,
      mediaMime: "text/csv",
      ...(sniffed.normalised
        ? {
            note: {
              code: "CSV_NORMALISED" as const,
              severity: "warn" as const,
              relPath,
              message: `normalised to UTF-8 comma CSV (detected ${describeDialect(sniffed)})`,
            },
          }
        : {}),
    };
  }
  return {
    media: buf,
    mediaMime: XLSX_MIME,
    note: {
      code: "XLSX_LOSSY",
      severity: "warn",
      relPath,
      message: "converted to a Google Sheet; macros and some formatting are lost",
    },
  };
}

/** Warn when Drive's copy changed after our last publish (decision 3). */
async function checkDivergence(
  drive: DriveClient,
  fileId: string,
  manifest: Manifest,
  relPath: string,
): Promise<Diagnostic | null> {
  const entry = manifest.entries[relPath];
  if (!entry) return null;
  try {
    const meta = await drive.get(fileId);
    if (meta.trashed) {
      return {
        code: "DRIVE_FILE_GONE",
        severity: "error",
        relPath,
        message: `Drive file ${fileId} is in the trash; restore it or re-run with --repair`,
      };
    }
    if (meta.modifiedTime && entry.publishedAt && meta.modifiedTime > entry.publishedAt) {
      const who =
        meta.lastModifyingUser?.displayName ?? meta.lastModifyingUser?.emailAddress ?? "someone";
      return {
        code: "DRIVE_MODIFIED",
        severity: "warn",
        relPath,
        message: `changed in Drive by ${who} at ${meta.modifiedTime}; local content wins (Drive revision history keeps their version)`,
      };
    }
    return null;
  } catch (e) {
    if (e instanceof DriveError && (e.status === 404 || e.status === 403)) {
      return {
        code: "DRIVE_FILE_GONE",
        severity: "error",
        relPath,
        message: `Drive file ${fileId} is not accessible (${e.status}); re-run with --repair to recreate it`,
      };
    }
    throw e;
  }
}

export { GOOGLE_DOC, GOOGLE_SHEET };
