/**
 * AdaptivePool tests: the bounded-concurrency and adaptive-throttling
 * machinery behind parallel publish (design: docs/parallel-publish.md).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AdaptivePool } from "../core/pool.ts";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("processes every item exactly once, in items order at limit 1", async () => {
  const seen: number[] = [];
  await new AdaptivePool(1).run([0, 1, 2, 3, 4], async (n) => {
    seen.push(n);
    await delay(1);
  });
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);
});

test("never has more items in flight than the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  await new AdaptivePool(3).run(
    Array.from({ length: 12 }, (_, i) => i),
    async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight--;
    },
  );
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit 3`);
  assert.ok(peak > 1, `expected real overlap, peak was ${peak}`);
});

test("halve() reduces the active limit, floored at 1", () => {
  const pool = new AdaptivePool(8);
  assert.equal(pool.limit, 8);
  pool.halve();
  assert.equal(pool.limit, 4);
  pool.halve();
  assert.equal(pool.limit, 2);
  pool.halve();
  assert.equal(pool.limit, 1);
  pool.halve();
  assert.equal(pool.limit, 1, "floor is 1 - throttling never stalls the run");
});

test("a throttled-off worker stops pulling but in-flight items finish", async () => {
  const pool = new AdaptivePool(4);
  const processed: number[] = [];
  const all = Array.from({ length: 10 }, (_, i) => i);
  const runDone = pool.run(all, async (n) => {
    if (n === 1) pool.halve(); // worker ranks 2 and 3 stop after their current item
    processed.push(n);
    await delay(5);
  });
  await runDone;
  assert.equal(processed.length, all.length, "every item still processed");
});

test("rethrows the error of the lowest failing item index", async () => {
  const pool = new AdaptivePool(4);
  const errors: unknown[] = [];
  await pool
    .run([0, 1, 2, 3, 4, 5], async (n) => {
      await delay(2);
      if (n === 4) throw new Error("boom-4");
      if (n === 2) throw new Error("boom-2");
    })
    .catch((e) => errors.push(e));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /boom-2/, "lowest index wins regardless of completion order");
});

test("empty items are a no-op", async () => {
  await new AdaptivePool(3).run([], async () => {
    throw new Error("must not run");
  });
});
