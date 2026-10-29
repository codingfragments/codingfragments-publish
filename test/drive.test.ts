/**
 * Retry-hardening tests for the REST client: which responses are retried,
 * the backoff curve, and that rate limits surface through the listener so
 * publish can adapt (design: docs/parallel-publish.md, slice 1).
 *
 * fetch is stubbed with a scripted response sequence; sleep is a no-op so
 * the tests stay instant.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  RestDriveClient,
  backoffDelayMs,
  isRetryableStatus,
} from "../core/drive.ts";
import type { TokenProvider } from "../core/drive.ts";

const tokens: TokenProvider = { accessToken: async () => "test-token" };
const noSleep = { sleepMs: async () => {} };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function errorResponse(status: number, reason?: string): Response {
  const body = reason === undefined ? "nope" : JSON.stringify({ error: { errors: [{ reason }] } });
  return new Response(body, { status });
}

/** Stub global fetch with a queue; each call shifts the next response. */
function stubFetch(...queue: Response[]): { calls: number; restore(): void } {
  const realFetch = globalThis.fetch;
  const stub = {
    calls: 0,
    restore(): void {
      globalThis.fetch = realFetch;
    },
  };
  globalThis.fetch = (async () => {
    stub.calls++;
    const next = queue.shift();
    if (!next) throw new Error("fetch stub exhausted");
    return next;
  }) as typeof fetch;
  return stub;
}

test("isRetryableStatus: rate limits and transient 5xx only", () => {
  assert.ok(isRetryableStatus(429, ""));
  assert.ok(isRetryableStatus(403, "rateLimitExceeded"));
  assert.ok(isRetryableStatus(403, "userRateLimitExceeded"));
  for (const s of [500, 502, 503, 504]) assert.ok(isRetryableStatus(s, ""));
  assert.ok(!isRetryableStatus(403, "insufficientFilePermissions"));
  assert.ok(!isRetryableStatus(400, "badRequest"));
  assert.ok(!isRetryableStatus(404, "notFound"));
  assert.ok(!isRetryableStatus(401, "invalid_client"));
});

test("backoffDelayMs: exponential with jitter, capped", () => {
  // Deterministic with jitter pinned to 0.
  assert.equal(
    backoffDelayMs(0, () => 0),
    1000,
  );
  assert.equal(
    backoffDelayMs(1, () => 0),
    2000,
  );
  assert.equal(
    backoffDelayMs(3, () => 0),
    8000,
  );
  assert.equal(
    backoffDelayMs(7, () => 0),
    MAX_BACKOFF_MS,
    "capped at the ceiling",
  );
  // Jitter adds up to 1s but never exceeds the cap.
  assert.ok(backoffDelayMs(0, () => 0.999) > 1000);
  assert.ok(backoffDelayMs(0, () => 0.999) <= 2000);
});

test("a 429 is retried, succeeds, and reports the rate limit", async () => {
  const stub = stubFetch(
    errorResponse(429),
    errorResponse(429),
    jsonResponse({ id: "fld1", name: "Docs", mimeType: "folder" }),
  );
  const client = new RestDriveClient(tokens, noSleep);
  const events: number[] = [];
  client.setRateLimitListener(() => events.push(client.rateLimitEvents));
  try {
    const folder = await client.createFolder("Docs");
    assert.equal(folder.id, "fld1");
    assert.equal(stub.calls, 3, "two rate limits, then success");
    assert.equal(client.rateLimitEvents, 2);
    assert.deepEqual(events, [1, 2], "listener fired for each rate limit");
  } finally {
    stub.restore();
  }
});

test("403 rateLimitExceeded is retried; other 403s are not", async () => {
  const stub = stubFetch(
    errorResponse(403, "rateLimitExceeded"),
    jsonResponse({ id: "doc1", name: "x", mimeType: "document" }),
  );
  const client = new RestDriveClient(tokens, noSleep);
  try {
    await client.createEmptyDoc("x", "parent");
    assert.equal(stub.calls, 2);
    assert.equal(client.rateLimitEvents, 1);
  } finally {
    stub.restore();
  }
});

test("retries are exhausted into the original DriveError", async () => {
  const stub = stubFetch(...Array.from({ length: MAX_ATTEMPTS }, () => errorResponse(429)));
  const client = new RestDriveClient(tokens, noSleep);
  try {
    await assert.rejects(() => client.createFolder("Docs"), /-> 429/);
    assert.equal(stub.calls, MAX_ATTEMPTS, "exactly MAX_ATTEMPTS fetches, no more");
    assert.equal(client.rateLimitEvents, MAX_ATTEMPTS - 1);
  } finally {
    stub.restore();
  }
});

test("non-retryable errors fail immediately without backoff", async () => {
  const stub = stubFetch(errorResponse(400, "badRequest"));
  const client = new RestDriveClient(tokens, noSleep);
  try {
    await assert.rejects(() => client.createFolder("Docs"), /-> 400/);
    assert.equal(stub.calls, 1);
    assert.equal(client.rateLimitEvents, 0);
  } finally {
    stub.restore();
  }
});
