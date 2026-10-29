# gdrive-publish

Publish a folder of markdown, CSV and Excel files to Google Drive as **native
Google types** — markdown becomes Google Docs, CSV/XLSX become Google Sheets —
while **relative links between your files are rewritten to the real Google Doc
URLs**. A `toc.md` linking to `./details.md` becomes a Doc whose link opens the
*details* Doc.

Re-publishing updates the same Drive files in place, so **URLs you shared stay
valid**.

> Status: complete — core library, CLI, and pi extension. All behaviour below
> is verified by `npm test` (offline) and was smoke-tested against a real
> Drive.

## Install

**As a pi package** (extension + skill ship as one unit):

```bash
pi install git:github.com/codingfragments/codingfragments-publish@v0.10.1
```

(From v0.10.1 on; the npm versions ≤ 0.10.0 were published from the original
monorepo and carry the extension but not the packaged skill.)

**As a standalone CLI:**

```bash
npm i -g gdrive-publish
```

## Using it from pi

The `gdrive_publish` tool is **inert unless this project is set up for
publishing**: it is registered only when the working directory (or an ancestor,
up to the repo root) has a `.gdrive-manifest.json` *and* a cached OAuth token
exists. Sessions in unrelated repositories never see a tool that can write to
Drive.

| Situation | What is registered |
|---|---|
| unrelated directory | `/gdrive-publish-init`, `/gdrive-publish-status` only |
| manifest present, not authenticated | the same two commands only |
| manifest + token present | additionally the `gdrive_publish` tool |

```text
/gdrive-publish-status                 # what is missing, and why
/gdrive-publish-init Project X Docs    # create the Drive folder + manifest
/reload                                # picks up the now-registered tool

gdrive_publish { mode: "plan" }        # read-only, never prompts
gdrive_publish { mode: "publish" }     # asks for confirmation first
```

Writes are confirm-gated: in an interactive session `publish` shows the
create/update/orphan counts via `ctx.ui.confirm`, and in a non-interactive
session it **refuses** unless `assumeYes: true` is passed explicitly. The
accompanying [skill](../../skills/gdrive-publish/SKILL.md) tells the agent to
plan first, to never prune unasked, and how to explain each warning.

## How it works

Publishing is two-phase, which is what makes link rewriting possible at all:

```
phase 0  scan the tree, build the link graph, run the full offline
         link/image analysis                            (no network)
phase 1  create folders; create EMPTY Doc shells for each .md;
         convert-upload CSV/XLSX  -> every fileId is now known
         -> manifest checkpointed with `pending` markers
phase 2  rewrite relative links to real Doc/Sheet URLs, inline images,
         fill content via files.update  -> fileIds (and URLs) unchanged
phase 3  final manifest write + report
```

`plan` and `publish --dry-run` run phase 0 only and report exactly the
diagnostics a real publish would, so the preview never understates the outcome.

Drive cannot pre-allocate ids for Workspace types (`files.generateIds` does not
support convert-on-upload), so a single-pass "rewrite then upload" is
impossible. Phase 1 exists purely to learn the ids.

## Install / auth

Distributed as the zero-dependency npm package `gdrive-publish` (Node >= 20;
ships compiled JS in `dist/` while the TypeScript sources stay for pi and
monorepo use):

```bash
npx gdrive-publish login      # zero-install, one-time browser consent
npm i -g gdrive-publish       # or install once; scope: drive.file
```

Run straight from the monorepo without any install:

```bash
node extensions/gdrive-publish/cli.ts login
```

Installing it as a pi package (`pi install npm:gdrive-publish`) registers the
extension; never do that on a machine that also loads this monorepo via static
paths - see the repo README's double-load warning.

Credentials are resolved in this order, and the chosen source is reported by
**name** — never by value:

1. `GDRIVE_PUBLISH_CLIENT_ID` + `GDRIVE_PUBLISH_CLIENT_SECRET`
2. `GDRIVE_PUBLISH_CLIENT_SECRET_FILE=/path/to/client_secret.json`
3. `~/.config/gdrive-publish/client_secret.json`
4. an rclone drive remote (`GDRIVE_PUBLISH_RCLONE_REMOTE=name`, or the only one)

Tokens are cached per client identity as
`~/.config/gdrive-publish/token-<sha256(client_id)[0:8]>.json` (mode 0600), so
switching credential sources costs one extra consent instead of an opaque
`invalid_client` error.

## Usage

The command surface is defined once in `commands.ts` and rendered everywhere
(`gdrive-publish help`, `help <command>`, `<command> --help`, strict flag
validation, and the generated reference in the manual), so help cannot drift
from behaviour:

```bash
gdrive-publish help              # overview
gdrive-publish help publish      # flags, examples, exit codes for one command
```

Every command except `login` is fully non-interactive and scriptable from CI
and git hooks. The task-oriented guide (first publish, day-two workflows,
troubleshooting) is the [manual](MANUAL.md).

## Ignoring content (opt-out)

`ignorePatterns` in the same `.gdrive-publish.json` excludes content from
publishing altogether:

```json
{ "ignorePatterns": ["_*", "secrets.md", "drafts/**"] }
```

The same glob engine as `rawPatterns`, but inverted: a matching file never
publishes - **including native types** (`secrets.md` is genuinely excluded,
not published) and never warns as unsupported. A matching directory is
pruned whole - its subtree is never even walked, so `_*` cleanly excludes
underscore trees like `_drafts/` at any depth. Ignored is stronger than
raw: an ignored file never uploads as a raw file either.

Files that were published *before* falling under a pattern become
**orphans**: `plan` reports them, and they leave Drive only through an
explicit `publish --prune` (trash, like any orphan) - nothing disappears
silently.

## Raw uploads (opt-in)

Files whose type has no native Drive conversion (no `markdown`→Doc, no
`csv`/`xlsx`→Sheet) can still be published **as raw binary uploads** -
stored as-is in Drive under their exact filename, updated in place with
stable ids, and linkable from your markdown (links rewrite to
`https://drive.google.com/file/d/<id>/view`).

This is strictly opt-in per pattern, via `.gdrive-publish.json` next to
your docs (committed like the manifest):

```json
{ "rawPatterns": ["*.zip", "data/*.json", "archives/**"] }
```

Glob semantics follow `.gitignore` intuition: patterns without `/` match
the basename at any depth, patterns with `/` are anchored to the root,
`**` spans segments. A pattern can never hijack a native type - `*.json`
will not touch a `.csv`. Without a config, nothing new ever leaves the
machine; the default is still skip-with-warning.

Images are claimable too - a `*.png` pattern uploads them as raw files
**in addition to** their embedding into Docs (embeds always inline from
disk, because Drive URLs do not render in converted Docs). Unreferenced,
unclaimed images produce an `IMAGE_UNREFERENCED` warning instead of being
silently dropped.

`gdrive-publish plan docs/` prints a tip when unsupported files exist, and
`plan docs/ --suggest-config` creates or extends the config with patterns
derived from the extensions actually found (merging, never removing), then
shows the file and the resulting plan - verify the patterns before the
next run. The suggestion also cautions when a derived pattern looks
credential-adjacent (`.env`, `.pem`, `id_rsa`, …).

## The manifest

`.gdrive-manifest.json` sits next to your docs and **should be committed** — it
is the identity map from source path to Drive fileId, and therefore the reason
URLs stay stable for everyone. `publish` never touches git; it just tells you
the file changed.

It is written via temp-file + atomic rename, and checkpointed after phase 1
with `pending: true` entries. If a run dies between creating shells and filling
them, the next run fills those exact Docs instead of creating duplicates.

## Behaviour worth knowing

| Input | Result |
|---|---|
| `[x](./other.md)` | rewritten to the other file's Doc URL |
| `[x](./data.csv)` | rewritten to the Sheet URL |
| `[x](./other.md#section)` | links to the top of the Doc, anchor dropped (warned) |
| `[x](../outside.md)` | left verbatim (warned) — outside the publish root |
| `[x](https://…)` | untouched |
| `[x](./missing.md)` | left verbatim (warned) |
| links inside ``` fences / `code spans` | never rewritten |
| `![img](./pic.png)` | **inlined as a base64 `data:` URI** so Drive embeds a real copy |
| YAML front matter | stripped (Drive mangles it); `title:` becomes the Doc name |
| Doc name | front-matter `title` → first H1 → filename stem |
| `.csv` | dialect + encoding sniffed, normalised to UTF-8 comma CSV, then converted |
| `.xlsx` / `.xls` | uploaded as-is and converted (macros/formatting lost, warned) |
| unsupported files (`.txt`, `.zip`, `.json`, …) | skipped with a warning, **or** uploaded as raw files when matched by a `rawPatterns` entry in `.gdrive-publish.json` |
| local file deleted | reported as an orphan; only `--prune` removes it, and only to **trash** |
| file changed in Drive | local content wins, loud warning naming the editor (Drive keeps revision history) |

### Why images are inlined

The obvious approach — upload the image, share it, link to
`drive.google.com/uc?export=view&id=…` — **cannot work** on a Workspace that
blocks anyone-with-link sharing: `POST /permissions {type:"anyone"}` fails with
`publishOutNotPermitted`, and Drive's importer fetches image URLs
*anonymously*, so even domain-shared images render as a 1×1 placeholder.
Base64 `data:` URIs embed byte-identical images with no permissions at all.
See `spike/FINDINGS.md`.

Guardrails: a warning above 2 MB per image, and a hard error above 10 MB of
prepared document payload (base64 inflates by ~33%).

## Scope and blast radius

Only `https://www.googleapis.com/auth/drive.file` is requested: the tool can
only see files it created itself. `init` creates its own root folder, which you
can then move and share freely in Drive — access survives the move (verified).
Nothing is ever hard-deleted; `--prune` uses trash.

## Tests

```bash
npm test          # 118 tests, offline, no credentials, ~2s
npm run typecheck # 0 errors
npm run lint      # biome
```

CI (`.github/workflows/ci.yml`) runs all three on Node 24 for every push and
pull request. Node 24 is required because everything here is plain TypeScript
executed through Node's native type stripping - there is no build step.

| Suite | Tests | What it guards |
|---|---|---|
| `links.test.ts` | 10 | link/image parsing; never rewriting inside fenced blocks or inline code spans |
| `csv-naming.test.ts` | 12 | encoding/delimiter sniffing, quoting, front matter, Doc naming |
| `scan-prepare.test.ts` | 20 | file classification, ignore rules, path-escape refusal, image inlining, size caps, plan-time analysis mode |
| `auth.test.ts` | 13 | credential-chain precedence, the `GOCSPX-`/`rclone reveal` rule, per-client token keying |
| `drive-manifest-report.test.ts` | 18 | exact REST request shapes, error-reason parsing, atomic/sorted manifest IO, report rendering |
| `publish.test.ts` | 17 | two-phase ordering, update-in-place, crash recovery, orphan safety, trash-not-delete, diagnostic dedupe |
| `cli.test.ts` | 18 | exit-code contract (0/1/2/3), `--json` shape, dry-run purity, plan/publish diagnostic parity, secrets never printed |
| `extension.test.ts` | 10 | the tool is registered only in configured projects; writes are confirm-gated |

The Drive REST layer is tested by swapping `globalThis.fetch`, so request
shapes are asserted without network access; `auth.ts` is tested with a stub
`rclone` on `PATH`; the CLI is tested as a real subprocess because exit codes
are the contract for CI and git hooks.

### Manual sandbox

[`sandbox/docs`](../../sandbox/README.md) is a committed, deliberately awkward
doc tree (cross-type links, anchors, escapes, code-fenced links, a latin-1
semicolon CSV, an xlsx, an obvious test image) for publishing to a real Drive
and inspecting by hand. Its README documents the exact plan output to expect,
so a missing warning is visibly a regression.

### Deliberate gaps

- **No live Drive tier in CI.** Nothing automatically verifies Google's actual
  behaviour, so the fake `DriveClient` can drift. Publish `sandbox/docs` and
  look at the result before releasing anything that touches upload or
  conversion.
- **Image embedding must be verified by rendering** (export PDF -> rasterise ->
  inspect pixels). An `<img>` tag, an `![]()` construct, or a `word/media/*`
  part in a docx export all report success on a document that is visibly
  blank - three false positives that a human eye caught during the spike.
- **Heading anchors** are dropped rather than resolved to Google Docs heading
  ids.
- **`--repair`** is not implemented: an inaccessible or trashed Drive file
  produces a `DRIVE_FILE_GONE` error instead of being recreated.

## Layout

```
core/       pure logic, zero pi imports, injectable DriveClient
  auth.ts       credential chain, token cache, loopback consent
  drive.ts      DriveClient interface + REST implementation
  links.ts      link parsing/rewriting (code-fence aware)
  naming.ts     front matter + Doc naming
  csv.ts        dialect sniffing (row-consistency based) + normalisation
  prepare.ts    front-matter stripping, link rewriting, image inlining
  publish.ts    planner + two-phase publisher
  manifest.ts   atomic, sorted, checkpointed manifest IO
  report.ts     text and JSON rendering
cli.ts      non-interactive CLI
index.ts    pi extension: readiness gating, typed tool, confirm prompts
test/       offline suite + fake Drive client
```
