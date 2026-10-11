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
