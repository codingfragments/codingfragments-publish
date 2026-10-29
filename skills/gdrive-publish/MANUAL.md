# gdrive-publish — skill manual

This manual is for **humans** working in a pi session. It explains what the
`gdrive-publish` skill does, when it activates, what the agent will do on your
behalf, and how to steer or stop it. The [SKILL.md](SKILL.md) in this folder is
the instruction text the *agent* reads — different document, different
audience. The CLI itself has its own [manual](../../extensions/gdrive-publish/MANUAL.md).

## What this skill is

A skill is a instruction pack pi loads for the agent. This one teaches the
agent how to publish a documentation folder to Google Drive using the
`gdrive_publish` tool (registered by the extension) or the CLI — without you
having to explain Drive conversion, link rewriting, manifests or warnings each
time.

What actually gets published, and what the result looks like, is decided by the
`gdrive-publish` core; the skill only governs *how the agent behaves* while
using it.

## When it activates

The agent reaches for it when you ask for things like:

- "publish these docs to Google Drive"
- "make this a Google Doc and share the link"
- "update the Drive copy of the handbook"
- "put the docs where my non-technical colleagues can read them"

It is **not** needed for reading Drive or anything unrelated to publishing.

## What the agent will do

1. **Check readiness** — the `gdrive_publish` tool exists only when the project
   is configured (a `.gdrive-manifest.json` and a cached token). If missing,
   the agent will tell you to run `gdrive-publish login` in a terminal (only
   you can do the browser consent) and then `/gdrive-publish-init <name>`.
2. **Plan first** — it calls the tool with `mode: "plan"`, which is read-only,
   and shows you the outcome, including warnings.
3. **Ask you** — before writing anything, `mode: "publish"` triggers a
   confirmation showing what will be created, updated and trashed.
4. **Remind you to commit the manifest** — `.gdrive-manifest.json` must be
   committed for the next publish to update the same Docs.

## Safety rails, and how to override them

The agent has explicit rules it should not break. If you want one broken,
say so explicitly — the rails are there because the failure modes are silent.

| Rail | Why | Overriding it |
|---|---|---|
| Never `prune: true` unless you asked | Pruning moves Drive files to trash | Say "prune the deleted files too" |
| Never `assumeYes: true` without your approval | Publishing is a write to your Drive | Say "yes, publish it" after seeing the plan |
| Never runs `login` through a tool call | OAuth needs your browser and your token file | Run `gdrive-publish login` yourself |
| Plan before publish | A bad plan is cheap; a bad publish is not | Generally don't |

The extension enforces the second rail independently: in a non-interactive
session the tool refuses to publish without `assumeYes`, and says so in its
result so the agent has to come back to you.

## Worked example

```text
you:    put docs/ on google drive so the team can read it

agent:  (plans, shows:)
        7 to create, 0 to update, 0 orphan(s)
        WARN ANCHOR_DROPPED     toc.md    ./details.md#section-two
        WARN CSV_NORMALISED     data/report.csv  delimiter=';' encoding=latin1
        → okay to publish? the two warnings are expected for this tree.

you:    yes

agent:  (publishes, then:)
        7 created. manifest updated: docs/.gdrive-manifest.json
        → please commit the manifest, then folder link: https://…
```

## Reading the warnings the agent shows you

The full table lives in the [skill file](SKILL.md); the ones you will
actually meet:

- `ANCHOR_DROPPED` — the link works but lands at the top of the target Doc.
- `LINK_OUTSIDE_ROOT` / `LINK_TARGET_MISSING` — the link will be broken in
  Drive; fix the source or move the file into the folder.
- `IMAGE_LARGE` — an image is being embedded as base64; big ones bloat the
  upload.
- `DOC_PAYLOAD_TOO_LARGE` — an **error**: that document is skipped until you
  shrink it.
- `DRIVE_MODIFIED` — someone edited a Doc in Drive; your local version wins
  and theirs is kept in revision history.

## Limits

- Heading anchors are not preserved (links go to the top of the Doc).
- `.xls`/`.xlsx` conversion loses macros and some formatting.
- Images are embedded as copies inside each Doc — re-publishing re-uploads
  them.
- The skill drives the local tool; it cannot see or fix things inside Drive
  itself (permissions, sharing settings beyond the created folder).
