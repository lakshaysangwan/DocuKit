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
| `c104606`…`13e0fff` (W9, 4 commits) | Redact PDF in the workspace: marks drawn by mouse, touch or pen ("Draw marks" toggle so a finger can scroll), moved / resized / deleted as overlay boxes, Add mark, Smaller/Larger, mm fields, Undo/Redo, Find & mark all, the redacted output shown page by page before download with "No text found under any of your N marks"; marks mapped through page geometry (rotated / offset / UserUnit); MuPDF now removes only the image pixels under a mark (it removed whole images before); `usePdfThumbnails` deleted; copy no longer claims SSN/email/custom-pattern search, a warning dialog or "Apply Redactions" | Clean worktree: 669 Chromium, 975 Firefox/WebKit, 59 mobile, 9 visual, 966 unit. Live: Redact specs against docukit.uk on three engines, phone touch mark with the text under it gone from the downloaded file |

W9 notes: search still marks the whole line containing a phrase (over-covers); shapes only partly
under a mark stay under the black box (copy claims only fully covered shapes). **Open:**
`tools/pdf-doc-layer.spec.ts:134` ("leaving the tool releases its thumbnails…", now driving Split
PDF) fails on production on all three engines — only 1 of 5 thumbnail blob URLs revoked after the
in-site link — while passing locally; either a timing race in the test or a real leak on client-side
navigation. To investigate next.
| `e017ce1`, `9b73cb8`, `e8f6cda` (W10) | Protect PDF and Unlock PDF in the workspace as two components (mode tabs gone): the document shown; Protect detects an already-encrypted file on upload and points to Unlock, and after a run offers "Check it opens"; Unlock shows a locked stage until the password opens the file, opens restrictions-only files with no password (qpdf removes them with an empty password), and gives precise errors (wrong password / not a PDF / could not be unlocked) instead of "Incorrect password" for everything; copy fixed ("password-free" and "Unlock & Download" gone, `wasmDeps` now qpdf + pdf.js). The production-only `pdf-doc-layer` failure was a test bug: `/split-pdf` → `/split-pdf/` redirect satisfied the "back on a trailing-slash URL" wait before navigating; no thumbnail leak | Clean worktree: 696 Chromium, 1026 Firefox/WebKit, 63 mobile, 9 visual, 969 unit. Live: protect/unlock and doc-layer specs against docukit.uk on three engines, phone protect → unlock round trip with no `/Encrypt` left |

W10 notes: `qpdf-helper.ts` now captures qpdf's error output for every call (Compress included); no
Before/After on Protect (the output needs its password — "Check it opens" stands in). The unmigrated
example in the contract and large-file specs is now `/digital-signature-pdf`.
| `d7bc04b`, `3df690a` (W11) | Digital Signature PDF in the workspace: the PDF shown first, certificate generate/upload after it, an explicit "Visible signature box" / "Invisible signature" choice with the box placed on any page as an overlay (default unchanged: bottom-right of page 1), written as the widget's appearance through page geometry; result pane checks the byte range, digest and RSA signature (and says trust is not checked); signer name taken from the certificate used; existing `/Annots` and `/Fields` kept; copy no longer claims PAdES, Acrobat verification or legal standing | Clean worktree: 712 Chromium, 1066 Firefox/WebKit (run hung after its last test; that batch re-ran 6/6), 65 mobile, 9 visual, 997 unit. Live: Digital Signature and Sign specs against docukit.uk on three engines (functional checks all pass), phone sign with `/ByteRange` ending at the file length |

W11 notes: signing re-saves the whole file, so an earlier signature is invalidated (as before);
OpenSSL 3 (AES) .p12 files untested; the Sign PDF FAQ question "Is this a legally binding
signature?" stays but its answer should say plainly that we cannot say — copy sweep. **Found on the
live site:** besides the blocked Web Analytics beacon, Cloudflare injects its bot-detection script
(`/cdn-cgi/challenge-platform/.../jsd/oneshot`), which POSTs browser signals — not blocked by the CSP
because it is same-origin — and WebKit logs "access control checks" errors on every page alongside
it. This is a Cloudflare dashboard setting (Bot Fight Mode / JavaScript detections), Lakshay's call;
it conflicts with the "no tracking scripts" promise on the privacy page.
| `c15d520`…`3e06511` (W12, 5 commits) | Compress Image in the workspace with a new shared `workspace/ImageStage.tsx`: live Original vs Compressed `CompareView` (debounced for JPEG/WebP up to 12 MP, a Preview button for AVIF, PNG and larger images), facts from the real output; bugs fixed — download extension matches the real format, transparent PNG → JPEG flattened onto white, missed target reported with the smallest size reached, unused `stripExif`/`percentage` removed (re-encoding drops EXIF, copy says so), PNG quality slider hidden, PNG not offered in Target size; HEIC input decoded; default format WebP | Clean worktree: 734 Chromium, 1101 Firefox/WebKit, 67 mobile, 9 visual, 1013 unit. Live: `compress-image-preview.spec.ts` against docukit.uk 30/30 on Chromium and WebKit (short check — account near its weekly limit) |

Session stopped here on 2026-10-23 at Lakshay's request (weekly token limit at ~91%).

Folded into HANDOFF.md on 2026-10-23.

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

---

## 2026-10-24 — third coordinator session

One sub-agent at a time: task agent → fresh verify agent (gate in a clean worktree) → push → the same
verify agent checks docukit.uk.

| Commit | What shipped | Verified |
|---|---|---|
| `b840812`, `8cfa5ca` (W13) | Resize Image in the workspace: the stage shows the output size at true proportions with the image placed as Fit / Cover / Stretch will place it, live as size, percentage, preset, mode or background change, from one layout function (`resizeLayout` in `src/lib/resize-image.ts`) shared with the writer; Cover crop position by drag, arrow keys or slider; new percentage sizing (1–400%) and White / Black / Transparent background; after a run the resized file itself is shown with facts read back from it; batches through `MultiFileDownload` (was a forced ZIP). Bugs fixed: WebP/GIF/BMP were always saved as JPEG named `.jpg` (format now sniffed from the bytes; GIF/BMP → PNG, HEIC → JPEG); transparent PNGs were flattened onto white; HEIC and undecodable AVIF could not be resized (new shared `decodeToBitmap`); an empty or 0 width ran a 1 px resize and sizes had no cap (now disabled with a reason, max 10,000 px); a width typed before the image loaded was overwritten. Copy: false "Fill" mode, "searchable" presets and "one-side resize" claims removed; FAQ and steps rewritten | Clean worktree: 752 Chromium, 900 Firefox/WebKit (1 known WebKit large-file flake), 69 mobile, 17 visual, 1033 unit. Live (deployed ~2 min after the push): `resize-image.spec.ts` against docukit.uk 16/16 functional on three engines (the H1 no-console-errors check fails only on the CSP-blocked Cloudflare beacon), workspace contract + mobile for Resize 27/27, Compress Image specs on Chromium |

W13 notes: `load-image.ts` moved from `compress-image/` to `workspace/`; `CompareView` and `ImageStage`
gained an optional `content` slot; `ResizeImageOptions` reshaped (unused percentage / maintainAspect /
fill removed). New seeded fixture `photo-rotated.jpg` (EXIF 6). A social preset does not switch the
mode to Cover (the frame shows Fit's bars). Not checked on a real phone or Safari. **CI found:** the
`e2e` job on `main` has failed since W12 (run for `67f54b4`): on Linux WebKit,
`tools/compress-image-preview.spec.ts:76` (transparent PNG → JPEG) and
`workspace/contract.spec.ts:153` Sign PDF fail on every retry, though both pass in the Windows gates;
five more WebKit tests were flaky. Queued as the next task.
| `bfbd912`, `69d4afd`, `4879934` (CI1) | CI's `e2e` job can finish and report again: its limit raised from 60 to 90 minutes (the last two runs were cancelled at 60 with the suite still running). Linux WebKit failures fixed: the Compress Image transparent-PNG test's fixture was so flat that the PNG beat the JPEG and the tool rightly kept the original (fixture now has seeded grain); axe graded the action button mid-fade from its disabled 40% opacity (`seriousViolations` waits for transitions to end). Product fix: the workspace Options / Result pane becomes a keyboard tab stop (with a focus ring) when it scrolls and has nothing focusable inside — Safari could not scroll it while a job ran | Clean worktree: 752 Chromium, 900 Firefox/WebKit (Firefox `compress-image-preview.spec.ts:241` HEIC flaky once), 69 mobile, 17 visual, 206 extra WebKit workspace + a11y, 1033 unit. Live (deployed ~1.5 min after the push): contract, axe and Compress Image specs against docukit.uk 314/314 on Chromium and WebKit; Crop pages 11/11 on WebKit |

CI1 notes: worked from CI run 39911221969's artifacts (no Linux available locally). Still open: on CI
the Crop Flatten `/Rotate 90` result page once rendered solid black — the test now reads the page's
JPEG from the downloaded file first, so a repeat will say whether the file or the viewer is wrong; the
Extract PDF Pages lost first click (`landing-pages.spec.ts:151`) is now reported per page but not
explained. Sharding the e2e job is the longer-term answer to its run time.
| `8a6e8dd`, `773b85b` (W14) | Convert Image in the workspace: the image shown large on `ImageStage` with a strip for batches; live Original vs Converted `CompareView` for JPG/WebP up to 12 MP (a Preview button for AVIF, PNG and larger images), and the download is the very bytes compared; facts read from the output (sniffed format, quality or lossless, pixel size, size change, transparency filled or kept, GIF first frame, no EXIF); batches through `MultiFileDownload` (was a forced ZIP), clashing names get "(2)". Bugs fixed: transparent images converted to WebP/AVIF were flattened onto white (now only JPEG, and it says so); BMP/TIFF/ICO/GIF outputs in the options type silently became WebP (type narrowed to the four real encoders); a failed image in a batch was dropped with a toast and the rest offered as if all worked (now the run stops and names it); download name follows the sniffed format; HEIC shown instead of a placeholder. Preview hook shared with Compress Image (`workspace/use-image-preview.ts`). Copy: BMP/TIFF/ICO/GIF/SVG outputs and an SVG DPI setting removed; five Convert task pages updated ("separate files or one ZIP") and still preset their format | Clean worktree: 767 Chromium, 924 Firefox/WebKit (1 known WebKit large-file flake), 71 mobile, 17 visual, 1041 unit. Live (deployed ~2 min after the push): Convert and landing-page specs against docukit.uk 78 functional passes on three engines (51 failures all the CSP-blocked Cloudflare beacon in no-console-errors checks), workspace contract + mobile for Convert 9/9, Compress Image preview 15/15 |

W14 notes: no test feeds a GIF or AVIF input; AVIF transparency is not read back from the output. **CI
after CI1:** the `e2e` job now finishes (~1h17m) instead of being cancelled, but is still red on Linux
WebKit: `tools/crop-pdf-pages.spec.ts:185` (Crop Flatten, `/Rotate 90`) fails every attempt at "red
square in the viewer" — the downloaded file passes its pixel check, so the result view does not show
the flattened page on Linux WebKit; flaky there: `page-numbers-placement.spec.ts:169`,
`sign-pdf-placement.spec.ts:75`, `protect-pdf-permissions.spec.ts:108`, and on Firefox
`compress-image-preview.spec.ts:241` (HEIC) and `organize-pages.spec.ts:102`. Queued as CI2.
| `ae4aaf0` (CI2) | Safari-engine browsers show PDF pages with images instead of black: on Linux WebKit (which, unlike Playwright's Windows WebKit, has OffscreenCanvas in workers) pdf.js drew the decoded ImageBitmap of a full-page JPEG black at ~1.9× downscale — seen in the CI trace as a solid black viewer render of the Crop Flatten output while its thumbnails and the downloaded file were right. `src/lib/pdfjs.ts` now passes `isOffscreenCanvasSupported: false` to every `getDocument` on a WebKit page (user agent `AppleWebKit/` without Chrome/Chromium/Edg/OPR), the path Windows WebKit always took. Test helpers for Page Numbers and Sign placement re-read the viewer image from a fresh decode until it is opaque (WebKit read an empty bitmap from a just-loaded `<img>`) | Clean worktree: 767 Chromium, 924 Firefox/WebKit (1 known WebKit large-file flake), 213 extra WebKit workspace + a11y, 71 mobile, 17 visual, 1041 unit. Live (deployed ~1 min after the push): Crop pages, Page Numbers and Sign placement, Compress PDF specs against docukit.uk on Chromium and WebKit 89/89 functional (H1 console check fails only on the CSP-blocked Cloudflare beacon); workspace contract on WebKit 126/126 |

CI2 notes: whether real Safari (macOS/iOS) had the black render is unknown — it was not available;
the change applies to all WebKit browsers on purpose, at some main-thread cost when drawing images.
CI for the W14 commits (40109981892, 40110622582) failed only on the Crop case CI2 fixes plus the
Firefox HEIC flake. Unaddressed CI flakes: WebKit `protect-pdf-permissions.spec.ts:108` (goto load
timeout), Firefox `organize-pages.spec.ts:102` (lost first click), Firefox
`compress-image-preview.spec.ts:241` (HEIC decode slow under load).
| `ff4ccc5`, `3d4e72a` (W15) | Lock Image and View-Once Image in the workspace — **all 20 tools now run in it**. **Security fixes:** a crafted view-once link could run script on docukit.uk (the `/view/` page used the decrypted type unchecked for a same-origin blob URL, so a `text/html` / SVG payload became a page on the site) — it now renders only JPEG/PNG/WebP/GIF/AVIF/BMP; the Pages Function's 12 MB limit was checked only on `Content-Length` (chunked uploads skipped it) — now on bytes received, and every response sends `Cache-Control: no-store`. Lock Image: PBKDF2 100,000 → 600,000 rounds (round count stored per file, old files still open); image shown large (HEIC/AVIF/BMP newly accepted); strength bar, show-passwords, "What you get"; the locked HTML stores the sniffed type, "Save image" returns the original bytes, honest messages when WebCrypto or scripts are unavailable; non-images refused. View-Once: "What leaves your browser" (encrypted image + expiry; the server sees the IP; never the key, image or name); done state is **Copy link** in the single slot; no Cancel after upload; base64url links (old links still parse); the `/view/` page fetches nothing until "Open image" (link previews and reloads no longer burn the one view), clear expired / incomplete / wrong-key / retryable errors; leaked object URL and extension-less saved file fixed. Copy rewritten from the code for both | Clean worktree: 771 Chromium, 932 Firefox/WebKit (1 Firefox `landing-pages.spec.ts:136` flaky, 3/3 solo), 75 mobile, 17 visual, 1056 unit. Live (~10 min after the push): Lock and View-Once specs (stubbed API) against docukit.uk 37 functional passes on three engines (6 H1 console-check failures all the CSP-blocked Cloudflare beacon), workspace 25/25; **one real view-once on production in Chromium**: upload 201 with a 190-byte ciphertext body (no PNG signature, no key anywhere), 0 API calls before "Open image", image shown and saved byte-identical, reopen 404 "no longer available", `no-store` on all three |

W15 notes: `DownloadButton` / `ActionBar` `download` gained an optional `icon` (contract addition, for
Copy link). `contract.spec.ts` dropped "not migrated is not widened" (no unmigrated tool is left) and
gained a test that fails if a registry tool is missing from `migrated.ts`. "Once" is best-effort on
Cloudflare KV (eventually consistent: two near-simultaneous opens from different locations could both
succeed); the copy claims only "deleted the first time it is opened". Not tested on a real iPhone /
Safari; whether mail or Quick Look previews run the locked HTML is unknown (`<noscript>` note shown).
**CI is green** on `main` again from `ae4aaf0` (runs 40120237750, 40121241773).
| `12099bc` (F1) | Typed signatures are drawn in the handwriting style picked: the four `public/fonts/*.woff2` files were the wrong Google Fonts subsets (Dancing Script = Vietnamese, only A and B; Caveat and Pacifico = Cyrillic-ext; Sacramento = Latin-ext, none of A–Z / a–z / 0–9 — read from each cmap), so every typed signature fell back to a system font. Replaced with the official Latin files (same names, same four styles) plus a `-latin-ext` file each loaded only by `unicode-range` when a name needs it; `public/fonts/OFL.txt` added (SIL OFL 1.1); Sign FAQ says "pick one of four handwriting styles" | Clean worktree: 773 Chromium, 935 Firefox/WebKit (WebKit large-file known flake, 3/3 solo; `image-to-pdf-preview.spec.ts:685` flaky once), 75 mobile, 17 visual, 1056 unit. Live (~1 min after the push): new `sign-pdf-fonts.spec.ts` (failed against production before the deploy) passes on three engines, reading each style's signature image out of the downloaded PDF; Sign mobile 6/6 |

F1 notes: Caveat's Latin file is 48.8 KB (over the 40 KB aim; a custom subset came out larger). The
service worker caches every `*.woff2`, ~100 KB more. The fonts spec repeats the fallback stacks from
`signature-image.ts` instead of importing them.

Lakshay's requests on 2026-10-25, queued: **F2** — Sign PDF upload: pick out only the signature from a
photo of it (paper made transparent, cropped to the ink); **F3** — Sign PDF: an obvious "add to all
pages / chosen pages" at the same place on each page ("Copy to all pages" exists but sits only in the
selection bar under the page).
| `9187f2c` (F2) | Sign PDF picks the signature out of an uploaded photo (Lakshay's request): the Upload tab takes JPEG/PNG/WebP/HEIC (EXIF upright), shows the cleaned signature on a checkerboard with Original / Cleaned, a live Sensitivity slider and "Make ink black"; the stamp is a PNG with alpha cropped to the ink (an `/SMask` image in the PDF, so the page shows through). Pure `src/lib/sign/signature-extract.ts` run in a new `signature-worker.ts` (main-thread fallback): paper colour estimated on a grid and divided out (evens lighting, removes tint), Otsu threshold kept above the paper's noise, specks dropped by component size relative to the pen width (dots of i kept), soft alpha edges, faint ink darkened, 4 px margin. 12 MP photo → preview 0.3–1.2 s by engine; slider 0.05–0.23 s. Copy: new bullet and FAQ with the limits (shadows, ruled lines, print behind the signature) | Clean worktree: 777 Chromium, 944 Firefox/WebKit (WebKit large-file EBUSY known flake), 75 mobile, 17 visual, 1067 unit; the new worker loads under the real CSP with no violation. Live (~2 min after the push): Sign upload, Sign and placement specs against docukit.uk 81 functional passes on three engines (6 failures all the CSP-blocked Cloudflare beacon), mobile 6/6; the worker loads on production in Chromium and WebKit |

F2 notes: ruled lines, printed text and shadows reaching the photo's edge are kept as ink (slider or
Original are the remedies); a very thick marker may be partly taken for paper; the chosen picture is
not kept across tab switches.
| `5ecf3f6` (F3) | Sign PDF puts a signature on every page or the pages chosen, in the same place on each (Lakshay's request): "Put this signature on: This page only / All pages (N) / Choose pages" in the controls pane under "Your signature" (Choose pages = the shared `parsePageRange` field — odd / even / last — synced with page checkboxes); copies keep the same size and distance from the left and bottom edge of each displayed page (`copyRectToPage`, correct on landscape, `/Rotate 90` and offset-CropBox pages); copies stay linked — drag, resize, nudge or mm edit on any page moves them all live, one Undo step; "Unlink page N"; Remove on a linked copy asks This page / All N pages; "Signature on 2 of 4 pages…" line, rail ticks, announcements. Pure `src/lib/sign/stamp-groups.ts`. Copy: two bullets replace "Copy a stamp to every page in one click" | Clean worktree: 783 Chromium, 965 Firefox/WebKit (WebKit `ux/large-file.spec.ts:16` now fails every time on Windows `EBUSY` unlinking its temp file — not F3), 75 mobile, 17 visual, 1073 unit. Live (~1 min after the push): all-pages, Sign and placement specs against docukit.uk 87 functional passes on three engines (6 failures all the CSP-blocked Cloudflare beacon), mobile 6/6 |

F3 notes: new seeded fixture `doc-mixed-pages.pdf` (Letter, landscape, `/Rotate 90`, A5 offset
CropBox). A stamp near an edge that does not fit a smaller page is shrunk/moved by `copyRectToPage`;
editing that copy then passes its fitted size to the others — untested. The design doc's 4.1 still
describes the old flow.
| `d9a7d0e`…`f6da6b0` (F4, 5 commits) | Five small follow-ups. The `MultiFileDownload` result gallery fits its pane instead of the screen (auto-fill columns ≥ 8.5 rem: 2 cards of ~150 px in the workspace pane at 1280 / 1920 and ~140 px at 375, was 4 × ~69 px; names wrap to two lines with the full name as a tooltip; 44 px buttons on touch) — PDF to Image, Split PDF and the Compress / Resize / Convert Image batches. Sign PDF FAQ "Is this legally binding?" now says we cannot tell (law, document type, the other party) and that Sign places an image, not a certificate signature. Homepage search finds tools by other words via a new hidden `searchKeywords` field (join, esign, shrink, remove password, black out, self-destruct…; island +155 bytes). Unused `redact` worker message type removed. `ux/large-file.spec.ts` writes its 51 MB file in Playwright's output folder and tolerates a locked file on cleanup | Clean worktree: 790 Chromium, 968 Firefox/WebKit, 75 mobile, 17 visual, 1077 unit — no flakes, no failures (large-file passes on WebKit again). Live (~2 min after the push): result-gallery + home-search specs against docukit.uk 82 functional passes on three engines, PDF to Image + Split 47 on Chromium (7 failures all the CSP-blocked Cloudflare beacon), mobile project 75/75 |
| `4c7bf22`, `ba037ef` (F5) | Image to PDF "Fit Image" pages are a printable size instead of one point per pixel: the page keeps the image's exact proportions at the DPI the file states (JFIF / EXIF / PNG pHYs, 100–1200 DPI) or 150 DPI, long edge capped at A3's 420 mm; the embedded image is untouched (full resolution, upright JPEGs byte-for-byte). A 12 MP photo was 1.41 × 1.06 m, now 420 × 315 mm; at a stated 300 DPI 339 × 254 mm; an A4 300 DPI scan is exactly A4. Only the 16 Fit Image rows of the pinned layout table changed. Redact "Find & mark all" marks only the phrase (was the whole line): MuPDF's own text search in the worker (new `op: 'search'`), any capitals, across text items and line breaks, rotated / offset pages; marks are padded 12% of their height then pulled clear of every neighbouring character, because MuPDF deletes any character a mark overlaps at all — the old whole-line marks could delete letters on the lines above and below on single-spaced text. Copy: "Find & mark every place a phrase appears"; Fit Image FAQ and note | Clean worktree: 794 Chromium, 968 Firefox/WebKit, 75 mobile, 17 visual, 1096 unit — no flakes (the WebKit step was cut off by the session ending overnight and re-run). Live (~2 min after the push): Image to PDF, source-check and Redact specs against docukit.uk 64 functional passes on each of three engines (3 per engine all the CSP-blocked Cloudflare beacon), mobile 8/8 |

F5 notes: a Fit Image page for a tiny or very thin image can fall below PDF's 3 pt minimum (as
before for 1–2 px images); MuPDF search returns at most 1000 matches per page.
| `ef62090`…`d8de25a` (F6, 5 commits) | Compress PDF wins back size and says what it does. **Identical images stored once** (lossless, every level; `src/lib/pdf-dedupe.ts` on pdf-lib's object graph — bytes and every dictionary entry but /Length must match, masks / ICC / palettes compared by content): on a 3-page fixture with repeated images Low 886 → 432 KB, Medium/High ~202 KB vs ~292/259 KB on the old live site, pixel-identical. **The DPI setting is a real DPI**: `src/lib/pdf-image-placement.ts` reads the content streams for how large each image is drawn and reduces only along an axis drawn sharper than the setting (Medium 150, High 96 DPI; images it cannot place keep their resolution); facts say "reduced to 96 DPI as drawn on the page (from 141 DPI)" — High is gentler than the old blanket 48% scale on stretched images (`doc-photo.pdf` High 14.1 KB, was 7.3 KB). **"Strip embedded fonts" removed** (it lost text). **Soft-masked images compressed** keeping their `/SMask` (narrow allow-list extension: Flate 8-bit grey/RGB base with a plain same-size 8-bit grey SMask and no /Mask; anything with a /Mask — the T4 black-page shape — still untouched): a soft-masked fixture 160 KB → Medium 23 KB. **The preview sends the file to its worker once** per file (`workerPool.openSession`): 48 659 bytes per page change → 0 | Clean worktree: 806 Chromium, 1000 Firefox/WebKit, 75 mobile, 17 visual, 1120 unit — no flakes; image-safety ×2 on three engines 96/96. Live (~1 min after the push): compress, alpha and dedupe specs against docukit.uk 57 functional passes on three engines (3 failures the CSP-blocked Cloudflare beacon), image-safety 48/48, Compress landing pages 2/2, mobile 3/3 |

F6 notes: a preview page can differ from the full run when the same image is also drawn larger on
another page (the per-image DPI rule uses the largest placement). Lakshay's T4 scan gains from
dedupe only: its overlay carries a /Mask and stays untouched. `docs/design/compress-preview.md`
still mentions `stripFonts` and the scale-based DPI (historical).
| `71bebaa` (F7) | Watermark PDF: drag a single watermark anywhere on the page (mouse, touch, pen); the position becomes Custom, stored as the centre as fractions of the displayed page, so every page in "Apply to" gets it at the same relative spot; only the centre is kept on the page (the watermark may hang over the edge, clipped as in the file); arrow keys nudge 0.5% (Shift 5%), "Centre from left / top (mm)" fields, "Reset position", and the nine presets still snap; tiled mode has no drag box and says why. One layout function (`watermark-layout.ts`, new `'custom'` position) still drives preview and file. Shared `OverlayLayer` / `OverlayBox` gained `resizable`, `keepOnPage` and `help` (defaults unchanged). Copy: two bullets, new FAQ | Clean worktree: 814 Chromium, 1007 Firefox/WebKit, 76 mobile, 17 visual, 1132 unit — no flakes; Sign / Edit / Digital Signature (shared overlay) pass on every engine. Live (~1 min after the push): Watermark specs against docukit.uk 18 functional passes per engine on three engines (2 each the CSP-blocked Cloudflare beacon), Sign placement 16/16 on Chromium and WebKit, phone drag 3/3 |

F7 notes: Watermark has no undo history (Reset position and presets are the way back). The mm fields
measure on the page shown; on mixed page sizes the same fraction is different mm elsewhere (the help
text says so). Not checked in a desktop PDF reader or on a real phone.
| `09b5fae`…`966e339` (CI3, 7 commits) | CI's `e2e` job is sharded: 9 jobs (Chromium + mobile ×2, Firefox ×3, WebKit ×4, `fail-fast: false`, 40 min each) inside `mcr.microsoft.com/playwright:v1.62.1-noble` (installing browsers hung 10+ min on 3 of 9 shards; a step fails the job if the locked `@playwright/test` is not 1.62.1, so a Playwright bump must bump the image tag), plus an `e2e passed` job to require; actions at v7; triggers now include pushes to `task/**` and `workflow_dispatch`. **Product fix:** Firefox crashed the tab when Convert / Compress was clicked while a HEIC preview was still decoding — the pool terminated the image worker while heic-to's nested worker was busy; the image pool now answers a cancelled job at once and ends its worker only after it finishes (1 crash in ~35 local runs → 0 in 120). Test fixes: Compress Image contract waits for the action to fade in before axe; Extract PDF Pages landing test waits for every page before clicking | CI on the branch: green twice (12m10s, 15m22s). Clean worktree: 814 Chromium, 1007 Firefox/WebKit, 76 mobile, 17 visual, 1132 unit, image tools ×3 on Firefox 138/138 — no flakes. Live (~1 min after the push): Compress Image preview + Convert specs against docukit.uk 81 functional passes on three engines, HEIC / Extract landing pages on Firefox and WebKit (10 failures all the CSP-blocked Cloudflare beacon). **First sharded CI run on main (40328873858): success in 15m08s** (was ~1h26m; WebKit 2/4 the long pole at 15m) |

CI3 notes: still unexplained CI flakes — WebKit `home-search.spec.ts:298` (the island hydrated though
the test blocks its script; 2 of 8 runs), Chromium `sign-pdf-all-pages.spec.ts:164` (a drag not
registered, 1 of 8), a one-off WebKit `page.goto` internal error. `protect-pdf-permissions:108` and
`organize-pages:102` did not recur in 8 runs. Whether stock Firefox (not Playwright's) also crashed
on the HEIC cancel is unverified.
| `1de4b62`…`fcf2326` (F8, 7 commits) | Copy-truth sweep and fixture untracking. View-Once uploads an encrypted copy, so "Files never leave your device" / "never uploaded" / "No uploads, no accounts, no limits" (hero, footer, homepage meta) now say files are processed on the device and not uploaded except View-Once's encrypted copy (real limits exist: Merge 50 files, View-Once 10 MB, Resize 10,000 px); View-Once share image tagline "Encrypted in Your Browser · Link Opens Once"; Edit PDF and Lock Image share images redrawn with current text. Privacy page (Oct 2026): what View-Once sends (encrypted image + expiry; key after `#` never sent; server sees the IP, our function stores nothing), and "Docukit's code sets no cookies and includes no analytics or tracking scripts" — scoped to our code because of Cloudflare's injected script (below). Registry: Split "up to 500 pages reliably" (unbacked), Unlock "Instant", Digital Signature "verifies the signer's identity" corrected. Unused `HowItWorks.astro` / `TrustSection.astro` (untrue claims) deleted. New guard `parity/no-free-copy.spec.ts` (every built page's visible text, titles, meta, alt/aria/placeholder, manifest, share-image strings). The nine generated fixtures under `tests/e2e/fixtures/files/` untracked and the folder ignored (a clean checkout generates all 31 at globalSetup). Home-search position checks tolerate < 0.05 px (the longer hero put the heading on a fractional y; Firefox rounded it differently) | Clean worktree (895fb2a): 854 Chromium, 1011 Firefox/WebKit, 76 mobile, 17 visual, 1132 unit; one Firefox sub-pixel failure fixed in `fcf2326`, re-gated (home-search ×3 on Firefox 69/69, Chromium / WebKit / mobile, parity 102). Live (~2 min after the push): new hero, privacy wording and share image served; parity incl. the free-word guard 102/102 against docukit.uk; landing pages and home-search functional passes (beacon-only failures) |

F8 notes: **Measured on production** (fresh Chromium, plain homepage visit): Cloudflare's JavaScript
Detections load `/cdn-cgi/challenge-platform/.../jsd/main.js` and POST to `.../jsd/oneshot/...`, and
set one cookie, `cf_clearance` (`.docukit.uk`, httpOnly, expires in one year). The site's own code
sets none — hence the scoped privacy wording until Lakshay switches JS detections off. **Found:**
`ux/home-search.spec.ts:298` fails every time against production (and was the WebKit CI flake): the
test blocks `**/_astro/ToolSearch.*.js`, but Astro retries the island script as
`ToolSearch.<hash>.js?astro-retry=<ts>`, which the pattern misses, so the island hydrates — a test
gap, queued. Remaining unproven bullets: Merge "Up to 50 files at once", Protect "Password strength
meter"; partial: Compress PDF grayscale, PDF to Image folder/share, Convert GIF/AVIF input and AVIF
transparency, View-Once expiry.
