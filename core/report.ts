/**
 * Report rendering: human-readable text and machine-readable JSON
 * (`--json` keeps the CLI usable from CI and from the pi extension).
 */

import fs from "node:fs";
import { describeDialect, normaliseCsv } from "./csv.ts";
import type { Diagnostic, Plan, PublishSummary } from "./types.ts";

export function renderPlan(plan: Plan, root: string): string {
  const lines: string[] = [];
  lines.push(`plan ${root}`);
  const creates = plan.items.filter((i) => i.action === "create");
  const updates = plan.items.filter((i) => i.action === "update");
  const unchanged = plan.items.filter((i) => i.action === "unchanged");

  for (const item of plan.items) {
    const marker = item.action === "create" ? "+" : item.action === "update" ? "~" : "=";
    let detail = `-> ${
      item.kind === "markdown" ? "Doc" : item.kind === "file" ? "File" : "Sheet"
    } "${item.name}"${item.kind === "file" ? " (raw upload)" : ""}`;
    if (item.kind === "csv") {
      try {
        const sniffed = normaliseCsv(fs.readFileSync(`${root}/${item.relPath}`));
        if (sniffed.normalised) detail += ` (${describeDialect(sniffed)} -> normalised)`;
      } catch {
        // unreadable file is reported via diagnostics
      }
    }
    lines.push(`  ${marker} ${item.relPath.padEnd(40)} ${detail}`);
  }
  for (const orphan of plan.orphans) {
    lines.push(`  ! ${orphan.relPath.padEnd(40)} -> orphan "${orphan.name}" (not pruned)`);
  }
  if (plan.rawSuggestion && plan.rawSuggestion.coverable.length > 0) {
    lines.push(
      `  TIP   ${plan.rawSuggestion.coverable.length} unsupported file(s) could be published as raw uploads.`,
    );
    lines.push(`        Run: gdrive-publish plan ${plan.root} --suggest-config`);
  }
  lines.push("");
  lines.push(
    `  ${creates.length} to create, ${updates.length} to update, ${unchanged.length} unchanged, ${plan.orphans.length} orphan(s)`,
  );
  const diag = renderDiagnostics(plan.diagnostics);
  if (diag) lines.push("", diag);
  return lines.join("\n");
}

export function renderDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "";
  const lines: string[] = [];
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warn");
  for (const d of errors) {
    lines.push(`  ERROR ${d.code}${d.relPath ? ` ${d.relPath}` : ""}: ${d.message}`);
  }
  for (const d of warnings) {
    lines.push(`  WARN  ${d.code}${d.relPath ? ` ${d.relPath}` : ""}: ${d.message}`);
  }
  return lines.join("\n");
}

export function renderSummary(summary: PublishSummary): string {
  const lines: string[] = [];
  lines.push(
    `  ${summary.created} created, ${summary.updated} updated, ${summary.repaired} repaired, ` +
      `${summary.unchanged} unchanged, ${summary.pruned} pruned, ${summary.failed} failed, ` +
      `${summary.orphans} orphan(s) kept`,
  );
  const c = summary.concurrency;
  if (c && (c.effective !== c.requested || c.rateLimitEvents > 0)) {
    lines.push(
      `  concurrency: ${c.requested} → ${c.effective} (adaptive, ${c.rateLimitEvents} rate-limit event(s))`,
    );
  }
  const diag = renderDiagnostics(summary.diagnostics);
  if (diag) lines.push(diag);
  lines.push(`  folder: ${summary.rootFolderUrl}`);
  lines.push(`  manifest updated: ${summary.manifestPath}`);
  lines.push("  -> review and commit the manifest to keep URLs stable for others");
  return lines.join("\n");
}

export function planJson(plan: Plan): unknown {
  return {
    root: plan.root,
    rootFolderId: plan.rootFolderId ?? null,
    folders: plan.folders,
    items: plan.items,
    orphans: plan.orphans,
    diagnostics: plan.diagnostics,
    rawSuggestion: plan.rawSuggestion,
  };
}

export function summaryJson(summary: PublishSummary): unknown {
  return {
    created: summary.created,
    updated: summary.updated,
    repaired: summary.repaired,
    failed: summary.failed,
    unchanged: summary.unchanged,
    pruned: summary.pruned,
    orphans: summary.orphans,
    manifestPath: summary.manifestPath,
    rootFolderUrl: summary.rootFolderUrl,
    concurrency: summary.concurrency ?? null,
    diagnostics: summary.diagnostics,
  };
}
