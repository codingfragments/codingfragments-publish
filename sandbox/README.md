# gdrive-publish sandbox

A deliberately awkward documentation tree for exercising
[`gdrive-publish`](../README.md) by hand, against a
real Google Drive. The offline test suite uses its own throwaway fixtures; this
tree exists so a human can publish something and *look* at the result — which
is how the image-embedding bug was eventually caught.

## Use it

```bash
cd sandbox/docs

# 1. see what would happen — no network, no writes
node ../cli.ts plan .

# 2. once per sandbox: create the Drive folder + manifest
node ../cli.ts init . --name "gdrive-publish sandbox"

# 3. publish for real
node ../cli.ts publish .

# 4. re-run: everything should report "unchanged" and no fileId may change
node ../cli.ts publish .
```

The generated `.gdrive-manifest.json` is **gitignored here** on purpose: it
would pin the sandbox to one person's Drive folder. In a real project you
commit it.

## What to check in Drive

| Open | Expect |
|---|---|
| `Sandbox Handbook` (from `toc.md`) | front matter gone, title used as the Doc name; the first four links open the corresponding Docs; the two data links open **Sheets** |
| the code block in the handbook | `[this must NOT be rewritten](./details.md)` still literal, and the inline-code link untouched |
| `Nested Intro` | a red/yellow checkerboard image renders inline; the missing image is left as literal text |
| `Details` | table, fenced code, nested list and blockquote survived |
| `report` Sheet | three real columns (`Spalte 1`, `Spalte 2`, `Notiz`), not one mangled column — the source is semicolon-delimited **latin-1** |
| `book` Sheet | `region/q1/q2` with numeric values, sheet named `Numbers` |

## Expected plan output

`plan` is offline and must report every one of these before you publish:

```
  + data/book.xlsx      -> Sheet "book"
  + data/clean.csv      -> Sheet "clean"
  + data/report.csv     -> Sheet "report" (delimiter=';' encoding=latin1 -> normalised)
  + details.md          -> Doc "Details"
  + guide/deeper/note.md-> Doc "Deep Note"
  + guide/intro.md      -> Doc "Nested Intro"
  + toc.md              -> Doc "Sandbox Handbook"

  WARN UNSUPPORTED_FILE   notes.txt
  WARN IMAGE_MISSING      guide/intro.md   ../img/nope.png
  WARN FRONTMATTER_STRIPPED toc.md
  WARN ANCHOR_DROPPED     toc.md           ./details.md#section-two
  WARN LINK_OUTSIDE_ROOT  toc.md           ../outside.md
  WARN LINK_OUTSIDE_ROOT  toc.md           /etc/hosts
  WARN LINK_TARGET_MISSING toc.md          ./does-not-exist.md
  WARN LINK_TO_UNSUPPORTED toc.md          ./notes.txt
```

If a warning is missing, that is a regression — the dry run is the review
surface and must not understate what publishing will do.

## What each file is for

| File | Exercises |
|---|---|
| `toc.md` | front matter, both relative link spellings, cross-type links, anchors, escapes, absolute paths, missing targets, unsupported targets, external links, reference-style links, links inside fenced and inline code |
| `details.md` | tables, fenced code, nested lists, blockquote, backlink |
| `guide/intro.md` | nested directory, parent-relative links, image inlining, missing image |
| `guide/deeper/note.md` | two-level nesting and upward links |
| `data/report.csv` | semicolon-delimited latin-1 CSV with commas and quotes inside fields (the "German Excel export" case) |
| `data/clean.csv` | already-canonical CSV, must be reported as *not* normalised |
| `data/book.xlsx` | native workbook conversion, including a named sheet |
| `img/checkerboard.png` | an image obvious enough to judge by eye |
| `notes.txt` | unsupported file type, and a link target that exists but is not published |

## Cleaning up

Publishing creates real Drive files. To remove them: delete the local files and
run `publish . --prune` (which moves them to **trash**, never hard-deletes), or
drag the folder to the trash in Drive and delete `.gdrive-manifest.json`.
