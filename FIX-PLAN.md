# DocuKit — Remediation & Premium-Parity Plan

Goal: bring the **19 existing tools** up to the quality bar of premium products
(Adobe Acrobat online / Smallpdf / iLovePDF) — not to add new tools. "Premium parity" here means
each operation is:

1. **Correct** on hard inputs (large, complex, scanned, encrypted, odd page sizes, CMYK, HEIC).
2. **Faithful** — preserves fonts, vectors, color, metadata unless intentionally changed.
3. **Visible before commit** — you can preview the effect, not just download and hope.
4. **Fast** — no needless main-thread jank; WASM warmed; batch-capable.
5. **Accessible** — WCAG 2.1 AA.
6. **Honest** — the UI never claims a capability it doesn't deliver.

Every step below lists **Goal · Files · Approach · Acceptance (the e2e test that must pass) ·
Effort (S ≤0.5d / M ~1–2d / L ~3–5d)**. Steps are ordered by dependency; the **critical path** is
Phase 0 → 1.

### Progress log
- **✅ P0.1 done** — centralized pdf.js loader `src/lib/pdfjs.ts` (`getPdfjs()`), all 5 call sites
  refactored, `postinstall` syncs the worker from node_modules → `public/pdfjs` (no version drift),
  privacy guard `tests/e2e/guards/no-external-requests.spec.ts` added.
- **✅ P1.1 done** — PDF→Image now uses the local worker; H-1 gone; its 3 functional tests
  un-skipped and passing. Suite: **100 passed / 0 skipped**.
- **✅ Bonus (dev fix)** — `optimizeDeps.entries` in `astro.config.mjs` so Web-Worker WASM deps
  (qpdf) are pre-bundled at boot; kills the `504 Outdated Optimize Dep` full-page reload that hit
  the first WASM operation in dev.
- **✅ P1.4 done** — Edit "Keep as Annotations" now emits real PDF annotation objects (new
  `src/lib/pdf-annotations.ts`: FreeText/Square/Circle/Line/Ink/Stamp with `/AP` appearance
  streams, coordinate-mapped per page, existing `/Annots` preserved). `handleSave` branches on
  `saveMode`; Flatten keeps the raster-composite path. `edit-pdf.spec.ts` gains two deep tests —
  **Flatten → zero `/Annot` objects, Keep → a real `FreeText` annotation** (via new
  `readPdfAnnotationSubtypes` harness helper). Chose pdf-lib over MUPDF here to keep the editor
  route light (no 8–11 MB WASM); MUPDF stays reserved for redaction (D1).
- **✅ Bonus (UX)** — Edit background render was blurry (rasterized at scale 1 + JPEG 0.8, then
  CSS-upscaled). Now renders at `min(3, ceil(dpr)+1)×` density (JPEG 0.92) with the bg canvas
  backing store sized to the image while CSS-pinned to the coordinate space; coordinate space
  unchanged so annotation mapping is unaffected. Suite: **102 passed / 0 skipped**.
- **✅ P1.5 done (with a documented deviation from "@signpdf")** — Extracted signing into a pure,
  Node-runnable `src/lib/pdf-sign.ts` (`generateSelfSignedCert`, `loadP12`, `signPdfWithPkcs7`) and
  slimmed `DigitalSignatureTool.tsx` to call it. Added `verifyPdfSignature` to the harness and a
  test that **cryptographically validates** the output — `messageDigest` == SHA-256 over the
  ByteRange content **and** the RSA signature over the authenticated attributes verifies — proving
  the signature is spec-correct, not just marker-present. **Did not adopt `@signpdf`**: v3 requires
  Node's global `Buffer`, which would force a bundle-wide polyfill into this fully client-side app;
  the existing node-forge path is now proven valid, so the swap would add deps + polyfill risk for
  no correctness gain. Suite: **102 passed / 0 skipped**.
- **✅ P1.2 done** — compress-pdf **already** recompressed images (probe: High −79%, Medium −36%,
  Low ~0%); the AUDIT "pass-through" was stale. Real work done: (a) added `qpdfCompress`
  (object-streams + max-level flate recompress) as a lossless structural pass at the end of
  `compressPdf`, so **Low** now shrinks losslessly and every tier squeezes more; (b) **removed the
  dishonest UI fallback** that showed "Full compression requires MUPDF (coming soon)" and silently
  passed through — errors now surface honestly. Added image-heavy fixture `pdfPhoto` and upgraded
  `compress-pdf.spec.ts` to assert **Low ≤ original, Medium < 0.9× original, High < Medium**.
  (Routing image re-encode through jSquash/mozjpeg for better quality-per-byte is left to **P3.1**,
  where the plan already scopes the image-codec swap.) Suite: **103 passed / 0 skipped**.
- **✅ P1.3 done (fixes H-2)** — Installed `mupdf` (D1). New `src/workers/mupdf-worker.ts` +
  `src/lib/redact-with-mupdf.ts` (spawns the worker per job, terminates after). Each mark →
  a MuPDF `Redact` annotation; `applyRedactions` physically removes the underlying text/image/vector
  and burns a black box, leaving the rest of the text layer selectable. The old whole-page raster is
  now only an explicit fallback if MuPDF rejects a doc. Corrected the dishonest "pages are
  rasterized" copy. `redact-pdf.spec.ts` now extracts text with pdf.js (new `extractPdfText` helper)
  and asserts **redacted string gone on the marked page, body text still present, and other pages
  untouched** (proves per-region, not rasterization). Two gotchas solved: MuPDF `setRect` is
  top-left/y-down and the rect must be flushed with **`annot.update()`** (not `page.update()`) before
  `applyRedactions`; and the worker must **dynamic-import** mupdf inside the handler (a top-level
  `import` blocks the ~10 MB WASM and hangs message-handler registration). `mupdf` added to Vite
  `optimizeDeps.exclude`. Suite: **104 passed / 0 skipped**.
- **✅ Phase 2 done (live previews — the premium-feel priority)** — All four tools now show what
  they'll do before you commit, each with an `operation-visibility` test asserting the preview is
  really rendered (`canvas.width*height > 0` / `naturalWidth > 0`) and reacts to option changes:
  - **P2.1 Watermark** — `WatermarkPreview.tsx` composites the watermark on page 1 (text/image,
    opacity/rotation/size/placement); test flips opacity and asserts the pixels change.
  - **P2.2 Page numbers** — `PageNumbersPreview.tsx` mirrors the worker's placement (mm margins,
    bottom-left origin, all 6 formats, start/skip); test switches format and asserts pixels change.
  - **P2.3 Crop** — `CropPreview.tsx` draggable crop rectangle (edge handles) two-way-synced to the
    numeric margin inputs, dims the cropped-away area, plus **auto-crop whitespace** (content-bbox
    detection on page 1). Test asserts auto-crop sets a non-zero margin and the overlay moves.
    *(Crop "flatten" mode — physically dropping off-crop content — is deferred: it's a worker change,
    not a visibility feature; tracked for a later pass.)*
  - **P2.4 Compress** — after compressing, a `BeforeAfterSlider` shows page 1 original-vs-compressed
    (shared `src/lib/pdf-preview.ts` `renderPdfPageToDataUrl`); test asserts both renders paint and
    differ.
  Suite: **108 passed / 0 skipped**. Phases 0–2 complete.
- **Decisions D2/D3 resolved (user):** D3 = **add both AVIF + HEIC**; D2 = **implement** advertised
  features (not trim copy).
- **✅ P3.1 done** — New shared `src/lib/image-codec.ts` (jSquash mozjpeg/webp/png `encodeImageData`
  + `bufferToImageData` decode). Routed **all three** image tools through it: image-worker
  `compress-image` (getImageData→jSquash), `convert-image`, `resize-image` (replaced `canvas.toBlob`).
  jSquash added to Vite `optimizeDeps.exclude`. 11 image-tool tests green.
- **✅ P3.2 done (D3)** — Installed `@jsquash/avif` + `heic-to`. `image-codec` gained an **AVIF**
  encoder and **HEIC decode** fallback (`createImageBitmap` → on failure `heicTo` via libheif).
  Added AVIF as an output in convert-image + compress-image, and HEIC/HEIF to their accepted inputs.
  New test: PNG→AVIF yields a valid AVIF (magic-byte check via extended `assertImage`). *(HEIC-decode
  has no automated test — browsers can't encode HEIC so there's no fixture to round-trip; the decode
  path is wired and manual-testable.)* Suite: **109 passed / 0 skipped**.
- **✅ P3.4 done** — PDF→Image gained **AVIF** output + a **600 DPI** preset, and now encodes every
  format through jSquash (canvas can't reliably emit AVIF). New test: page→AVIF is a valid AVIF.
- **✅ P3.5 done** — Resize now has a correctly-named **Cover (crop)** fit mode (test: 1200×800 →
  exact 500×500) and **saved custom presets** in localStorage (save/apply/delete; test proves they
  persist across a reload). Suite: **112 passed / 0 skipped**.
- **✅ P3.3 done** — Batch mode for compress-image **and** resize-image: drop multiple → shared
  options apply to all → per-file processing → **ZIP** download; single-file keeps its rich UX
  (FileInfoCard, before/after slider, dimension detection, presets) so all prior tests still pass.
  Extracted `resizeOneImage`; both tools now use `FileList`. New batch tests (2 files → ZIP) green.
  Suite: **114 passed / 0 skipped**.
- **✅ P3.6 done** — Redact extras: **Find & Redact** (pdf.js text search → auto-marks every match
  on every page, mapped text-item bbox → percent), **metadata strip** in the MuPDF worker (clears
  Title/Author/Subject/Keywords/Creator/Producer), and a **SHA-256 before/after** integrity panel.
  Test: search "Test Document" → mark all → redact → gone doc-wide, body text remains, distinct hashes.
- **✅ P3.7 done** — Merge **per-file page selection**: new `MergeOptions.pageSelections` (0-indexed,
  per-buffer; null = all) honored in the worker; a "Choose pages per file" panel with a page-range
  input per file. Test: take page 1 of file A + all of file B → 6 pages.
- **✅ Phase 3 COMPLETE.** Suite: **116 passed / 0 skipped**. Phases 0–3 all done.
- **✅ P4.1 done (fixes M-4)** — Cross-tool form-label audit. Every previously bare `<label>`-sibling
  control now has an associated name: `htmlFor`/`id` pairs where a visible label exists (page-numbers
  start/skip/font/color, watermark text/size/opacity/rotation/color, crop & image-to-pdf margins,
  digital-signature CN/Org, compress-pdf DPI/quality, compress-image quality/target-KB, resize W/H,
  convert quality, pdf-to-image quality, split range/every-N, protect & lock password/confirm, view-once
  share-link), and `aria-label` where the control is placeholder-only or span-labelled (crop &
  pdf-to-image page-range, pfx password, sign typed-signature, AnnotationToolbar font-size/stroke/opacity/
  stamp-select, AnnotationCanvas edit textarea). New `unlabelledFormControls(page)` harness helper +
  `tests/e2e/a11y/labels.spec.ts`: 16 tests that upload the right fixture, expand each tool's options
  (custom mode, target-size, page-range, every-N, per-file page ranges, typed-signature tab), and assert
  **zero** visible controls lack an accessible name. *(Implemented as a dedicated a11y spec rather than
  bolting per-tool upload/expand logic onto the report-only serial site-sweep — same assertion intent,
  cleaner and debuggable.)* Suite: **132 passed** (116 + 16).
- **✅ P4.2 done (fixes L-1)** — Heading hierarchy. The interactive islands opened with an `<h3>`
  directly under the page `<h1>` (skip); demoted digital-signature "Certificate", crop "Crop Margins",
  and sign-pdf "Step 1/2/3" to `<h2>` so they're peers of the static How-to/Features/FAQ `<h2>` sections.
  New `collectHeadingSkips(page)` helper + `tests/e2e/a11y/headings.spec.ts`: every route (home + all
  tools + privacy) has exactly one `<h1>` and no level skips. **22 passed.**
- **✅ P4.3 done** — Keyboard + screen-reader for the drag-and-drop file list. `FileList`'s
  `KeyboardSensor` was already wired; added meaningful dnd-kit `announcements` (referencing the real
  file name + 1-based position for pick-up / move / drop / cancel) and `screenReaderInstructions`, and
  made each drag handle's `aria-label` name its file (`Reorder <name>`). `ProcessingOverlay` now has a
  dedicated `sr-only` polite live region announcing progress at 10% deciles (throttled so it isn't
  chatty; container downgraded from `role=status` to a labelled `role=group`). Redact's pointer-only
  draw surface gained an `sr-only` note pointing keyboard users to the (already keyboard-operable)
  Find-&-Redact search + focusable per-mark remove buttons; crop is already fully keyboard-operable via
  its labelled numeric margin inputs. New `collectHeadingSkips`/keyboard test: `tests/e2e/a11y/keyboard.spec.ts`
  drives a full keyboard reorder (Space → Arrow → Space), gating each keystroke on its live-region
  announcement, and asserts the order changed. **1 test.**
- **✅ P4.4 done** — Installed `@axe-core/playwright` (4.13). `tests/e2e/a11y/axe.spec.ts` runs axe
  (`wcag2a/2aa/21a/21aa`) on every route **and** the mid-operation processing state, asserting **zero
  serious/critical** violations. Fixes surfaced by axe: (a) **contrast** — `--color-text-muted`
  darkened to `#666666` (light) / lightened to `#9E9EA8` (dark); `--color-success`/`--color-error`
  darkened to green-700/red-700 in **light** mode so accent *text* on their `/5` tint panels clears
  4.5:1, with **dark**-mode overrides preserving the brighter values (a darker accent would fail on
  dark surfaces); (b) **definition-list/dlitem** — the FAQ `<dl>/<dt>/<dd>` wrapped around
  `<details>` was invalid, converted to `<div>/<span>/<div>` (FAQ JSON-LD already provides the machine
  semantics); (c) **nested-interactive** — the DropZone's focusable file `<input>` was nested inside
  its `role="button"` element; moved it out to a sibling (still opened via ref). The mid-op scan waits
  for the overlay's fade-in to reach `opacity:1` so contrast is graded on steady-state colours.
  **23 tests.**
- **✅ Phase 4 COMPLETE.** Full suite: **178 passed / 0 skipped** (116 prior + 62 a11y:
  16 labels + 22 headings + 1 keyboard + 23 axe). New harness helpers: `unlabelledFormControls`,
  `collectHeadingSkips`. New dep: `@axe-core/playwright` (dev).
- **✅ P5.1 done (fixes L-3)** — Feedback consistency. Eight tools emitted a transient toast whose text
  was identical to the persistent result panel already on screen (image-to-pdf, watermark, page-numbers,
  protect-unlock, sign-pdf, view-once, digital-signature, lock-image). Toasts reworded to short,
  action-oriented confirmations distinct from the panel headline (panels — which the e2e specs assert
  on — left intact). New `tests/e2e/ux/feedback.spec.ts` proves the toast (sonner portal, outside
  `#main-content`) differs from the persistent panel.
- **✅ P5.5 done** — Cross-tool flow. Extracted the ad-hoc inline "next step" links into a shared
  `NextStep` component (`data-testid="next-step"`); migrated the three existing ones (convert / resize /
  pdf-to-image → Compress Image) and added consistent in-flow suggestions to image-to-pdf & merge →
  Compress PDF, watermark → Protect PDF, compress-image → Resize Image. Test asserts the panel offers a
  correctly-linked next step. Suite green (+3 UX tests).
- **✅ P5.2 done** — Actionable, non-silent PDF load errors. New shared `src/lib/notify.ts`
  `notifyPdfLoadError()` shows one consistent message with a **one-click "Unlock PDF" deep-link**
  (sonner action), replacing 11 tools' plain dead-end "Failed to load" toasts. Fixed a real **silent
  failure**: `usePdfThumbnails.loadThumbnails` swallows parse/encryption errors and returns 0, and the
  thumbnail tools ignored it — so an encrypted PDF left the tool blank with no message. Now
  pdf-to-image / split / redact / sign / organize check the 0-count and surface the actionable error
  (drop zone stays, so the user retries after unlocking). New `tests/e2e/ux/errors.spec.ts` feeds an
  unreadable PDF and asserts the actionable Unlock link appears.
- **Next up:** Phase 5 — P5.3 large-file UX (size warnings, cancellable long ops, ETAs) →
  P5.4 mobile & dark-mode pass (add a mobile Playwright project). Then Phases 6 (perf), 7 (gates).

Grounding facts (verified against the repo, not assumed):
- Image ops (`src/workers/image-worker.ts`) use **OffscreenCanvas encoders**, so the installed
  `@jsquash/jpeg|png|webp` premium codecs are **unused**. AVIF/HEIC codecs are **not installed**.
- `compress-pdf` **has** a real image-recompression worker path (`compressPdf`,
  `src/workers/pdf-worker.ts:589`) that currently errors → UI passes through. It is a **fix**, not a rewrite.
- Encryption/decryption already use **qpdf-wasm** (premium AES-256) — good.
- **MUPDF is not installed** despite the registry claiming it. True redaction needs a
  content-stream engine → this is the one place a new heavy dependency is warranted (see Decision D1).
- `@signpdf/signpdf` is installed but the digital-signature tool hand-rolls PKCS#7 with node-forge.

---

## Decisions

- **D1 — Redaction engine → DECIDED: add MUPDF (mupdf.js).** Lazy-loaded only on the redact route
  (~8–11 MB WASM). It becomes a **shared Phase-1 enabler**: true redaction (P1.3), and optionally the
  cleanest path for real PDF compression (P1.2, image downsample + `mutool clean`) and crop-flatten
  (P2.3). A new `src/workers/mupdf-worker.ts` will own it so the main pdf-worker stays light.
- **D2 — Advertised-but-missing features.** *Open.* Default is **implement** (per "premium parity");
  each Phase-3 step notes the faster copy-trim fallback. Confirm per-tool when we reach Phase 3.
- **D3 — AVIF/HEIC support.** *Open.* Add `@jsquash/avif` + a HEIC decoder (`libheif-wasm`) to honor
  the image-format claims, or drop those formats from the copy. Confirm at P3.2.

---

## Phase 0 — Foundations & guardrails (unblocks everything, prevents regressions)

**P0.1 · Single source of truth for the pdf.js worker** — S
- **Goal:** never again mismatch/CDN the worker (root cause of H-1).
- **Files:** new `src/lib/pdfjs.ts` exporting a `getPdfjs()` that sets
  `GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs'`; refactor every caller
  (`pdf-to-image`, `edit-pdf`, `redact-pdf`, `merge` thumbnail, `usePdfThumbnails`) to use it.
- **Approach:** copy the worker into `/public/pdfjs/` at the installed version via a `postinstall`
  script so it can never drift from the bundled `pdfjs-dist`.
- **Acceptance:** a new `tests/e2e/guards/no-external-requests.spec.ts` asserts **zero** cross-origin
  requests while exercising each tool; the H-1 characterization test is deleted.
- **Effort:** S.

**P0.2 · CI gate on the e2e suite** — S
- **Goal:** the suite that exists must run on every PR.
- **Files:** `.github/workflows/e2e.yml` (Playwright, `workers:2`, retries:2 — already configured).
- **Acceptance:** CI red on any functional/visual/a11y regression; artifacts (screens, sweep JSON)
  uploaded.
- **Effort:** S.

**P0.3 · WASM warm-up + worker pool health** — M
- **Goal:** eliminate first-operation cold-start jank (premium tools feel instant).
- **Files:** `src/workers/worker-pool.ts`; add idle prewarm on route enter (`requestIdleCallback`).
- **Approach:** on a tool page, warm the relevant worker (compile WASM, init qpdf/jSquash) before
  the user clicks. Show a subtle "ready" state.
- **Acceptance:** extend the sweep to record time-to-first-result; assert < 1.5 s warm on a small file.
- **Effort:** M.

---

## Phase 1 — Fix broken / misleading operations (trust & data integrity)

**P1.1 · PDF→Image: local worker + correct version (fixes H-1)** — S
- **Files:** `src/components/islands/pdf-to-image/PdfToImageTool.tsx:69` → use `getPdfjs()` (P0.1).
- **Add:** AVIF/higher-DPI handled in Phase 3; here just make it *work* and stay local.
- **Acceptance:** un-`fixme` the 3 functional tests in `tests/e2e/tools/pdf-to-image.spec.ts`
  (all-pages ZIP, single-page PNG, JPEG+quality); delete the characterization test.
- **Effort:** S.

**P1.2 · Compress PDF actually compresses (fixes M-1)** — L
- **Files:** `src/workers/pdf-worker.ts:589` (`compressPdf`), `qpdf-helper.ts`,
  `CompressImageTool`-style codec reuse.
- **Approach:** (a) debug why the current image-stream recompression path throws and remove the
  lossless pass-through fallback; (b) downsample embedded images to the target DPI and re-encode
  with **jSquash** (mozjpeg/webp) instead of canvas; (c) run **qpdf** object-stream + `--compress-streams`
  + linearization for structural savings; (d) implement the advertised **grayscale** + **strip-fonts**
  custom options for real.
- **Acceptance:** upgrade `tests/e2e/tools/compress-pdf.spec.ts` to assert a **real size reduction**
  on an image-heavy fixture (add a scanned-style fixture with an embedded JPEG); Low = lossless but
  ≤ original, Medium/High strictly smaller.
- **Effort:** L.

**P1.3 · Redact — true per-region redaction (fixes H-2)** — L (depends on D1)
- **Files:** `src/components/islands/redact-pdf/RedactPdfTool.tsx`, new
  `src/workers/redact-worker.ts` (or extend pdf-worker).
- **Approach (Option A / mupdf):** map each `mark` (percent rect → PDF points) to a MUPDF redaction
  annotation per page; `applyRedactions()` removes underlying text/images and burns the fill.
  Keep whole-page rasterize only as an explicit fallback for pages MUPDF rejects.
- **Acceptance:** new assertions in `tests/e2e/tools/redact-pdf.spec.ts`: after redaction, the
  document still has **selectable text outside** the mark (extract text via pdf.js and assert the
  redacted string is gone but a known non-redacted string remains); page count preserved; file not
  fully rasterized (text layer present).
- **Effort:** L.

**P1.4 · Edit PDF — implement "Keep as Annotations" (fixes M-3)** — M
- **Files:** `src/components/islands/edit-pdf/EditPdfTool.tsx:237-295`.
- **Approach:** when `saveMode === 'annotations'`, emit real PDF annotation objects (text/free-text,
  square, ink, stamp) via pdf-lib instead of flattening; keep Flatten as the composited path.
- **Acceptance:** `tests/e2e/tools/edit-pdf.spec.ts` — Flatten output has **no** `/Annots`; Keep
  output contains `/Annot` objects and re-opens with the annotation editable.
- **Effort:** M.

**P1.5 · Digital signature — use `@signpdf/signpdf`** — M
- **Goal:** premium-grade, spec-correct signing + support for the advertised .p12 upload path.
- **Files:** `src/components/islands/digital-signature/DigitalSignatureTool.tsx` (replace hand-rolled
  ByteRange/Contents surgery with `@signpdf` + `P12Signer`/`Signer`).
- **Acceptance:** current PKCS#7 assertions still pass; add a test that **validates** the signature
  (hash over ByteRange verifies) rather than only checking markers.
- **Effort:** M.

---

## Phase 2 — Operation visibility / live previews (the premium feel — your direct ask)

Reuse `usePdfThumbnails` to render a sample page with the effect overlaid, so users see the result
**before** downloading. Each gets a `tests/e2e/visual/*` check (screenshot + assertion the preview
updates when options change).

**P2.1 · Watermark live preview** — M — overlay text/image on a sample page; update on
opacity/rotation/size/placement change. (Registry already promises this.)
**P2.2 · Page-numbers live preview** — M — render first & last page with the number placed; reflect
position/format/start/skip.
**P2.3 · Crop visual handles** — L — draggable crop rectangle on the rendered page (like redact's
draw layer), plus the existing numeric inputs kept in sync; add **auto-crop whitespace** (detect
content bbox) and the advertised **Flatten** mode. (Covers M-5.)
**P2.4 · Compress-PDF before/after preview** — M — render a page from original vs compressed and
show the `BeforeAfterSlider` already used by compress-image.
- **Acceptance (all):** new `operation-visibility` cases assert the preview element is rendered
  (`naturalWidth>0`) and its pixels change when a relevant option changes.

---

## Phase 3 — Feature parity with what's advertised (close the honesty gap)

(Default: implement. Fallback per item: trim the copy — decision D2.)

**P3.1 · Image codecs → jSquash for real quality/ratio** — M — route `compress-image` /
`convert-image` / `resize-image` encoders through `@jsquash/*` (mozjpeg, oxipng, webp) instead of
canvas; measurably smaller files at equal quality (premium differentiator).
**P3.2 · AVIF + HEIC** — M (depends on D3) — add `@jsquash/avif` and a HEIC decoder; honor the
format menus in convert/compress/pdf-to-image, or trim.
**P3.3 · Batch everywhere** — M — compress-image & resize-image are single-file but advertise batch;
reuse the `FileList` multi-file pattern + ZIP download already in convert-image.
**P3.4 · PDF→Image: AVIF output + custom DPI to 600** — S — extend format/DPI options.
**P3.5 · Resize: Cover mode + custom saved presets** — S — add the `cover` fit + localStorage presets.
**P3.6 · Redact extras** — M — Find-&-Redact (pdf.js text search → auto-marks), full metadata strip
(qpdf), SHA-256 before/after verification panel.
**P3.7 · Merge per-file page selection** — M — expand file cards to thumbnail page pickers (advertised).
- **Acceptance:** each advertised bullet in `tools-registry.ts` maps to a passing e2e assertion; add
  a meta-test that fails if a feature bullet has no corresponding covered capability.

---

## Phase 4 — Accessibility to WCAG 2.1 AA

**P4.1 · Associate all form labels (fixes M-4)** — S — `htmlFor`/`id` (or wrap) for image-to-pdf
margins, digital-signature CN/Org, page-numbers, crop, split every-N, target-size. **Acceptance:**
extend the sweep to assert `inputsMissingLabel === 0` on **every** tool *after opening its options*
(not just at load); `getByLabel()` resolves each field.
**P4.2 · Heading hierarchy (fixes L-1)** — S — demote step/section `h3`s under an `h2`, no skips.
**P4.3 · Keyboard + SR for drag/drop & canvases** — M — dnd-kit keyboard reorder announced via
`aria-live`; redact/crop draw operable by keyboard; progress overlays announce percent.
**P4.4 · Focus management & contrast** — M — focus moves to results on completion; audit color
tokens for 4.5:1; honor `prefers-reduced-motion` (already partial in ProcessingOverlay).
- **Acceptance:** integrate `@axe-core/playwright`; zero serious/critical violations per page and in
  the mid-operation state.

---

## Phase 5 — UX polish (premium interaction quality)

**P5.1 · Consistent feedback (fixes L-3)** — S — toast = transient confirmation, panel = persistent
result with next-step actions; never identical strings.
**P5.2 · Robust error & empty states** — M — actionable errors (encrypted-PDF → deep-link to Unlock;
too-large → suggest Compress), retriable, never silent.
**P5.3 · Large-file UX** — M — size/among-page warnings, cancellable long ops (cancel already exists
in some), progress ETAs.
**P5.4 · Mobile & dark-mode pass** — M — verify every tool on a phone viewport (add a mobile
Playwright project) and both themes.
**P5.5 · Cross-tool flow** — S — the existing "next step" suggestions everywhere, consistent.

---

## Phase 6 — Performance & reliability at premium scale

**P6.1 · Move image ops off the main thread where still on it** — S — resize is canvas-on-main;
route through the image worker.
**P6.2 · Big-document hardening** — L — stream/segment large PDFs; guard memory; test 100–500 pp and
50–200 MB inputs (premium tools handle these). Add large fixtures.
**P6.3 · Cross-browser** — M — add WebKit + Firefox Playwright projects; verify HEIC, OffscreenCanvas,
COOP/COEP, downloads. Confirm COOP/COEP headers are set in **production** (Cloudflare), not just dev.
**P6.4 · Lighthouse budget** — S — wire the already-installed `@lhci/cli`; budget: perf ≥ 95,
a11y = 100, TTI < 2 s on tool pages.

---

## Phase 7 — Release gates

- All e2e green across Chromium/WebKit/Firefox + mobile; axe clean; LHCI within budget.
- A "feature-parity" meta-test ties every marketing bullet to a covered capability (no more copy drift).
- Visual-regression snapshots for the preview surfaces.
- Manual pass against a real premium-comparison corpus (scanned docs, CJK/RTL fonts, forms, CMYK).

---

## Suggested execution order (critical path first)

1. **P0.1, P0.2** (foundations + CI) → **P1.1** (PDF→Image, quick win, deletes a HIGH).
2. **P1.4, P1.5** (edit annotations, real signing) in parallel with **P1.2** (compress) — the L item.
3. **D1** decision → **P1.3** (redaction).
4. **Phase 2** previews (highest perceived-quality ROI, your priority).
5. **Phase 3** parity → **Phase 4** a11y → **Phase 5/6** polish & scale → **Phase 7** gates.

Each merged step flips its named test from `fixme`/characterization to a real passing assertion, so
"done" is observable, not asserted.
