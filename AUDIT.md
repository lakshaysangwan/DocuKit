# DocuKit — UI/UX, Functional & Performance Audit

**Date:** 2026-08-25
**Method:** A committed Playwright e2e suite that drives all 19 tools with *real* generated
files (PDFs via pdf-lib, images via browser canvas), exercises every option, runs each
operation, and asserts on the real output bytes — plus a site-wide sweep that records load
timing, console/network errors and static accessibility observations for all 22 pages.

- Suite: `tests/e2e/` (run `npx playwright test`)
- Raw sweep data: `test-results/audit-sweep.json`
- Operation-visibility screenshots: `test-results/screens/`
- Result at time of writing: **96 passed, 3 skipped** (the 3 skips document a live bug — see H-1).

Findings are reported, **not fixed** (per the brief). Severity: **HIGH** (broken / privacy /
data-integrity), **MEDIUM** (feature missing vs. promised, or notable UX/a11y gap), **LOW**
(polish / copy accuracy).

---

## Severity summary

| # | Severity | Area | Finding |
|---|----------|------|---------|
| H-1 | **HIGH** | PDF→Image | Tool is completely non-functional (pdf.js version mismatch) **and** loads its worker from an external CDN, breaking the "nothing leaves your device" promise |
| H-2 | **HIGH** | Redact | Whole-page rasterization instead of true per-region redaction; destroys selectable text on the *entire* page; advertised MUPDF/Find-&-Redact/metadata-strip features absent |
| M-1 | MEDIUM | Compress PDF | Does not actually compress — falls back to a lossless pass-through ("requires MUPDF (coming soon)"); no quality preview |
| M-2 | MEDIUM | Multiple | **Operation not visible before applying** — several tools advertise live previews they don't have (watermark, page-numbers, compress-pdf, crop) |
| M-3 | MEDIUM | Edit PDF | "Flatten" vs "Keep as Annotations" toggle is non-functional — both always flatten |
| M-4 | MEDIUM | A11y | Form inputs not programmatically associated with their labels (image-to-pdf, digital-signature, page-numbers, crop) |
| M-5 | MEDIUM | Crop PDF | Advertised visual drag-handles / auto-crop / Flatten mode not implemented (numeric CropBox only) |
| L-1 | LOW | A11y | Heading hierarchy skips h2 (sign-pdf, digital-signature) |
| L-2 | LOW | Copy | Feature lists overstate format/mode support in several tools |
| L-3 | LOW | UX | Success message duplicated identically in toast **and** result panel |

---

## HIGH severity

### H-1 · PDF→Image is broken and leaks to a third-party CDN
**Files:** [PdfToImageTool.tsx:69](src/components/islands/pdf-to-image/PdfToImageTool.tsx#L69)
**Test:** `tests/e2e/tools/pdf-to-image.spec.ts` (characterization test passes; 3 functional tests `test.fixme`)

The tool sets its pdf.js worker to a **remote CDN pinned at 4.4.168**:
```
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
```
while the bundled `pdfjs-dist` is **5.5.207**. Every conversion aborts with
*"The API version '5.5.207' does not match the Worker version '4.4.168'."* — the tool produces
no output at all. This was confirmed live (the error text renders in the UI).

Two problems in one line:
1. **Functional:** version mismatch → 100% failure. Every other tool loads the worker locally
   from `/pdfjs/pdf.worker.min.mjs`; this one should too.
2. **Privacy:** loading the worker from `unpkg.com` contradicts the site-wide promise
   ("All processing happens locally in your browser", "no uploads"). It also fails offline.

**Fix direction:** point `workerSrc` at the local `/pdfjs/pdf.worker.min.mjs` (as merge/edit/redact do).

### H-2 · Redact rasterizes the whole page (not true per-region redaction)
**File:** [RedactPdfTool.tsx:121-160](src/components/islands/redact-pdf/RedactPdfTool.tsx#L121-L160)
**Test:** `tests/e2e/tools/redact-pdf.spec.ts`

When any mark exists, the tool renders **every page** to a canvas and re-embeds it as a flat
JPEG. Consequences:
- Text on *any* redacted page becomes non-selectable/non-searchable — not just the redacted
  region. This is a real accessibility + usability regression and inflates file size.
- The registry advertises **"True redaction via MUPDF," "Find & Redact by text pattern,"
  "Full Metadata Strip," "SHA-256 before/after comparison"** — none are implemented.

The safe way to redact only the marked regions (and keep the rest selectable) is content-stream
surgery, which pdf-lib can't do but **MUPDF (already a listed dependency for this tool) can**,
via redaction annotations. See the design note below (this was also raised directly).

> ⚠️ Do **not** "fix" this by drawing black boxes over text with pdf-lib — the glyphs remain in
> the content stream and are recoverable with Select-All/Copy. That is the classic redaction
> failure. Region-only redaction requires removing the underlying text (MUPDF).

---

## MEDIUM severity

### M-1 · Compress PDF doesn't compress
**File:** [CompressPdfTool.tsx:84-104](src/components/islands/compress-pdf/CompressPdfTool.tsx#L84-L104)
**Test:** `tests/e2e/tools/compress-pdf.spec.ts`

On the real compression path the worker returns an error and the UI falls back to a lossless
"merge-with-self" pass-through, toasting *"Full compression requires MUPDF (coming soon)."* The
tool page advertises "reduce file size by up to 90%," a "side-by-side quality preview," and
"custom DPI/JPEG quality" — the medium/high presets don't meaningfully reduce size and there is
no preview. Output is always a valid PDF, so it *looks* like it worked. (Tests confirm valid PDF
output and that Low/Medium/Custom controls render; they intentionally don't assert a size drop.)

### M-2 · Operations aren't visible before you apply them (preview gap)
This is the most impactful UX theme and was raised directly: *what an operation does should be
clearly visible.* Where the app shows the document, it does so well; where it doesn't, users
configure blind and only discover the result after downloading.

**Verified visible (good):** `tests/e2e/visual/operation-visibility.spec.ts` + screenshots in
`test-results/screens/`:
- Merge / Reorder / Sign / Redact render **real** page thumbnails (asserted `naturalWidth > 0`).
- Edit PDF: adding a text annotation **visibly changes the canvas** (before/after pixel diff).
- Redact: the drawn mark is a visible red overlay before applying.
- Compress **Image**: real before/after comparison slider.

**Missing previews (advertised but absent):**
| Tool | Advertised | Reality |
|------|-----------|---------|
| Watermark PDF | "Live preview on sample page" | No preview — configure blind, see result only after download |
| Add Page Numbers | "Live preview on first and last page" | No preview |
| Compress PDF | "Side-by-side quality preview" | No preview |
| Crop PDF | "Visual crop with drag handles" | Numeric margins only — you can't see the crop box |

**Recommendation:** add a single rendered sample page with the effect overlaid (watermark,
page number, crop rectangle) — the thumbnail infrastructure (`usePdfThumbnails`) already exists
and is used by merge/organize/sign/redact.

### M-3 · Edit PDF save-mode toggle does nothing
**File:** [EditPdfTool.tsx:237-295](src/components/islands/edit-pdf/EditPdfTool.tsx#L237-L295)
**Test:** `tests/e2e/tools/edit-pdf.spec.ts` (asserts both options render)

`handleSave` never reads `saveMode`; it always composites annotations into the page image
("flatten"). The "Keep as Annotations" option (which promises Adobe-editable annotation objects)
produces the same flattened output — misleading.

### M-4 · Unlabeled form controls (accessibility)
**Sweep:** `test-results/audit-sweep.json` → `inputsMissingLabel` = 4 on image-to-pdf, 2 on
digital-signature (visible at load). Found additionally during test authoring on **page-numbers**
(Start number / Skip first N), **crop-pdf** (top/right/bottom/left margins) once their panels open.

Labels are rendered as adjacent text but not associated (`<label>` without `htmlFor`, input
without `id`), so screen readers announce these number fields as unlabeled. `getByLabel()` can't
find them either — a good proxy for the a11y gap. **Fix:** add `htmlFor`/`id` pairs or wrap the
input in the `<label>`.

### M-5 · Crop PDF is numeric-only
**File:** [CropPdfTool.tsx](src/components/islands/crop-pdf/CropPdfTool.tsx)
Registry advertises "visual crop with drag handles," "auto-crop whitespace detection," and a
"Flatten (permanent)" mode. The implementation offers numeric margins (mm/pt), all/range, and
hardcodes `mode: 'cropbox'`. Functional for what it does; three advertised capabilities are absent.

---

## LOW severity

### L-1 · Heading hierarchy skips
**Sweep:** `headingSkips` — sign-pdf (`h1 → h3 "Step 1: Create your signature"`) and
digital-signature (`h1 → h3 "Certificate"`) jump a level. Minor screen-reader/navigation nit;
demote to `h2` or promote the surrounding structure.

### L-2 · Feature lists overstate support
Copy vs. implementation mismatches (marketing accuracy):
- **Convert Image / Compress Image:** advertise AVIF/BMP/TIFF/ICO/GIF/SVG/HEIC; output is
  JPEG/PNG/WebP only. Compress is single-file (claims batch).
- **PDF→Image:** advertises AVIF and DPI up to 600; offers PNG/JPEG/WebP and presets to 300.
- **Resize Image:** advertises a "Cover" mode, custom preset saving, and batch; offers
  fit/fill/stretch, single-file, social presets only. (Also uses a canvas path, not the
  advertised WASM.)

### L-3 · Duplicate success messaging
Success text is shown identically in a Sonner toast **and** the result panel (e.g. "Watermark
applied!", "Page numbers added!"). Harmless but redundant; it also indicates the toast and panel
copy aren't differentiated (the merge tool does this better: toast "PDFs merged!" vs panel
"Merge complete").

---

## Performance

Measured by the sweep against a warm `astro dev` server (production is static + CDN, so expect
equal-or-better). All 22 routes, sorted slowest first:

| Metric | Best | Worst | Notes |
|--------|------|-------|-------|
| TTFB | 10 ms (privacy) | 45 ms (home) | Excellent |
| DOMContentLoaded | 158 ms | 336 ms (home) | Fast |
| Full load | 163 ms | 336 ms (home) | Fast |

- **No console errors** and **no failed (≥500) requests** on any page (after filtering dev-only
  Vite/`astro dev` re-optimization noise).
- Home is the heaviest page (tool grid + icons) but still ~336 ms full load.
- **Caveat:** First-Contentful-Paint came back `null` on most pages in the sweep — a
  measurement-timing artifact of reading paint entries right after `load`, **not** a page issue.
  Treat FCP numbers as unreliable here; TTFB/DCL/load are trustworthy.
- WASM tools have a genuine cold-start cost on first use (WASM compile + Vite dep optimize in
  dev) — that's why processing timeouts in the suite are generous. Not visible in page-load
  metrics because work is deferred to the worker on first operation.

---

## What's working well (verified, not assumed)

- **Real cryptography round-trips:**
  - Protect → Unlock recovers a readable PDF; wrong password is rejected
    (`tests/e2e/tools/protect-unlock-pdf.spec.ts`).
  - Lock Image produces a self-contained HTML that **actually decrypts** with the password and
    rejects the wrong one (`tests/e2e/tools/lock-image.spec.ts`).
  - Digital Signature emits a genuine PKCS#7 signature dict (`/Type /Sig`,
    `adbe.pkcs7.detached`, `/ByteRange`) from an in-browser RSA-2048 self-signed cert
    (`tests/e2e/tools/digital-signature.spec.ts`).
  - View-Once keeps the AES key in the URL **fragment** only (never before `#`)
    (`tests/e2e/tools/view-once-image.spec.ts`).
- **Correct document operations:** merge page counts, split modes (extract/remove/ranges/each/
  every-N with ZIP output), reorder/rotate/delete, page numbers, watermark (text + image),
  image↔PDF, resize to exact pixel dimensions (verified by decoding the output).
- **Accessibility baseline is solid:** every page has exactly one `h1`, `main`/`banner`/
  `contentinfo` landmarks, `lang="en"`, a viewport meta, unique `<title>` + meta description,
  `alt` on all images, and accessible names on all buttons/links.
- **Operation visibility where it counts:** thumbnails genuinely render; edits visibly change
  the canvas; redaction marks and image before/after are shown.

---

## Test-suite notes (for future maintenance)

- **`data-testid` added throughout** to make the app reliably testable: `dropzone`
  (+ `data-hydrated`, `data-state`, `data-compact`), `tool-action` (every primary action),
  `download-button`, `processing-overlay`, `file-card`/`file-row`/`file-info`/`file-remove`,
  `page-thumb`, `editor-canvas`, `redact-page`, and `password`/`confirm-password`/`unlock-password`.
- **Hydration gate:** DropZone now exposes `data-hydrated`; the harness waits on it before
  setting files. Astro islands hydrate on idle, and setting a file `<input>` before the React
  `onChange` is wired silently drops the file — this was the root cause of the two original
  merge-pdf flakes. (Real users can't act before hydration, so this is a test-robustness
  affordance, not a user-facing bug.)
- **Page counting:** `countPdfPages` (regex) works for worker-saved PDFs; tools that call
  pdf-lib `.save()` directly use object streams, so those use `countPdfPagesStrict` (real parser).
- **Known-broken quarantine:** the 3 PDF→Image functional tests are `test.fixme` with a
  characterization test that will start failing (alerting) once H-1 is fixed.

---

## Design note — per-region ("true") redaction (answering the direct question)

Requested behavior: redact only the marked area, keep the rest of the page selectable.

- **Current:** whole-page rasterize → safe but destroys all text on the page (H-2).
- **Unsafe shortcut:** black box over text with pdf-lib → text still copyable underneath. Never ship.
- **Correct:** **MUPDF (WASM)** redaction annotations — `pdf_add_redaction` / `pdf_apply_redaction`
  remove the underlying text/images intersecting each rectangle and burn the fill, leaving the
  rest of the page as native selectable text. `mupdf` is already a declared dependency for this
  tool, so this was the intended design; the code fell back to rasterization. Recommend wiring the
  existing `marks` state to MUPDF redaction and keeping full-page rasterize only as a fallback.
