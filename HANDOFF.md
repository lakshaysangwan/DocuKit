# DocuKit — handoff for the coordinator session

Written 2026-10-11 at the end of the first coordinator session (it ran over 10 and 11 October). The
next session runs as a **coordinator** that gives every task to a sub-agent, **one sub-agent at a
time**, keeps notes, and ships to production. This file is the brief; `WORKLOG.md` is the running log
the coordinator appends to; `docs/design/` holds the two designs most of the queue depends on.

Read sections 1–5 before spawning anything. Section 6 is the queue.

---

## 1. Where things stand

- **Production** is `https://docukit.uk`, deployed by Cloudflare Pages from `main`. Every push to `main`
  deploys (about 1–2 minutes).
- **The last code change on `main` is `491dcb4`** ("Say what Protect PDF permissions are…"); the only
  commit after it is documentation (this file, `WORKLOG.md`, `docs/design/`). Everything shipped this
  session is pushed and was checked on the live site.
- **The main tree** at `D:\Project\DocuKit` is on branch `main`. There is no uncommitted work to decide
  about any more: the batch the previous handoff asked about shipped as T0. `git status` there shows
  only noise — `.claude/settings.local.json` and regenerated fixtures under `tests/e2e/fixtures/files/`
  — which is never staged.
- `remediation/phases-0-3` (local and on `origin`) is an old branch at `085a6e0`. It is no longer used.
- **CI** (`.github/workflows/ci.yml`): job `ci` = typecheck, lint, unit tests, build, Lighthouse
  (non-blocking), `npm audit --audit-level=critical`. Job `e2e` = full Playwright suite on four projects
  against a production build. The workflow concluded `success` for every commit up to `d3f7b5c`; the
  run for `491dcb4` was still in progress when this was written. `gh run list --branch main --limit 5`
  shows it (`gh` is now installed and logged in).
- **Stack:** Astro 7 (static output) + React islands + Tailwind 4, Vite 8. PDF work via pdf-lib, pdf.js,
  MuPDF and qpdf (all WASM, in Web Workers). Image codecs via jSquash; HEIC via `heic-to/csp`.
  Cloudflare Pages Functions in `functions/` back the view-once tool.

### 1.1 In flight — one unverified branch

`task/T11-home-search` (homepage tool search) holds three commits on top of the **old** base
`085a6e0`, where `main` stood before this session (12 commits before `491dcb4`):

| Commit | Subject |
|---|---|
| `2acc23a` | Add the matcher behind homepage tool search |
| `66d95af` | Add a search field to the homepage |
| `108f7a1` | Test that text typed before the search loads is kept |

- It adds `src/lib/tool-search.ts` and its unit test, `src/components/islands/home/ToolSearch.tsx`,
  15 lines in `src/components/home/ToolGrid.astro`, and two specs (`tests/e2e/ux/home-search.spec.ts`,
  `tests/e2e/mobile/home-search.spec.ts`). None of those files has changed on `main` since `085a6e0`.
- Its agent was stopped before it wrote a final report. **Nothing about the branch is verified and it
  may be incomplete.** The next step is T11 in section 6.
- Worktree: `C:\Users\LAKSHAY\AppData\Local\Temp\docukit-wt\t11`, clean apart from the sync noise in
  `public/pdfjs/pdf.worker.min.mjs`. **It has no `node_modules` junction** (checked 2026-10-11; the real
  `D:\Project\DocuKit\node_modules` is intact). Recreate the junction before using the worktree
  (section 3) and remove it again before the worktree is removed.

### 1.2 What did not carry over

Sub-agent IDs do not survive into a new session, so no agent from this session can be resumed. Their
final reports existed only in session transcripts; what the next coordinator needs from them is in
`WORKLOG.md`, in section 6 below, and in the two files under `docs/design/`. Anything not in the repo
is gone.

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
WT="C:/Users/LAKSHAY/AppData/Local/Temp/docukit-wt/<id>"
git -C D:/Project/DocuKit fetch -q origin
git -C D:/Project/DocuKit worktree add -b task/<id>-<slug> "$WT" origin/main
cd "$WT" && cmd //c "mklink /J node_modules D:\\Project\\DocuKit\\node_modules"
node scripts/sync-pdfjs-worker.mjs        # REQUIRED — see gotchas
```

When it finishes, the agent stops its server and removes **only the junction**, leaving the worktree:

```bash
cmd //c "rmdir C:\\Users\\LAKSHAY\\AppData\\Local\\Temp\\docukit-wt\\<id>\\node_modules"
ls D:/Project/DocuKit/node_modules | wc -l     # must still be populated (746 entries on 2026-10-11)
```

`rmdir` only. A recursive delete of a worktree that still has the junction deletes the real
`node_modules`. The coordinator checks that `<worktree>/node_modules` is gone before running
`git worktree remove --force "$WT"`.

### Clean worktree for the verify agent (tests exactly what is committed)

```bash
WT="$TEMP/docukit-verify"
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

---

## 4. Coordinator protocol

Lakshay's rule, which applies to **every** task he asks for, large or small:

> The coordinator does no work itself. It only coordinates. Sub-agents do all the work.

And since 2026-10-11:

> "let's do one after another no multiple subagents. too much token consumption."

Six agents had been started together on 2026-10-10 (four builders and two large design agents). They
hit the account session limit about a quarter of an hour later and everything stopped until the limit
reset; work resumed the next day. So the pipeline is strictly serial:

**task agent → fresh verify agent runs the gate → coordinator pushes → the same verify agent checks
the live site → coordinator logs → next task.**

### What the coordinator does — and nothing else

- Reads this file, `WORKLOG.md` and the design docs, and talks to Lakshay.
- Breaks requests into tasks, writes each sub-agent's brief, spawns it, and reads its report.
- Does the git bookkeeping of integration: rebase or merge a finished task branch onto `main`,
  `git push`, clean up worktrees and branches.
- Appends to `WORKLOG.md` after every integration, and keeps the queue in this file current.

### What the coordinator never does

- Edit source, tests, copy or config. Not even a one-line fix — spawn an agent.
- Investigate a bug, read through code to design something, or debug a failing test.
- Run builds or test suites. The pre-push gate and the live-site check are run by a **verify agent**
  (rule 3), whose report the coordinator acts on.

If the coordinator catches itself opening a source file to understand a problem, that is the signal to
write a brief instead.

### Handing off at half context

When roughly **half of the coordinator's context is used** — or sooner if Lakshay asks — it must:

1. Stop spawning new tasks; let the running agent finish; integrate what is ready.
2. Have a sub-agent rewrite this file so that sections 1, 5, 6 and 8 describe the state at that moment
   (what `main` is, what shipped, what is in flight on which branch, what is left, anything learned
   that the next coordinator needs), and bring `WORKLOG.md` up to date. Any design or investigation
   report that exists only in a transcript is saved under `docs/design/` in the same step.
3. Commit and push.
4. Give Lakshay a kickoff prompt for the next chat, in the same form as the one at the bottom of this
   file, so the next coordinator works in exactly the same way.

Do not wait until context is nearly full: a handoff written by a coordinator that is already losing
detail is worse than one written early.

### Rules for the work

1. **One sub-agent at a time.** No parallel task agents, and no read-only design agents running
   beside a task either. A new idea from Lakshay while an agent is running goes into the queue
   (section 6), not into another agent.
2. **One task = one sub-agent = one git worktree = one branch** (`task/<id>-<slug>`), cut from
   `origin/main` with the commands in section 3. Give the agent a port for `serve-dist.mjs` in its
   brief (4330–4333 were used this session) and have it stop the server when it finishes.
3. **Only the coordinator pushes, and only after a verify agent says so.** Task agents commit to their
   branch and report back; they never push. The coordinator spawns a **fresh** verify agent for each
   gate (about 55k tokens) rather than resuming one that carries a large context, pushes if the gate
   passes, then **resumes that same verify agent** for the live check on docukit.uk. Then it appends
   to `WORKLOG.md`.
4. **Keep briefs narrow.** Each agent starts with no context, so its brief must include: the task spec
   from section 6, sections 2 and 3 of this file, the files it owns, and its port. Name the files and
   tell it not to explore beyond them. For anything touching the workspace, give it the relevant
   sections of `docs/design/tool-workspace.md` rather than the whole file.
5. **Task agents run only their own specs, on Chromium.** The full cross-browser gate belongs to the
   verify agent. Verify agents redirect test output to log files and report short: counts, failures,
   and what they did about each failure.
6. **Every agent commits as it goes**, in case the session limit cuts it off. An agent cut off by the
   limit can be resumed with SendMessage in the same session and continues from its transcript; tell
   it to re-check its worktree state first.
7. **Registry and coverage belong to the task agent now.** With one agent at a time the hot files
   (`src/lib/tools-registry.ts`, `src/lib/landing-pages.ts`, `tests/e2e/parity/coverage.ts`,
   `src/workers/pdf-worker.ts`, `src/types/worker-messages.ts`, `src/components/islands/shared/*`)
   cannot conflict, so a task agent edits `tools-registry.ts` and `coverage.ts` itself for its own
   tool, in the same change as the code, and must run `tests/e2e/parity/parity.spec.ts`.
8. **Every agent brief ends with a required report:** commits made, files touched, tests run with
   exact commands and results, anything it noticed but did not fix, any claim in the copy it could not
   verify, and the steps for the live-site check.
9. Treat a task agent's "done" as a claim. The verify agent re-runs its tests at integration time.
10. **Small requests follow the same route.** A one-line copy change still goes to a sub-agent and
    through the verify agent; the coordinator does not make an exception because a task looks trivial.

---

## 5. What has shipped (all live)

### This session (2026-10-11; commits, verification and bug write-ups are in `WORKLOG.md`)

- **T0, `f6805f6`…`5ac8727` (7 commits) — the source-check batch.** Page thumbnails in Split PDF and
  PDF to Image; Watermark "Specific pages" and a front/behind layer; a font selector in Add Page
  Numbers; Image to PDF margins in mm / in / pt; Sign PDF "Place on all pages"; false claims trimmed
  from the registry. One behaviour changed: a blank "Custom range" in PDF to Image no longer means all
  pages — an empty selection exports nothing and says so.
- **T4, `32dbf58` — Compress PDF no longer turns pages black or garbles images.** `planImagePass` in
  `src/lib/pdf-compress.ts` re-encodes only an allow-list of image shapes (no masks, one plain filter,
  8-bit, Gray/RGB/CalRGB/ICC-RGB, identity `/Decode`) and leaves everything else byte-identical; the
  original is returned at every level when the result would not be smaller. The cost: documents made
  of masked images barely shrink. Lakshay's 4-page scan goes 641 KB → 558 KB at most and misses a
  200 KB target, which the tool reports (T17 is the follow-up).
- **T14, `2e2ae36` and `491dcb4` — Protect PDF writes the permissions the visitor ticks.** The open
  and permissions passwords are always different (a random 24-character one is generated and shown
  once if none is typed); new "No password, restrictions only" mode; passwords starting with `@` or
  `--` work; the worker checks the output's `/P` against the request; the screen and FAQ say
  permissions are advisory. Commenting forces form filling on, because the PDF permission bit includes
  it.

### Before that (2026-10-10, single-agent session)

- Canonical URLs, JSON-LD and internal links use the trailing-slash URLs that actually serve; `/view/`
  removed from the sitemap. Structured data and share images reach the page; per-tool OG images come
  from `npm run generate:og`.
- Security headers deploy from `public/_headers`, including a CSP with `'wasm-unsafe-eval'`;
  `serve-dist.mjs` applies the same file.
- 15 task landing pages in `src/lib/landing-pages.ts`, guarded by `landing-pages.test.ts`.
- Rearrange PDF batch rotate; Compress PDF Target size mode (`compressPdfToTarget`); HEIC conversion
  fixed under the CSP (fixture `tests/e2e/fixtures/static/photo.heic`); the upload box keeps its
  height; Astro 6 → 7.

---

## 6. Queue

Take it from the top, one task at a time. T0, T4 and T14 are done. Estimates are single-agent working
time including the agent's own tests, and are given only where a design or an earlier session produced
one. Findings marked "from reading code" were not run in a browser — the task agent confirms each
before acting on it.

### T11 — Homepage tool search · finish and verify the existing branch

State of the branch: section 1.1. One agent: recreate the junction in the existing worktree, rebase
`task/T11-home-search` onto `origin/main`, check the work against the spec below, finish what is
missing, run its own specs (Chromium, and the mobile spec on the `mobile` project), and report. Then
the gate.

Spec the original agent was given:
- A visible search field at the top of the homepage tool grid, filtering across all tools in
  `tools-registry.ts` and all task pages in `landing-pages.ts` on name and description/keywords,
  case-insensitive, tolerant of obvious variants ("jpg"/"jpeg"; "pdf to jpg" finds PDF to Image and the
  PDF to JPG task page). The index is derived from those two files at build time, not hand-maintained.
- Results link to the real trailing-slash URLs.
- Keyboard: arrows move, Enter opens, Esc clears; a focus shortcut (`/` or Ctrl/Cmd+K) if it fits.
  Combobox/listbox semantics, labelled input, result count or "no results" announced. Works by touch
  at 375px with no horizontal scroll.
- A clear "no results" state; no layout shift when the island hydrates (reserve the field's height).
- Without JavaScript the homepage shows the full grid exactly as today.
- A small island only; `src/components/ui/command.tsx` if it fits and its dependency is installed,
  otherwise a small accessible combobox with the reason stated. No CSP change, no external requests.
- Tests: typing finds a tool; typing finds a task page; keyboard selection navigates to the right URL;
  no-results state; the no-JS grid; a unit test for the matcher. If the homepage has visual baselines,
  do not update them silently.

### T16 — Crop PDF quick fix: cursor and handles

Lakshay, with a screenshot: the cursor changes over the whole page, and the drag handles are four tiny
dots on a thin outline.

- The cursor changes only over the parts that can be dragged.
- Corner **and** edge handles that are clearly visible and easy to grab, with direction-specific
  resize cursors, and the area outside the crop dimmed.
- Make it a step toward the overlay rules in `docs/design/tool-workspace.md`, not throwaway: section
  2.7 (no hover-only affordances; every pointer gesture has a button or field equivalent), section 2.8
  (keyboard moves and resizes), section 4.1 (44px handle hit areas on phones). The later Crop
  migration replaces `crop-pdf/CropPreview.tsx` with an `OverlayBox` that has edge and corner handles;
  keep the `crop-preview` test id, which has a visual baseline.
- From the design's audit, from reading code: the edge grab zone is about 5 CSS px, and "Current page"
  is always page 1. The second is for the migration, not this fix.

### T15 — PDF to Image without the forced ZIP

Lakshay: "why not give option to download 3 files together … needless extra steps for user who just
wanted images".

- A download button per image; "Download all" as separate files for small sets; ZIP as an option
  rather than the only route; save-to-folder where the File System Access API exists; the share sheet
  on phones. A single page is never zipped.
- Browsers may prompt for or block multiple downloads (Chrome asks after the first; iOS Safari is
  stricter). Test per engine and set the "small set" threshold from what works.
- Build it as a **shared download component** and report which other multi-output tools should adopt
  it (Split "each page", batch image convert and compress).
- Settle in the brief how it sits in the workspace's single action slot (T13), whose "done" state has
  one primary Download button.
- Fix here as well: exported files are named by position (`page1`, `page2`), not by source page.

### T13 — The shared tool workspace · about 65–70 agent-hours in all

Lakshay: "we should rethink UI if we're getting this many issues in each tool regarding visibility.
maybe divide screen left and right"; in Sign, "i didn't know what to click on to add the signature";
in Image to PDF, "i don't know what my image on pdf will look like".

**The design is `docs/design/tool-workspace.md`. Read it before briefing any step.** In short:

- **Root cause.** All 20 tools render one 1104px column with previews capped at 384px, above or below
  the controls, so the document and the option that changes it are never on screen together. Every
  tool also has two buttons: `tool-action` processes, then a separate download button appears and a
  result panel is inserted below.
- **Layout.** Once a file is accepted, an in-flow, viewport-height workspace replaces the narrow
  column: document pane on the left, a 380px controls pane on the right, a fixed-height action bar.
  Before upload nothing changes, and unmigrated tools stay pixel-identical (the widening is opt-in
  through a CSS `:has()` hook). Below 1024px the panes stack; on a phone "Options" is an expanding
  panel and the document stays visible.
- **Single action slot.** One box, four states in the same place: ready (`tool-action` + hint) →
  running (progress, cancel) → done (`download-button` + summary + "Make changes") → error. Nothing is
  ever inserted below it. Any change to an input returns it to ready. After "done" the document pane
  renders the real output bytes with a Before/After toggle. The existing test contract (`tool-action`
  → `download-button` → download event) is kept.
- **Five archetypes.** A place on page (Sign, Edit, Crop, Redact, Watermark, Page Numbers) — thumbnail
  rail + one large page with an overlay. B pick/arrange pages (Split, Rearrange, PDF to Image) — page
  grid. C build a document (Image to PDF, Merge) — grid of the output pages. D whole-file transform
  (Compress PDF, Protect, Unlock, Digital Signature) — one large page, compare on. E image (Compress,
  Resize, Convert, Lock, View-Once) — image stage.
- **Geometry.** Every place-on-page tool writes raw pdf-lib coordinates and ignores `/Rotate` and box
  offsets. `src/lib/pdf/page-geometry.ts` (step 1a) fixes that for all of them; previews and writers
  import the same pure functions.

**Steps, in serial order** (the design's "parallel with" column no longer applies):

| Step | Work | Effort |
|---|---|---|
| 1a | `src/lib/pdf/*`: doc handle, geometry, render scheduler, hooks, vitest; re-point `usePdfThumbnails` internals | 3h |
| 1b | Shell: `ToolWorkspace`, `ActionBar`, `WorkspaceFileBar`, `StepPrompt`, the `:has()` hook in `ToolPageLayout.astro`, shared specs | 3–4h |
| 1c | Split `pdf-worker.ts` into per-operation modules behind a thin dispatcher (mechanical) | 1.5h |
| 2a | **Pilot: Sign PDF** with `PageViewer`, `PageRail`, `OverlayLayer`; rewrite Sign specs; rotated and offset-CropBox fixtures | 7–8h |
| 2b | **Image to PDF** with `PageGrid`, `PageCard`, `OutputPagePreview`, `lib/images-to-pdf-layout.ts`, input normalisation | 4–5h |
| 3 | Contract freeze: reconcile 2a and 2b, add `PagePreviewDialog` and `CompareView`, update this file | 1.5h |
| 4A | Merge (T1) 3.5h · Split (T2) 2.5h · Compress PDF (T12) 3.5–4h · Rearrange 2h | ~12h |
| 4B | Watermark 3.5h · Page Numbers 2.5h · Crop 3.5h · PDF to Image 2–3h | ~12h |
| 4C | Redact 3.5h · Edit 4–5h · Digital Signature 2.5h · Protect/Unlock 2h | ~12.5h |
| 4D | `ImageStage` + Compress Image 3h, then Resize 2h · Convert 1.5h · Lock 1h · View-Once 1h | ~8.5h |

- One agent per row in steps 1–3, one agent per tool in step 4. Each tool migrates whole in its own
  branch; there is no feature flag.
- The design wanted 2a and 2b done by different agents to test whether the contract is usable by
  someone who did not write it. In serial mode every task is a fresh agent, so that holds.
- After step 3, `src/components/islands/workspace/` and `src/lib/pdf/` are frozen: a tool agent adds
  files only under its own `islands/<tool>/` and reports "contract change requests", which the
  coordinator batches into one task.
- New shared specs: `workspace/contract.spec.ts` (parametrised by a `migrated.ts` list that each
  migrating agent extends) and `workspace/mobile.spec.ts`. Test ids that must survive, and the tests
  that must be rewritten, are listed in the design (sections 3.2 and 5).
- Each migrating agent regenerates only its own visual baselines and lists them in its report.

**Defaults the coordinator told Lakshay it would proceed on unless he objected; he has not objected:**
the workspace is in-flow with the document left and controls right; one button that changes from
action to download; the Sign flow is PDF-first with the signature placed on the page immediately;
"rotate" and "adjust opacity" are removed from Sign's copy until built.

**Still waiting on Lakshay — ask when T13 comes up, and in any case before step 2b:**

- (a) **Image to PDF output changes:** add Orientation with Auto as the default; remove the hidden
  10 mm margin in "Fit Image"; merge or differentiate "Center" and "Fit" (today they run the same
  code). Each changes what current visitors get. The coordinator recommends all three. Blocks step 2b.
- (b) **Scope:** all 20 tools, or stop after the ones he complained about (through 4B). The
  coordinator recommends all 20, with Lock, View-Once and Convert last and light.
- (c) **Are pages 2, 4 and 5 of his `merged-3-organized.pdf` really blank?** They showed as blank
  thumbnails in Sign. Not reproduced; the design gives two code-level candidates (section 7). Matters
  to step 2a.

**What this design does to the earlier plans:**

- **T-shared is dissolved** into steps 1a, 2 and 3. Do not start it separately. `lib/pdf-thumbs.ts`
  becomes `lib/pdf/doc-handle.ts`; the page card becomes `PageGrid` / `PageCard`; the zoom dialog is
  `PagePreviewDialog` in step 3.
- **T0's `shared/PageSelectorGrid.tsx`** is superseded by `PageGrid`; its test ids (`page-selector`,
  `page-select-<n>`, `page-thumb`) are kept.
- **T5 (result panels shift the layout)** is solved structurally for migrated tools by the fixed
  action bar. What remains is extending `ux/layout-stability.spec.ts` so `tool-action` and
  `download-button` share a box within 1px and the stage box is identical across ready, running and
  done. That belongs to step 1b.
- **T1 and T2** become step 4A; their specs follow.

#### T1 — Merge PDF: page-level view · step 4A · ~3.5h

Lakshay (2026-10-10, with a screenshot): the per-file range inputs give no idea what will come out,
and the first-page cards are small and unclear. He wants every page shown, the output order visible,
and pages rearrangeable. The model and worker design are unchanged; only where things sit has changed.

- **Model:** `pageList: { id, fileId, pageIndex | null }[]` in output order is the source of truth
  (`pageIndex: null` = "all pages of a locked file whose page count is unknown").
- **Document pane:** the "Pages in the merged PDF" grid — every page with its file-letter badge
  (A, B, C…), its output position and "A · page 2". Drag to reorder across files; × to leave a page
  out; click to enlarge (`PagePreviewDialog`); size is the stage's S/M/L control; "Reset order".
- **Controls pane:** files as compact sortable rows — badge, name, page count, the existing range
  input (`data-testid="page-range-input"`, same `aria-label`), inline password field for encrypted
  files, remove button — then options and the action, "Merge into 1 PDF (12 pages)".
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
  `parity/closed-gaps.spec.ts` (bookmarks, fast path, password). The result texts ("Merge complete",
  "Before:", "After:") move into the result view unchanged.
- New tests: interleaving pages from two files yields that exact page order (use `extractPdfText`);
  removing a page drops it; a typed range updates the grid and vice versa; the bookmark path still
  remaps correctly when a file is split across runs.
- Copy to correct in the same change: the FAQ says to "expand any file card to see its page
  thumbnails" and the description says "Drag to reorder pages" — neither is true today.

#### T2 — Split PDF: show the document and the result, in every mode · step 4A · ~2.5h

Lakshay: "in split rn we don't show pdf at all, how does end user see what pdf they are playing with
or what they're gonna get" — and he wants it "in each mode". T0 shipped a small thumbnail grid in
three of the five modes; this is the full version. Unchanged in substance.

- **Document pane:** the page grid, always shown after upload, click to enlarge.
- The text field stays the source of truth (so `odd`, `even`, `last` keep working); clicking a page
  rewrites it. T0's grid already has this logic.
- Per mode, the grid shows the outcome through `PageGrid`'s `groups` and badge props:
  - **Extract Pages:** selected pages highlighted, the rest dimmed. "You'll get 1 PDF with N pages."
  - **Remove Pages:** selected pages marked "Removed"; the rest are what you keep.
  - **Split by Range:** each range colour-coded and labelled "PDF 1", "PDF 2"…; pages in no range
    dimmed as "not included".
  - **Split Every N:** groups shown with alternating colour and a divider; last group may be shorter.
  - **Extract Each Page:** every page labelled with its own PDF number.
- **Controls pane:** mode, range field, and above the action an **output list**: one row per file that
  will be produced, with its real name (`<name>-split.pdf`, or `<name>-part1.pdf`… inside
  `<name>-split.zip`), page range and page count. Use T15's download component for the multi-file
  modes if T15's report recommends it.
- The landing pages `/delete-pdf-pages/` and `/extract-pdf-pages/` reuse this tool; their copy says
  pages are chosen by typing — update it.

### T12 — Compression quality preview · built on the workspace

Lakshay: "we should see the possibility of showing the quality of pdf and image while compressing,
especially in pdf". Design: `docs/design/compress-preview.md`.

- **Step 1 — make the after-view truthful** (the design's Option A, ~3h): any page, zoom, the whole
  page uncropped, a facts line (settings used, "N of M images re-encoded"), and an automatic warning
  when a page came out grossly different (a 32×32 brightness-grid comparison of the two renders). The
  current view shows only page 1 at about 77 DPI through a JPEG, so it cannot show quality loss.
- **Step 2 — a live one-page preview while choosing a level** (Option B, ~5–6h more for PDF, ~2h for
  images): a worker probe cuts one page out and runs it through the same compression.
- Build on the workspace's `PageViewer`, `PageRail` and `CompareView`, **after** steps 1–3 of T13; do
  not build the standalone viewer files the design's section 4 names. It is the Compress PDF row of
  step 4A and the Compress Image row of 4D. The two designs' estimates disagree: the workspace rollout
  gives that 4A row 3.5–4h including a "Preview this page" pass; this design's own figures are the
  larger ones above. Plan on the larger.
- Defaults told to Lakshay, not objected to: a suspect page shows a warning and "Download anyway"; on
  phones the preview sits behind a button; Target size previews only after the run, with what it took;
  Compress Image auto-compresses on slider change for normal-sized JPEG/WebP; making the DPI slider a
  real resolution belongs to T17.
- The registry bullet `'Side-by-side quality preview'` appears in the registry, three landing pages
  and `coverage.ts`; keep the string and point its coverage entry at the new spec.

### T17 — Compress correctness and size follow-ups

Check each item against the current code first. T4 already fixed these from the design's section 7:
dropped masks and `/Decode`, mask streams converted, predictors, colour-space guessing, unclosed
bitmaps, output larger than input, and JPEG quality ≥ 90 with a downscale asked for.

Size, on documents like Lakshay's scan:
- Deduplicate identical image streams — about 150 KB lossless on his file (pages 1/3 and 2/4 carry the
  same overlays).
- Alpha-aware compression of masked images — the only way that file reaches 200 KB. Needs careful
  pixel tests; T4 chose to skip masked images because carrying a mask through JPEG could not be shown
  to preserve appearance.
- Possible later: predictor images and ICC-gray/CalGray made compressible.

Correctness, Compress PDF:
- The "target missed" notice uses 1024-byte KB while sizes elsewhere use 1000.
- No e2e test for the 200KB preset landing page. The target-size pages will report a miss more often
  on masked-image documents; their copy has not been reviewed for that.
- "Strip embedded fonts" can make text vanish, with no warning on the checkbox. Its check
  `fonts.constructor.name === 'PDFDict'` may also fail in a minified build (not checked).
- "Image DPI" is not a DPI: it is a scale factor relative to an assumed 150 and does nothing from 150
  upward.
- "Convert to grayscale" affects images only.
- Success is reported even when no image was re-encoded; an invalid target leaves the status at
  "processing"; `imagesTotal` counts mask streams.

Correctness, Compress Image (all from reading code):
- Wrong file extension when the original or a substituted WebP is returned.
- A transparent PNG saved as JPEG gets a black background (no white fill).
- A missed target is not reported.
- The quality slider does nothing for PNG; `stripExif` and `percentage` are never read.

Worker pool: an abort does not drain the queue (`worker-pool.ts`).

### T18 — Copy truth sweep · folds into T8

The false or unverifiable claims found this session. All are from reading code unless marked; confirm
each, then fix the code or trim the copy. A tool's workspace migration corrects its own copy in the
same change, so do first the ones whose migration is far off. More detail: section 7 of
`docs/design/tool-workspace.md`.

- **Buttons the how-to steps name that do not exist:** "Merge & Download", "Split & Download" (the
  button is "Split PDF"), "Compress & Download", "Unlock & Download", "Crop & Download", and Add Page
  Numbers' "Apply & Download". Sign and Rearrange do have "Apply & Download", and it does not download.
- **Add Page Numbers:** the how-to mentions a page range and a first-and-last-page preview; the
  feature bullet says "Live preview on first and last page". Only page 1 is previewed and there is no
  range.
- **Unlock PDF:** the FAQ says a restrictions-only file unlocks with no password, but the tool refuses
  an empty password (tested by T14). Either allow an empty password or change the answer to: "Enter
  the permissions (owner) password. Docukit then saves a copy with the restrictions removed." The
  how-to says "password-free PDF" — the word "free" in visible copy.
- **Protect / Unlock:** both list `wasmDeps: ['pdf-lib']` though qpdf does the work. The Protect note
  and FAQ name Adobe Acrobat as honouring permissions; that was not verified (Lakshay's to-do below).
  If he wants only tested claims, drop "such as Adobe Acrobat" from both places.
- **Sign PDF:** "Place it anywhere", "Drag-and-drop placement with resize/rotate", and the how-to's
  "Drag to reposition, resize with handles, adjust opacity". Placement today is a click on a thumbnail
  at fixed coordinates. The pilot (2a) makes drag and resize true; rotate and opacity are trimmed.
- **Image to PDF:** "JPEG, PNG, WebP, BMP, TIFF, SVG, HEIC support" — the picker accepts JPEG, PNG,
  WebP, BMP and GIF only. "Custom page sizes" has no control.
- **Watermark:** the FAQ's "configurable spacing" for tiling and "set font" have no control. The "live
  preview" does not match the output (tiling, image size, rotation pivot) and always shows page 1 with
  the watermark on top, whatever range or layer is chosen.
- **Crop:** the FAQ describes a "Custom per-page" mode that does not exist.
- **Edit PDF:** the registry says "Fabric.js canvas overlay"; Fabric is not a dependency.
- **Digital Signature:** the copy says "optionally place a visible signature image"; a visible box is
  always drawn at a fixed spot on page 1.
- **Merge:** see T1.
- **Compress PDF:** "4 compression levels" (there are five options); `mupdf` listed as a dependency
  though compression does not use it; percentage ranges with nothing behind them.
- **Compress Image:** the copy mentions stripping EXIF and a percentage mode; neither option is read.
- **Coverage notes:** ten bullets in `coverage.ts` carry "SOURCE CHECK — implemented at …; needs a
  test" from an earlier session. T0 re-read only those for the six tools it touched.

### Smaller bugs noticed, unfixed

- Add Page Numbers returns to idle silently when the worker errors.
- Place-on-page tools (Sign, Watermark, Page Numbers, Crop, Edit's flatten) ignore `/Rotate` and box
  offsets. Fixed structurally by the workspace geometry module.
- Redact drawing is mouse-only (no touch or pen).
- Clearing a number input shows "0", so typing "1.5" displays "01.5" (the value is right). Shared by
  the number inputs across tools.
- PDF to Image names files by position, not source page (fix in T15).
- Unlock shows every failure as "Incorrect password".
- Protect does not warn on upload that a PDF is already encrypted (it does give a clear error on run).
- `usePdfThumbnails` never destroys its pdf.js document, copies the whole buffer and re-renders the
  full list once per page (fixed by step 1a).
- Watermark's image picker accepts WebP and SVG, and Sign's signature upload accepts WebP, but the
  worker embeds only PNG and JPEG. Image to PDF embeds anything that is not PNG as JPEG, so WebP, BMP
  and GIF probably fail, and it ignores EXIF orientation (both fixed by step 2b's input normalisation).
- Sign: stamps cannot be removed; every signature is forced into 200×60pt; the stored signature is
  written to sessionStorage and never read (all replaced by step 2a).
- `BeforeAfterSlider` crops with `object-cover` and its halves do not line up until the first drag.
- **Cleanup:** stop tracking the nine generated fixtures (`git rm --cached`) and ignore
  `tests/e2e/fixtures/files/`, so `git status` is quiet. First confirm nothing reads them before
  `globalSetup` has run.

### Still open from the earlier backlog

**T3 — HEIC where it is advertised but broken · ~1.5h.** Verified against a real file on 2026-10-10:
- Compress Image: "The source image could not be decoded" — `compressImage` in `lib/image-ops.ts`
  calls `createImageBitmap` directly; route it through the libheif fallback in `lib/image-codec.ts`.
- Resize Image: the dropzone rejects HEIC and `resizeImage` has the same decode problem.
- Image to PDF: the dropzone rejects HEIC although the hero copy and a feature bullet promise it (also
  TIFF and SVG — check each). pdf-lib embeds only JPEG/PNG, so decode and re-encode first. This part
  overlaps the input normalisation in step 2b of T13 (design section 4.2); do it there.
- Add tests with `FIXTURE.heic`; move the coverage entries to `covered`.

**T6 — Installable / offline (PWA) is not working · ~1–1.5h.** `@vite-pwa/astro` generates `sw.js`,
but no page registers it and no page links the manifest. If it were registered it would throw: the
generated worker has a `NavigationRoute` bound to `/`, which is not in the precache (HTML is excluded
by `globPatterns`). The PRD lists "installable, offline-capable". Decide the caching design
deliberately — a stale-HTML bug here is hard to recover from.

**T7 — Titles and descriptions for all 20 tools · ~1h.** Still blocked on the full `Queries.csv`
export from Search Console. Known from a screenshot: 9 of the top 10 queries are about view-once image
sharing ("one time view image", "view once photo link", "upload image delete after first view");
"docukit" ranks about 6th. A first pass from those phrases is possible; refine when the export
arrives. Titles ≤ 60 chars, descriptions ≤ 160, no "free".

**T8 — Tool-by-tool review.** Now largely delivered by the workspace migration (each tool is rebuilt
and its copy corrected in the same change) plus T18. What is left afterwards: deepen the page copy
(use cases, "which tool should I use", more FAQs — the competitor has 8 per page, DocuKit has 4) and
compare each screen with ihatepdf.cv's equivalent.

**T9 — New tools (browser-only) · ~1–2h each; OCR and Compare ~half a day each.** Flatten PDF, headers
and footers, extract images, extract text, edit metadata, pages per sheet, OCR, compare PDFs,
Markdown/HTML to PDF. Skip Word/Excel conversion and AI chat. Each new tool needs a registry entry, a
coverage entry, a spec, an icon and an OG image — and is built on the workspace once it exists.

**T10 — Guides and "alternative to" pages · ~1.5h for the section, ~15–20m per article.** ihatepdf.cv
has 113 guides and three alternative pages; DocuKit has none. Needs a content collection and layout
first.

### Lakshay's own to-dos

- **Switch off Web Analytics** in the Cloudflare dashboard (Pages project → Metrics → Web Analytics).
  Every page still logs one CSP violation from the blocked beacon.
- **Check a protected file in Adobe Acrobat Reader.** Protect a PDF on docukit.uk with "Copy text and
  images" unticked, open it in Acrobat Reader with the open password, then File → Properties →
  Security: it should show Content Copying: Not Allowed and Printing: Allowed, and copying should be
  disabled. This is the one check no agent could run.
- **Say which viewer he used** when he copied text from the protected PDF. Firefox's built-in viewer
  ignores permissions by default.
- **Answer the three workspace questions** under T13: (a) Image to PDF output changes, (b) scope,
  (c) whether pages 2, 4 and 5 of `merged-3-organized.pdf` are really blank.
- In Search Console, click **Validate Fix** on the "Excluded by noindex" report only. Leave "Page with
  redirect" alone — the slash-less URLs will always redirect.
- Export `Queries.csv` (Performance → Export) when the export works.

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
| `src/components/islands/shared/` | DropZone, FileList, PageThumbnailGrid, PageSelectorGrid, DownloadButton, BeforeAfterSlider… |
| `src/hooks/use-pdf-thumbnails.ts` | Thumbnails for six tools; rasterises every page on the main thread. Re-implemented in step 1a. |
| `src/workers/pdf-worker.ts`, `worker-pool.ts` | PDF operations; the pool falls back to inline on engines without OffscreenCanvas. Split per operation in step 1c. |
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
You are the coordinator for DocuKit. Read HANDOFF.md, WORKLOG.md and docs/design/tool-workspace.md
in the repo before doing anything else, and follow the coordinator protocol in HANDOFF.md section 4
exactly.

You do no work yourself. Every task — including small ones — goes to one sub-agent working in its own
git worktree and branch, and only one sub-agent runs at a time: no parallel task agents and no
parallel design agents. When a task agent reports, spawn a fresh verify sub-agent to run the pre-push
gate, push if it passes, and have that same verify agent check the change on the live site. Your own
actions are limited to: briefing and spawning sub-agents, reading their reports, rebasing/merging and
pushing to main, keeping WORKLOG.md and the HANDOFF.md queue up to date, and talking to me. Push each
task to production as soon as it is verified, then start the next one. If I raise something new while
an agent is running, add it to the queue instead of spawning another agent.

Take the queue in HANDOFF.md section 6 from the top, starting with T11 (finish and verify the
existing branch). Ask me the open workspace questions listed under T13 before the Image to PDF
migration.

When about half of your context is used, stop spawning new work, finish integrating what is ready,
have a sub-agent update HANDOFF.md and WORKLOG.md to the current state and save any design report
that exists only in a transcript under docs/design/, push them, and give me a kickoff prompt like
this one for the next chat.
```
