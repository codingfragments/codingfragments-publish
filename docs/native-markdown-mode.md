# Design: `markdownMode: "native"` for gdrive-publish

Status: **planned, not implemented** — decisions locked 2026-10-24. Each implementation
slice lands as a branch + PR off `main`; nothing merges without review.

## Background

Google Drive (Docs Markdown Mode) now natively previews, edits, and supports
commenting on `.md` files without converting them to Google Docs (rollout from
2026-10-05). gdrive-publish currently uploads markdown as `text/markdown`
through Drive's convert-on-import path, producing a real Google Doc
(`application/vnd.google-apps.document`).

Native mode publishes `.md` files as raw Drive markdown files instead:
byte-perfect round-trip, local file remains the source of truth, no conversion
losses.

Scope decisions below were chosen explicitly from options (front matter,
images, mode-switch policy, anchors) — recommendations accepted 2026-10-24.

## Goal & non-goals

**Goal:** a per-tree opt-in mode where `.md` files publish as native Drive
markdown files (preview/edit/comment in Docs' Markdown Mode). Default stays
`doc`.

**Non-goals:** CSV/XLSX behavior (Sheets conversion unchanged), local images
as separate Drive files, three-way merge with remote edits, the Docs API
`batchUpdate` path (raw `files.update` media replacement is the mechanism).

## Behavior spec (locked decisions)

| Aspect | Decision |
|---|---|
| Default | `"doc"` — zero behavior change for every existing tree |
| Mode scope | Per publish root (whole tree), stamped into the manifest at `init`, enforced at `publish` |
| Mode switch on a published tree | **`MODE_MISMATCH` hard error** — points at the deliberate path: delete manifest + Drive folder, re-init |
| Front matter | **Stripped** in both modes (title → file name; YAML renders as junk otherwise) |
| Local images (relative paths) | **Warn (`MD_NATIVE_IMAGE_LOCAL`) + leave as-is** — no upload/rewrite in this iteration; warning names the options (remote URL, prose reference, or switch that tree to doc mode) |
| Remote images (`https://…`) | Left untouched, no diagnostic — viewer may render them browser-side; we claim nothing either way |
| Heading anchors (`#fragment`) | **Kept** — fragment appended to the rewritten file URL; `ANCHOR_UNVERIFIED` info diagnostic once per publish |
| CSV/XLSX / `rawPatterns` | Unchanged |
| `DOC_PAYLOAD_TOO_LARGE` | Not applied on the native path (raw media upload has no 10 MB Docs cap) |
| Manifest discipline | Unchanged — fileIds stay stable across re-publishes, shared URLs survive |
| Two-phase crash recovery | Unchanged — reserved 0-byte `.md` shells are as resumable as Doc shells (`PENDING_RESUMED`) |

## Change map

| File | Change |
|---|---|
| `core/config.ts` | `PublishConfig` + `markdownMode?: "doc" \| "native"`; extend unknown-key validation; export `effectiveMode(config)` defaulting to `doc` |
| `core/types.ts` | `Manifest` gains `markdownMode?`; new `DiagnosticCode`s (below) |
| `core/drive.ts` | One new `DriveClient` method: `createEmptyFile(name, mimeType, parentId)` — metadata-only `files.create` (0-byte shell, mirroring `createEmptyDoc`). Fill via existing `updateMedia(fileId, "text/markdown", bytes)`. `convertUpload` untouched |
| `core/scan.ts` | None — classification unchanged |
| `core/prepare.ts` | Native branch: strip front matter, rewrite links, **no base64 image inlining** |
| `core/links.ts` | Native replacer appends `splitAnchor`'s fragment to the target URL instead of dropping it |
| `core/publish.ts` | Branch point: native `markdown` items reserve via `createEmptyFile(name, "text/markdown", …)` in phase 1, fill via `updateMedia` in phase 2 — parallel to the Doc shell flow |
| `cli.ts` | `init` gains `--markdown-mode <doc\|native>` (stamps manifest + writes config); `plan`/publish output shows the mode |
| `commands.ts` | Flag specs + help text (single source for help, per repo convention) |
| `test/fake-drive.ts` | Stub for `createEmptyFile` alongside unit tests per slice |
| `README.md` / `MANUAL.md` / `skills/gdrive-publish/SKILL.md` | Mode knob, new warning-table rows, availability caveat |

## New diagnostics

- `MD_NATIVE_IMAGE_LOCAL` — **warn**: a local relative image link cannot resolve in the Drive viewer
- `MODE_MISMATCH` — **error**: manifest mode ≠ config mode
- `ANCHOR_UNVERIFIED` — **info**: fragment preserved; Markdown Mode scrolling unconfirmed

## Implementation slices (each = branch + PR, in order)

1. **`feat/gdrive-native-md-config`** — config field, validation, mode resolver,
   manifest stamping, `--markdown-mode` flag, plan output, `MODE_MISMATCH`
   guard. Inert until mode=native is set.
2. **`feat/gdrive-native-md-client`** — `createEmptyFile` on `DriveClient` +
   `RestDriveClient` (+ fake stub).
3. **`feat/gdrive-native-md-publish`** — prepare/links branches + publish
   two-phase branch + new diagnostics + unit tests.
4. **`docs/gdrive-native-md`** — README, MANUAL.md, SKILL.md updates.

## Sequencing note

**Slice 3 should not ship without the availability probe:** confirm on the
target Workspace accounts (right-click an `.md` in Drive → Open with →
Preview) that native Markdown Mode is live. If it isn't, uploads still work
but users get raw files without the nice viewer — must be known before docs
promise it.

## Known unknowns (accepted risks, verify before/with slice 3)

- Anchor scrolling (`#fragment` → scroll) in Markdown Mode — unverified
- Front matter rendering (decision: strip, so low risk)
- Comment round-tripping through Markdown Mode
- Feature availability per account/Workspace admin policy

None block the design; worst case they degrade to warnings. They shape the
final diagnostic wording.

## Related, deliberately parked

- Test harness & stress-test plan for the native path (fake-drive extension,
  scratch-account integration harness, record/replay for CI, nightly canary)
  — discussed 2026-10-24, to be designed separately.
