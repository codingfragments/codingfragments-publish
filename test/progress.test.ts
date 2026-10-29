/**
 * Progress renderer tests.
 *
 * Publish work is operation-based (the total is known from the plan), so the
 * assertions focus on what users actually see: the bar never exceeds the
 * terminal width, the ETA is honest (zero when done), and byte counts render
 * in human units.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  barString,
  bytesPerSecond,
  etaMs,
  fmtBytesCompact,
  fmtDuration,
  renderBarLine,
  totalSteps,
} from "../core/progress.ts";
import type { ProgressEvent } from "../core/progress.ts";

function event(completed: number, total: number, bytes = 0): ProgressEvent {
  return { label: "published toc.md", completed, total, bytes };
}

test("barString fills proportionally and clamps", () => {
  assert.equal(barString(0, 4), "░░░░");
  assert.equal(barString(0.5, 4), "██░░");
  assert.equal(barString(1, 4), "████");
  assert.equal(barString(2, 4), "████", "fraction above 1 clamps to full");
  assert.equal(barString(0.25, 0), "", "zero width renders nothing");
});

test("fmtDuration picks sensible units", () => {
  assert.equal(fmtDuration(400), "400ms");
  assert.equal(fmtDuration(1000), "1.0s");
  assert.equal(fmtDuration(9500), "9.5s");
  assert.equal(fmtDuration(61000), "1m1s");
  assert.equal(fmtDuration(125000), "2m5s");
});

test("fmtBytesCompact uses B, KB and MB", () => {
  assert.equal(fmtBytesCompact(512), "512 B");
  assert.equal(fmtBytesCompact(2048), "2 KB");
  assert.equal(fmtBytesCompact(5 * 1024 * 1024), "5.0 MB");
});

test("bytesPerSecond guards against zero elapsed time", () => {
  assert.equal(bytesPerSecond(1000, 0), 0);
  assert.equal(bytesPerSecond(1000, 1000), 1000);
  assert.equal(bytesPerSecond(500, 250), 2000);
});

test("etaMs is linear, zero when done or before start", () => {
  assert.equal(etaMs(0, 10, 5000), 0, "no data yet");
  assert.equal(etaMs(10, 10, 5000), 0, "already complete");
  // 2 of 4 done in 10s -> 10s remaining
  assert.equal(etaMs(2, 4, 10000), 10000);
});

test("renderBarLine never exceeds the terminal width", () => {
  for (const width of [40, 60, 80, 120]) {
    for (const completed of [0, 1, 5, 9]) {
      const line = renderBarLine(event(completed, 9, 145_000), 61_000, width);
      assert.ok(line.length <= width, `width ${width}: line was ${line.length}: ${line}`);
    }
  }
});

test("renderBarLine truncates the label, not the stats", () => {
  const long: ProgressEvent = {
    label: "published guide/deeper/very/deeply/nested/long-file-name.md with extra words",
    completed: 3,
    total: 9,
    bytes: 12_345,
  };
  const line = renderBarLine(long, 5000, 60);
  assert.ok(line.length <= 60);
  assert.ok(line.includes("3/9"), "counter survives");
  assert.ok(line.includes("ETA"), "eta survives");
  assert.ok(line.endsWith("…"), "label truncated with an ellipsis");
});

test("renderBarLine shows 100% and no ETA when complete", () => {
  const line = renderBarLine(event(9, 9, 9999), 30000, 80);
  assert.ok(line.includes("9/9 · 100%"));
  assert.ok(!line.includes("ETA"), "no eta once done");
});

test("totalSteps sums the plan-derived work", () => {
  assert.equal(totalSteps({ folders: 2, items: 9, fills: 5, prunes: 1 }), 17);
});
