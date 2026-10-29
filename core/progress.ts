/**
 * Progress rendering for publish runs.
 *
 * Publish work is a sequence of discrete Drive API calls where per-request
 * latency dominates, not bandwidth - so the bar is **operation-based** (the
 * total is known upfront from the plan), the ETA derives from the item
 * completion rate, and byte counters are shown as informational context rather
 * than a bandwidth claim.
 *
 * Everything here is pure and testable; the TTY glue (carriage returns,
 * terminal width, isatty) lives in the CLI.
 */

export interface ProgressEvent {
  /** Human description of the step that just finished, e.g. "published toc.md". */
  label: string;
  /** Steps completed so far, including this one. */
  completed: number;
  /** Total steps planned for the run. */
  total: number;
  /** Payload bytes sent so far (content only, not protocol overhead). */
  bytes: number;
}

export interface ProgressTotals {
  folders: number;
  items: number;
  fills: number;
  prunes: number;
}

/** Total step count for a run, derivable from the plan before any work starts. */
export function totalSteps(totals: ProgressTotals): number {
  return totals.folders + totals.items + totals.fills + totals.prunes;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Solid blocks with a light shade head, Unicode-friendly, width-safe. */
export function barString(fraction: number, width: number): string {
  const w = Math.max(0, Math.floor(width));
  const frac = clamp(fraction, 0, 1);
  const filled = Math.round(frac * w);
  return `${"█".repeat(filled)}${"░".repeat(w - filled)}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

export function fmtBytesCompact(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Rate estimate: bytes per second, guarded against zero time. */
export function bytesPerSecond(bytes: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return (bytes / elapsedMs) * 1000;
}

/** Linear ETA in milliseconds based on completion rate; 0 when done or no data. */
export function etaMs(completed: number, total: number, elapsedMs: number): number {
  if (completed <= 0 || completed >= total) return 0;
  const perStep = elapsedMs / completed;
  return perStep * (total - completed);
}

/**
 * Render the single-line progress display, hard-capped to `width`.
 *
 * The bar shrinks to make room; the label is what gets truncated first.
 */
export function renderBarLine(event: ProgressEvent, elapsedMs: number, width: number): string {
  const frac = event.total > 0 ? clamp(event.completed / event.total, 0, 1) : 1;
  const pct = Math.round(frac * 100);
  const eta = etaMs(event.completed, event.total, elapsedMs);
  const done = event.completed >= event.total;
  const parts = [
    `${event.completed}/${event.total} · ${pct}%`,
    fmtDuration(elapsedMs),
    ...(done ? [] : [`ETA ${fmtDuration(eta)}`]),
    `${fmtBytesCompact(event.bytes)} · ${fmtBytesCompact(bytesPerSecond(event.bytes, elapsedMs))}/s`,
  ];
  const stats = parts.join(" · ");
  const overhead = `[${"█".repeat(1)}] `.length; // rough static cost of the bar frame
  const labelBudget = width - stats.length - overhead - 20;
  let label = event.label;
  if (label.length > labelBudget) label = `${label.slice(0, Math.max(0, labelBudget - 1))}…`;

  // Compose once to measure, then size the bar to whatever width remains.
  const fixed = ` ${stats} ${label}`;
  const barWidth = clamp(width - fixed.length - 2, 10, 30);
  const line = `[${barString(frac, barWidth)}] ${stats} ${label}`.trimEnd();
  return line.length > width ? line.slice(0, width) : line;
}
