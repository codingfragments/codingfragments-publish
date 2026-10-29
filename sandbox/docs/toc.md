---
title: Sandbox Handbook
author: gdrive-publish sandbox
status: draft
---

# Sandbox Handbook

This tree exercises every interesting publishing behaviour. Publish it, then
open the resulting Doc and click through.

## Should become working Doc links

- [Details page](./details.md)
- [Details, written without the ./ prefix](details.md)
- [Nested guide](./guide/intro.md)
- [Deeply nested note](./guide/deeper/note.md)

## Should become a Sheet link

- [Quarterly report (CSV)](./data/report.csv)
- [Workbook (XLSX)](./data/book.xlsx)

## Expected warnings

- [Anchor link](./details.md#section-two) - anchor is dropped (ANCHOR_DROPPED)
- [Outside the root](../outside.md) - left verbatim (LINK_OUTSIDE_ROOT)
- [Absolute path](/etc/hosts) - left verbatim (LINK_OUTSIDE_ROOT)
- [Missing target](./does-not-exist.md) - left verbatim (LINK_TARGET_MISSING)
- [Unsupported target](./notes.txt) - left verbatim (LINK_TO_UNSUPPORTED)

## Should be left completely alone

- [External link](https://example.com)
- [Mail link](mailto:nobody@example.com)
- [In-page anchor](#should-be-left-completely-alone)

Links inside code must survive literally:

```md
[this must NOT be rewritten](./details.md)
![nor this](./img/checkerboard.png)
```

And inline code too: `[not a link](./details.md)`.

A reference-style link works as well: [reference][ref].

[ref]: ./details.md

small edit for the progress demo
tweak again
