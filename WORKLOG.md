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

Queue changes since `HANDOFF.md` was last rewritten (fold these in at its next update): T11, T16,
T15 and W1 are done; the workspace's step 1c (splitting `pdf-worker.ts`) is dropped because it only
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
