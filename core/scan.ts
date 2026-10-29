/**
 * Source tree scanning and file classification (decision 7: the publish root
 * directory *is* the publish set).
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig, matchesAnyPattern } from "./config.ts";
import { MANIFEST_FILENAME } from "./types.ts";
import type { FileKind, SourceFile } from "./types.ts";

export const MARKDOWN_EXT = new Set([".md", ".markdown"]);
export const CSV_EXT = new Set([".csv", ".tsv"]);
export const XLSX_EXT = new Set([".xlsx", ".xls"]);
export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

/** Directories never traversed. */
export const IGNORED_DIRS = new Set([
  ".git",
  ".svn",
  "node_modules",
  ".pi",
  "dist",
  "build",
  ".next",
  "coverage",
  ".venv",
  "__pycache__",
  ".DS_Store",
]);

export function classify(relPath: string): FileKind | null {
  const ext = path.extname(relPath).toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (CSV_EXT.has(ext)) return "csv";
  if (XLSX_EXT.has(ext)) return "xlsx";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

/** MIME for raw uploads: informational (Drive icons/preview), octet-stream fallback. */
export function rawMimeType(relPath: string): string {
  // Claimed images keep their real image mime (claimed images are raw files
  // now, and the image mime is what Drive uses for previews and thumbnails).
  const image = imageMimeType(relPath);
  if (image) return image;
  switch (path.extname(relPath).toLowerCase()) {
    case ".zip":
      return "application/zip";
    case ".json":
      return "application/json";
    case ".txt":
    case ".text":
      return "text/plain";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".pdf":
      return "application/pdf";
    case ".tar":
      return "application/tar";
    case ".gz":
    case ".tgz":
      return "application/gzip";
    case ".7z":
      return "application/x-7z-compressed";
    default:
      return "application/octet-stream";
  }
}

export function imageMimeType(relPath: string): string | null {
  switch (path.extname(relPath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

export interface ScanResult {
  files: SourceFile[];
  /**
   * Files skipped because their extension is not supported AND no
   * rawPatterns entry covers them (raw-matched files become `kind: "file"`).
   */
  skipped: string[];
}

export interface ScanOptions {
  /** Overrides the config file (tests / freshly-written config re-scans). */
  rawPatterns?: string[];
  /** Same for ignorePatterns. */
  ignorePatterns?: string[];
}

/**
 * Recursively scan a publish root. Files whose type has no native Drive
 * conversion publish as raw uploads when (and only when) they match a
 * rawPatterns entry from .gdrive-publish.json. ignorePatterns entries
 * exclude files outright - native types included - and a matching
 * directory is pruned whole, gitignore-style. Symlinked directories are
 * not followed.
 */
export function scan(root: string, opts?: ScanOptions): ScanResult {
  const config = loadConfig(root);
  const rawPatterns = opts?.rawPatterns ?? config?.rawPatterns ?? [];
  const ignorePatterns = opts?.ignorePatterns ?? config?.ignorePatterns ?? [];
  const files: SourceFile[] = [];
  const skipped: string[] = [];

  const walk = (dir: string, rel: string): void => {
    const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Office lock files (`~$workbook.xlsx`, ~2 KB of who-has-it-open
      // bookkeeping, never content) are dropped silently, like hidden
      // files: they exist exactly while the real file is being edited, and
      // "ignoring" must not depend on whether the editor is still open.
      if (entry.name.startsWith("~$")) continue;
      if (entry.name.startsWith(".") && entry.name !== MANIFEST_FILENAME) {
        // Hidden files/directories are not published (manifest handled separately).
        if (entry.isDirectory()) continue;
        if (entry.name !== MANIFEST_FILENAME) continue;
      }
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        // A matching directory is pruned whole (children are never even
        // walked) - gitignore intuition, and the point of excluding `_*`
        // style trees is to skip the subtree, not warn per file.
        if (matchesAnyPattern(ignorePatterns, relPath)) continue;
        walk(path.join(dir, entry.name), relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === MANIFEST_FILENAME) continue;
      // Ignored files never publish - native types included: an ignore is
      // content-level (unlike rawPatterns, which can never hijack a native
      // conversion) and they never warn as unsupported either.
      if (matchesAnyPattern(ignorePatterns, relPath)) continue;
      const kind = classify(relPath);
      const absPath = path.join(root, relPath);
      // Raw upload is opt-in per pattern, for files WITHOUT a native
      // conversion: unclassified types (no conversion at all) and images
      // (embedded into Docs, never converted). markdown/csv/xlsx always
      // keep their native conversion - a pattern cannot hijack them.
      const claimable = kind === null || kind === "image";
      if (claimable && matchesAnyPattern(rawPatterns, relPath)) {
        files.push({ relPath, absPath, kind: "file", size: fs.statSync(absPath).size });
        continue;
      }
      if (!kind) {
        skipped.push(relPath);
        continue;
      }
      files.push({ relPath, absPath, kind, size: fs.statSync(absPath).size });
    }
  };

  walk("", "");
  return { files, skipped };
}

/** Folder paths needed in Drive, parents before children. */
export function folderPaths(files: SourceFile[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    const parts = f.relPath.split("/");
    parts.pop();
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      set.add(acc);
    }
  }
  return [...set].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}
