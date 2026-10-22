# DocuKit work log

Append-only. The coordinator adds an entry after every integration to `main`: the date, the commit,
what changed for users, how it was verified, and anything left open. Newest entries at the bottom.
The brief and the backlog live in `HANDOFF.md`.

---

## 2026-10-10 — single-agent session (before the coordinator model)

| Commit | What shipped | Verified |
|---|---|---|
| `b17a806` | Canonicals, JSON-LD urls and internal links use trailing-slash URLs; `/view/` out of the sitemap | Build output; live canonicals and sitemap |
| `2c883d6` | `npm audit fix` (Astro 6.0.8 → 6.4.8 and others); 59 → 27 advisories | Typecheck, lint, unit tests, build |
| `489c45b` | Structured data reaches the page (missing `head` slot); per-tool share images; Organization schema | Build output; live JSON-LD and OG image |
| `ca6e044` | Security headers and CSP deploy from `public/_headers`; `serve-dist.mjs` applies them | 97 Chromium + 42 Firefox/WebKit tests under the CSP |
| `6ee3a8f` | Rearrange PDF: rotate a selection or all pages | New tests read output page rotations |
| `26cb86d` | 11 task landing pages + "Popular tasks" links + footer row | 283 Chromium tests from a clean worktree; all pages checked live |
| `e499422` | HEIC conversion fixed under the CSP (`heic-to/csp`); real HEIC fixture; thumbnail fallback | HEIC → JPG on three engines; converted a real file on the live site |
| `1a957a1` | Upload box keeps its height after a file is added | 162/162 with retries off on three engines |
| `c4b7e31` | HEIC to JPG task page | With the above |
| `c578f91` | Compress PDF: Target size mode | 300 Chromium + 68 Firefox/WebKit; 46.9 KB → 21.6 KB at a 30 KB target on the live site |
| `9b2ee7e` | Compress PDF to 100KB / 200KB / 1MB task pages | With the above |
| `c61ae27` | Astro 6 → 7 (Vite 8) to clear the last critical advisory | 301 Chromium, 269 Firefox/WebKit, 22 mobile; five tools run on the live site in Chromium and WebKit; CI `ci` job green |

### Mistake worth remembering

`ca6e044` shipped a CSP without `'unsafe-eval'`, which broke HEIC conversion in production for about
two and a half hours. No test covered HEIC because there was no fixture, so the suite stayed green.
It was found only when a real HEIC file was created for another reason. Lesson: an "unproven" entry in
`coverage.ts` is a blind spot for exactly this kind of change — when tightening a policy or upgrading
a dependency, exercise the unproven features by hand.

### Left open at the end of the session

- The uncommitted source-check work in the working tree (HANDOFF.md §1.1) — needs Lakshay's decision.
- Merge PDF page-level view and Split PDF visual preview: designed (HANDOFF.md T1, T2), not started.
- Cloudflare Web Analytics is still switched on in the dashboard and is blocked by the CSP.
- CI `e2e` job for `c61ae27` was still running when the session ended.

---

## 2026-10-11 — first coordinator session

The session opened on 2026-10-10 and stopped at the account session limit within the hour; everything
below was finished, verified and shipped on the 11th.

| Commit | What shipped | Verified |
|---|---|---|
| `f6805f6`…`5ac8727` (T0, 7 commits) | The source-check batch: page thumbnails in Split PDF and PDF to Image; Watermark "Specific pages" and a front/behind layer; a font selector in Add Page Numbers; Image to PDF margins in mm / in / pt; Sign PDF "Place on all pages"; false claims trimmed from the registry | Clean worktree of `5ac8727`: 310 Chromium, 268 Firefox/WebKit, 22 mobile, 9 visual. Live: all six tools run end to end on docukit.uk in Chromium, Split and Sign also in WebKit; Watermark "behind" pixel-checked |
| `32dbf58` (T4) | Compress PDF no longer turns pages black or garbles images: only an allow-list of image shapes is re-encoded, everything else is left untouched; the original is returned when the result would not be smaller | Clean worktree: 327 Chromium, 300 Firefox/WebKit (16 new image-safety tests on each engine), 22 mobile, 67 unit. Live: synthetic masked-image PDF at High / Medium / Target in Chromium and High in WebKit, and Lakshay's own file at High and Target 200 KB — every page as light as the original |
| `2e2ae36`, `491dcb4` (T14) | Protect PDF writes the permissions the visitor ticks; the open and permissions passwords are always different (a random one is generated and shown once); new "No password, restrictions only" mode; passwords starting with `@` or `--` work; the screen and copy say permissions are advisory | Clean worktree: 354 Chromium, 357 Firefox/WebKit (28 permission + 7 protect/unlock tests on each of three engines), 22 mobile, 94 unit. Live: seven cases on Chromium and two on WebKit, reading `/P`, pdf.js permissions and the password role from the downloaded files |
| `99b4cec`…`36a1db1` (T11, 3 commits) | A search field on the homepage over all 20 tools and 15 task pages: jpg/jpeg and image/photo/picture match each other, arrow keys and Enter choose, `/` or Ctrl+K focuses, hidden without JavaScript; about 8.5 KB of script | Clean worktree: 376 Chromium, 400 Firefox/WebKit, 26 mobile, 116 unit. Live: nine checks on Chromium, three on WebKit and Firefox; all 35 result links return 200 |
| `4610097`, `b25e3ce`, `f19ca59` (T16) | Crop PDF: eight visible drag handles, resize cursors only over handles and edges, corner drag, box move, touch scrolling on the preview, keyboard nudging, a live size readout; one false FAQ line corrected; the flaky Firefox home-search test fixed | Clean worktree: 381 Chromium, 410 Firefox/WebKit, 26 mobile, 9 visual, 116 unit. Live: handle drags and the CropBox of the downloaded file checked on three engines, plus an emulated-touch run |
| `792392d`, `379b6da` (T15) | PDF to Image hands over the images themselves: a card and Download button per image, "Download all" as separate files for 2–10 images, ZIP as a secondary (primary above 10), "Save to a folder…" in Chromium, a share option where files can be shared, files named by source page (`-page-03`); DPI and quality copy corrected. Site-wide: scrolled-to targets stop below the sticky header, smooth scrolling only without reduced motion; the test suite now runs with reduced motion | Clean worktree: 400 Chromium, 444 Firefox/WebKit, 26 mobile, 9 visual, 123 unit; no download-timeout flakes. Live: 39 checks; "Download all" produced 3 download events on each of three engines; ZIP entries, source-page names and the 12-page case checked on Chromium |

T15 notes: several downloads fired with no gap are dropped (Chromium kept 10 of 40, WebKit 1); with
150 ms between them all three engines delivered 40 of 40 — hence 10 files at 300 ms. A page cannot
tell whether the browser saved each file, so the status line reports only what was started. Not
verified: the real Chrome multiple-download prompt, real Safari/iOS/Android, the real folder picker
and share sheet (stubs only). `shared/MultiFileDownload.tsx` is reusable; Split PDF and the batch modes
of Convert, Compress and Resize Image still force a ZIP. One lost-click flake remains
(`tools/watermark-pdf.spec.ts:41` on Firefox, once, not reproduced in 13 runs).
| `20c5a2b`…`afb93bd` (W1, 5 commits) | Workspace step 1a, no visible change: `src/lib/pdf/` (`doc-handle`, `page-geometry`, `render-scheduler`), hooks `use-pdf-document` and `use-page-thumb`, `usePdfThumbnails` rebuilt on them (blob thumbnails, page count as soon as the file opens, document closed and URLs revoked); every pdf.js document now shares one `PDFWorker`, which removes the Crop Flatten "worker is being destroyed" error | Clean worktree: 405 Chromium, 455 Firefox/WebKit, 26 mobile, 9 visual, 453 unit (geometry proven on 16 real rotated / offset PDFs by pixel). Live: five thumbnail tools, four round trips reading the output, 48-page file, Flatten 10/10 Chromium and 5/5 Firefox |

W1 notes: the API is documented in the files; it differs from the design's section 3.1 in that
`destroy()` is async, `requestThumb` returns a promise, and `releasePage(url)` / `closeDocument()`
exist — a viewer must release a render when it replaces it. `use-history.ts` was not built. No caller
of `usePdfThumbnails` calls `clear()` when a file is removed, so thumbnails live until the next file
or leaving the tool. WebKit is 4–7% slower to the last thumbnail of a 48-page file. Remaining lost
clicks (Firefox in the gate, WebKit in the live check: 8 in 40 same-tab reloads of Crop PDF) are the
Crop button moving between pointer-down and pointer-up as the page settles (y 877 → 72); a second
click works. The workspace's fixed action bar is the structural fix.
| `d4b561d`…`9e57f41` (W2, 8 commits) | The shared tool workspace (`src/components/islands/workspace/`: frame, single action slot, page viewer, rail, movable boxes, `use-history`) and Sign PDF rebuilt in it: drop the PDF first, create the signature beside the page, drag / corner-resize / remove / duplicate / copy to all pages, undo and redo, mm fields, initials and date, the signed file shown after signing with Before/After and "Make changes"; stamps land exactly where shown on rotated and offset pages; Sign copy rewritten | Clean worktree: 435 Chromium, 513 Firefox/WebKit, 30 mobile, 9 visual (no baseline changed), 527 unit. Live: full flow on three engines; shown vs in-file position within 0.0001 of the page on plain, `/Rotate 90` and offset-CropBox fixtures; phone emulation; Merge, Split and Compress unchanged |

W2 notes: the component contract as shipped, and how a tool adopts the workspace, is in the W2 task
report — the short version: keep the `File`, `usePdfDocument(file)`, `useToolRun()`, return
`<ToolWorkspace toolId active empty title prompt fileBar stage rail controls result action />` with
`PageViewer` / `PageRail` / `ActionBar`, call `run.invalidate()` on every input change, add the tool to
`tests/e2e/workspace/migrated.ts`. Differences from the design's section 3.2: `title` is a prop; no
floating overlay toolbar (selection actions are a docked bar in the viewer footer); `PageViewer` has
no `zoom` / `compareDoc` props; `WorkspaceFileBar` takes one `file`; not built yet: `PageGrid` /
`PageCard`, `PagePreviewDialog`, `CompareView`, `OutputPagePreview`, `ImageStage`. Left out of Sign: a
pages popover at 1024–1279px, zoom buttons on phones, dropping a new PDF onto an open workspace, stamp
rotation and opacity. Found: the four signature font files (`public/fonts/*.woff2`) contain no Latin
letters, so typed signatures were always drawn in a fallback font — script-font fallbacks added, real
fix is new font files; pages that leave two graphics states open made appended content land half-size
and shifted — fixed for Sign (`src/lib/pdf/content-balance.ts`), still present in Watermark and Page
Numbers. `tools/sign-pdf.spec.ts:102` is flaky on WebKit (mouse moves fired faster than
`signature_pad`'s 16 ms throttle) — pace the moves ≥20 ms.
| `0d14ec7`…`973280d` (W3, 9 commits) | Image to PDF in the workspace: every output page shown as it will be saved (true proportions, margin guides, live as options are typed); drag and keyboard reorder with a visible prompt; page dialog; Orientation option defaulting to Auto (Lakshay's decision — landscape images get landscape A4/Letter/Legal pages); "Fit Image" without margins; "Center" merged into "Fit"; WebP/GIF/BMP/HEIC re-encoded before embedding; EXIF-rotated photos upright. New shared `PageGrid`, `PageCard`, `PagePreviewDialog`, `OutputPagePreview`. Fixed the keyboard-reorder and WebKit drawn-signature test flakes | Clean worktree: 471 Chromium, 586 Firefox/WebKit, 34 mobile, 9 visual, 692 unit. Live: four mixed images on three engines, output order / MediaBox / `cm` equal to the preview to 0.01 pt; Portrait, Fit Image, typed margins, remove, add, dialog, JPG to PDF, phone |

W3 notes: one layout function (`src/lib/images-to-pdf-layout.ts`) feeds both the preview and the
writer; its vitest table pins every unchanged option combination to the pre-refactor numbers. Open:
"Cover" fills inside the margins on one axis but bleeds to the page edge on the other (asked
Lakshay); "Fit Image" turns pixels into points, so a 12 MP photo makes a page about 1.4 m wide;
re-encoded images over Safari's canvas limit may come out blank on iOS (not verified). On 2026-10-20
Windows cleaned `%TEMP%` and deleted the W3 worktree's files mid-task (commits survived) — worktrees
now live under `D:/Project/docukit-wt/<id>`. Lakshay's decisions on 2026-10-21: Image to PDF output
changes approved; migrate every tool the workspace suits; sub-agents run at medium effort at most.
| `fb819e8`, `b77b0d1` (T19) | Edit PDF in the workspace: every added object (text, image, rectangle, ellipse, line, arrow, drawing, highlight, whiteout, stamp) resizable by corner handles, Smaller/Larger, keyboard and mm fields with "Keep proportions"; text font-size field (6–144 pt); properties editable on the selected object; sensible default sizes relative to the page; output drawn per object as vectors and real text (was a full-page PNG in "Part of the page"), correct on rotated and offset pages in both save modes; copy corrected ("Fabric.js", "Bezier smoothing", "50 actions" removed) | Clean worktree: 495 Chromium, 632 Firefox/WebKit, 37 mobile, 9 visual (editor baseline regenerated on purpose), 722 unit. Live: text, image and rectangle sized by handle and fields on three engines, file vs screen within 0.002% of the page, annotations mode, `/Rotate 90`, phone |

T19 notes: the old canvas editor (`AnnotationCanvas`, `AnnotationToolbar`, `pdf-annotations.ts`) is
gone; shapes are now added at a default size and then resized, not drawn by dragging; single-letter
shortcuts were dropped; "Save PDF" needs at least one object. Not verified: non-ASCII text (saved as a
picture of itself), HEIC/GIF images inside Edit, annotations in Acrobat. The design doc's Edit row
still names `AnnotationCanvas`.
| `9129d0a`, `481a7f0`, `fdb23cf` (T1) | Merge PDF in the workspace: every page of every file in output order with file-letter badges, drag across files, × to leave a page out, page ranges synced both ways with the grid, inline unlock, "Reset order", options always visible; worker `segments` on both paths, `sourceKey` in `mupdf-merge.ts` so bookmarks remap when a file is split into runs; blank pages only at file changes | Clean worktree: 514 Chromium, 668 Firefox/WebKit, 39 mobile, 9 visual (two Merge baselines regenerated on purpose), 736 unit. Live (after a second push — Cloudflare Pages had not started a build for `fdb23cf`, the next push triggered one): the Merge specs run against docukit.uk on three engines (interleave, ranges, ×, reset, blank pages, bookmarks, inline unlock — output order read back), phone emulation |

T1 notes: new WebKit flakes in `tools/merge-pdf-pages.spec.ts` (the Unlock button re-renders while
clicked — possibly the 500 ms auto-try of the password, which could also eat a real click — and a
lost file-row keyboard drag), and one `workspace/contract.spec.ts` axe colour-contrast hit on Edit
PDF mid-transition. Not tested: 50+ files, very large PDFs, real touch drag.
| `8c38628`, `76d0478`, `e28b132` (T2) | Split PDF in the workspace: every page shown in every mode with the outcome on the grid (Selected / Removed / "PDF 1, 2…" colour-and-label groups / dividers for Every N / per-page numbers), an output list with real file names, several results through `MultiFileDownload` instead of a forced ZIP, page numbers past the end flagged instead of trimmed; Delete / Extract PDF Pages copy updated; Merge's Unlock button no longer vanishes under a click while the automatic password try runs | Clean worktree: 535 Chromium, 708 Firefox/WebKit, 41 mobile, 9 visual, 748 unit. Live (Cloudflare started the build ~10 minutes after the push): Split, Delete and Extract specs against docukit.uk on three engines, phone emulation; a Firefox fast-click experiment on Extract PDF Pages lost 0 of 30 clicks |

T2 notes: `PageGrid` / `PageCard` gained selection, marks and group dividers; `MultiFileDownload`'s
logic is now a `useMultiFileDownload()` hook. A Firefox flake in `tools/landing-pages.spec.ts:150`
(first page click lost) fired twice in the gate but not on production. At 375 px in S size the "Not
included" tag is truncated. PDF to Image still uses the old `PageSelectorGrid`. Cloudflare Pages builds
now start up to ~10 minutes after a push (both T1 and T2); allow 15 minutes before calling a deploy
stuck. Live-run specs that assert "no console errors" fail on production only because the CSP blocks
the Cloudflare Web Analytics beacon — switching Web Analytics off (Lakshay's to-do) fixes that.
| `1451f7f`, `f1db66c`, `217d009` (T12) | Compress PDF in the workspace with a quality preview: a live one-page Original / Compressed preview while choosing a level (desktop; a "Preview quality" button on phones and engines without OffscreenCanvas), `CompareView` of any page of the real output at Fit / 100% / 200% after a run, facts lines from the compressor's real per-image outcomes, a gross-corruption check on the shown page plus up to six others that demotes the download to "Download anyway", Target-size "what it took" and harsh-end warning; copy corrected ("Five settings", no "Compress & Download", percentage ranges removed) | Clean worktree: 559 Chromium, 760 Firefox/WebKit, 44 mobile, 9 visual, 782 unit. Live: preview, image-safety and compress specs against docukit.uk on three engines (corruption warning fires on a stubbed black encoder), phone "Preview quality" path |

T12 notes: new shared `workspace/CompareView.tsx` (Compress Image can adopt it; `BeforeAfterSlider`
stays until then), `doc-handle.renderPage` gained `format: 'png'` and `pixels`, worker op
`compress-probe`. KB stays 1024 bytes site-wide. Open: a preview can differ from the run when an
image on the previewed page is the soft mask of an image on another page; "Strip embedded fonts"
still loses text (now labelled so); the probe copies the whole file to the worker on each page
change; not tried on real Safari/iOS or a real 200-page scan.
| `e918f97`, `2e79a88` (W4) | Watermark PDF in the workspace: one layout function (`src/lib/watermark-layout.ts`) draws the preview on any page and writes the file (`watermark-write.ts`, through page geometry, open graphics states closed); pages left out by "Apply to" badged "Not watermarked"; new Font, Spacing, "Distance from edge" and image-width controls; WebP re-encoded, SVG no longer accepted. Output changes, following what the preview showed: rotation is clockwise as on screen and pivots on the visual centre, single text is vertically centred, tiling uses one rule (default spacing 60 pt), images default to 50% of the page width | Clean worktree: 575 Chromium, 790 Firefox/WebKit, 46 mobile, 9 visual (Watermark baseline regenerated on purpose), 832 unit. Live: Watermark and placement specs against docukit.uk on three engines, source-check Watermark tests, phone |

W4 notes: drag-to-position not built (nine presets); the preview draws glyphs with browser fonts
stretched to the standard-font widths; not checked in a desktop PDF reader. The live run was cut off
once by the session limit and resumed.
| `dbf47e2`…`4a70b3f` (W5, 4 commits) | Add Page Numbers in the workspace: any page previewed with its own number from one layout function (`src/lib/page-number-layout.ts`) that also drives the writer (`page-number-write.ts`); skipped pages marked "No number on this page"; new margin sliders (mm); worker failures shown in the action slot; correct and upright on rotated, offset and unbalanced pages; copy corrected (no "first and last page", page range or "Apply & Download"). Shared `src/lib/standard-fonts.ts` and `src/lib/pdf/append-content.ts` extracted from Watermark (its output unchanged) | Clean worktree: 589 Chromium, 823 Firefox/WebKit, 48 mobile, 9 visual (Page Numbers baseline regenerated on purpose), 914 unit. Live: Page Numbers and Watermark placement specs against docukit.uk on three engines, phone |

W5 notes: output on upright pages moves by at most ~0.3 pt (centred/right numbers now measured
without kerning, as drawn). "of N" counts only the numbered pages and ignores the start number (start
3 on 5 pages ends "Page 7 of 5") — kept as today's behaviour; asked Lakshay. No page range built. The
gate's Chromium step took 8 hours of wall time because the laptop slept mid-run; nothing failed.
| `6cd3bf6`…`f5c2566` (W6, 5 commits) | Crop PDF in the workspace: any page shown with the crop box (same handles), "Current page" = the page shown (it always cropped page 1 before), pages outside the choice badged "Not cropped", visual margins written through page geometry in CropBox and Flatten modes (correct on rotated and offset pages), inches added with exact round trips, touch drag of the whole box, Auto-crop on the page shown, range field accepts odd/even/first/last; copy corrected — Flatten makes files larger (1 KB → 79 KB on a one-page fixture), so "smaller file" is gone | Clean worktree: 610 Chromium, 859 Firefox/WebKit, 50 mobile, 9 visual (two Crop baselines regenerated on purpose), 929 unit. Live: Crop specs against docukit.uk on three engines (one Chromium page-load timeout passed alone), Crop parity tests, phone touch drag with the CropBox read back |

W6 notes: Crop keeps its own handles (not `OverlayBox`); `PageViewer` gained an optional `padding`;
new `CropOptions` worker shape. The unmigrated-tool example in the contract and large-file specs is
now `/protect-pdf`. Not verified: real-device touch, the Flatten 24 MP cap on huge pages.
| `17fccb9`, `946a86d`, `a720076` (W7) | Rearrange / Rotate PDF pages in the workspace: rotate left/right, duplicate, delete, view larger and reorder always visible on every card (44 px on touch), click / Shift-click / Space selection with Rotate/Delete selected and Rotate all, blank pages, Undo/Redo, Reset, "Save PDF (N pages)" with the saved file re-rendered in the grid; turns now add to a page's own `/Rotate` (they overwrote it before), blank pages take the displayed shape of the page before them; tool and `/rotate-pdf/` copy corrected | Clean worktree: 630 Chromium, 898 Firefox/WebKit, 52 mobile, 9 visual (two Organize baselines regenerated on purpose), 945 unit. Live: Organize specs and the rotate-pdf landing test against docukit.uk on three engines, phone tap-to-rotate with `/Rotate` read back |

W7 notes: `PageCard` / `PageGrid` gained opt-in `actions`, `largeTouchTargets` and Shift modifiers;
`shared/PageThumbnailGrid.tsx` removed (unused). History limit 100 steps (no number in the copy).
| `4a8dc59`, `ca4a047`, `1174623` (W8) | PDF to Image in the workspace: selectable page grid synced with the range field (odd / even / last), "Not exported" marks, "You'll get N images" with real names and pixel sizes, a magnifier that renders each page exactly as it will be saved (same code path as the conversion; byte-identical at normal sizes; 100% zoom; 600 DPI capped at 12 MP / 6 MP on low-memory devices with an estimated size), downloads through the action slot; `shared/PageSelectorGrid.tsx` removed; PDF to Image and PDF to JPG copy updated | Clean worktree: 647 Chromium, 932 Firefox/WebKit, 55 mobile, 9 visual, 951 unit. Live: PDF to Image specs and the JPG landing tests against docukit.uk on three engines, phone selection and download names |

W8 notes: `tests/e2e/tools/pdf-doc-layer.spec.ts` now drives `/redact-pdf` (the last user of
`usePdfThumbnails`). The shared `MultiFileDownload` result gallery squeezes three columns into the
narrow workspace result pane — fix once for all tools. 600 DPI on very large pages can exceed browser
canvas limits during export (pre-existing).

Queue changes since `HANDOFF.md` was last rewritten (fold these in at its next update): T11, T16,
T15, W1, W2, W3, T19 (Edit PDF sizing, in the workspace), T1 (Merge), T2 (Split), T12 (Compress
PDF preview), W4 (Watermark), W5 (Page Numbers), W6 (Crop), W7 (Rearrange) and W8 (PDF to Image)
are done; the workspace's step 1c (splitting `pdf-worker.ts`) is dropped because it only
served parallel agents. Lakshay said to keep working in the same chat until he says stop, so the "hand off at half
context" rule in HANDOFF section 4 and its kickoff prompt no longer applies. New items found:
- **Crop Flatten race (real, user-visible):** clicking Crop in Flatten mode very soon after loading a
  file can show "PDFWorker.create - the worker is being destroyed"; a second click works. 2 in 30 runs
  of `parity/closed-gaps.spec.ts:258`, with or without T16. Likely `CropPreview.tsx` calling
  `doc.destroy()` without awaiting it while `src/lib/pdf-flatten-crop.ts` opens a document.
- **Lost clicks in WebKit/Firefox tests:** the "waiting for event download" flakes are clicks landing
  while the target sits under the sticky header after a smooth scroll (site-wide
  `scroll-behavior: smooth`). About 4% per run on `tools/crop-pdf.spec.ts`. Worth a harness fix.
- **Crop copy still false:** "inches" is listed but only mm and pt exist; an FAQ names a "Numeric
  Input mode"; the how-to names a "Crop & Download" button. Box move is mouse-only.
- **Homepage search:** add `searchKeywords` to registry entries for synonyms ("join", "esign").

T11 notes: `ux/home-search.spec.ts:311` is flaky on Firefox (the test holds back the island script and
then waits for `load`, which Firefox sometimes blocks on) — fix with `waitUntil: 'domcontentloaded'`.
Result links that stay on screen are prefetched by the site-wide Astro prefetch setting (same-origin
page GETs, the typed text is never sent); the spec's "typing fetches nothing" comment is true only for
fast typing. No typo tolerance and no synonyms ("join", "esign"): a `searchKeywords` field on the
registry entries would add them.

### The Protect PDF permissions bug (T14), for the record

Lakshay protected a PDF with copying disallowed and could still copy. Three causes, all real:
`qpdfEncrypt` passed a fixed `--print=none --modify=none` and the worker never forwarded the ticked
options, so every output had `/P -3376` (copy always allowed, everything else forbidden); the open
password doubled as the owner password, so opening the file granted every right; and Firefox's
built-in viewer ignores permission flags unless `pdfjs.enablePermissions` is set. Not verified: that
Adobe Acrobat honours the flags (the on-screen note and a FAQ name it — Adobe's help page could not be
fetched and no copy of Acrobat was available), and what Chrome/Edge's built-in viewer does.
Left open: the Unlock PDF FAQ says a restrictions-only file unlocks with no password, but the tool
refuses an empty password; the Unlock how-to says "password-free PDF", which puts "free" in visible
copy.

### The black-page bug (T4), for the record

Lakshay compressed a real 4-page scan on the live site and page 1 came out black. Each page ended with
a full-page RGB image carrying both `/SMask` and a stencil `/Mask`; `compressPdfOnce` re-encoded it as
a JPEG under a brand-new dictionary with no masks, so the overlay turned opaque and its hidden samples
are black. The same loop was also inverting `/Decode [1 0]`, `/Indexed` and `/Separation` images,
garbling Flate images with a PNG predictor and shifting CMYK. Cost of the fix: that file now shrinks
13% at most (641 KB → 558 KB) and misses a 200 KB target, which the tool reports. Two follow-ups would
win size back: deduplicating identical image streams (about 150 KB on that file, lossless) and
alpha-aware compression of masked images. The pre-existing compare-slider test would have passed on a
black page; `tools/compress-pdf-image-safety.spec.ts` is the pixel guard.

### Fixed during the T0 review (part of the commits above)

- Sign "Place on all pages" counted rendered thumbnails, so a long PDF would have been stamped only as far as its thumbnails had loaded.
- PDF to Image exported every page when the selection was empty; it now exports nothing and says so. A blank "Custom range" therefore no longer means "all pages".
- Image to PDF margins drifted on each unit switch (10 mm → in → mm gave 9.91); the value is now held in points.
- Watermark "behind" could have reordered the page's own content when nothing was drawn.

### Notes from this integration

- One WebKit failure in the first gate run (`tools/page-numbers.spec.ts`, download never started) did not reproduce in a solo run, five repeats or a second full run. Three other agents were testing at the time. WebKit "waiting for event download" timeouts under load also hit Crop PDF, which the commit does not touch — treat them as load, and do not run the gate while other agents test.
- `node scripts/sync-pdfjs-worker.mjs` leaves `public/pdfjs/pdf.worker.min.mjs` modified (line endings only) in a worktree. Never stage it.
- The fixtures under `tests/e2e/fixtures/files/` are all written by `tests/e2e/fixtures/generate.ts` from Playwright's `globalSetup`, including the untracked ones. None need committing.
- A lower-case drive letter in the shell's working directory (`d:\…`) makes `npm test` fail with "Cannot read properties of undefined (reading 'config')". `cd /c/ && cd "D:/Project/DocuKit"` fixes it.
- Production still logs one CSP violation per page: Cloudflare injects the Web Analytics beacon at the edge and the CSP blocks it. Lakshay's to-do (switch Web Analytics off in the dashboard) is still open.
- **Working mode changed:** Lakshay asked for one sub-agent at a time ("too much token consumption") after six parallel agents hit the account session limit. Tasks now run serially.
- Two read-only design agents ran on 2026-10-10: the shared tool workspace (T13) and the compression quality preview (T12). Their reports existed only in session transcripts and are now saved unedited in `docs/design/tool-workspace.md` and `docs/design/compress-preview.md`. Nothing from either is built.
- The GitHub CLI is now installed and logged in, so CI can be read with `gh run list --branch main`. The workflow concluded `success` for every commit up to `d3f7b5c`; the run for `491dcb4` was still in progress at handoff.

### Left open at the end of the session

Closed from the previous session's list: the uncommitted source-check work shipped as T0, and CI for
`c61ae27` concluded `success`. The queue, in order, is `HANDOFF.md` section 6. Open now:

- `task/T11-home-search` (homepage tool search): three commits on the old base `085a6e0`, never verified. Its agent was stopped before it reported. The worktree is still at `C:\Users\LAKSHAY\AppData\Local\Temp\docukit-wt\t11`, without a `node_modules` junction.
- The shared tool workspace (T13) is designed, not started. Three questions are waiting on Lakshay: the Image to PDF output changes, whether to migrate all 20 tools, and whether pages 2, 4 and 5 of his `merged-3-organized.pdf` are really blank.
- Lakshay's requests from this session that are queued, not started: Crop PDF cursor and handles (T16), PDF to Image without the forced ZIP (T15), the compression quality preview (T12).
- Not verified by anyone: that Adobe Acrobat honours the Protect PDF permissions, which the screen and a FAQ say it does. Lakshay to check in Acrobat Reader (File → Properties → Security).
- Cloudflare Web Analytics is still switched on and still blocked by the CSP.
