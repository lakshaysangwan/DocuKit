# DocuKit — handoff for the coordinator session

Rewritten 2026-10-23 at the end of the second coordinator session (11–23 October). The next session
runs as a **coordinator** that gives every task to a sub-agent, **one sub-agent at a time**, and ships
each verified task to production. This file is the brief; `WORKLOG.md` is the running log (read it
from the 2026-10-11 heading); `docs/design/tool-workspace.md` is the workspace design.

Read sections 1–5 before spawning anything. Section 6 is the queue.

---

## 1. Where things stand

- **Production** is `https://docukit.uk`, deployed by Cloudflare Pages from `main`. Builds now start
  up to ~10 minutes after a push; allow 15 minutes before calling a deploy stuck.
- **`main` is `52db184`** plus this documentation commit. Everything in `WORKLOG.md` through W12 is
  pushed, verified in a clean worktree and checked on the live site.
- **Nothing in flight:** no task branches, no worktrees besides the main checkout. An empty leftover
  folder `D:\Project\docukit-wt\verify` may exist — harmless.
- **The main tree** at `D:\Project\DocuKit` shows only noise in `git status`:
  `.claude/settings.local.json` and regenerated fixtures under `tests/e2e/fixtures/files/`. Never
  stage them. `remediation/phases-0-3` is an old unused branch.
- **CI** (`.github/workflows/ci.yml`): job `ci` = typecheck, lint, unit tests, build, Lighthouse
  (non-blocking), `npm audit --audit-level=critical`; job `e2e` = full Playwright suite on four
  projects against a production build. `gh run list --branch main --limit 5`.
- **Stack:** Astro 7 (static output) + React islands + Tailwind 4, Vite 8. PDF work via pdf-lib,
  pdf.js, MuPDF and qpdf (all WASM, in Web Workers). Image codecs via jSquash; HEIC via `heic-to/csp`.
  Cloudflare Pages Functions in `functions/` back the view-once tool.

---

## 2. Standing instructions from Lakshay

1. **Ship verified work straight to production.** Verify, commit, push to `main`, confirm on
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
7. **One sub-agent at a time.** On 2026-10-11: "let's do one after another no multiple subagents. too
   much token consumption." See section 4.

Lakshay tests the live site himself and reports what he finds, usually with a screenshot or one of his
own files. Those reports are where T4, T14 and most of the current queue came from. The practice so
far when a task needs one of his files: the agent reads it in place and never copies it into the repo,
commits it or quotes its content.

---

## 3. How to verify and ship (the procedure that worked)

```bash
cd /c/ && cd "D:/Project/DocuKit"                  # exact case — see gotchas
npm run typecheck && npm run lint && npm test      # lint: 0 errors, 3 known warnings; 94 unit tests
npm run build                                      # ~12s on Astro 7
node scripts/serve-dist.mjs                        # serves dist/ on :4322 WITH the real _headers/CSP
E2E_BASE_URL=http://localhost:4322 npx playwright test <specs> --project=chromium --reporter=line
```

- Always test against the **production build via `serve-dist.mjs`**, not `astro dev`: it applies
  `dist/_headers`, so a CSP that breaks a tool breaks the test. (That is how the HEIC regression was
  eventually caught.)
- **Pre-push gate**, run by a verify agent from a clean worktree of the exact commit: the whole
  non-visual suite on Chromium (`--grep-invert "visual regression"`), plus `tests/e2e/tools
  tests/e2e/guards tests/e2e/xbrowser tests/e2e/ux` on Firefox and WebKit, plus the `mobile` project,
  plus the visual specs on Chromium. At `491dcb4` that is about 354 tests on Chromium, 357 across
  Firefox and WebKit, 22 mobile, 9 visual and 94 unit. A verify agent took 20–35 minutes this
  session, gate and live check together.
- **After pushing, check the live site**, not just CI: load the changed pages in Playwright against
  `https://docukit.uk` and run the changed tool end to end, reading the downloaded file.

### Worktree for a task agent (the brief that worked, verbatim)

```bash
WT="D:/Project/docukit-wt/<id>"
git -C D:/Project/DocuKit fetch -q origin
git -C D:/Project/DocuKit worktree add -b task/<id>-<slug> "$WT" origin/main
cd "$WT" && cmd //c "mklink /J node_modules D:\\Project\\DocuKit\\node_modules"
node scripts/sync-pdfjs-worker.mjs        # REQUIRED — see gotchas
```

When it finishes, the agent stops its server and removes **only the junction**, leaving the worktree:

```bash
cmd //c "rmdir D:\Project\docukit-wt\\<id>\\node_modules"
ls D:/Project/DocuKit/node_modules | wc -l     # must still be populated (746 entries on 2026-10-11)
```

`rmdir` only. A recursive delete of a worktree that still has the junction deletes the real
`node_modules`. The coordinator checks that `<worktree>/node_modules` is gone before running
`git worktree remove --force "$WT"`.

### Clean worktree for the verify agent (tests exactly what is committed)

```bash
WT="D:/Project/docukit-wt/verify"
git -C D:/Project/DocuKit worktree add -q --detach "$WT" <sha>
cd "$WT" && cmd //c "mklink /J node_modules D:\\Project\\DocuKit\\node_modules"
node scripts/sync-pdfjs-worker.mjs
npm run build && PORT=4323 node scripts/serve-dist.mjs &
E2E_BASE_URL=http://localhost:4323 npx playwright test ... > gate-chromium.log 2>&1
# teardown — stop the server, junction FIRST, then the worktree:
cmd //c "rmdir <full windows path>\\node_modules" && git -C D:/Project/DocuKit worktree remove --force "$WT"
```

### Integration (coordinator)

The task branch is already rebased on `origin/main` and the verify agent passed exactly `<sha>`:

```bash
git -C D:/Project/DocuKit push origin <sha>:refs/heads/main
cd /c/ && cd "D:/Project/DocuKit" && git merge --ff-only origin/main
```

Then the live check, then the `WORKLOG.md` entry (its own commit on `main` in the main tree, pushed),
then worktree and branch cleanup.

### Gotchas that cost time

- **pdf.js assets are gitignored** (`public/pdfjs/{standard_fonts,cmaps,wasm,iccs}`) and copied by
  `postinstall`. A worktree that reuses `node_modules` must run `sync-pdfjs-worker.mjs`, or nine
  WebKit PDF tests fail on a font 404 that looks like a real regression.
- **`sync-pdfjs-worker.mjs` leaves `public/pdfjs/pdf.worker.min.mjs` modified** (line endings only) in
  a worktree. Never stage it.
- **Every file under `tests/e2e/fixtures/files/` is generated** by `tests/e2e/fixtures/generate.ts`
  from Playwright's `globalSetup`, including the untracked ones. A test run rewrites the nine tracked
  ones, so they always show as modified. Never commit them. New fixtures are added to `generate.ts`
  (seeded, so identical on every run), not checked in. Ignoring the folder in `.gitignore` does not
  work while nine files are tracked — see the cleanup task in section 6.
- **A lower-case drive letter in the shell's working directory** (`d:\…`) makes `npm test` fail in
  every file with "Cannot read properties of undefined (reading 'config')". `cd /c/ && cd
  "D:/Project/DocuKit"` fixes it. It happens after an agent is resumed.
- **WebKit "waiting for event download" timeouts appear under load** and pass when the spec runs
  alone. They hit Page Numbers and Crop PDF this session while other agents were testing. Run the gate
  with nothing else running; re-run a failing WebKit download test solo before calling it a regression.
- **The scratchpad directory is shared between agents.** One agent overwrote another's throwaway
  script. Tell each agent to use its own subfolder.
- **`npm install` mutates the shared `node_modules`.** Run through a junction it changes the real one
  for every worktree, so never run it while anything is testing. A task that needs a new package says
  so before installing it.
- **Git Bash heredocs** containing JS template literals or stray quotes fail to parse. Write edit
  scripts to a file with the Write tool and run them with `node`.
- **GitHub:** `gh` is installed and logged in as `lakshaysangwan`, so use `gh run list` / `gh run view`
  for CI. The unauthenticated API (60 requests/hour) is no longer needed; still do not poll in a loop.
- **Line endings:** files are LF in git, some are CRLF on disk. Preserve whatever the file uses.
- **Known flaky tests** (pre-existing, not regressions): `a11y/keyboard.spec.ts` keyboard reorder on
  Chromium; `ux/large-file.spec.ts` on WebKit (`EBUSY` unlinking a temp file on Windows). CI runs with
  `retries: 2`.
- **A green suite is not proof the output is right.** The old Compress PDF compare-slider test passed
  on a black page, and Protect PDF's tests passed while the permission checkboxes did nothing. Tests
  for a tool must read the downloaded file (pixels, `/P`, content streams), not only the screen.
- Astro's `trailingSlash` is deliberately left at the default: every URL the site emits has a trailing
  slash, but dev/preview accept both so tests can `goto('/merge-pdf')`.
- **Worktrees live under `D:/Project/docukit-wt/<task-id>`, never under `%TEMP%`.** Windows cleaned
  Temp mid-task on 2026-10-20 and deleted a worktree's files (the commits survived).
- **Laptop sleep pauses runs.** One gate took 8 hours of wall time with nothing failing.
- **Cloudflare Pages build delay:** a build can start ~10 minutes after the push; allow 15.
- **Cloudflare-injected scripts on the live site** (the Web Analytics beacon the CSP blocks, and the
  bot-detection `/cdn-cgi/challenge-platform/.../jsd/oneshot` script) make live runs fail their "no
  console errors" checks. Count those as passes.
- **The Playwright line reporter can hang after the last test** (seen once on WebKit). If a step
  stalls >10 minutes after its last test, stop only that run's own processes and re-run what has no
  result. Never kill the user's own Firefox (Program Files).
- **dnd-kit** swallows clicks ~50 ms after a drop and attaches its keyboard listener a tick after
  Space; tests must wait for both.
- **`signature_pad` throttles moves at 16 ms**; pace synthetic moves ≥20 ms.
- **The suite runs with reduced motion**; animations do not play in tests.

---

## 4. Coordinator protocol

These are the rules in force (Lakshay's, as of 2026-10-23).

- **The coordinator does no work itself.** It briefs and spawns sub-agents, reads their reports,
  rebases/merges and pushes to `main`, logs in `WORKLOG.md`, keeps section 6 current, and talks to
  Lakshay.
- **One sub-agent at a time.** No parallel agents of any kind (token cost).
- **Per task:** task agent (own worktree and branch) → a **fresh** verify agent runs the gate in a
  clean worktree → coordinator pushes to `main` → **the same** verify agent checks the live site →
  coordinator logs it in `WORKLOG.md` → next task.
- **Effort:** medium at most. Task agents medium; verify and doc agents low.
- **Keep going through the queue until Lakshay says stop.** There is no self-initiated handoff at
  half context; that rule is gone. If Lakshay raises something while an agent runs, queue it.
- **Worktrees** under `D:/Project/docukit-wt/<task-id>`, never under `%TEMP%`.
- **Verify agents:** if a Playwright step stalls >10 minutes after its last test, stop only its own
  processes and re-run what has no result; never kill the user's own Firefox (Program Files). Live-run
  "no console errors" failures caused by Cloudflare's injected scripts count as passes. Allow 15
  minutes for a Cloudflare build before checking the live site.
- **Rules for the work:** copy says only what a tool really does and never shows the word "free";
  tests read the downloaded file, not just the screen; new fixtures go in `generate.ts`.

---

## 5. What has shipped (all live)

The headline: **every PDF tool and Compress Image now run in the shared workspace**
(`src/components/islands/workspace/`). `docs/design/tool-workspace.md` is the design; the component
contract lives in the files themselves; `tests/e2e/workspace/migrated.ts` lists migrated tools.
Commits, verification figures and per-task notes are in `WORKLOG.md`.

- **T0** — source-check batch: Split/PDF to Image thumbnails, Watermark pages and layer, Page Numbers font, Image to PDF units, Sign on all pages.
- **T4** — Compress PDF no longer blackens pages or garbles images (allow-list of image shapes).
- **T14** — Protect PDF writes the ticked permissions; separate open/permissions passwords; restrictions-only mode.
- **T11** — homepage tool search.
- **T16** — Crop PDF handles, cursors, keyboard nudging, size readout.
- **T15** — PDF to Image hands over the images without a forced ZIP (`MultiFileDownload`).
- **W1** — workspace step 1a: `src/lib/pdf/` document handle, page geometry, render scheduler; one shared `PDFWorker`.
- **W2** — the workspace itself, and Sign PDF in it.
- **W3** — Image to PDF in the workspace (true-proportion page previews, Orientation Auto).
- **T19** — Edit PDF in the workspace with resizable objects.
- **T1** — Merge PDF page-level view.
- **T2** — Split PDF shows the document and the result in every mode.
- **T12** — Compress PDF with a quality preview and `CompareView`.
- **W4** — Watermark PDF. **W5** — Add Page Numbers. **W6** — Crop PDF. **W7** — Rearrange / Rotate.
- **W8** — PDF to Image. **W9** — Redact PDF. **W10** — Protect and Unlock PDF. **W11** — Digital Signature PDF.
- **W12** — Compress Image with the new shared `workspace/ImageStage.tsx` and `CompareView`.

Dropped: workspace step 1c (splitting `pdf-worker.ts`) — it only served parallel agents.

---

## 6. Queue

### Waiting on Lakshay

- **Cloudflare dashboard:** switch off Web Analytics (Pages project → Metrics → Web Analytics) and the
  bot-detection script (zone → Security → Bots → Bot Fight Mode / JavaScript detections). The second
  POSTs browser signals from every page and contradicts the privacy page's "no tracking scripts".
- **Decisions:** Page Numbers "Page X of N" with a start number (start 3 on 5 pages ends "Page 7 of
  5" — should N be the last number printed?); Image to PDF "Cover" crops past the margins on one side
  — keep, or stop at the margins?; Edit PDF — bring back drag-to-draw shapes?
- **Checks only he can do:** try Sign, Image to PDF, Edit PDF and Redact on his phone; open a
  protected PDF and a digitally signed PDF in Adobe Acrobat.

### 1. Remaining image tools into the workspace

Resize Image, Convert Image, Lock Image, View-Once — reuse `workspace/ImageStage.tsx` and
`CompareView` (built in W12). The batch image tools and Split already use `MultiFileDownload`; check
Resize and Convert do.

### 2. Follow-ups found during the migration

- Signature fonts `public/fonts/*.woff2` have no Latin glyphs — replace with Latin subsets.
- Compress PDF size wins: dedupe identical image streams; alpha-aware compression of masked images.
- Compress PDF: the DPI slider is a scale, not a DPI; "Strip embedded fonts" loses text; the probe re-copies the file to the worker per page.
- `MultiFileDownload` result gallery squeezes 3 columns into the narrow result pane — fix once for all tools.
- Image to PDF "Fit Image" turns pixels into points (a 12 MP photo makes a ~1.4 m page).
- Redact search marks the whole line containing a phrase.
- Watermark: drag-to-position (only nine presets today).
- Sign PDF FAQ "Is this a legally binding signature?" — answer plainly that we cannot say.
- Homepage search synonyms ("join", "esign") via `searchKeywords` on registry entries.
- Copy truth sweep for anything not yet migrated.
- `src/types/worker-messages.ts` declares an unused `redact` op.
- Untrack the nine fixtures under `tests/e2e/fixtures/files/` and ignore the folder.
- `tools/pdf-doc-layer.spec.ts:134` fails on production on all engines (thumbnail URLs not revoked after in-site navigation) — test race or real leak; investigate (W9).
- Lost clicks under the sticky header after smooth scroll cause WebKit/Firefox download flakes — harness fix.
- Confirm two older items are gone: the Crop Flatten "worker is being destroyed" race (likely fixed by W1's shared worker) and the false Crop copy ("Numeric Input mode", "Crop & Download").

### 3. Older backlog still open

- **T3 remainder** — HEIC in any tool not yet covered.
- **T6** — PWA / offline.
- **T7** — titles; needs `Queries.csv` from Lakshay.
- **T9** — new tools.
- **T10** — guides.

---

## 7. Map of the code

| Path | What it is |
|---|---|
| `docs/design/tool-workspace.md` | The shared-workspace design (T13): audit, layouts, component contract, per-tool mapping, rollout. |
| `docs/design/compress-preview.md` | The compression quality preview design (T12), and a list of Compress defects (T17). |
| `src/lib/tools-registry.ts` | The 20 tools: copy, FAQs, steps, feature bullets. Marketing claims live here. |
| `src/lib/landing-pages.ts` | Task pages = an existing tool + a preset. May only repeat the base tool's bullets. |
| `src/components/tool-page/ToolPageLayout.astro` | Every tool and task page: JSON-LD, hero, island, popular tasks, related, FAQ. The workspace's `:has()` hook goes here. |
| `src/components/home/ToolGrid.astro` | The homepage tool grid (T11 adds the search island to it). |
| `src/components/islands/<tool>/` | The interactive tools (React). |
| `src/components/islands/workspace/` | The shared tool workspace: frame, action slot, PageViewer, PageRail, PageGrid/PageCard, overlay boxes, CompareView, ImageStage, use-history. The contract is in these files. |
| `src/components/islands/shared/` | DropZone, FileList, PageSelectorGrid, MultiFileDownload, DownloadButton, BeforeAfterSlider… |
| `src/lib/pdf/` | Document handle, page geometry, render scheduler (W1); `src/hooks/use-pdf-document.ts`, `use-page-thumb.ts` on top. |
| `src/workers/pdf-worker.ts`, `worker-pool.ts` | PDF operations; the pool falls back to inline on engines without OffscreenCanvas. |
| `src/workers/qpdf-helper.ts`, `src/lib/pdf-protect.ts`, `src/lib/pdf-encryption-info.ts` | Protect / Unlock: qpdf arguments, permission bits, reading `/P` back. |
| `src/lib/pdf-compress.ts`, `image-ops.ts`, `image-codec.ts` | Plain functions shared by worker and main thread. `planImagePass` is the Compress PDF allow-list. |
| `public/_headers` | Deployed security headers and CSP. A `_headers` at the repo root is never deployed. |
| `tests/e2e/parity/coverage.ts` | Every advertised bullet → the test that proves it, or an honest "unproven". `parity.spec.ts` enforces it. |
| `tests/e2e/parity/source-check-closures.spec.ts` | T0's tests; pins the Image to PDF margin geometry the workspace refactor must not change. |
| `tests/e2e/tools/compress-pdf-image-safety.spec.ts` | The pixel guard for Compress PDF (renders the download with MuPDF). |
| `tests/e2e/tools/protect-pdf-permissions.spec.ts`, `tests/e2e/helpers/pdf-security.ts` | The permission truth table, read from the downloaded file. |
| `tests/e2e/fixtures/generate.ts` (+ `masked-images.ts`) | Writes every fixture in `fixtures/files/` at `globalSetup`. `fixtures/static/` holds the checked-in ones. |
| `tests/e2e/helpers/harness.ts` | Upload/download helpers; `uploadFiles` waits for island hydration. |
| `tests/e2e/visual/snapshots.spec.ts` | Nine Chromium element baselines. |
| `scripts/serve-dist.mjs` | Static server that applies `dist/_headers`. |
| `scripts/sync-pdfjs-worker.mjs` | Copies the gitignored pdf.js assets; required in every worktree. |
| `scripts/generate-og-images.ts` | Regenerate share images after adding a tool or task page. |
| `FIX-PLAN.md` | Older fix plan; T0 recorded the source-check sweep and the parity figures there. |

---

## 8. Kickoff prompt for the next chat

Paste this as the first message of a new session opened in `D:\Project\DocuKit`:

```text
You are the coordinator for DocuKit. Before doing anything else, read HANDOFF.md, WORKLOG.md (from
the 2026-10-11 section) and docs/design/tool-workspace.md, and follow HANDOFF.md section 4 exactly.

You only coordinate; you do no work yourself. Every task goes to a sub-agent in its own worktree under
D:/Project/docukit-wt/<task-id>, and only one sub-agent runs at a time. Spawn sub-agents at effort
medium at most: task agents medium, verify and doc agents low. When a task agent reports, spawn a
fresh verify agent to run the gate; if it passes, push the task straight to production, and have that
same verify agent check the live site. Then log it in WORKLOG.md and start the next task.

Keep going through the HANDOFF.md section 6 queue until I say stop — do not hand off on your own.
Start with the remaining image tools (Resize, Convert, Lock Image, View-Once) in the workspace. If I
raise something new while an agent is running, add it to the queue.
```
