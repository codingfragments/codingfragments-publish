/**
 * Manifest persistence (decisions 1, 2, 18, 20).
 *
 * - lives in the source tree next to the docs, committed and PR-reviewable
 * - written via temp file + atomic rename so a kill never truncates it
 * - checkpointed after phase 1 with `pending` entries so a crash between
 *   reserving ids and filling content is recoverable without duplicates
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MANIFEST_FILENAME, MANIFEST_VERSION } from "./types.ts";
import type { Manifest, ManifestEntry } from "./types.ts";

export function manifestPath(root: string): string {
  return path.join(root, MANIFEST_FILENAME);
}

export function emptyManifest(rootFolderId: string, rootFolderName: string): Manifest {
  return {
    version: MANIFEST_VERSION,
    rootFolderId,
    rootFolderName,
    folders: {},
    entries: {},
  };
}

export function load(root: string): Manifest | null {
  const p = manifestPath(root);
  if (!fs.existsSync(p)) return null;
  const raw: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${MANIFEST_FILENAME} is not a JSON object`);
  }
  const m = raw as Manifest;
  if (m.version !== MANIFEST_VERSION) {
    throw new Error(
      `${MANIFEST_FILENAME} has version ${String(m.version)}, expected ${MANIFEST_VERSION}`,
    );
  }
  if (!m.rootFolderId) throw new Error(`${MANIFEST_FILENAME} is missing rootFolderId`);
  m.folders ??= {};
  m.entries ??= {};
  return m;
}

/** Stable, diff-friendly serialisation: sorted keys, 2-space indent, trailing newline. */
export function serialize(manifest: Manifest): string {
  const sortedEntries: Record<string, ManifestEntry> = {};
  for (const key of Object.keys(manifest.entries).sort()) {
    const entry = manifest.entries[key];
    if (entry) sortedEntries[key] = entry;
  }
  const sortedFolders: Record<string, string> = {};
  for (const key of Object.keys(manifest.folders).sort()) {
    const id = manifest.folders[key];
    if (id !== undefined) sortedFolders[key] = id;
  }
  const ordered: Manifest = {
    version: manifest.version,
    rootFolderId: manifest.rootFolderId,
    rootFolderName: manifest.rootFolderName,
    ...(manifest.credentialSource ? { credentialSource: manifest.credentialSource } : {}),
    ...(manifest.clientIdHash ? { clientIdHash: manifest.clientIdHash } : {}),
    folders: sortedFolders,
    entries: sortedEntries,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Atomic write: temp file in the same directory, then rename. */
export function save(root: string, manifest: Manifest): string {
  const dest = manifestPath(root);
  const tmp = path.join(root, `.${MANIFEST_FILENAME}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, serialize(manifest));
  fs.renameSync(tmp, dest);
  return dest;
}

export function contentHash(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32);
}

export function pendingEntries(manifest: Manifest): string[] {
  return Object.entries(manifest.entries)
    .filter(([, e]) => e.pending)
    .map(([relPath]) => relPath);
}
