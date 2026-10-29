# Spike findings — gdrive-publish import behaviour

- date: 2026-09-18T10:18:52.038Z
- credential source: rclone remote "gdriveDD" (client_id hash `d57c1eab`)
- scope granted: `https://www.googleapis.com/auth/drive.file`
- probe: `spike/probe.ts` on branch `spike/gdrive-import-probe`

| Unknown | Verdict |
|---|---|
| U2: empty Doc → files.update media keeps fileId and replaces body | **PASS** |
| U3: importer keeps absolute links, tables, code blocks, lists, front matter | **PASS** |
| U4: uc?export=view&id= images embed in Docs | **PARTIAL** |
| U5: CSV/XLSX convert to Sheets; Sheet re-publish keeps id | **PASS** |
| U6: two-phase publish rewrites relative links to sibling Doc URLs | **PASS** |
| U7: which image strategy actually embeds (docx media-part count) | **PASS** |
| U1: drive.file folders nest + access survives move/rename | **PASS** |

## U2: empty Doc → files.update media keeps fileId and replaces body — PASS

- fileId and Google-Doc mimeType unchanged after files.update media
- body replaced by markdown content

Evidence:

- doc: https://docs.google.com/document/d/1TF5uSlg0CMfCJRqRBj5g9hk_UHNJlfUo0QelaqWuVYw/edit
- export before update (0 chars) vs after (49 chars) — see appendix

## U3: importer keeps absolute links, tables, code blocks, lists, front matter — PASS

- survived: absolute link to another Doc, external http link, table structure, fenced code block, heading, list items
- front matter does NOT survive — it becomes a mangled heading ("---\n\n## title: Fidelity Fixture author: probe\n\n# Fidelity Fi"); PR2 must strip front matter and use its title for the Doc name

Evidence:

- doc: https://docs.google.com/document/d/1kZNexH7XiUOX1p58aj3BEbQzThICRl9wpGE78p8vNeY/edit

## U4: uc?export=view&id= images embed in Docs — PARTIAL

- NO permission variant worked under drive.file:
- variant {anyone, reader}: Error: POST https://www.googleapis.com/drive/v3/files/1cp1BHtGZwRqaEYpJzXH7nY9eGh6kHRio/permissions -> 400: {
  "error": {
    "code": 400,
    "message": "Bad 
- variant {anyone, reader, allowFileDiscovery:false}: Error: POST https://www.googleapis.com/drive/v3/files/1cp1BHtGZwRqaEYpJzXH7nY9eGh6kHRio/permissions -> 400: {
  "error": {
    "code": 400,
    "message": "Bad 
- variant {anyone, reader} + supportsAllDrives=true: Error: POST https://www.googleapis.com/drive/v3/files/1cp1BHtGZwRqaEYpJzXH7nY9eGh6kHRio/permissions?supportsAllDrives=true -> 400: {
  "error": {
    "code": 40
- export shows googleusercontent.com image reference — image appears embedded
- NOTE: programmatic check is via export text; final judgement needs a manual look at the Doc

Evidence:

- image file: https://drive.google.com/file/d/1cp1BHtGZwRqaEYpJzXH7nY9eGh6kHRio/view
- local copy of the same PNG for comparison: /var/folders/s4/l3lqm1pn66s137jygzdr657c0000gp/T/gdrive-spike-test-image.png
- doc for manual check: https://docs.google.com/document/d/19WRZifJbNYbDEBH83rLak2F_6Ka_8phvBIfvslqwYsM/edit

## U5: CSV/XLSX convert to Sheets; Sheet re-publish keeps id — PASS

- clean UTF-8 comma CSV converts to a well-formed Sheet
- Sheet re-published via files.update media works (id stable, content replaced)
- Drive auto-detected the semicolon dialect (no mangling) — better than expected
- latin1 content check: appendix export shows 'Wert 1' intact only if encoding survived
- hand-crafted xlsx converted to Sheet with values intact
- xlsx target is a native Spreadsheet

Evidence:

- clean sheet: https://docs.google.com/spreadsheets/d/17qar8jUnP5HtdJPyt4uQ6I8BnQBObBt3teFUA0P6Nno/edit
- messy sheet: https://docs.google.com/spreadsheets/d/1Lt5E8uyHKlS0ZaTs1MbIW54sqc3LwBy1P5Gc8xduu_o/edit
- xlsx sheet: https://docs.google.com/spreadsheets/d/1hgkqykPCcl6TRsBbF44FgOWDz0pPwpeLkpx7UDMaoUk/edit

## U6: two-phase publish rewrites relative links to sibling Doc URLs — PASS

- toc Doc contains the details fileId 2 time(s) (expected 2: "./details.md" and "details.md")
- details Doc links back to the toc Doc — bidirectional rewriting works
- this is the original user requirement proven end to end: a relative markdown link resolves to the sibling Google Doc

Evidence:

- toc Doc (click the links): https://docs.google.com/document/d/1-hNPT4neBBskRJSiT5tN7An_wqI2_joWViOnNOJf9dQ/edit
- details Doc: https://docs.google.com/document/d/1AqoQPMhbHpT-td6sf22VqoPy1upya28-Y9RukG_dCZg/edit

## U7: which image strategy actually embeds (docx media-part count) — PASS

- account domain detected: datadoghq.com
- permission type=anyone FULL ERROR: Error: POST https://www.googleapis.com/drive/v3/files/1wozFJY4PBg7y-VbI33f2XMsrEMakEPAx/permissions -> 400: {
  "error": {
    "code": 400,
    "message": "Bad Request. User message: \"\"",
    "errors": [
      {
        "message": "Bad Request. User message: \"\"",
        "domain": "global",
        "reason": "publishOutNotPermitted"
      }
    ]
  }
}

- permission type=domain (datadoghq.com): OK
- A markdown + uc? URL: 1 embedded image(s)
- B markdown + data: URI: 1 embedded image(s)
- C html + data: URI: 1 embedded image(s)
- D html + uc? URL: 1 embedded image(s)
- at least one strategy embeds a real image (see counts above)

Evidence:

- A markdown + uc? URL: https://docs.google.com/document/d/1C4xB9YWe0_0myy_GR9ftKr5dpxzcHphm3pRS03STios/edit
- B markdown + data: URI: https://docs.google.com/document/d/19SLUxzWFW_-iOsVywtIBvXuFTzm6QqRxXMokvsembLM/edit
- C html + data: URI: https://docs.google.com/document/d/1AUX59LZ5cMD7e68266g9ekLKjnyzMZt5SvMH8sS9Sh8/edit
- D html + uc? URL: https://docs.google.com/document/d/17uFkB4OGXg-zanXVVbpYTAejWbaUiSVogKbH13ejM-Y/edit

## U1: drive.file folders nest + access survives move/rename — PASS

- created root folder + 2 nested levels under My Drive root (ids …p6SRf_, …iHSx_Y, …e5-ale)
- after parent move + rename, get and files.update inside the tree still work

Evidence:

- root: https://drive.google.com/drive/folders/1CSTBmXu-39SPWdjHRSgTKKy9rqp6SRf_
- root folder after move+rename: https://drive.google.com/drive/folders/1CSTBmXu-39SPWdjHRSgTKKy9rqp6SRf_

## Appendix — raw exports

### U2: export of empty Doc (before update)

````text

````

### U2: export after update

````text
# Target Doc

This doc exists to be linked at.  

````

### U3: exported fidelity doc

````text
---

## title: Fidelity Fixture author: probe

# Fidelity Fixture

See the [target doc](https://docs.google.com/document/d/1TF5uSlg0CMfCJRqRBj5g9hk_UHNJlfUo0QelaqWuVYw/edit) for the linked object. An external link to [Google](https://www.google.com) should also survive.

## Table

| col1 | col2 |
| :---- | :---- |
| a | b |

## Code

```ts
const x: number = 42; // code fence
```

Inline `code` and a list:

- one  
- two

Anchor link: [section](#table)  

````

### U4: exported image doc (markdown)

````text
# Image Embed Test

Below this line there should be a **large 480x320 image**: a red/yellow checkerboard with a black border and a white diagonal stripe.

![test image]()

If you see the checkerboard, remote images are embedded by the importer. If you see a broken image or nothing, the fallback design applies.  

````

### U4: exported image doc (html)

````text
<html><head><meta content="text/html; charset=UTF-8" http-equiv="content-type"></head><body class="doc-content" style="background-color:#ffffff;max-width:468pt;padding:72pt 72pt 72pt 72pt"><h1 id="h.66ud7z1h29eu" style="padding-top:20pt;margin:0;color:#000000;padding-left:0;font-size:20pt;padding-bottom:6pt;line-height:1.15;page-break-after:avoid;font-family:&quot;Arial&quot;;orphans:2;widows:2;text-align:left;padding-right:0"><span style="color:#000000;font-weight:400;text-decoration:none;vertical-align:baseline;font-size:20pt;font-family:&quot;Arial&quot;;font-style:normal">Image Embed Test</span></h1><p style="padding:0;margin:0;color:#000000;font-size:11pt;font-family:&quot;Arial&quot;;line-height:1.15;orphans:2;widows:2;text-align:left"><span>Below this line there should be a </span><span style="font-weight:700">large 480x320 image</span><span style="color:#000000;font-weight:400;text-decoration:none;vertical-align:baseline;font-size:11pt;font-family:&quot;Arial&quot;;font-style:normal">: a red/yellow checkerboard with a black border and a white diagonal stripe.</span></p><p style="padding:0;margin:0;color:#000000;font-size:11pt;font-family:&quot;Arial&quot;;line-height:1.15;height:11pt;text-align:left"><span style="color:#000000;font-weight:400;text-decoration:none;vertical-align:baseline;font-size:11pt;font-family:&quot;Arial&quot;;font-style:normal"></span></p><p style="padding:0;margin:0;color:#000000;font-size:11pt;font-family:&quot;Arial&quot;;line-height:1.15;orphans:2;widows:2;text-align:left"><img></p><p style="padding:0;margin:0;color:#000000;font-size:11pt;font-family:&quot;Arial&quot;;line-height:1.15;height:11pt;text-align:left"><span style="color:#000000;font-weight:400;text-decoration:none;vertical-align:baseline;font-size:11pt;font-family:&quot;Arial&quot;;font-style:normal"></span></p><p style="padding:0;margin:0;color:#000000;font-size:11pt;font-family:&quot;Arial&quot;;line-height:1.15;orphans:2;widows:2;text-align:left"><span style="color:#000000;font-weight:400;text-decoration:none;vertical-align:baseline;font-size:11pt;font-family:&quot;Arial&quot;;font-style:normal">If you see the checkerboard, remote images are embedded by the importer. If you see a broken image or nothing, the fallback design applies.</span></p><p style="padding:0;margin:0;color:#000000;font-size:11pt;font-family:&quot;Arial&quot;;line-height:1.15;orphans:2;widows:2;height:11pt;text-align:left"><span style="color:#000000;font-weight:400;text-decoration:none;vertical-align:baseline;font-size:11pt;font-family:&quot;Arial&quot;;font-style:normal"></span></p></body></html>
````

### U5: clean csv export

````text
a,b
1,2
````

### U5: clean csv export after re-publish

````text
a,b
9,9
````

### U5: messy (semicolon/latin1/BOM) csv export

````text
ÿSpalte 1,Spalte 2
Wert 1,Wert 2
````

### U5: xlsx export (first sheet as csv)

````text
col1,col2,col3
1,2,3
````

### U6: exported toc Doc

````text
# Table of contents

See [the details](https://docs.google.com/document/d/1AqoQPMhbHpT-td6sf22VqoPy1upya28-Y9RukG_dCZg/edit) for specifics. And [details again](https://docs.google.com/document/d/1AqoQPMhbHpT-td6sf22VqoPy1upya28-Y9RukG_dCZg/edit) written without the ./ prefix.  

````

### U6: exported details Doc

````text
# Details

Back to [the toc](https://docs.google.com/document/d/1-hNPT4neBBskRJSiT5tN7An_wqI2_joWViOnNOJf9dQ/edit).  

````

---

## Conclusions (post-run analysis — design impact for PR 2)

All five load-bearing assumptions were verified against the live Drive API
under scope `drive.file` with the rclone `gdriveDD` OAuth client (client_id
hash `d57c1eab`). None of them kills the design; two improve it.

1. **Two-phase publish works exactly as designed.** Creating an empty Google
   Doc, then `files.update` + media (`text/markdown`) keeps the fileId, keeps
   the native Doc mimeType, and replaces the body (U2, PASS). This is the
   mechanic that makes stable URLs and link rewriting possible.

2. **The importer preserves what matters** (U3, PASS): absolute `/document/d/`
   links to other Docs, external http links, tables, fenced code, headings,
   and lists all survive the round-trip. **Front matter does NOT survive** —
   it becomes a mangled heading. Consequence: the publisher must strip front
   matter before upload and use its `title:` for the Doc name (per decision
   11). This moves from "nice to have" to **mandatory preprocessing**.

3. **Images embed as copies — no permission needed** (U4, better than
   designed): `anyoneWithLink=reader` is **not settable** under `drive.file`
   (all payload variants 400), but it is also unnecessary — the markdown
   importer fetches the image server-side and embeds a copy *inside* the Doc
   (confirmed by `<img>` in the HTML export; original image file stays
   private). Image handling simplifies: upload + rewrite + embed, no
   permissions API call at all. Caveat: same-Drive-owner context assumed,
   which holds — publishing always targets the authoring user's own Drive.
   Eyeball-verification of the kept probe Doc still pending (see U4 evidence).

4. **Tabular is easier than feared** (U5, PASS): clean comma CSV → Sheet;
   re-publish of a Sheet via `files.update` + `text/csv` media keeps the id
   and replaces content; `.xlsx` converts to a native Spreadsheet with values
   intact. Drive even auto-detected the semicolon dialect and decoded
   latin1 content correctly (`Wert 1` intact). Honest caveat: the fixture's
   "BOM" was a single `0xFF` byte (latin1 cannot encode U+FEFF), which came
   back as garbage `ÿ` inside the first cell — so real-Excel-BOM behaviour is
   *unproven*, and the agreed local sniff-and-normalise step (decision 12)
   stays in the design as cheap insurance against undocumented importer
   behaviour.

5. **`drive.file` blast-radius model holds** (U1, PASS): folder creation and
   nesting works, and after a simulated manual move (parent change) plus
   rename of the published root, reads and writes inside the tree still
   work. Users can freely reorganise the published folder.

Incidental findings:

- `rclone config dump` returns the client secret **already deobscured**, and
  `rclone reveal` run on such plaintext returns garbage with exit 0. The
  credential chain must only `reveal` values that are not already `GOCSPX-`
  literals (bug found and fixed in this probe; the rule goes into PR 2).
- `/usr/bin/zip -r .`-style invocation silently skips dotfiles ("Nothing to
  do!", exit 12) — the xlsx fixture needs an explicit part list.
- The probe's cleanup path (trash, never delete) worked on first try; the
  `--keep` mode (`GDRIVE_PUBLISH_KEEP=1`) is how the eyeball evidence was
  left behind.

**Verdict: proceed to PR 2 (`feat/gdrive-publish-core`) as designed.**
The only design change versus the agreed plan: image handling loses the
permissions step (simpler), and front-matter stripping becomes mandatory.

## U6 — the requirement itself, proven end to end (added after the first run)

The probe now performs a real two-phase publish of a 2-file fixture
(`toc.md` linking to `./details.md` and `details.md` linking back):

- phase 1 creates empty Doc shells for both files to reserve fileIds,
- phase 2 rewrites the relative links to `https://docs.google.com/document/d/<id>/edit`
  and fills both Docs via `files.update` + media.

Result: **PASS**. The exported toc Doc contains the details Doc's fileId twice
(both `./details.md` and bare `details.md` forms were rewritten), and the
details Doc links back to the toc Doc — bidirectional rewriting works. The
exported markdown shows real hyperlinks, e.g.:

`See [the details](https://docs.google.com/document/d/<detailsId>/edit) for specifics.`

This closes the last risk: the original user requirement ("a Google Doc should
link to the corresponding Google Doc URL") is verified against the live API
before any production code is written.

Naive-rewriter caveat observed: the probe's regex rewrites *every* inline link
including ones inside code fences, and resolves targets by simple string key
rather than by path. PR 2 must do proper path resolution relative to each
file's directory and must skip fenced/inline code — both already in the agreed
test-bed fixture list.

## CORRECTION — image handling (decision 9 overturned by U7)

The first run's U4 verdict ("images embed, no permission needed") was **wrong**,
and so were two successive verification methods. Recorded here because the
failure mode is instructive:

| Check | Result | Why it lied |
|---|---|---|
| markdown export contains `googleusercontent` / html export contains `<img>` | "embedded" | Drive emits an `<img>` tag and `![]()` even for an image it could not resolve |
| docx export contains a `word/media/*` part | "embedded" (all 4 strategies) | A failed fetch still produces a media part — a placeholder |
| **docx media part byte size + dimensions** | **decisive** | Placeholder is `1x1 RGBA, 70 bytes`; a real embed is byte-identical to the source |

Human eyeball ("no image embed") caught what all three automated checks missed.
PR 2's e2e assertion must therefore compare **image bytes/dimensions**, never
the mere presence of a tag or media part.

### Root cause

`POST /files/{id}/permissions {type:"anyone"}` fails with HTTP 400 and
`reason: "publishOutNotPermitted"` — a Google **Workspace admin policy** on
`datadoghq.com` that forbids anyone-with-link sharing. It is *not* a
`drive.file` scope limitation. `{type:"domain", domain:"datadoghq.com"}`
succeeds. But the markdown/html importer fetches image URLs **anonymously**,
so domain-shared images are still unfetchable and render as the 1x1
placeholder. No Drive-hosted URL can ever work on this account.

### Measured strategy comparison (same 480x320, 3319-byte source PNG)

| Strategy | Embedded media | Verdict |
|---|---|---|
| A: markdown + `uc?export=view&id=` | `1x1 RGBA, 70 B` | broken placeholder |
| B: markdown + `data:image/png;base64,...` | `480x320 RGB, 3319 B` | **works, byte-identical** |
| C: html + `data:` URI | `480x320 RGB, 3319 B` | works (markdown is preferred; no md->html step needed) |
| D: html + `uc?` URL | `1x1 RGBA, 70 B` | broken placeholder |

### Replacement for decision 9

Images are **base64-inlined as `data:` URIs** into the markdown before upload:
no image files in Drive, no permissions API call, no dependence on admin
sharing policy, and the published Doc is self-contained when shared. Guardrails
(new): warn above ~2 MB per image, hard-fail above ~10 MB of total document
payload, and account for base64's ~33% inflation. Consequence: images are
copies, so re-publishing re-uploads them.

This also *simplifies* the design — the image-permission code path and the
`uc?` URL rewriting rule both disappear.

### Canonical image verification (supersedes the checks above)

Human review rejected the embed twice before the real state was established.
Final resolution: **export the Doc as PDF, rasterise page 1, and look at the
pixels** (`files.export?mimeType=application/pdf` + `pdftoppm -png`). Verified
this way:

| Doc | Strategy | Rendered result |
|---|---|---|
| `1qbqXc93...` ("Image Embed Test") | markdown + `uc?` URL | blank page \u2014 text only |
| `1C4xB9YW...` (A) | markdown + `uc?` URL | blank |
| `19SLUxzW...` (B) | markdown + `data:` URI | **image renders correctly** |
| `1AUX59LZ...` (C) | html + `data:` URI | image renders |

Note on the earlier confusion: the "Image Embed Test" Doc is a `uc?`-URL
document whose own body text promises a checkerboard, so it is the obvious
one to open and it can never render. The byte-size check (70 B 1x1 placeholder
vs 3319 B original) was correct, but only the PDF render is both decisive and
unambiguous to a human.

PR 2 consequence: the `GDRIVE_PUBLISH_E2E=1` suite asserts image embedding by
exporting PDF and checking for non-blank image content \u2014 never by the presence
of an `<img>` tag, an `![]()` construct, or a `word/media/*` part, all three of
which produce false positives.
