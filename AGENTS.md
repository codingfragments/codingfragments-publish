# AGENTS.md — gdrive-publish / codingfragments-publish

This file is loaded automatically by pi when working in this repository. It
gives an agent (or a human) enough context to build, test, and ship changes
without re-discovering the project's shape from scratch.

## What this repo is

The standalone home of **gdrive-publish**: a CLI and a pi extension that
publishes a folder of markdown/CSV/XLSX files to Google Drive as native Google
Docs and Sheets, rewriting relative links between them into real Doc URLs.
Extracted from codingfragments/pi-extensions (v0.10.0); npm versions ≤ 0.10.0
were published from there, this repo publishes from 0.10.1 on.

Layout:

| Path | Contents |
|---|---|
| `cli.ts` | CLI entry (non-interactive except `login`) |
| `commands.ts` | Single source of truth for the command table, help text, `VERSION` |
| `index.ts` | pi extension: registers the `gdrive_publish` tool + slash commands |
| `core/` | Publishing engine — no pi imports, no network beyond Drive REST |
| `test/` | Offline suite (`node --test`); `fake-drive.ts` is the Drive double |
| `skills/gdrive-publish/` | The pi skill, shipped with the package (`pi.skills`) |
| `docs/` | Design docs (locked plans for future features) |
| `spike/` | The original Drive-API probe + findings — archaeology, not product code |
| `sandbox/` | Manual live-Drive testing tree (has its own manifest) |

## Rules that bind every agent session

1. **Plan before implementing.** A plan or selected option is NOT permission
   to code. Wait for an explicit "go ahead" for the task at hand.
2. **Gitflow:** every change on a `feat/…`/`fix/…`/`chore/…`/`docs/…` branch
   off `main`, squash-merged via PR. Never commit to `main` directly (the
   initial scaffold commit was the one-time exception).
3. **No push of any ref without explicit consent in that turn.** Creating a
   PR is a push. Local commits on a work branch are fine.
4. **Releases are doubly gated:** consent to merge the version bump, then a
   separate consent to push the tag — the tag push publishes to npm via
   Trusted Publishing.
5. **Version discipline:** the version lives in `package.json` AND
   `commands.ts` `VERSION` — a test enforces they match; the release workflow
   enforces tag = version. Bump via a `chore/…` PR, regenerate MANUAL.md
   (`npm run docs:cli`) in the same PR.

## Build / test / lint

```bash
npm install          # dev deps only (biome, typescript, @types/node)
npm run lint          # biome check .
npm run typecheck     # tsc --noEmit
npm test              # node --test test/*.test.ts  (offline, no credentials)
npm run docs:cli      # regenerate MANUAL.md's CLI reference section
npm run build         # compile dist/ (what the npm tarball ships)
```

- Node 24 required: plain TypeScript runs via native type stripping
  (`node:assert`'s suite included); no build step for tests.
  **Parameter properties in constructors are not supported** — declare fields
  explicitly.
- `test/docs.test.ts` regenerates the CLI reference and compares with the
  committed MANUAL.md: after ANY change to `commands.ts`, run
  `npm run docs:cli` or CI fails.
- The full suite must pass before a release; the release workflow runs it
  again.
- Live-Drive tests are opt-in (`GDRIVE_PUBLISH_E2E=1`) and never run in CI.

## Code conventions

- `core/` stays free of pi imports and of side effects beyond what is passed
  in — the same logic backs the CLI and the extension.
- Error contract: one item's Drive failure is a `PUBLISH_FAILED` diagnostic
  (run continues); only non-Drive failures abort. Don't weaken this.
- Manifest discipline: fileIds are the product's identity — update in place,
  never recreate silently. Checkpoint after every manifest mutation.
- Diagnostics codes are stable identifiers: never rename one.
- Security: extensions run with full system permissions. Never log secrets
  or token values; credential resolution reports sources by NAME only.

## Release checklist

1. `chore/<version>` PR: bump `package.json` + `commands.ts`, `npm run
   docs:ci`, merge (with consent).
2. Create signed annotated tag `v<version>` on the merge commit.
3. Push the tag (separate consent!) → `release.yml` runs tests, builds,
   checks tag=version, `npm publish` via Trusted Publishing.
4. Trusted Publishing is registered on npmjs.com for:
   repository `codingfragments/codingfragments-publish`, workflow `release.yml`.

## Historical note

Design docs and tag history for v0.1.0–0.10.0 live in the original monorepo
(codingfragments/pi-extensions, tags `gdrive-publish-v*`). This repo's own
history starts at the extraction; versions continue from 0.10.1.
