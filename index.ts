import fs from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  AuthError,
  CachedTokenProvider,
  clientHash,
  readToken,
  resolveCredentials,
} from "./core/auth.ts";
import { RestDriveClient } from "./core/drive.ts";
import * as manifestIo from "./core/manifest.ts";
import { buildPlan, publish } from "./core/publish.ts";
import {
  planJson,
  renderDiagnostics,
  renderPlan,
  renderSummary,
  summaryJson,
} from "./core/report.ts";
import { MANIFEST_FILENAME, folderUrl } from "./core/types.ts";

/**
 * gdrive-publish — pi harness integration.
 *
 * Deliberately inert unless this project is actually set up for publishing
 * (see ../../spike/FINDINGS.md and the README): the `gdrive_publish` tool is
 * only registered when the working directory has a `.gdrive-manifest.json`
 * *and* a cached OAuth token exists. Otherwise only the setup command is
 * registered, so unrelated sessions in unrelated repos never expose a tool
 * that can write to Google Drive.
 *
 * All real work lives in `core/`, which is imported directly (no subprocess,
 * no JSON contract) and is shared verbatim with the CLI.
 */

interface Readiness {
  manifestDir: string | null;
  hasToken: boolean;
  credentialSource: string | null;
  detail: string;
}

/** Find a manifest in cwd or the nearest ancestor (stops at the repo root). */
function findManifestDir(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, MANIFEST_FILENAME))) return dir;
    if (fs.existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function assess(cwd: string): Readiness {
  const manifestDir = findManifestDir(cwd);
  let hasToken = false;
  let credentialSource: string | null = null;
  try {
    const creds = resolveCredentials();
    credentialSource = creds.source;
    hasToken = readToken(creds.clientId) !== null;
  } catch {
    // No resolvable credentials: stay inert and let the setup command explain.
  }
  const detail = !manifestDir
    ? `no ${MANIFEST_FILENAME} in or above ${cwd}`
    : hasToken
      ? `ready (${manifestDir})`
      : "manifest found but not authenticated";
  return { manifestDir, hasToken, credentialSource, detail };
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function (pi: ExtensionAPI) {
  const readiness = assess(process.cwd());

  // ---- always available: setup + diagnostics (read-only) -----------------

  pi.registerCommand("gdrive-publish-init", {
    description: "Create the Drive folder and manifest for this project (gdrive-publish)",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify(
          "usage: /gdrive-publish-init <folder name>  e.g. /gdrive-publish-init Project X Docs",
          "warning",
        );
        return;
      }
      const root = ctx.cwd;
      if (manifestIo.load(root)) {
        ctx.ui.notify(`${root} already has a ${MANIFEST_FILENAME}`, "warning");
        return;
      }
      try {
        const creds = resolveCredentials();
        if (!readToken(creds.clientId)) {
          ctx.ui.notify(
            `not authenticated for ${creds.source} - run "gdrive-publish login" in a terminal first`,
            "error",
          );
          return;
        }
        const drive = new RestDriveClient(new CachedTokenProvider(creds));
        const folder = await drive.createFolder(name);
        const manifest = manifestIo.emptyManifest(folder.id, folder.name);
        manifest.credentialSource = creds.source;
        manifest.clientIdHash = clientHash(creds.clientId);
        manifestIo.save(root, manifest);
        ctx.ui.notify(
          `created Drive folder "${folder.name}" and ${MANIFEST_FILENAME} - commit the manifest, then reload to get the gdrive_publish tool`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(
          `init failed: ${e instanceof AuthError ? e.message : String(e).slice(0, 200)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("gdrive-publish-status", {
    description: "Show gdrive-publish readiness, manifest and credential identity",
    handler: async (_args, ctx) => {
      const state = assess(ctx.cwd);
      const lines = [`readiness: ${state.detail}`];
      lines.push(`credentials: ${state.credentialSource ?? "none resolvable"}`);
      if (state.manifestDir) {
        const manifest = manifestIo.load(state.manifestDir);
        if (manifest) {
          lines.push(
            `manifest: ${Object.keys(manifest.entries).length} entr(ies), folder "${manifest.rootFolderName}"`,
          );
          lines.push(folderUrl(manifest.rootFolderId));
          const pending = manifestIo.pendingEntries(manifest);
          if (pending.length) lines.push(`pending (unfilled) Docs: ${pending.join(", ")}`);
        }
      }
      lines.push(
        readiness.manifestDir && readiness.hasToken
          ? "gdrive_publish tool: registered"
          : "gdrive_publish tool: NOT registered (run init and login, then /reload)",
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ---- the writing tool: only when this project is actually set up -------

  if (!readiness.manifestDir || !readiness.hasToken) {
    pi.on("session_start", (_event, ctx: ExtensionContext) => {
      // Quiet by design: a notification in every unrelated session would be noise.
      ctx.ui.setStatus("gdrive-publish", "");
    });
    return;
  }

  const root = readiness.manifestDir;

  pi.registerTool({
    name: "gdrive_publish",
    label: "Publish to Google Drive",
    description:
      "Publish this project's markdown/CSV/XLSX files to Google Drive as native Google Docs/Sheets, " +
      "rewriting relative links between files to the real Google Doc URLs. " +
      'Use mode "plan" to preview (read-only, no writes) and mode "publish" to apply. ' +
      "Re-publishing updates the same Drive files, so shared URLs stay stable. " +
      "Only files under the manifest directory are published.",
    parameters: Type.Object({
      mode: StringEnum(["plan", "publish"] as const, {
        description: "plan = preview only (no writes); publish = create/update Drive files",
      }),
      prune: Type.Optional(
        Type.Boolean({
          description:
            "When publishing, move Drive files whose local source was deleted to Drive trash (never hard-deleted). Defaults to false.",
        }),
      ),
      repair: Type.Optional(
        Type.Boolean({
          description:
            "Recreate Drive files that are trashed or inaccessible, under new ids - previously shared URLs for them stop working. Only use when the user explicitly approved repairing.",
        }),
      ),
      assumeYes: Type.Optional(
        Type.Boolean({
          description:
            "Skip the interactive confirmation. Required to publish in non-interactive sessions; use only when the user has already approved.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const manifest = manifestIo.load(root);
      if (!manifest) {
        return textResult(`no ${MANIFEST_FILENAME} in ${root} anymore; run /gdrive-publish-init`);
      }
      const plan = buildPlan({ root, manifest });

      if (params.mode === "plan") {
        return textResult(renderPlan(plan, root), { plan: planJson(plan) });
      }

      const creates = plan.items.filter((i) => i.action === "create").length;
      const updates = plan.items.filter((i) => i.action === "update").length;
      const errors = plan.diagnostics.filter((d) => d.severity === "error");
      if (errors.length) {
        return textResult(
          `refusing to publish: the plan has ${errors.length} error(s)\n${renderDiagnostics(errors)}`,
          { plan: planJson(plan) },
        );
      }

      const orphanNote = params.prune ? " (will be trashed)" : " (kept)";
      const summaryLine = `${creates} to create, ${updates} to update, ${plan.orphans.length} orphan(s)${orphanNote}`;

      if (!params.assumeYes) {
        if (!ctx.hasUI) {
          return textResult(
            `refusing to publish without confirmation in a non-interactive session. ${summaryLine}. Ask the user to approve, then call again with assumeYes: true.`,
            { plan: planJson(plan) },
          );
        }
        const ok = await ctx.ui.confirm(
          "Publish to Google Drive?",
          `${root}\n${summaryLine}\n\nLocal content wins; Drive-side edits are kept in revision history.`,
        );
        if (!ok) return textResult("publish cancelled by the user", { plan: planJson(plan) });
      }

      const drive = new RestDriveClient(new CachedTokenProvider(resolveCredentials()));
      const done: string[] = [];
      try {
        const summary = await publish({
          root,
          drive,
          manifest,
          plan,
          prune: params.prune ?? false,
          repair: params.repair ?? false,
          onProgress: (event) => {
            done.push(event.label);
            ctx.ui.setStatus(
              "gdrive-publish",
              `publishing ${event.completed}/${event.total}: ${event.label}`,
            );
            onUpdate?.({ content: [{ type: "text", text: event.label }], details: {} });
          },
        });
        ctx.ui.setStatus("gdrive-publish", "");
        return textResult(renderSummary(summary), { summary: summaryJson(summary) });
      } catch (e) {
        ctx.ui.setStatus("gdrive-publish", "");
        const detail = e instanceof AuthError ? e.message : String(e).slice(0, 400);
        return textResult(
          `publish failed after ${done.length} step(s): ${detail}\nThe manifest was checkpointed, so re-running fills the same Drive files instead of creating duplicates.`,
          { steps: done },
        );
      }
    },
  });

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const manifest = manifestIo.load(root);
    const count = manifest ? Object.keys(manifest.entries).length : 0;
    ctx.ui.setStatus("gdrive-publish", `gdrive-publish ready (${count} published)`);
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    ctx.ui.setStatus("gdrive-publish", "");
  });
}
