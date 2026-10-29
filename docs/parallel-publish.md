# Design: retry hardening + bounded parallel publish for gdrive-publish

Status: **planned, not implemented** — decisions discussed and approved
2026-10-25. Each slice lands as a branch + PR off `main`.

## Background

Publish is fully sequential today: phase 1 reserves ids (convert-upload /
empty Doc shells) item by item, phase 2 fills content item by item. Request
latency dominates (per the progress-bar design note), so wall-clock time is
roughly `files × RTT`.

Two code facts (verified 2026-10-25):

- `request()` in `core/drive.ts` has **no retry, no backoff, no 429
  handling** — any single `429`/`5xx` throws and kills the run. A transient
  rate limit aborts a 200-file publish.
- The two item loops (`publish.ts`, phase 1 reservation, phase 2 fill) are
  plain `for`/`await` — parallelizable without touching the phase boundary.

Two Google facts (verified 2026-10-25):

- Quota is measured in **quota units** (new model since 2026-05): 325,000
  units/min per user per project; a `files.update` costs ~50 — a few hundred
  KB-sized docs per minute is trivially inside quota.
- Drive backend rate-limit checks can emit `429` **even under published
  quota**, specifically for "many small files uploaded concurrently" —
  exactly our workload. Documented best practice: 2–5 concurrent uploads
  per user, exponential backoff with jitter, reduce concurrency when
  throttled.

Conclusion: parallel publish is legitimate and a real speedup, but
**concurrency without retry handling is strictly worse than today** —
parallel bursts provoke 429s, and each would abort the run. Retry hardening
is the prerequisite, hence slice order below.

## Slice 1: `feat/gdrive-publish-retry` — harden `request()`

- Truncated exponential backoff **with jitter**: `min(2^n s + jitter, 64 s)`.
- Retry on: `429`, `403 rateLimitExceeded`, `403 userRateLimitExceeded`,
  `500`, `502`, `503`, `504`.
- Max ~8 attempts, then the existing `DriveError` path.
- Worth shipping **even without** parallelism — one transient 429 currently
  fails the whole run.
- No behavior change on success paths; no new config surface.

## Slice 2: `feat/gdrive-publish-parallel` — bounded worker pool

- Small internal pool helper (no new dependency), items within phase 1 and
  within phase 2 execute through it.
- **Folders stay sequential** — parent-before-child ordering is
  load-bearing; folders are a tiny fraction of the work.
- **Manifest checkpoint between phases stays** — phase 2 needs all reserved
  ids for link rewriting; `PENDING_RESUMED` semantics unchanged.
- **Adaptive throttle:** on a 429, halve the pool for the rest of the run,
  floor 1, never scale back up mid-run. Automatic, not configurable.
- **Error-report determinism:** diagnostics are sorted by `relPath` before
  rendering (parallel completion order is meaningless to a reader).

## Concurrency configuration (the knob)

Precedence chain, first match wins (mirrors the credential chain):

```
--concurrency 5                        1. CLI flag (publish only), this run
GDRIVE_PUBLISH_CONCURRENCY=4           2. env var — CI, hooks, shell wrappers
.gdrive-publish.json "concurrency": 4  3. per-tree, committed next to the docs
default 3                              4. mid-band of Google's 2–5 band
```

- **Validation is strict** (repo config style): integer **1–10**, anything
  else is a hard error naming the layer (config file / env / flag) — no
  silent clamping. Flag out of range → exit 2.
- **`1` means exactly today's sequential behavior** — escape hatch and A/B
  timing baseline.
- **Max 10 rationale:** above ~5–10 there is no throughput win (latency
  dominates), only 429 provocation — the documented failure mode.
- One value for both phases — two knobs for one workflow is a config smell.
- `plan` is offline and never needs the flag.

## Reporting

- Publish summary gains one line, e.g.:
  `concurrency: 5 → 2 (adaptive, 3 rate-limit events)` — the feedback loop
  for tuning.
- Progress bar switches from item-order to a completed/total counter
  (order is no longer meaningful).

## Tuning guidance (for MANUAL/SKILL when slice 4-ish docs land)

| Tree | Setting |
|---|---|
| ≤ 20 files | leave default 3 — run is Drive-latency-bound, not ours |
| 100+ small docs | try `--concurrency 5` once; no `THROTTLED` note → persist in config |
| images / large workbooks | stay 3 — payload size dominates |
| flaky network / heavy 429s | drop to 1–2, or trust the adaptive halving |

Quotas are per user per project: the datadog and marxworld accounts have
independent buckets, but a single publish run targets one account — the knob
is per-run, not per-account.

## Sequencing

Both slices land **before** the native-markdown slices
(`docs/native-markdown-mode.md`): they reshape the same publish loops, and
doing them first avoids rebasing the native branch over a changed loop
structure.
