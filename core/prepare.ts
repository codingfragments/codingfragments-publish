/**
 * Document preparation: front-matter stripping, link rewriting against the
 * resolved id map, and image inlining as `data:` URIs.
 *
 * Image strategy (decision 9, rewritten after the spike): local images are
 * base64-inlined so Drive embeds a real copy. `uc?export=view&id=` URLs cannot
 * work on Workspaces that block anyone-with-link (`publishOutNotPermitted`),
 * and the importer fetches image URLs anonymously, so shared-URL embedding is
 * impossible. Verified by PDF-render comparison in the spike.
 */

import fs from "node:fs";
import path from "node:path";
import { classifyTarget, rewriteLinks } from "./links.ts";
import { splitFrontMatter } from "./naming.ts";
import { imageMimeType } from "./scan.ts";
import type { Diagnostic, FileKind } from "./types.ts";

/** Warn above this per-image size; base64 inflates by ~33%. */
export const IMAGE_WARN_BYTES = 2 * 1024 * 1024;
/** Hard-fail a document whose prepared payload exceeds this. */
export const DOC_MAX_BYTES = 10 * 1024 * 1024;

export interface ResolvedTarget {
  fileId: string;
  url: string;
  kind: FileKind;
}

export interface PrepareInput {
  relPath: string;
  markdown: string;
  /** Publish-root-relative path -> published Drive target. */
  resolved: Map<string, ResolvedTarget>;
  /** Absolute path of the publish root, for reading images. */
  root: string;
  /** Known source files (for distinguishing "missing" from "not published"). */
  known: Set<string>;
  /**
   * Analysis-only mode, used by `plan`: produce identical diagnostics without
   * building the upload payload. Images are measured (`ceil(n/3)*4`) instead
   * of being base64-encoded, so planning an image-heavy tree stays cheap and
   * the returned `content` must not be uploaded.
   */
  analyzeOnly?: boolean;
}

export interface PrepareResult {
  /** Content to upload as `text/markdown`. Not usable when `analyzeOnly`. */
  content: string;
  diagnostics: Diagnostic[];
  inlinedImages: number;
  /** Size the uploaded payload will have, in bytes. */
  payloadBytes: number;
}

/** base64 length of `n` raw bytes, without building the string. */
function base64Size(n: number): number {
  return Math.ceil(n / 3) * 4;
}

/** Normalise a relative link target against the linking file's directory. */
export function resolveRelative(fromRelPath: string, target: string): string | null {
  const decoded = safeDecode(target);
  const baseDir = path.posix.dirname(fromRelPath);
  const joined = path.posix.normalize(path.posix.join(baseDir === "." ? "" : baseDir, decoded));
  if (joined.startsWith("..")) return null; // escapes the publish root
  return joined.replace(/^\.\//, "");
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Prepare a markdown document for upload: strip front matter, rewrite in-set
 * links to Drive URLs, inline images, and collect diagnostics.
 */
export function prepareMarkdown(input: PrepareInput): PrepareResult {
  const diagnostics: Diagnostic[] = [];
  const fm = splitFrontMatter(input.markdown);
  if (fm.present) {
    diagnostics.push({
      code: "FRONTMATTER_STRIPPED",
      severity: "warn",
      relPath: input.relPath,
      message: fm.fields.title
        ? `front matter removed (Drive would mangle it); title "${fm.fields.title}" used as the Doc name`
        : "front matter removed (the Drive importer turns it into a mangled heading)",
    });
  }

  let inlinedImages = 0;
  let imageBytes = 0;
  const content = rewriteLinks(fm.body, (link) => {
    const kind = classifyTarget(link.target);
    if (kind === "external" || kind === "anchor-only") return null; // untouched
    if (kind === "absolute") {
      diagnostics.push({
        code: "LINK_OUTSIDE_ROOT",
        severity: "warn",
        relPath: input.relPath,
        message: `absolute path link left verbatim: ${link.raw}`,
      });
      return null;
    }

    const resolvedPath = resolveRelative(input.relPath, link.target);
    if (resolvedPath === null) {
      diagnostics.push({
        code: "LINK_OUTSIDE_ROOT",
        severity: "warn",
        relPath: input.relPath,
        message: `link escapes the publish root, left verbatim: ${link.raw}`,
      });
      return null;
    }

    if (link.isImage) {
      const abs = path.join(input.root, resolvedPath);
      const mime = imageMimeType(resolvedPath);
      if (!mime) {
        diagnostics.push({
          code: "IMAGE_UNSUPPORTED",
          severity: "warn",
          relPath: input.relPath,
          message: `unsupported image type, left verbatim: ${link.raw}`,
        });
        return null;
      }
      if (!fs.existsSync(abs)) {
        diagnostics.push({
          code: "IMAGE_MISSING",
          severity: "warn",
          relPath: input.relPath,
          message: `image not found, left verbatim: ${link.raw}`,
        });
        return null;
      }
      const buf = fs.readFileSync(abs);
      if (buf.length > IMAGE_WARN_BYTES) {
        diagnostics.push({
          code: "IMAGE_LARGE",
          severity: "warn",
          relPath: input.relPath,
          message: `${resolvedPath} is ${fmtBytes(buf.length)}; inlined as base64 (~${fmtBytes(
            base64Size(buf.length),
          )} in the upload)`,
        });
      }
      inlinedImages++;
      imageBytes += base64Size(buf.length);
      if (input.analyzeOnly) {
        // Keep the link shape so the rewritten document is still parseable,
        // but do not pay for encoding a payload nobody will upload.
        return `data:${mime};base64,<${buf.length} bytes>`;
      }
      return `data:${mime};base64,${buf.toString("base64")}`;
    }

    const target = input.resolved.get(resolvedPath);
    if (!target) {
      const code = input.known.has(resolvedPath) ? "LINK_TO_UNSUPPORTED" : "LINK_TARGET_MISSING";
      diagnostics.push({
        code,
        severity: "warn",
        relPath: input.relPath,
        message:
          code === "LINK_TARGET_MISSING"
            ? `link target does not exist, left verbatim: ${link.raw}`
            : `link target is not published, left verbatim: ${link.raw}`,
      });
      return null;
    }
    if (link.anchor) {
      diagnostics.push({
        code: "ANCHOR_DROPPED",
        severity: "warn",
        relPath: input.relPath,
        message: `anchor dropped (links to the top of the Doc): ${link.raw}`,
      });
    }
    return target.url;
  });

  // In analyzeOnly mode the image payloads were replaced by placeholders, so
  // the real upload size is the text plus the base64 size of each image.
  const textBytes = Buffer.byteLength(content, "utf8");
  const payloadBytes = input.analyzeOnly ? textBytes + imageBytes : textBytes;
  if (payloadBytes > DOC_MAX_BYTES) {
    diagnostics.push({
      code: "DOC_PAYLOAD_TOO_LARGE",
      severity: "error",
      relPath: input.relPath,
      message: `prepared payload is ${fmtBytes(payloadBytes)}, over the ${fmtBytes(
        DOC_MAX_BYTES,
      )} limit (reduce or shrink inlined images)`,
    });
  }

  return { content, diagnostics, inlinedImages, payloadBytes };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
