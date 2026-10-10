# DocuKit — handoff for the coordinator session

Written 2026-10-10 at the end of a long single-agent session. The next session is meant to run as a
**coordinator** that spawns one sub-agent per task, keeps notes, and ships to production. This file is
the brief; `WORKLOG.md` is the running log the coordinator appends to.

Read sections 1–5 before spawning anything. Section 6 is the backlog.

---

## 1. Where things stand

- **Production** is `https://docukit.uk`, deployed by Cloudflare Pages from `main`. Every push to `main`
  deploys (about 1–2 minutes).
- **`main` = `c61ae27`** ("Upgrade to Astro 7…"). The local branch `remediation/phases-0-3` is the same
  commit. All work from the last session is committed, pushed and verified live.
- **CI** (`.github/workflows/ci.yml`): job `ci` = typecheck, lint, unit tests, build, Lighthouse
  (non-blocking), `npm audit --audit-level=critical`. Job `e2e` = full Playwright suite on four projects
  against a production build. `ci` is green as of `c61ae27`.
- **Stack:** Astro 7 (static output) + React islands + Tailwind 4, Vite 8. PDF work via pdf-lib, pdf.js,
  MuPDF and qpdf (all WASM, in Web Workers). Image codecs via jSquash; HEIC via `heic-to/csp`.
  Cloudflare Pages Functions in `functions/` back the view-once tool.

### 1.1 Uncommitted work in the working tree — decide this first

The working tree at `D:\Project\DocuKit` holds a finished but **never committed** batch from an earlier
session (the "source-check sweep" described at the top of `FIX-PLAN.md`'s uncommitted diff). It is not
from the last session and was deliberately left untouched. It contains:

| Area | What it adds |
|---|---|
| Split PDF, PDF to Image | A thumbnail page grid (`shared/PageSelectorGrid.tsx`, untracked) — production currently shows **no pages at all** in Split |
| Watermark PDF | "Specific pages" range and a real front/behind layer control |
| Add Page Numbers | A font selector that actually changes the embedded font |
| Image to PDF | Margin units (mm / in / pt) that convert |
| Sign PDF | Place a stamp on every page in one action |
| Registry + coverage | Copy trimmed where a claim was false; `coverage.ts` notes |
| Tests | `tests/e2e/parity/source-check-closures.spec.ts` (untracked) + `harness.ts` helpers |

Files: `ImageToPdfTool.tsx`, `PageNumbersPreview.tsx`, `PageNumbersTool.tsx`, `PdfToImageTool.tsx`,
`SignPdfTool.tsx`, `SplitPdfTool.tsx`, `WatermarkPdfTool.tsx`, `lib/pdf-preview.ts`,
`lib/tools-registry.ts`, `types/worker-messages.ts`, `workers/pdf-worker.ts`,
`tests/e2e/helpers/harness.ts`, `tests/e2e/parity/coverage.ts`, `FIX-PLAN.md`, plus the two untracked
files. (`.claude/settings.local.json` and the regenerated fixtures under `tests/e2e/fixtures/files/`
are noise — never commit them.)

Every local e2e run last session was against this tree and passed, including the untracked spec.

**Recommendation — task T0:** review it, commit it in logical commits, verify from a clean worktree,
ship it. It must go first because git worktrees are cut from `HEAD`, so sub-agents will not see this
work until it is committed, and four backlog tasks edit the same files. **Confirm with Lakshay before
committing it** — it is his tree and he has not yet said what it is.

Until T0 lands, any commit touching those files must stage only its own hunks (the last session did
this by rebuilding the index blob from `HEAD` + the intended change).

---

## 2. Standing instructions from Lakshay

1. **Ship verified work straight to production.** Verify, commit, push `HEAD:main`, confirm on
   docukit.uk, move to the next thing. Do not stop to ask between changes.
2. **Never show the word "free"** in visible copy: titles, descriptions, headings, FAQs, share images.
   The no-cost signal lives only in structured data (`offers.price: 0`). No hidden keyword text.
3. **Only claim what the tools really do.** Read the code before writing any feature claim; existing
   copy is not evidence. The parity gate (`tests/e2e/parity`) enforces that every bullet in
   `tools-registry.ts` is accounted for in `coverage.ts`.
4. **Keep the privacy promise.** The privacy page says no analytics or tracking scripts. The CSP
   blocks the Cloudflare Web Analytics beacon on purpose; Lakshay will switch the beacon off in the
   Cloudflare dashboard himself. Do not allowlist it.
5. **Explain plainly.** Lakshay is comfortable in the codebase but newer to infrastructure; give
   step-by-step instructions for anything he has to do in a dashboard.
6. Commit messages: a short imperative subject that says what changed for the user, a body that says
   why, ending with the `Co-Authored-By:` line the session supplies.

---

## 3. How to verify and ship (the procedure that worked)

```bash
npm run typecheck && npm run lint && npm test      # fast gates (lint: 0 errors; 4 known warnings)
npm run build                                      # ~12s on Astro 7
node scripts/serve-dist.mjs                        # serves dist/ on :4322 WITH the real _headers/CSP
E2E_BASE_URL=http://localhost:4322 npx playwright test <specs> --project=chromium --reporter=line
```

- Always test against the **production build via `serve-dist.mjs`**, not `astro dev`: it applies
  `dist/_headers`, so a CSP that breaks a tool breaks the test. (That is how the HEIC regression was
  eventually caught.)
- Full pre-push gate used last session: whole non-visual suite on Chromium
  (`--grep-invert "visual regression"`), plus `tests/e2e/tools tests/e2e/guards tests/e2e/xbrowser
  tests/e2e/ux` on Firefox and WebKit, plus the `mobile` project. About 15 minutes.
- **After pushing, check the live site**, not just CI: load the changed pages in Playwright against
  `https://docukit.uk` and run the changed tool end to end.

### Clean-worktree verification (tests exactly what is committed)

```bash
WT="$TEMP/docukit-verify"
git worktree add -q --detach "$WT" HEAD
cd "$WT" && cmd //c "mklink /J node_modules D:\\Project\\DocuKit\\node_modules"
node scripts/sync-pdfjs-worker.mjs        # REQUIRED — see gotchas
npm run build && PORT=4323 node scripts/serve-dist.mjs &
E2E_BASE_URL=http://localhost:4323 npx playwright test ...
# teardown — junction FIRST, or the real node_modules can be deleted:
cmd //c "rmdir <full windows path>\\node_modules" && git worktree remove --force "$WT"
```

### Gotchas that cost time

- **pdf.js assets are gitignored** (`public/pdfjs/{standard_fonts,cmaps,wasm,iccs}`) and copied by
  `postinstall`. A worktree that reuses `node_modules` must run `sync-pdfjs-worker.mjs`, or nine
  WebKit PDF tests fail on a font 404 that looks like a real regression.
- **`npm install` mutates the shared `node_modules`.** Never run it while another worktree is testing.
- **Git Bash heredocs** containing JS template literals or stray quotes fail to parse. Write edit
  scripts to a file with the Write tool and run them with `node`.
- **GitHub's unauthenticated API is limited to 60 requests/hour.** Do not poll check-runs in a loop;
  poll the live site instead, or have Lakshay run `gh auth login` (the `gh` CLI was not installed).
- **Line endings:** files are LF in git, some are CRLF on disk. Preserve whatever the file uses.
- **Known flaky tests** (pre-existing, not regressions): `a11y/keyboard.spec.ts` keyboard reorder on
  Chromium; `ux/large-file.spec.ts` on WebKit (`EBUSY` unlinking a temp file on Windows). CI runs with
  `retries: 2`.
- Astro's `trailingSlash` is deliberately left at the default: every URL the site emits has a trailing
  slash, but dev/preview accept both so tests can `goto('/merge-pdf')`.

---

## 4. Coordinator protocol

Lakshay's rule, which applies to **every** task he asks for from now on, large or small:

> The coordinator does no work itself. It only coordinates. Sub-agents do all the work.

The goal is parallel speed without two agents corrupting each other's work.

### What the coordinator does — and nothing else

- Reads this file and `WORKLOG.md`, and talks to Lakshay.
- Breaks requests into tasks, writes each sub-agent's brief, spawns it, and reads its report.
- Does the git bookkeeping of integration: rebase or merge a finished task branch onto `main`,
  `git push`, clean up worktrees and branches.
- Appends to `WORKLOG.md` after every integration, and keeps the backlog in this file current.

### What the coordinator never does

- Edit source, tests, copy or config. Not even a one-line fix — spawn an agent.
- Investigate a bug, read through code to design something, or debug a failing test.
- Run builds or test suites. The pre-push gate and the live-site check are run by a dedicated
  **verify agent** (see rule 2), whose report the coordinator acts on.

If the coordinator catches itself opening a source file to understand a problem, that is the signal to
write a brief instead.

### Handing off at half context

When roughly **half of the coordinator's context is used** — or sooner if Lakshay asks — it must:

1. Stop spawning new tasks and let running agents finish; integrate what is ready.
2. Have a sub-agent rewrite this file so that sections 1, 5 and 6 describe the state at that moment
   (what `main` is, what shipped, what is in flight on which branch, what is left, anything learned
   that the next coordinator needs), and bring `WORKLOG.md` up to date.
3. Commit and push both files.
4. Give Lakshay a kickoff prompt for the next chat, in the same form as the one at the bottom of this
   file, so the next coordinator works in exactly the same way.

Do not wait until context is nearly full: a handoff written by a coordinator that is already losing
detail is worse than one written early.

### Rules for the work

1. **One task = one sub-agent = one git worktree = one branch** (`task/<id>-<slug>`), cut from the
   current `main`. Give each agent its own port for `serve-dist.mjs` (4330, 4331, …).
2. **Only the coordinator pushes, and only after a verify agent says so.** Task agents commit to their
   branch and report back; they never push to `main`. The coordinator rebases a finished branch onto
   `main`, spawns a **verify agent** to run the pre-push gate from section 3 on that exact commit,
   pushes if it passes, then has the verify agent confirm the change on docukit.uk. Then it appends
   to `WORKLOG.md`.
3. **Integrate one branch at a time.** After each push, tell still-running agents to rebase.
4. **Respect the hot files** — these are edited by almost every task and will conflict:
   `src/lib/tools-registry.ts`, `src/lib/landing-pages.ts`, `tests/e2e/parity/coverage.ts`,
   `src/workers/pdf-worker.ts`, `src/types/worker-messages.ts`,
   `src/components/islands/shared/*`. Either give one agent ownership of a hot file per round, or have
   agents report the registry/coverage lines they need and let the coordinator apply them.
5. **Do not run heavy Playwright suites in parallel.** The tools are CPU-bound WASM; the config already
   limits itself to 2 workers on this laptop. Task agents run only the specs for their own tool, on
   Chromium. The full cross-browser gate is run by one verify agent at a time, before each push.
6. **Three or four agents at a time is the practical ceiling** on this machine. Each agent starts with
   no context, so its brief must include: the task spec from section 6, sections 2 and 3 of this file,
   the files it owns, the files it must not touch, and its port.
7. **Every agent brief ends with a required report:** commits made, files touched, tests run with
   results, anything it noticed but did not fix, and any claim in the copy it could not verify.
8. Treat a task agent's "done" as a claim. The verify agent re-runs its tests at integration time.
9. **Small requests follow the same route.** A one-line copy change still goes to a sub-agent and
   through the verify agent; the coordinator does not make an exception because a task looks trivial.

---

## 5. What the last session shipped (all live)

- Canonical URLs, JSON-LD and internal links now use the trailing-slash URLs that actually serve;
  `/view/` removed from the sitemap. (Search Console had 21 "Page with redirect", 1 "noindex".)
- Structured data and share images now reach the page (a missing `head` slot was dropping them);
  per-tool OG images generated by `npm run generate:og`.
- Security headers deploy for the first time (`public/_headers`), including a CSP with
  `'wasm-unsafe-eval'`. `serve-dist.mjs` applies the same file.
- 15 task landing pages in `src/lib/landing-pages.ts` (Rotate PDF, Delete/Extract PDF Pages, PDF to
  JPG, JPG to PDF, PNG/WebP/HEIC conversions, Compress Image to 50/100KB, Compress PDF to
  100KB/200KB/1MB). Guarded by `landing-pages.test.ts`.
- Rearrange PDF: batch rotate (selection or all pages).
- Compress PDF: Target size mode (`compressPdfToTarget` in `lib/pdf-compress.ts`).
- HEIC conversion fixed under the CSP; real HEIC fixture at `tests/e2e/fixtures/static/photo.heic`.
- Upload box no longer changes height after a file is added (it caused missed clicks).
- Astro 6 → 7 to clear the last critical `npm audit` advisory.

---

## 6. Backlog

Estimates are single-agent working time including verification. "Parallel-safe" says what it
conflicts with.

### T0 — Ship the uncommitted source-check work · ~1–1.5h · **serial, first**
See 1.1. Blocks T2, T4 and the per-tool reviews of the files listed there.

### T1 — Merge PDF: page-level view · ~2.5–3h · needs T-shared
Lakshay's request (2026-10-10, with a screenshot): the per-file range inputs give no idea what will
come out, and the first-page cards are small and unclear. He wants every page shown, the output order
visible, and pages rearrangeable.

Design worked out last session:

- **Model:** `pageList: { id, fileId, pageIndex | null }[]` in output order is the source of truth
  (`pageIndex: null` = "all pages of a locked file whose page count is unknown").
- **Files** become compact sortable rows (extend `FileList`'s `rows` variant with optional
  `renderLeading` / `renderExtra` props): colour-coded letter badge (A, B, C…), name, page count, the
  existing range input (`data-testid="page-range-input"`, same `aria-label`), inline password field for
  encrypted files, remove button.
- **"Pages in the merged PDF"** grid below: every page as a clear thumbnail with its file badge, its
  output position, and "A · page 2". Drag to reorder across files; × to leave a page out; click to
  enlarge (T-shared zoom dialog); S/M/L size toggle; "Reset order".
- **Sync:** typing a range replaces that file's pages in the grid (at the position of its first page);
  an unparseable range marks the input invalid and changes nothing. Removing a page in the grid
  rewrites that file's range text via `formatPageRange`. Reordering files regroups the grid by file,
  keeping each file's own page order.
- **Worker:** add `MergeOptions.segments?: { file: number; pages: number[] }[]` (runs of consecutive
  pages from one file, in output order). In `merge()` build a `parts` list from `segments`, else from
  the per-file selections as today, and loop over that in both paths. In `mupdf-merge.ts` give
  `MergeInput` a `sourceKey` so several runs of one file share one opened document and one page map;
  graft all pages first, then re-create links and remap each source's outline **once** with the
  complete map. "Insert a blank page between documents" fires only where the source file changes.
- Existing tests to keep green: `tools/merge-pdf.spec.ts`, the three merge tests in
  `parity/closed-gaps.spec.ts` (bookmarks, fast path, password).
- New tests: interleaving pages from two files yields that exact page order (use
  `extractPdfText`); removing a page drops it; a typed range updates the grid and vice versa; the
  bookmark path still remaps correctly when a file is split across runs.

### T2 — Split PDF: show the document and the result, in every mode · ~2.5h · needs T0 and T-shared
Lakshay: "in split rn we don't show pdf at all, how does end user see what pdf they are playing with
or what they're gonna get" — and he wants it "in each mode".

- Always show the pages after upload: large clear thumbnails (S/M/L), click to enlarge.
- The text field stays the source of truth (so `odd`, `even`, `last` keep working); clicking a page
  rewrites it. T0 already contains this logic for a small grid — build on it.
- Per mode, the grid itself shows the outcome:
  - **Extract Pages:** selected pages highlighted, the rest dimmed. "You'll get 1 PDF with N pages."
  - **Remove Pages:** selected pages marked "Removed"; the rest are what you keep.
  - **Split by Range:** each range colour-coded and labelled "PDF 1", "PDF 2"…; pages in no range
    dimmed as "not included".
  - **Split Every N:** groups shown with alternating colour and a divider; last group may be shorter.
  - **Extract Each Page:** every page labelled with its own PDF number.
- Under the grid, an **output list**: one row per file that will be produced, with its real name
  (`<name>-split.pdf`, or `<name>-part1.pdf`… inside `<name>-split.zip`), page range and page count.
- Keep testids the T0 spec relies on: `page-selector`, `page-select-<n>`, `page-thumb`.
- The landing pages `/delete-pdf-pages/` and `/extract-pdf-pages/` reuse this tool; their copy says
  pages are chosen by typing — update it once the grid is live.

### T-shared — pieces T1 and T2 both need · ~1.5h · do before T1/T2 or inside T1
- `lib/pdf-thumbs.ts`: open a document once, report the page count immediately, render every page
  progressively with a callback, cancellable. Render in idle slices — `usePdfThumbnails` currently
  rasterises every page on the main thread with a state update per page (noted as a performance bug in
  `FIX-PLAN.md`).
- `shared/PagePreviewDialog.tsx`: an accessible modal (`role="dialog"`, Esc and backdrop close, focus
  returned on close) that renders one page large (~1600px) on demand.
- A shared page card (thumbnail, badge, label, optional state overlay) so Merge, Split, Rearrange and
  PDF to Image look the same.

### T3 — HEIC where it is advertised but broken · ~1.5h · conflicts with T0 (Image to PDF)
Verified against a real file last session:
- Compress Image: "The source image could not be decoded" — `compressImage` in `lib/image-ops.ts`
  calls `createImageBitmap` directly; route it through the libheif fallback in `lib/image-codec.ts`.
- Resize Image: the dropzone rejects HEIC and `resizeImage` has the same decode problem.
- Image to PDF: the dropzone rejects HEIC although the hero copy and a feature bullet promise it
  (also TIFF and SVG — check each). pdf-lib embeds only JPEG/PNG, so decode and re-encode first.
- Add tests with `FIXTURE.heic`; move the coverage entries to `covered`.

### T4 — Compress PDF drops image transparency · ~1h · parallel-safe
`compressPdfOnce` replaces an image stream with a new dict that has no `/SMask`, so images with a soft
mask lose it. Skip images that carry `/SMask` or `/Mask` (or carry the mask across). Needs a fixture
PDF with a transparent PNG and a rendered-pixel assertion.

### T5 — Result panels shift the layout · ~45m · touches `shared/*`
One WebKit run lost a click on the download button right after a result appeared. Same class of bug
as the upload-box fix (`ux/layout-stability.spec.ts`). Check whether the result panel or toast moves
the download button, fix, and extend that spec.

### T6 — Installable / offline (PWA) is not working · ~1–1.5h · parallel-safe
`@vite-pwa/astro` generates `sw.js`, but no page registers it and no page links the manifest. If it
were registered it would throw: the generated worker has a `NavigationRoute` bound to `/`, which is
not in the precache (HTML is excluded by `globPatterns`). The PRD lists "installable, offline-capable".
Decide the caching design deliberately — a stale-HTML bug here is hard to recover from.

### T7 — Titles and descriptions for all 20 tools · ~1h · owns `tools-registry.ts`
Blocked on the full `Queries.csv` export from Search Console (Lakshay could not export it yet). Known
from a screenshot: 9 of the top 10 queries are about view-once image sharing ("one time view image",
"view once photo link", "upload image delete after first view"); "docukit" ranks about 6th. A first
pass from those phrases is possible; refine when the export arrives. Titles ≤ 60 chars, descriptions
≤ 160, no "free".

### T8 — Tool-by-tool review · ~20–30m per tool, 20 tools · parallel by tool, hot-file care
For each tool: run it for real, compare every claim on its page with the code, fix or trim what is
false, deepen the page copy (use cases, "which tool should I use", more FAQs — the competitor has 8
per page, DocuKit has 4), and compare the screen with ihatepdf.cv's equivalent. Only Rearrange,
Convert Image and Compress PDF were touched last session, and only for specific fixes.
`FIX-PLAN.md`'s uncommitted section already lists false claims found by source reading.

### T9 — New tools (browser-only) · ~1–2h each; OCR and Compare ~half a day each
Flatten PDF, headers and footers, extract images, extract text, edit metadata, pages per sheet, OCR,
compare PDFs, Markdown/HTML to PDF. Skip Word/Excel conversion and AI chat. Each new tool needs a
registry entry, a coverage entry, a spec, an icon and an OG image.

### T10 — Guides and "alternative to" pages · ~1.5h for the section, ~15–20m per article
ihatepdf.cv has 113 guides and three alternative pages; DocuKit has none. Needs a content collection
and layout first.

### T11 — Homepage tool search · ~45m · parallel-safe
`src/components/ui/command.tsx` exists but is unused. With 20 tools and 15 task pages, search earns
its place.

### Lakshay's own to-dos
- Turn off Web Analytics in the Cloudflare dashboard (Pages project → Metrics → Web Analytics).
- In Search Console, click **Validate Fix** on the "Excluded by noindex" report only. Leave "Page with
  redirect" alone — the slash-less URLs will always redirect.
- Export `Queries.csv` (Performance → Export) when the export works.
- Install the GitHub CLI: `winget install --id GitHub.cli`, then `gh auth login`.

### Suggested first round
1. T0 alone (serial; needs Lakshay's go-ahead).
2. Then in parallel: **T-shared → T1** (one agent), **T3**, **T4**, **T6** or **T11**.
3. Then **T2** (after T0 and T-shared), **T5**, and the first few tools of **T8**.

---

## 7. Map of the code

| Path | What it is |
|---|---|
| `src/lib/tools-registry.ts` | The 20 tools: copy, FAQs, steps, feature bullets. Marketing claims live here. |
| `src/lib/landing-pages.ts` | Task pages = an existing tool + a preset. May only repeat the base tool's bullets. |
| `src/components/tool-page/ToolPageLayout.astro` | Every tool and task page: JSON-LD, hero, island, popular tasks, related, FAQ. |
| `src/components/islands/<tool>/` | The interactive tools (React). |
| `src/components/islands/shared/` | DropZone, FileList, PageThumbnailGrid, DownloadButton… |
| `src/workers/pdf-worker.ts`, `worker-pool.ts` | PDF operations; the pool falls back to inline on engines without OffscreenCanvas. |
| `src/lib/pdf-compress.ts`, `image-ops.ts`, `image-codec.ts` | Plain functions shared by worker and main thread. |
| `public/_headers` | Deployed security headers and CSP. A `_headers` at the repo root is never deployed. |
| `tests/e2e/parity/coverage.ts` | Every advertised bullet → the test that proves it, or an honest "unproven". |
| `tests/e2e/helpers/harness.ts` | Upload/download helpers; `uploadFiles` waits for island hydration. |
| `scripts/serve-dist.mjs` | Static server that applies `dist/_headers`. |
| `scripts/generate-og-images.ts` | Regenerate share images after adding a tool or task page. |

---

## 8. Kickoff prompt for the next chat

Paste this as the first message of a new session opened in `D:\Project\DocuKit`:

```text
You are the coordinator for DocuKit. Read HANDOFF.md and WORKLOG.md in the repo root before doing
anything else, and follow the coordinator protocol in HANDOFF.md section 4 exactly.

You do no work yourself. For every task — including small ones — spawn a sub-agent in its own git
worktree and branch, and use a separate verify sub-agent to run the pre-push gate and the live-site
check. Your own actions are limited to: briefing and spawning sub-agents, reading their reports,
rebasing/merging and pushing to main, keeping WORKLOG.md and the HANDOFF.md backlog up to date, and
talking to me. Run independent tasks in parallel (three or four at a time), and push each one to
production as soon as it is verified.

Start with task T0 in HANDOFF.md: ask me whether the uncommitted work in the working tree should be
shipped, then proceed with the suggested first round.

When about half of your context is used, stop spawning new work, finish integrating what is ready,
have a sub-agent update HANDOFF.md and WORKLOG.md to the current state, push them, and give me a
kickoff prompt like this one for the next chat.
```
