> - **What this is:** the design for one shared workspace for all 20 tools (task T13 in `HANDOFF.md`): audit, layouts, component contract, per-tool mapping, rollout, risks, bugs found, and the owner's decisions. The text below the line is the design agent's report, unedited.
> - **Where it came from:** produced on 2026-10-10 by a read-only design agent from reading the code; nothing was built or run. It read the tree before T0, T4 and T14 were committed, so its line numbers and its notes about "the uncommitted batch" are older than `main`.
> - **Status on 2026-10-11:** the plan of record, not started. Lakshay was told the defaults for decisions 1–4 in section 8 and has not objected; decisions 5 and 6 are still waiting on him. It replaces T-shared and reshapes T1, T2 and T5. Work now runs one sub-agent at a time, so read "parallel with" in section 5 as an ordering constraint only; the serial order is in `HANDOFF.md` section 6.

---

# DocuKit shared tool workspace: audit, design, contract, rollout

Read-only work: nothing was edited, built or run. Every finding comes from reading the code on disk (including the uncommitted batch); items I inferred but did not execute are marked "inferred".

## 0. Summary

- **Root cause is structural.** All 20 islands render one column inside `max-w-6xl` (1104px of content) in `ToolPageLayout.astro`. Previews are capped at `max-w-sm` (384px) or smaller and sit above or below the controls, so the document and the option that changes it are never on screen together.
- **Every tool has the two-button problem.** A `tool-action` button processes, then a separate `DownloadButton` appears beside it and a result panel appears below. "Apply & Download" (Sign, Rearrange) does not download.
- **Proposal: one in-flow, viewport-height workspace** that replaces the narrow column the moment a file is accepted. Document pane on the left, 380px controls pane on the right, and a fixed-height action bar whose single slot goes action → progress → download.
- **Pilot: Sign PDF**, then Image to PDF as second consumer, then freeze the contract and fan out 3–4 tools per round.
- **The existing test contract survives.** `tool-action` → `download-button` → download event stays as it is; both ids now render in the same slot.

Recurring technical finding: every place-on-page tool writes raw pdf-lib user-space coordinates from `page.getSize()` and ignores `/Rotate` and box offsets. Previews will not match output on rotated scans or cropped PDFs until the shared geometry module below exists.

---

## 1. Audit

Width for every tool: 1104px single column, about 57% of a 1920px screen. Severity reflects the visibility and discoverability gap.

| Tool | Archetype | Sees of input | Sees of result before download | Next action obvious? | Gap | Sev |
|---|---|---|---|---|---|---|
| Sign PDF | Place on page | 96×64px thumbnails (`h-24 w-16 object-cover`) | Nothing: a 12px green dot and "N stamps placed" | No (section 4.1) | Position and size hard-coded; cannot see, move, resize or remove | Critical |
| Image to PDF | Build a document | A4-ratio file cards that ignore every setting | Nothing | Yes | Page size, margins, fit and orientation are invisible | High |
| Merge PDF | Build a document | First-page card per file; ranges in a collapsed `<details>` | Nothing | Mostly | No page-level view; output order invisible | High |
| Split PDF | Pick pages | Thumbnails up to 80px wide, in 3 of 5 modes only | Counts only; no list of output files | Partly | No view in Every-N and Each modes; outcome not shown | High |
| Compress PDF | Whole-file transform | File name only | Page-1 slider at 384px, cropped by `object-cover`, only after a full run | Yes | Cannot judge quality before committing; one page, no zoom | High |
| Watermark PDF | Place (parametric) | Page-1 canvas at 384px | Same canvas, and it does not match the output (section 7) | Yes | Small, page 1 only, misleading | High |
| Crop PDF | Place on page | Page-1 canvas at 384px | Dimmed overlay on page 1 | Partly | "Current page" is always page 1; edge grab zone about 5 CSS px | High |
| Redact PDF | Place on page | All pages at 800px in a 60vh scroll box | Red marks; no after-view | Yes for mouse; No for touch | Mouse events only; no way to verify the result | High |
| Page Numbers | Place (parametric) | Page-1 canvas at 384px | Same; blank with no explanation when "skip first N" ≥ 1 | Yes | Page 1 only; margins not adjustable | Med-High |
| Resize Image | Image | No image at all (name and dimensions) | Nothing; fit modes unpreviewed | Yes | Result invisible | Med-High |
| Digital Signature | Transform (+place) | File name only | Nothing; a visible box is stamped on page 1 at a fixed spot, unannounced | Yes | Visitor never sees where the box goes | Med-High |
| Rearrange / Rotate | Arrange pages | S/M/L grid (80/120/160px) from 150px renders | The grid is the result | Partly: rotate, delete, duplicate are hover-only | Controls invisible on touch; no enlarge | Medium |
| Edit PDF | Place (free) | Page at container width; 60×80 strip | The canvas | Partly: icon-only toolbar | Renders every page up front before showing anything; no zoom | Medium |
| PDF to Image | Pick + convert | Thumbnails up to 80px | Nothing of the output image or its pixel size | Yes | Output unpreviewed | Medium |
| Compress Image | Image | 256px preview (single); list (batch) | Slider in `aspect-video` with `object-cover`, which crops | Yes | Small, cropped, no zoom | Medium |
| Convert Image | Image | File cards | Nothing | Yes | Low stakes | Low-Med |
| Unlock PDF | Transform | Name and encryption details | Nothing | Yes | Showing the opened pages would confirm success | Low-Med |
| Protect PDF | Transform | File name | n/a | Yes | Preview only confirms the right file | Low |
| Lock Image | Image | File name | n/a | Yes | No thumbnail | Low |
| View-Once Image | Image | 192px preview | The link | Yes | Fine | Low |

### Archetypes (five, including the "build" case)

| # | Archetype | Tools | Document pane shows |
|---|---|---|---|
| A | Place on page | Sign, Edit, Crop, Redact, Watermark, Page Numbers, Digital Signature's visible box | One input page, large, with an interactive overlay |
| B | Pick / arrange pages | Split, Rearrange/Rotate, PDF to Image | A grid of the input's pages, annotated with the outcome |
| C | Build a document from inputs | Image to PDF, Merge | The output pages that will be produced, in order; inputs become compact rows in the controls pane |
| D | Whole-file transform | Compress PDF, Protect, Unlock, Digital Signature | Input page large; after processing, the result rendered from the real output bytes, with compare |
| E | Image | Compress, Resize, Convert, Lock, View-Once | Image stage (fit / 100%), compare slider, file strip for batches |

---

## 2. The workspace design

### 2.1 Desktop (≥1280px)

```
 sticky site header (unchanged)
┌ workspace frame: width min(100vw-48px, 1760px) · height 100dvh - header · in normal flow ────┐
│ file bar  contract.pdf · 7 pages · 677 KB    [Change file]                        44px       │
├───────┬───────────────────────────────────────────────────────────┬──────────────────────────┤
│ rail  │ toolbar  ‹ 3 / 7 ›   - 100% +  [Fit page] [Fit width]  Undo Redo │ CONTROLS  380px   │
│ 104px │ prompt   "Drag your signature into place."                │ title (h2)               │
│  1    ├───────────────────────────────────────────────────────────┤ options (scrolls inside) │
│  2 ✓  │                                                           │                          │
│  3    │                 the page, large                           │                          │
│  …    │            ┌──────────────┐                               │                          │
│       │            │  signature   │◢                              ├──────────────────────────┤
│       │            └──────────────┘                               │ ACTION BAR  fixed 112px  │
│       │                                                           │ hint / progress / result │
│       │                                                           │ [      Sign PDF        ] │
└───────┴───────────────────────────────────────────────────────────┴──────────────────────────┘
 Popular tasks · Related tools · How-to · Features · FAQ  (static HTML, unchanged, below)
```

At 1920px the document pane is about 1240px wide. An A4 page at "Fit page" is roughly 600×850px, against 64×96px in Sign today.

- **Before upload nothing changes.** Hero, the 1104px column and the dropzone render exactly as the SSR HTML does today, so there is no hydration shift.
- **Widening needs no JavaScript outside the island.** The wrapper in `ToolPageLayout.astro` gets a class, and CSS does `.tool-shell:has([data-ws="active"]) { max-width: min(1760px, 100%) }`. Unmigrated tools never set the attribute and stay pixel-identical.
- **The workspace is entered synchronously** in the file-accept handler, with a skeleton page, and the frame is scrolled under the header. Because it happens inside the input event it is not a layout shift, and since the frame has a fixed size nothing moves when the PDF finishes opening.
- **The hero is left in place** rather than hidden, so nothing above the frame reflows.

### 2.2 Tablet

- **1024–1279px:** the rail collapses to the `‹ 3 / 7 ›` pager plus a "Pages" popover; two columns, controls 320px.
- **768–1023px:** stacked. The document gets at least 55dvh; controls sit below in a panel with internal scroll (max 45dvh); the action bar is pinned to the frame bottom.

### 2.3 Phone (375px)

```
┌──────────────────────────────┐
│ contract.pdf    ‹ 3/7 ›   ⋯  │ 44px
├──────────────────────────────┤
│        the page (fit width)  │ flex-1, never under 40dvh
│    ┌──────────┐              │
│    │ signature│◢             │
│    └──────────┘              │
├──────────────────────────────┤
│ Drag your signature into …   │ prompt, one line
├──────────────────────────────┤
│ [Options]   [   Sign PDF   ] │ 64px + safe-area inset
└──────────────────────────────┘
```

- **"Options" opens an expanding panel, not a modal.** It takes up to 60dvh and the document shrinks to the remaining 40dvh but stays visible and live, so every option change is seen as it is made.
- **The action bar is always on screen.**
- **Placement tools show one page at a time on phones**, so dragging an item never competes with scrolling.

### 2.4 Where the result goes

The action bar is one fixed-height box with four states in the same slot.

| State | Line 1 | Line 2 (button) | Test ids |
|---|---|---|---|
| ready | Hint, or the reason the button is disabled | Primary action | `tool-action`, `action-hint` |
| running | Progress bar and label | Cancel | `processing-overlay`, `progress-announce` |
| done | "contract-signed.pdf · 677.6 KB · 7 pages" | Download (primary) plus a text link "Make changes" | `download-button`, `result-summary`, `edit-again` |
| error | Error message | Primary action again | `tool-action`, `action-error` |

- **Nothing is ever inserted below it**, so the missed-click bug class (T5) cannot recur.
- **Result details replace the options in place.** Compress stats, the Redact SHA panel, the "target missed" notice and the next-step link swap into the options scroll area, in the same box at the same size.
- **Any change to an input invalidates the result** (an option, a page, a stamp) and returns the bar to "ready". This keeps tests that apply twice (for example `applyAndReadRotations` in `organize-pages.spec.ts`) working.
- **The document pane switches to the real output.** After "done" it renders the output bytes with pdf.js, with a Before/After toggle. That gives all 15 PDF tools "what you will get" with no per-tool preview code.
- **Why not auto-download on one click:** browsers drop user activation after a few seconds, so a long job would have its download silently blocked on some engines. One slot that changes label is predictable, and it keeps the 127 `tool-action` and 166 `download-button` references in the suite valid.

### 2.5 Viewing mode per archetype

| Archetype | Mode | Why |
|---|---|---|
| A Place | Thumbnail rail + one large page | Dragging must not fight scrolling; one high-resolution page keeps memory bounded; "this page / all pages" is unambiguous; the rail carries per-page badges |
| B Pick/arrange, C Build | Page grid (S/M/L), click to enlarge | The thing being manipulated is the page sequence, so many pages must be visible at once |
| D Transform | Same rail + one page as A, overlay off, compare on | One code path; T12 needs page choice and zoom anyway |
| E Image | Image stage + file strip | — |

**Continuous scroll of all pages is rejected for v1.** It needs virtualised high-resolution rendering, makes the overlay keyboard model ambiguous, and is where the 200-page memory problems come from. Redact is the only tool that uses it today, and its tests only ever touch page 0.

### 2.6 Alternatives considered

- **Keep one column with bigger previews:** rejected; controls and preview still cannot be seen together.
- **Controls left, document right:** rejected; the document is the subject, and a primary action at bottom-right matches what visitors know from other PDF tools.
- **Fixed full-screen takeover:** rejected as the default. It gains about 56px but hides the static marketing HTML and fights the sticky header and Astro's `ClientRouter`. It could be added later as an "Expand" toggle.
- **Horizontal toolbar with a full-width document:** kept only as the stage toolbar and Edit's tool palette; it cannot hold form-heavy tools and fails on phones.
- **Wizard with separate screens:** rejected; that is Sign's current failure.

### 2.7 "The next action is obvious" as contract rules

1. Exactly one filled primary button is visible at any time.
2. A disabled primary always shows its reason (the hint line is a required prop when disabled).
3. The prompt line is required for every tool and every state: one imperative sentence, announced with `role="status"`.
4. No hover-only affordances; handles and per-item buttons are always visible.
5. Every pointer gesture has a button or field equivalent.
6. Every change gives feedback in place, not only in a toast.
7. Undo and Redo are visible buttons wherever the stage is edited.

### 2.8 Accessibility

- **Focus:** on entering the workspace, focus moves to its `h2`. Tab order is file bar → stage toolbar → page overlay items → rail → options → action bar. In-workspace skip links: "Skip to options", "Skip to document".
- **Overlay items** are focusable with a label such as "Signature, page 3". Arrows nudge by 1/200 of the page width (Shift ×10), `+`/`-` resize 5%, Delete removes, Esc deselects, Tab cycles items in reading order.
- **Numeric X / Y / Width fields** (mm) in the controls pane are the full non-pointer path, and each move is announced.
- **Rail:** `role="listbox"` with arrow keys; PageUp / PageDown change page.
- **Focus on completion:** when the slot swaps, focus moves to `download-button`, which would otherwise be lost as `tool-action` unmounts.
- **Reduced motion:** instant scroll, no pane or panel transitions, static outline in place of the "just placed" pulse. `use-reduced-motion.ts` already exists.

### 2.9 Performance

- **One pdf.js document per file**, opened once and reused for count, thumbnails, main page, text search and geometry, then destroyed on removal or unmount. Today each preview re-opens the file with `buffer.slice(0)` (a full copy) and `usePdfThumbnails` never destroys its document.
- **Tools keep the `File`, not an `ArrayBuffer`**, and read fresh bytes for the worker at run time.
- **Rasters are `<img>` blob URLs**, never data URLs in React state and never one live canvas per page. One shared scratch canvas is released after each render. This also keeps `expectImageRendered` and `naturalWidth` assertions working.
- **Scheduler:** one render at a time, visible pages first, idle slices, stale tasks cancelled on page or zoom change. Per-page subscriptions replace the current whole-array state update per page.
- **200-page PDF:** page count is immediate; the rail mounts only visible items and renders thumbnails about 200px on the long edge on demand, with an LRU of about 300. The main page renders at fit size × device pixel ratio under a pixel budget (about 3 MP on low-memory phones, 8 MP otherwise), keeping current plus neighbours.
- **Sortable grids** use `content-visibility: auto` with a fixed intrinsic size instead of unmounting, so dnd-kit keeps its nodes.

### 2.10 Constraints checked

- **CSP in `public/_headers` is untouched.** `img-src blob: data:`, `style-src 'unsafe-inline'` and `worker-src blob:` already cover blob images, inline positioning styles and the blob-backed pdf.js worker.
- **Pages stay static Astro** with hero, steps, FAQ and related tools in the HTML.
- **Landing pages keep working** because they pass presets to the same islands (`initialMode`, `initialFormat`, `initialTargetKb`).
- **No new copy uses the word "free".**

---

## 3. Component contract

New directories: `src/components/islands/workspace/` and `src/lib/pdf/`. After step 3 of the rollout both are frozen: tool agents add files only under their own `islands/<tool>/` and report "contract change requests" for the coordinator to batch into a single-owner task.

### 3.1 Libraries (absorbs T-shared's `lib/pdf-thumbs.ts`)

**`src/lib/pdf/doc-handle.ts`**
```ts
openPdf(source: File | ArrayBuffer, opts?: { password?: string }): Promise<PdfDocHandle>
// throws PdfPasswordError | PdfParseError
interface PdfDocHandle {
  pageCount: number;
  geometry(i): Promise<PageGeometry>;          // { widthPt, heightPt (as displayed), rotate, viewBox, userUnit, matrix }
  renderPage(i, { cssWidth, dpr?, pixelBudget?, signal? }): Promise<{ url, widthPx, heightPx }>;
  requestThumb(i, longEdgePx): void;  subscribeThumb(i, cb): () => void;  getThumb(i): string | undefined;
  textContent(i): Promise<TextItem[]>;
  destroy(): void;
}
```

**`src/lib/pdf/page-geometry.ts`** (pure, vitest-covered for rotate 0/90/180/270, non-zero box origin, userUnit)
```ts
viewPointToPdf(geom, xNorm, yNorm): [x, y]
viewRectToPdfDraw(geom, rectNorm, rotationCwDeg): { x, y, width, height, rotateDeg }   // pdf-lib drawImage params
pdfRectToView(geom, rect): RectNorm
viewMarginsToCropBox(geom, marginsNorm): [x, y, w, h]
```

**`src/lib/pdf/render-scheduler.ts`**: priority queue, idle slicing, cancellation.

**Hooks:** `use-pdf-document.ts` (`{ status: 'idle'|'loading'|'ready'|'locked'|'error', doc, pageCount }`), `use-page-thumb.ts`, `use-history.ts` (generalised from the Rearrange reducer).

**Legacy adapter:** `src/hooks/use-pdf-thumbnails.ts` keeps its signature and is re-implemented on top of the above, so the six unmigrated callers get the performance and leak fix without being edited.

### 3.2 Components

| Component | Responsibility | Key props | Test ids | Replaces / wraps |
|---|---|---|---|---|
| `ToolWorkspace` | Frame, panes, responsive collapse, `data-ws` | `toolId, active, empty, fileBar, stage, rail?, controls, result?, prompt (required), action` | `workspace`, `ws-stage`, `ws-controls` | The per-tool `flex flex-col gap-6` root |
| `ActionBar` + `useToolRun` | Four-state single slot, focus hand-off | `phase, label, onRun, disabledReason?, progress?, onCancel?, download, summary?, onEditAgain?` | section 2.4 | Per-tool action row, result panel, `ProcessingOverlay`; wraps `DownloadButton` |
| `WorkspaceFileBar` | File chip, change/remove, large-file warning | `file \| files, extra?, onRemove` | `file-info` (+`data-filename`), `large-file-warning` | `FileInfoCard` |
| `StepPrompt` | Current-step sentence, live region | `text, tone?` | `step-prompt` | New |
| `PageViewer` | One page large; zoom, fit, pager; overlay slot | `doc, pageIndex, onPageChange, zoom?, overlay?: (frame) => ReactNode, compareDoc?` | `page-viewer`, `page-canvas`, `page-prev`, `page-next`, `zoom-in`, `zoom-out`, `zoom-fit` | `WatermarkPreview`, `CropPreview`, `PageNumbersPreview`, Redact's page list, Edit's wrapper |
| `PageRail` | Virtualised thumbnails with badges | `doc, current, onSelect, renderBadge?` | `page-rail`, `rail-page-<n>` | Sign's thumbnail row, Edit's strip |
| `OverlayLayer` / `OverlayBox` | Drag, resize, optional rotate, keyboard, selection toolbar; coordinates normalised 0–1 of the displayed page | `rect, onChange, selected, onSelect, lockAspect?, rotatable?, label, toolbar?` | `overlay-item`, `overlay-handle-<corner>`, `overlay-remove` | New |
| `PageGrid` / `PageCard` | Grid of pages or output pages; select, sort, group colours, state labels, enlarge | `items, renderPage, size, selected?, onToggle?, onReorder?, groups?, renderBadge?` | `page-grid`, `page-selector`, `page-thumb`, `page-select-<n>`, `insert-blank`, `duplicate-page` | `PageSelectorGrid`; wraps then replaces `PageThumbnailGrid` |
| `PagePreviewDialog` | One page at about 1600px on demand; Esc and backdrop close; focus returned | `doc, pageIndex, onClose` | `page-preview-dialog` | T-shared; uses existing `ui/dialog.tsx` |
| `CompareView` | Slider, side-by-side or toggle; no cropping | `before, after, labels, mode` | `compare-view`, `compress-preview` | `BeforeAfterSlider` |
| `OutputPagePreview` | True-proportion page with content laid out by a geometry function | `pageW, pageH, children, showMargins?` | `output-page` (+`data-draw`) | New (Image to PDF, later N-up) |
| `ImageStage` | Image at fit / 100%, checkerboard, compare | `src, resultSrc?, zoom` | `image-stage` | Per-tool `<img>` previews |

Ids that must survive every migration: `dropzone` (with `data-hydrated`, `data-state`), the first `input[type=file]` being the main document input, `file-info`, `file-card`, `file-row`, `tool-action`, `download-button`, `processing-overlay`, `progress-announce`, `page-thumb`, `page-select-<n>`, `page-selector`, `page-grid`, plus each tool's own ids.

---

## 4. Per-tool mapping

### 4.1 Sign PDF (pilot)

**What the code makes a visitor click today** (`src/components/islands/sign-pdf/SignPdfTool.tsx`):

1. The page opens on "Step 1: Create your signature". There is no PDF dropzone anywhere. In Upload mode the only dropzone on the page accepts PNG/JPEG/WebP for the signature image, so a visitor who drops their PDF there gets "File not supported".
2. Draw, then click "Use this signature →". Only then does "Step 2: Upload your PDF" appear.
3. Upload. "Step 3: Place signature on page(s)" appears with the 96×64px thumbnails.
4. The only way to place on one page is to click a thumbnail. The only cues are a `title="Place on page N"` tooltip and a "+ Signature" pill that shows on hover. Neither exists on touch, and nothing on screen says "click a page". This is the owner's "didn't know what to click".
5. The click writes fixed coordinates: signature at x=100pt, y=100pt, 200×60pt; date at (100, 80); initials at (320, 100), 60×40. Feedback is a toast, the green dot and the count. Clicking again silently replaces the stamp. There is no way to remove, move, resize or rotate, and `rotation` and `opacity` are always 0 and 1.
6. "Apply & Download" runs the worker and does not download. A second button, "Download Signed PDF", then appears beside it, and a "Signature applied!" panel appears below.

**New flow, desktop, first-time visitor:**

| # | Visitor does | Screen shows |
|---|---|---|
| 1 | Lands on the page | One dropzone: "Drop the PDF you want to sign, or browse" |
| 2 | Drops the PDF | Workspace opens with page 1 large and the rail on the left. Controls title "Sign this PDF". Prompt: "Create your signature on the right." Tabs "Draw / Type / Upload" with the drawing pad open. Button "Use this signature" is disabled, with hint "Draw your signature first". Action bar: "Sign PDF" disabled, hint "Add your signature to the page first". |
| 3 | Draws, clicks "Use this signature" | The signature appears on the page straight away, selected, with four corner handles, sized at 35% of page width with its true aspect ratio, at lower-middle of the visible area. A label on it reads "Drag to move · corners to resize". Prompt: "Drag your signature into place, or click the spot where it should go." The rail badge for the page shows a tick. `placed-count` reads "1 stamp placed". "Sign PDF" becomes enabled. |
| 4 | Clicks the signature line | The stamp jumps there; this "click to move" applies only until the first move. Or the visitor drags it, or drags a corner (aspect locked). Selection toolbar: "Copy to all pages", "Duplicate", "Remove". Undo and Redo are in the stage toolbar and on Ctrl+Z / Ctrl+Shift+Z. |
| 5 | Optionally adds more | Controls section "Add to this page": buttons "Signature", "Initials" (with the `initials-input` field), "Date". Each drops its item at a staggered default position on the current page, selected. |
| 6 | Optionally clicks "Copy to all pages" | Same offset from the bottom-left and same size on every page, clamped onto the page. Rail badges update; count reads "7 stamps placed". |
| 7 | Clicks "Sign PDF" | Progress shows in the same slot. Then the slot shows "Download signed PDF" with "contract-signed.pdf · 677.6 KB · 7 pages" and a link "Make changes". The page pane now renders the signed file itself, labelled "Signed — this is your file", with a Before/After toggle. |
| 8 | Clicks "Download signed PDF" | The file downloads |

**Phone:** the same states. Step 2 opens the Options panel at 60dvh with the pad, and the page stays visible above. "Use this signature" closes the panel and the stamp is on the page, selected. The prompt reads "Drag your signature into place, or tap where it should go." Corner handles have 44px hit areas, and the selection toolbar adds "Smaller" / "Larger" buttons so resizing never depends on a precise drag. The pager changes page. The action bar is always on screen.

**Supporting changes:**

- **Placed stamps reference a signature asset by id**, so redrawing the signature updates all of them. Today they keep the old image.
- **The signature PNG is trimmed to its ink bounds** so the box hugs the strokes.
- **The stored signature is restored on load**, with a "Use saved signature" chip. Today it is written to sessionStorage and never read.

**How the preview maps to the PDF.** A stamp is stored as a normalised rectangle of the displayed page (top-left origin) plus a clockwise rotation θ. The preview is the same PNG in an absolutely positioned `<img>` at those percentages. At apply time, on the main thread, using the same pdf.js viewport that drew the pixels:

- The stamp's own bottom-left corner (after θ) goes through `viewport.convertToPdfPoint`. That one call handles `/Rotate`, the CropBox/MediaBox offset (pdf.js uses their intersection as the view) and UserUnit, all of which I confirmed in the installed pdf.js 5.5.207.
- Width and height in user units are the view sizes divided by UserUnit.
- pdf-lib's `rotate` is `pageRotate − θ` degrees. pdf-lib rotates counter-clockwise about the image origin, and a `/Rotate R` page is displayed turned R clockwise, so an upright stamp needs +R.
- Worked check for `/Rotate 90` on Letter: the visual bottom-left maps to user-space (612, 0), and with `rotate: 90` the image extends along +y in user space, which is screen-right.

The existing `sign-visual` worker op already takes absolute x, y, width, height, rotation and opacity, so it needs no change for images. Date text uses the same anchor on its baseline, and its box width must come from Helvetica metrics so the preview and the drawn text agree.

**Tests to add:** vitest for the geometry, and an e2e that places a stamp at a known rectangle on new rotated-90 and offset-CropBox fixtures and reads the position back from the output.

### 4.2 Image to PDF (second migration)

**Where the geometry lives today:** inline in `imagesToPdf()` in `src/workers/pdf-worker.ts` (about lines 632–724). It picks the page size (`PAGE_SIZES`, or image pixels as points for "fit"), computes the box inside the margins, then the scale and draw rectangle per placement. The island (`ImageToPdfTool.tsx`) previews none of it: its cards are a fixed A4-ratio box with the image `object-contain`, whatever the settings.

**Sharing it:** extract a pure function to a new `src/lib/images-to-pdf-layout.ts`:
```ts
layoutImagePage(img: { width, height }, o: ImagesToPdfOptions): { pageW, pageH, draw: { x, y, w, h } }   // points, bottom-left origin
```
- The worker becomes `addPage([pageW, pageH]); drawImage(image, draw)`.
- The preview is `OutputPagePreview`: a white box with `aspect-ratio: pageW / pageH`, the `<img>` positioned by `draw` as percentages, `overflow: hidden` (the PDF clips to the page too), and dashed margin guides.
- It is plain CSS, so it follows a margin field as it is typed, with no pdf.js and no canvas.
- An existing test (`source-check-closures.spec.ts`) already pins a 1.5in margin to x=108pt in the output's `cm` matrix; that proves the extraction changes nothing.
- Add vitest for the function and an e2e comparing each `output-page`'s `data-draw` with the `cm` matrix of the downloaded file.

**Workspace mapping (archetype C):**

- **Document pane:** the output pages, in order, at true proportions. A4 and Letter visibly differ, and "Fit Image" pages take each image's shape. Each card shows "Page 2 of 5", the file name and a remove button.
- **Reorder:** drag, or the existing keyboard handle "Reorder <filename>". `file-card` and `data-filename` stay on the cards so `keyboard.spec.ts` and `layout-stability.spec.ts` keep passing.
- **Navigation:** S/M/L sizes; clicking a page opens it large with previous/next.
- **Caption:** physical size, for example "A4 · 210 × 297 mm".
- **Controls pane:** compact "Add images" dropzone, page size, orientation, fit mode, margins with the mm/in/pt units from the current batch, then the action "Create PDF (5 pages)".

**Mixed portrait and landscape.** Today every fixed-size page is portrait, so a landscape photo becomes a small strip on A4. I propose an Orientation option, "Auto (match each image) / Portrait / Landscape", implemented as one parameter of the layout function so the preview shows it per page. Making Auto the default changes current output, so that is an owner decision (section 8).

**For the preview to be truthful, these must be fixed in the same task:**

- **EXIF orientation (inferred, not run):** the browser shows phone photos upright, but pdf-lib embeds the raw JPEG. Inputs need normalising through `createImageBitmap(..., { imageOrientation: 'from-image' })`, re-encoding only when needed, with both preview and writer using the normalised size. The uncommitted `photo-exif.jpg` fixture can prove it.
- **Non-JPEG/PNG inputs (inferred):** the dropzone accepts WebP, BMP and GIF, but the worker calls `embedJpg` on anything that is not PNG. The same normalisation step fixes this; it overlaps T3.

**Early migration: yes, second.** It needs no pdf.js, the island is 238 lines, and it proves the shell, the action bar and the sortable grid for the "build" archetype that Merge then reuses. Giving it to a different agent from the Sign pilot also tests whether the contract is usable by someone who did not write it.

### 4.3 The other 18 tools

| Tool | Document pane | Overlay / state | Controls pane | Deleted |
|---|---|---|---|---|
| Merge (T1) | Output pages in order, each with a file-letter badge and position | Sortable across files, remove, enlarge | Compact file rows (badge, range input `page-range-input`, password), options, "Merge into 1 PDF (12 pages)" | Card grid as the main view, both `<details>` |
| Split (T2) | Page grid | Per-mode outcome via `groups`: selected/dimmed, "Removed", "PDF 1/2…" colours, alternating groups, numbered | Mode, range field (stays the source of truth), list of output files with real names and page counts | Small selector grid, duplicate file display |
| Rearrange / Rotate | Sortable page grid | Always-visible per-card rotate/duplicate/delete; insert-blank; enlarge | Rotate all/selected, undo/redo, size | Hover-only controls |
| PDF to Image | Selectable page grid; enlarge shows the page rendered at the chosen DPI/format with pixel size | Selected state | Format, DPI, quality, range | — |
| Compress PDF (T12) | `PageViewer` with `CompareView`; rail picks the page; zoom | — | Level, target size, custom settings; a "Preview this page" pass before committing | 384px slider in the result panel |
| Watermark | `PageViewer` on any page; pages outside "apply to" are badged "not watermarked" | Watermark drawn from a shared `lib/watermark-layout.ts` used by the worker too | Text/image, size, opacity, rotation, placement, apply-to, layer | `WatermarkPreview.tsx` |
| Page Numbers | `PageViewer` on any page with that page's real number; skipped pages say "No number on this page" | Number from a shared `lib/page-number-layout.ts` | Position, format, start, skip, font, colour, margins | `PageNumbersPreview.tsx` |
| Crop | `PageViewer` on any page | Crop rectangle as an `OverlayBox` with edge and corner handles; "Current page" means the page shown | Margins (two-way sync), units, auto-crop, apply-to, mode | `CropPreview.tsx`, the local range parser |
| Redact | `PageViewer`; rail badges show mark counts | Draw-to-mark with pointer events (mouse, touch, pen); marks are selectable and resizable. After apply, the pane shows the redacted file | Find and mark, mark list, metadata strip, confirm checkbox | 60vh all-pages list |
| Edit | `PageViewer` hosting the existing `AnnotationCanvas` in the overlay slot; pages rendered on demand | Existing object model | Tool palette in the stage toolbar; properties and save mode in the pane | Up-front render of every page, the thumbnail strip |
| Digital Signature | `PageViewer`; the visible box shown where it will land | Phase 2: placeable `OverlayBox` | Certificate form | — |
| Protect / Unlock | `PageViewer` to confirm the file. Unlock shows a locked placeholder until the password opens it, then the readable pages | — | Passwords, permissions, encryption details | — |
| Compress Image | `ImageStage` with `CompareView` and zoom; file strip for batches | — | Mode, quality, target, format | Cropped slider |
| Resize Image | `ImageStage` showing the output frame with the image as the fit mode will place it | Optional crop-position drag | Size, presets, mode | — |
| Convert Image | `ImageStage` with file strip | — | Format, quality | — |
| Lock Image / View-Once | `ImageStage` (plain) | — | Password / expiry | — |

---

## 5. Rollout

Estimates are single-agent working time including tests, on the scale HANDOFF.md uses.

| Step | Work | Effort | Parallel with |
|---|---|---|---|
| 1a | `lib/pdf/*`, geometry, scheduler, hooks, vitest; re-point `usePdfThumbnails` internals | 3h | 1b, 1c |
| 1b | Shell: `ToolWorkspace`, `ActionBar`, `WorkspaceFileBar`, `StepPrompt`, the `:has()` hook in `ToolPageLayout.astro`, shared specs | 3–4h | 1a, 1c |
| 1c | Split `pdf-worker.ts` into per-operation modules behind a thin dispatcher (mechanical, after the current batch lands) | 1.5h | 1a, 1b |
| 2a | **Pilot: Sign PDF**, with `PageViewer`, `PageRail`, `OverlayLayer`; rewrite Sign specs; rotated and cropped fixtures | 7–8h | 2b |
| 2b | **Image to PDF**, with `PageGrid`, `PageCard`, `OutputPagePreview`, the layout function and input normalisation | 4–5h | 2a |
| 3 | Contract freeze: reconcile 2a and 2b, add `PagePreviewDialog` and `CompareView`, update HANDOFF | 1.5h | — |
| 4A | Merge (T1) 3.5h · Split (T2) 2.5h · Compress PDF (T12) 3.5–4h · Rearrange 2h | | each other |
| 4B | Watermark 3.5h · Page Numbers 2.5h · Crop 3.5h · PDF to Image 2–3h | | each other |
| 4C | Redact 3.5h · Edit 4–5h · Digital Signature 2.5h · Protect/Unlock 2h | | each other |
| 4D | `ImageStage` + Compress Image 3h, then Resize 2h · Convert 1.5h · Lock 1h · View-Once 1h | | after the first |

Total is roughly 65–70 agent-hours, or about six rounds at three to four agents.

**Why Sign first.** It is the live complaint. It is also the hardest archetype (viewer, overlay, geometry, keyboard, touch), so a contract that survives it covers the other placement tools as subsets. Its existing test surface is small: 3 specs, 2 parity tests and 1 label test.

**Why 2a and 2b can run together.** They create disjoint shared files: viewer, rail and overlay for Sign; grid, card and output preview for Image to PDF.

**Why step 1c.** Watermark, Page Numbers, Crop, Merge and Image to PDF each need to change their own function in `pdf-worker.ts`, which HANDOFF lists as a hot file. Splitting it once lets later tasks own separate files.

### Keeping the suite green

- **No flag.** Each tool migrates whole in its own branch. Unmigrated tools are untouched because the widening is opt-in.
- **The two-step contract is preserved.** I found no test that clicks `tool-action` again without first changing an input or reloading.
- **`ux/layout-stability.spec.ts`** covers `/convert-image`, `/image-to-pdf` and `/merge-pdf`. It needs `dropzone` to keep cycling `accepted → idle` while `tool-action` is visible, which the compact "Add more" dropzone in the controls pane does; the fixed action bar makes the assertion trivially true. Extend it (this absorbs T5) so `tool-action` and `download-button` share a box within 1px and the stage box is identical across ready, running and done.
- **`visual/snapshots.spec.ts`** has nine Chromium element baselines. The migrating agent regenerates only its own and lists them in its report. The ones tied to deleted previews (`watermark-preview`, `page-numbers-preview`, `crop-preview`) keep their test id on the new page surface.
- **Mobile coverage is thin.** `mobile/mobile-smoke.spec.ts` checks only pre-upload overflow. Add `workspace/mobile.spec.ts`: after upload at 375px there is no horizontal overflow, the stage is at least 40% of the viewport, and the action bar is inside the viewport.
- **New `workspace/contract.spec.ts`**, parametrised by a `migrated.ts` list that the coordinator edits, as with the registry and coverage files. It checks: exactly one primary button, a non-empty prompt, a disabled-reason when disabled, focus on `download-button` after completion, and axe in the ready and running states.
- **Tests that must be rewritten:**
  - Sign: the "Step 1/2/3" texts and `button[title="Place on page 1"]`. `stamp-date`, `stamp-initials`, `initials-input`, `place-all-pages` and the exact "N stamp(s) placed" wording are kept.
  - Redact: `redact-pdf.spec.ts:156` expects `tool-action` to be absent with no marks; it becomes "disabled". The `div.bg-red-600\/60` selector in `operation-visibility.spec.ts` becomes `overlay-item`.
  - Merge and Split result texts ("Merge complete", "Split complete!", "Before:", "After:") move into the result view unchanged.

### How the earlier plans change

- **T-shared:** dissolved into steps 1a, 2 and 3. Do not start it separately.
- **T1 Merge:** the `pageList` model, worker `segments` and the MuPDF `sourceKey` work are unchanged. The "Pages in the merged PDF" grid becomes the document pane, files become compact rows in the controls pane, S/M/L becomes the stage size control, and enlarge is `PagePreviewDialog`. Still about 3.5h.
- **T2 Split:** unchanged in substance. Mode outcomes are the `groups` and badge props of `PageGrid`; the output list sits in the controls pane above the action. About 2.5h.
- **T12 Compress preview:** the agent designing it now should target `PageViewer` + `CompareView` + `PageRail` and not build its own viewer or zoom. Its real work is the "preview this page before committing" pass. Please pass it section 3 today.
- **T5:** solved structurally for migrated tools; only the spec extension remains.
- **T0's `PageSelectorGrid`:** superseded by `PageGrid`; its test ids are kept.

---

## 6. Risks and containment

| Risk | Containment |
|---|---|
| Pilot contract proves wrong after fan-out | Two different consumers, by two agents, before the freeze; fan-out only after step 3 |
| Preview and output drift again | Geometry lives in pure lib functions imported by both preview and writer; after apply the pane renders the real bytes; a "preview equals output" e2e per placement tool |
| Rotated or cropped pages | Coordinates only ever come from the pdf.js viewport; fixtures for rotate 90/270 and offset CropBox; vitest matrix |
| PDFs with unbalanced graphics state shift stamps (pdf-lib appends without isolating existing content; not verified here) | Wrap existing content streams in `q … Q` before drawing, in Sign, Watermark and Page Numbers |
| Phone memory | Blob-URL images, one scratch canvas, pixel budget, LRU, one page at high resolution |
| Layout shift / SEO | Empty state is byte-identical to today's SSR; activation is inside the input event; hero and marketing sections untouched; Lighthouse CI already exists |
| `:has()` support | Chrome 105+, Safari 15.4+, Firefox 121+; a one-line `documentElement.dataset` fallback if wanted |
| Nested scrolling on phones | Placement tools show one page with a pager; scroll chaining left on so the page below stays reachable |
| Astro view transitions | Islands unmount on navigation; `PdfDocHandle.destroy()` and URL revocation run in effect cleanup |
| Mixed old and new UI during rollout | Order follows owner pain: Sign, Image to PDF, Merge, Split, Compress first |
| Hot files | Step 1c split; coordinator applies registry, coverage and `migrated.ts` lines |
| Copy claims overtaking code | Each migration updates its registry bullets and `coverage.ts` in the same change |

---

## 7. Bugs and false claims noticed (outside the redesign)

**Sign PDF**
- "Apply & Download" does not download. The same two-button pattern is in every tool.
- These registry claims are false in the code: "Place it anywhere", "Drag-and-drop placement with resize/rotate", "Click anywhere on a page preview… Drag to reposition, resize with handles, adjust opacity".
- Stamps cannot be removed.
- Every signature is forced into 200×60pt, which distorts uploaded images and drawn signatures; initials are forced into 60×40.
- The typed signature is drawn on a fixed 400×120 canvas, so long names are probably clipped (inferred).
- On rotated pages or pages with a box offset the stamp will be sideways, shifted or off the visible page (inferred from raw coordinates).
- The date is `toLocaleDateString()` drawn in Helvetica. In locales whose dates use non-Latin digits or letters, pdf-lib will probably throw on encoding (inferred, not run).
- **Blank thumbnails: not reproduced.** Two code-level candidates: a text page at 64px wide is nearly white, with its page number in white text; or pdf.js painted nothing for those pages. It needs checking against the owner's file.

**Shared**
- `usePdfThumbnails` never destroys its pdf.js document, copies the whole buffer, stores data URLs in state and re-renders the full list once per page.
- `BeforeAfterSlider` crops with `object-cover` and reads its container width during render.
- How-to copy names buttons that do not exist: "Merge & Download", "Split & Download", "Compress & Download", "Protect & Download", "Unlock & Download", "Crop & Download".

**Watermark**
- The "live preview" does not match the worker:
  - Tiling is a fixed 3×4 grid in the preview and 200pt spacing in the output.
  - Image size is font size × 4 in the preview and min(50% of width, 300pt) in the output.
  - Rotated text pivots on its centre in the preview and on the text origin in pdf-lib.
  - Tiled images are rotated in the preview only.
- Rotation and box offset are ignored.

**Page Numbers**
- The feature bullet says "Live preview on first and last page"; only page 1 is previewed.
- Rotation is ignored.

**Crop**
- "Current page" is hard-wired to page 1.
- The FAQ describes a "Custom per-page" mode that does not exist.
- `setCropBox` ignores rotation and existing box origin, so rotated scans will have the wrong edges cropped (inferred).

**Redact**
- Drawing uses mouse events only, so it cannot work by touch or pen (inferred from the handlers).
- Every page is rendered at 800px up front.

**Edit**
- The registry says "Fabric.js canvas overlay"; Fabric is not a dependency, the canvas is custom.
- Flatten and annotation export map through `page.getSize()` and ignore rotation and offset.

**Digital Signature**
- A visible box is always drawn at a fixed spot on page 1. The copy says "optionally place a visible signature image".

**Image to PDF**
- "Fit Image" hides the margin controls but still sends the default 10mm margins, so the image is shrunk inside a hidden border.
- "Center" and "Fit" run identical code.
- "Cover" overflows the margins up to the page edge.
- "Custom page sizes" is advertised with no UI.
- TIFF, SVG and HEIC are advertised but not accepted.

**Merge**
- The FAQ says to "expand any file card to see its page thumbnails"; there are none.
- The description says "Drag to reorder pages"; only files reorder.

**Compress PDF**
- An invalid target leaves `status` at "processing" (minor).

---

## 8. Decisions only the owner can make

1. **Workspace shape.** In-flow frame the height of the viewport, document left and controls right, replacing the narrow column once a file is added. *Recommend yes.* The alternative is a full-screen takeover, which gains about 56px and hides the marketing HTML while a file is open.
2. **One button that changes, or auto-download.** *Recommend one slot:* "Sign PDF" becomes "Download signed PDF" in the same place. Auto-download is one click fewer but is blocked unpredictably on long jobs.
3. **Sign order and placement.** PDF first; the signature is created beside the page and appears on the page immediately, to be dragged or clicked into place. *Recommend yes.*
4. **Sign claims.** The pilot ships drag, resize, remove, undo and copy-to-all-pages. *Recommend trimming "rotate" and "adjust opacity" from the copy until they are built* (the overlay supports rotation; it costs about 1.5h more).
5. **Image to PDF defaults.** Add Orientation with Auto as the default, remove the hidden margin in Fit Image, and merge or differentiate Center and Fit. *Recommend all three.* Each changes what current visitors get.
6. **Scope.** Migrate all 20 in the order above. *Recommend yes, with Lock, View-Once and Convert last and light.* The alternative is to stop after rounds 4A and 4B, which covers every tool complained about so far and leaves two UIs in place.

---

## Sources (competitor look)

The search gave only the general pattern, not layouts: Smallpdf creates the signature in a Draw / Type / Upload dialog, then it is dragged onto the page and resized, with a single finishing action. I could not confirm pane arrangement for Smallpdf or iLovePDF, and the design does not rely on either.

- [How to Sign a Document Electronically](https://thepcenthusiast.com/how-to-sign-a-document-electronically/)
- [Smallpdf: the Indezine review](https://notes.indezine.com/2021/11/smallpdf-the-indezine-review.html)
- [Smallpdf: add signature block to PDF](https://smallpdf.com/blog/add-signature-block-to-pdf)

### Critical Files for Implementation

- D:\Project\DocuKit\src\components\tool-page\ToolPageLayout.astro
- D:\Project\DocuKit\src\components\islands\sign-pdf\SignPdfTool.tsx
- D:\Project\DocuKit\src\workers\pdf-worker.ts
- D:\Project\DocuKit\src\hooks\use-pdf-thumbnails.ts
- D:\Project\DocuKit\tests\e2e\helpers\harness.ts
