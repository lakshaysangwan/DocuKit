> **Updated 2026-10-26 (F6):** `stripFonts` ("Strip embedded fonts") was removed because it lost text, and the DPI setting is now a real DPI — `src/lib/pdf-image-placement.ts` reads how large each image is drawn and reduces only images drawn sharper than the setting (Medium 150, High 96 DPI) instead of scaling every image by a fixed factor. Where this report mentions either, it describes the code before F6.
>
> - **What this is:** the feasibility study and design for showing compression quality in Compress PDF and Compress Image (task T12 in `HANDOFF.md`): what the current compare view does, options A–C, the recommended brief, tests, and other defects noticed. The text below the line is the design agent's report, unedited.
> - **Where it came from:** produced on 2026-10-10 by a read-only design agent from reading the code; nothing was built or run, and its timings are estimates. It read `pdf-compress.ts` before the T4 fix (`32dbf58`), so its line numbers are stale and several items in section 7 are already fixed — check each against the current code.
> - **Status on 2026-10-11:** accepted in outline, not started. Build it on the shared workspace's `PageViewer` and `CompareView` (`docs/design/tool-workspace.md`) after the workspace foundations, not on the standalone files named in section 4. Lakshay was told the defaults for the five questions in section 8 and has not objected; they are listed under T12 in `HANDOFF.md` section 6.

---

## Compress quality preview: findings and recommended design

**Verdict:** a live before/after of one page, before the visitor commits to a level, is possible for PDF and cheap, because compression only ever replaces image objects one by one. The existing after-compress slider is real but cannot show the loss it is meant to show. I recommend fixing that view first (it needs no worker changes and can carry an automatic "this page came out wrong" check), then adding the live preview on top.

Everything below is from reading code; I ran nothing. Timings are estimates, not measurements. The competitor notes are from memory, not checked today.

### 0. What the existing compare view does (corrected premise)

**Compress PDF** — `D:\Project\DocuKit\src\components\islands\compress-pdf\CompressPdfTool.tsx:64-81` and `:345-358`
- It appears only after compression finishes (`status === 'done'`), in every mode including Target size and a missed target.
- It always shows page 1 (`renderPdfPageToDataUrl(buffer, 0)` and `(result, 0)`); there is no page choice.
- It renders the real output bytes: `result` is the buffer that gets downloaded.
- Resolution comes from `D:\Project\DocuKit\src\lib\pdf-preview.ts:7-28`: longest edge 900 px, then re-encoded as a JPEG data URL at quality 0.85. For A4 that is 636×900 px, about 77 DPI.
- It is displayed at most 384 CSS px wide in a 3:4 box with `object-cover`, so pages of other proportions are cropped. There is no zoom.
- Each render copies the whole file (`buffer.slice(0)`) and opens a new pdf.js document.
- Render errors are swallowed, so the preview is silently absent on failure.
- `response.stats` (`imagesTotal`, `imagesRecompressed`) is returned by the worker but never read by the island (`:141-150`).

**Why it cannot show quality loss.** High shrinks a 300 DPI scan to about 144 DPI, and the harshest Target step to about 75 DPI. Both are at or above the 77 DPI the preview renders at. Both sides also pass through the same 0.85 JPEG. Only gross damage is visible, such as the black page the owner found.

**Compress Image** — `D:\Project\DocuKit\src\components\islands\compress-image\CompressImageTool.tsx:274-282`
- After compression only, single file only (nothing in batch mode), both quality and target-size modes.
- Uses the real original and real output blobs at full resolution, but in a 16:9 `object-cover` box with no zoom.

**The slider itself** — `D:\Project\DocuKit\src\components\islands\shared\BeforeAfterSlider.tsx:86`
- The "before" image width is read from a ref during render. On first paint the ref is null, so the before layer is laid out inside the half-width clip and the two halves do not line up until the first drag. It is also stale after a resize.

**Test coverage.** `D:\Project\DocuKit\tests\e2e\visual\operation-visibility.spec.ts:108-126` asserts only that two images paint and have different `src`. It would pass on a black output.

### 1. How compression works today

All in `D:\Project\DocuKit\src\lib\pdf-compress.ts`. The same function runs in `pdf-worker.ts:769-772` and inline on the main thread where there is no OffscreenCanvas (`worker-pool.ts:41`, `:183-220`).

| Step | What happens | Where |
|---|---|---|
| Load | pdf-lib, `ignoreEncryption: true` | `:123` |
| Metadata | Title, Author, Subject, Keywords, Producer, Creator blanked at every level | `:131-136` |
| Image pass | Skipped when `level === 'low'`; otherwise every object with `/Subtype /Image` | `:156-172` |
| JPEG images | Decoded with `createImageBitmap`; skipped entirely when quality ≥ 90 | `:202-205` |
| Flate images | Inflated and read as 8-bit Gray/RGB/CMYK; everything else (JBIG2, JPX, CCITT, filter arrays, under 1 KB, over 10000 px) skipped | `:189`, `:197`, `:206-261` |
| Downscale | `scale = imageScale ?? (dpi < 150 ? dpi/150 : 1)` | `:269` |
| Grayscale | Images only | `:279-287` |
| Encode | jSquash mozjpeg; replaced only if smaller, with a brand-new dict (DeviceRGB, DCTDecode) | `:293-311` |
| Structure | pdf-lib save with object streams, then lossless qpdf pass, kept if smaller | `:320-345`, `qpdf-helper.ts:37-57` |

Text, fonts, vectors and content streams are never touched, except by `stripFonts`, which deletes page font mappings (`:139-152`).

**Levels** (presets live in the island, `CompressPdfTool.tsx:111-119`):
- **Low:** no image work.
- **Medium:** JPEG quality 75, scale 1 (no downsampling).
- **High:** quality 50, scale 72/150 = 0.48 per side (about 23% of the pixels).
- **Custom:** quality 1–100; the "DPI" slider 36–300 does nothing from 150 upward.

**Target size** (`:44-113`): a 12-step ladder from Low to quality 25 at scale 0.25. It runs the gentlest step, then the harshest, then bisects, for at most 6 whole-file passes. It returns the gentlest step that fits, or the smallest result if none does. The chosen step is not returned to the caller.

**Compress Image** (`D:\Project\DocuKit\src\lib\image-ops.ts:85-148`): decode, then jSquash encode at the chosen quality (mozjpeg, libwebp, AVIF or PNG; "original" means WebP). It returns the original if the output is not smaller. Target size is a binary search on quality 5–95 with no resizing; the quality found is not returned.

### 2. Feasibility

**PDF: possible with limits.**
- Each image is replaced independently and deterministically. A one-page PDF cut from the original and run through the same `compressPdfOnce` therefore renders exactly as that page will in the full output, at one page's cost.
- Limit 1: the file's total size cannot be known from one page. Before the run, only "images on this page: X → Y" is honest.
- Limit 2: Target size cannot be previewed before it runs, because the step depends on whole-file size. It gets an after-view plus "what it took".
- Limit 3: on engines without OffscreenCanvas the preview compress runs on the main thread and cannot be cancelled, so live-on-drag must become a button there.
- Limit 4: a page whose shared resources reference many images would pull them all into the one-page PDF. It needs a pixel budget and a fallback to the after-view.

**Images: possible.**
- The preview can be the real output: one encode per settled change, which is also the file to download.
- Limits: AVIF and very large images are too slow for live update; Target size is several encodes.

**Cost estimates.**
- One 300 DPI A4 colour scan page (8.7 MP): roughly 1–3 s to re-encode on a desktop and several seconds on a mid-range phone, plus about 0.2–0.6 s per pdf.js render. High is cheaper than Medium because it downsizes first.
- A 200-page scan at 300 DPI: minutes per pass today, times up to 5 image passes in Target mode. A whole-file preview per tick is out; one page costs 1/200 of that.
- Memory: the image pass holds roughly 100 MB transient for an 8.7 MP image (bitmap, canvas and ImageData; bitmaps are never closed). The preview adds a one-page PDF and two canvases. Cap each canvas at about 8 MP on desktop and 4 MP on phones.

**CSP.** `D:\Project\DocuKit\public\_headers:8` already allows `img-src blob: data:` and `worker-src blob:`. No change is needed and no network is involved.

### 3. Options (what is missing on top of the existing view)

**Option A — make the after-view truthful. About 3 h. No worker or hot-file changes.**
- **Visitor sees:** after compressing, any page (previous/next/number), Fit/100%/200% zoom with pan, split or side-by-side, the whole page uncropped. A facts line with the settings used and "N of M images re-encoded" (already in `stats`). A warning when a page came out grossly different.
- **How:** open original and output once each with pdf.js, render the chosen page to lossless PNG blobs at the zoom scale, and reduce both renders to a 32×32 brightness grid for the corruption check.
- **Large files:** two pdf.js handles instead of two full copies per page flip; one page rendered at a time.
- **Risks:** low. Corruption thresholds need calibrating so High and the harshest Target step never trip.

**Option B — A plus live preview while choosing. About 5–6 h more for PDF, about 2 h for images. Recommended.**
- **Visitor sees:** on file drop the preview appears on the most image-heavy page, before Compress is clicked. Changing level, custom sliders or grayscale updates the "after" side and "images on this page: X → Y". Target mode shows the result after the run with "to fit, images were set to JPEG quality 50 at 60% of their dimensions" and a warning at the harsh end.
- **How:** one worker probe returns a per-page image inventory plus a one-page PDF. Each settled change (250 ms debounce, latest-wins token, small cache per page and settings) sends that one-page PDF through the existing `compress-pdf` op. Both sides render from one-page PDFs, so the big file is never re-copied.
- **Large files:** one pdf-lib parse per page change, then per-page cost only. Above a pixel budget, on phones, or with no OffscreenCanvas, it shows a "Preview this level" button instead of updating live.
- **Risks:** touches `pdf-compress.ts`, `worker-messages.ts`, `pdf-worker.ts` and `worker-pool.ts` (all additive); shared-resource pages.

**Option C — fullest. About 6–8 h more.**
- "Images are 96% of this file", so a text-only PDF is told up front it will barely shrink.
- Effective DPI before and after on the previewed page, from a pdf.js operator-list walk.
- A Low/Medium/High strip of the same crop with per-page sizes.
- Visible-region rendering for deep zoom on phones.
- A background corruption sweep over all pages (about 1–3 min for 200 scanned pages).
- **Risks:** estimate honesty, pdf.js internals, memory.

**Corruption detection, specifically.**
- Wherever both renders exist the check is nearly free (under 5 ms): compare the brightness grids and flag when the mean difference or the share of strongly changed cells crosses a calibrated threshold.
- It catches black, inverted, sheared and missing-mask pages regardless of cause, because it uses pdf.js as an independent check on the real output.
- Checking 6 extra sampled pages after a run costs about 1–5 s in the background.
- It cannot catch a page pdf.js renders wrongly on both sides, or small local damage.

### 4. Recommendation and brief

Ship A now, then B once the `pdf-compress.ts` fixes have landed. A alone would have flagged the black-scan bug on screen.

**PR 1 (Option A)**
- **New `src/lib/pdf-thumbs.ts`** (or `pdf-page-render.ts` if T-shared lands first with a different shape): `openPdf(buffer) → { numPages, renderPage(index, { scale, maxPixels, signal }) → { blob (PNG), width, height, imageData }, destroy() }`. Do not edit `pdf-preview.ts`; it has uncommitted T0 changes.
- **New `src/lib/render-compare.ts`** (pure): `lumaGrid(imageData, 32)` and `compareGrids(a, b) → { meanAbsDiff, changedCellShare, verdict: 'same' | 'changed' | 'suspect' }`, with named threshold constants.
- **New `src/components/islands/shared/CompareView.tsx`:** two `<img>` layers clipped with `clip-path` (not the width hack), `object-contain`, modes Split / Side by side / Hold for original, zoom Fit / 100% / 200% with synced pan, keyboard divider.
  - Test ids: `compare-view`, `compare-before`, `compare-after`, `compare-zoom-fit|100|200`, `compare-mode-split|side|hold`.
- **New `src/components/islands/compress-pdf/CompressPreviewPanel.tsx`:** page picker, CompareView, facts, warnings.
  - Test ids: keep `compress-preview` as the wrapper with exactly two `img` inside, so the existing visual spec stays green. Add `data-source="preview|output"` on it. Add `preview-page-input`, `preview-page-prev`, `preview-page-next`, `preview-status` (aria-live), `quality-facts`, `corruption-warning`.
- **Edit `CompressPdfTool.tsx`:** replace `:59-81` and `:345-358`; read `response.stats`. On `suspect`, show the warning and demote the download to "Download anyway".
- **Edit `CompressImageTool.tsx:274-282`** to use CompareView (100% means image pixels 1:1).

**PR 2 (Option B)**
- **`pdf-compress.ts`:**
  - Compute settings once and return `applied`.
  - Have `compressPdfToTarget` return the chosen step.
  - Collect per-image outcomes when `options.report` is set.
  - Export the eligibility predicate so the probe uses the same rules.
- **New `src/lib/pdf-compress-presets.ts`:** level presets moved out of the island, so the UI and the facts read the same constants.
- **New `src/lib/pdf-compress-probe.ts`:** pure pdf-lib, no canvas, so it runs in the worker on every engine. It walks page resources (including form XObjects), picks the page with the most eligible image bytes when none is given, and returns the copied page.
- **`worker-messages.ts`** additions:

```ts
// CompressPdfOptions
report?: boolean;
// WorkerRequest
| { op: 'compress-probe'; buffer: ArrayBuffer; pageIndex?: number; progressPort: MessagePort }
// WorkerResponse
| { status: 'success-probe'; pagePdf: ArrayBuffer; pageIndex: number; pageCount: number;
    pages: { pageIndex: number; images: number; eligible: number; eligibleBytes: number; maxPixels: number }[];
    totals: { images: number; eligible: number; eligibleBytes: number; fileBytes: number } }
// ProcessingStats
applied?: { jpegQuality: number; imageScale: number; lossless: boolean; ladderStep?: number; ladderSteps?: number };
images?: { width: number; height: number; outWidth: number; outHeight: number; bytesBefore: number; bytesAfter: number;
           source: 'jpeg' | 'flate' | 'other'; action: 'recompressed' | 'kept';
           reason?: 'small' | 'unsupported' | 'masked' | 'not-smaller' | 'quality-90-plus' | 'failed' }[];
```

- **`pdf-worker.ts`:** one new `case`, and pass the new stats through at `:770-771`. Do the same passthrough in `worker-pool.ts:201-209`. The probe is not a canvas op.
- **New `src/components/islands/compress-pdf/useCompressPreview.ts`:** calls `workerPool.submit` directly, not `useWorker`, whose `run` aborts the previous job by terminating the worker. Let short preview jobs finish and drop stale results by token; terminate only on file removal or page change. Pause while a full compression runs.
- **New `src/lib/compress-facts.ts`** (pure): turns `applied` and `images` into the facts shown.
  - More test ids: `preview-page-size`, `target-applied`, `quality-warning`.
- **Images:**
  - `compressImage` returns `{ buffer, format, quality }` (call sites: `image-worker.ts:21`, `worker-pool.ts:192`).
  - The island auto-compresses on debounce for JPEG/WebP up to about 12 MP and keeps the button otherwise.
  - Show "quality 43% was needed to fit 100 KB".

**What the copy must satisfy**
- Name the page.
- Say "preview" before the run and "result" after.
- The pre-run size is for that page's images only, never the file.
- "Text and vector graphics are not changed" only when `stripFonts` is off.
- When the page has images and pdf.js finds no text on it, say the text is part of the picture and is compressed with it.
- Low: "images are not re-encoded; document properties are cleared".

**Tests**
- New `tests/e2e/tools/compress-preview.spec.ts` on `FIXTURE.pdfPhoto` (4 Letter pages, full-page JPEGs), with an in-page helper that draws both images to a canvas and returns mean absolute difference:
  1. PR 2: the preview is visible with both images painted while `download-button` is absent.
  2. Pixel proof: Low gives a difference of 0; Medium is above 0; High is above Medium.
  3. Size proof: `preview-page-size` after-bytes satisfy High < Medium < before.
  4. Faithfulness: the after image in preview at High matches the after image re-rendered from the real output once Compress finishes (`data-source="output"`), difference under 0.5.
  5. Five quick quality changes in Custom settle on facts naming the last value.
  6. Target 12 KB shows `target-applied` and `quality-warning`; Target 1 MB shows neither.
  7. Changing page changes the before image.
  8. `corruption-warning` is absent at High and at the harshest Target.
- Vitest: `render-compare` (identical, JPEG-like noise, black, inverted, half-black) and `compress-facts`.
- Verify gate: one WebKit run for the no-OffscreenCanvas path, and the existing no-external-requests guard.

**Registry and coverage.** Keep the bullet string `'Side-by-side quality preview'` unchanged; it is in the registry, three landing pages and `coverage.ts:66`. Point its coverage entry at the new spec. Any new bullet (for example "Check any page at 100% before you download") goes through the coordinator.

### 5. Quality indicators

**The code can back these:**
- JPEG quality used.
- Image dimensions before and after, in pixels and as a percentage per side.
- "N of M images on this page re-encoded; K left as they are", with the reason.
- Bytes for this page's images before and after.
- "Images are not re-encoded" at Low.
- "Text and vector graphics are not changed" (with the conditions above).
- "This page has no selectable text."
- The Target step chosen and whether it was the harshest.
- The corruption verdict.

**Avoid these:**
- Any 0–100 quality score, or "visually lossless".
- "Up to 90%".
- A DPI figure taken from the current slider; it is a scale factor relative to an assumed 150, not a resolution. Real effective DPI needs image placement (Option C).
- A whole-file size before the run.
- "Text stays sharp" on scanned pages.

### 6. Conflicts and ordering

- **`pdf-compress.ts`:** PR 2 edits the same loop as the `/SMask` fix (T4) and the black-output fix. Do PR 2 after both land. PR 1 does not touch the file.
- **T0's uncommitted edits:** `worker-messages.ts`, `pdf-worker.ts`, `tools-registry.ts`, `coverage.ts` and `pdf-preview.ts` all have uncommitted T0 changes in the main checkout. PR 2's edits are additive and in other regions, but should wait for the T0 commit. Registry and coverage lines go to the coordinator.
- **`shared/*`:** only a new file (`CompareView.tsx`). `BeforeAfterSlider` has no other users and can be deleted once both tools have moved.
- **Planned shared pieces:**
  - `PagePreviewDialog` is independent; CompareView can be hosted in it later for full screen.
  - `lib/pdf-thumbs.ts` overlaps with the open-once single-page renderer. This feature should not wait; whichever lands first creates that function there and the other builds on it.

### 7. Things that look wrong, outside this question

**PDF compression (`pdf-compress.ts`)**
- `:301-311` — the replacement dict drops `/SMask`, `/Mask`, `/Decode` and the original colour space. A dropped `/Decode` inverts images, a second route to black pages besides the mask loss T4 covers.
- `:165-172` — the loop also converts images that are themselves soft masks into DeviceRGB JPEGs. Scanners that layer a page as background plus masked foreground would break here. T4 should skip mask streams as well as images that carry one.
- `:206-258` — the Flate path ignores `/DecodeParms` predictors, which are common. Predictor rows are read as raw pixels, and the length check at `:234` lets them through, so the image comes out sheared. The colour space is guessed by substring (`:231-232`): Indexed-on-Gray and 4-channel ICC images are misread.
- `:203` — quality ≥ 90 skips JPEGs even when downscaling was asked for.
- `:269` and `CompressPdfTool.tsx:254` — "Image DPI" is not a DPI.
- `:139-152` — "Strip embedded fonts" removes font mappings, so text can vanish. The checkbox carries no warning (`CompressPdfTool.tsx:278`).
- `:279-287` — "Convert to grayscale" affects images only.
- `:205`, `:257` — bitmaps are never closed.
- Non-target levels can return a file larger than the input; the never-larger guard exists only in Target mode.

**Compress PDF island and copy**
- `CompressPdfTool.tsx:141-150` — it reports success even when no image was re-encoded.
- `CompressPdfTool.tsx:105-109` — status is set to processing before the target is validated and is left there.
- `tools-registry.ts:108-125` — "4 compression levels" (there are five options); a "Compress & Download" button that does not exist; `mupdf` listed as a dependency though compression does not use it; unbacked percentage ranges.

**Compress Image**
- `CompressImageTool.tsx:113` — the output blob is typed from the requested format even when the bytes are the returned original (`image-ops.ts:109`, `:147`) or WebP substituted for PNG in Target mode (`image-ops.ts:121`). The download gets the wrong extension.
- `image-ops.ts:92-95` — no white fill, so a transparent PNG saved as JPEG gets a black background.
- `image-ops.ts:145-147` — a missed target is not reported.
- `stripExif` and `percentage` are never read, and the copy mentions both.
- The quality slider does nothing for PNG.

**Worker pool**
- `worker-pool.ts:94-104` — an abort does not drain the queue.

### 8. Questions for the owner

1. Should the preview start automatically on file drop on phones, or sit behind a "Preview quality" button there to save battery and memory?
2. When a page looks corrupted, should the download be blocked, or shown as "Download anyway" with a warning (my default)?
3. Is it acceptable that Target size shows its preview only after the run, with "what it took"?
4. Should the DPI slider be made a real resolution? That changes what Medium and High produce and decides whether a DPI figure can be shown.
5. For Compress Image, should moving the slider compress automatically, making the Compress button mostly redundant?

### Critical Files for Implementation
- D:\Project\DocuKit\src\lib\pdf-compress.ts
- D:\Project\DocuKit\src\components\islands\compress-pdf\CompressPdfTool.tsx
- D:\Project\DocuKit\src\components\islands\shared\BeforeAfterSlider.tsx
- D:\Project\DocuKit\src\types\worker-messages.ts
- D:\Project\DocuKit\src\components\islands\compress-image\CompressImageTool.tsx
