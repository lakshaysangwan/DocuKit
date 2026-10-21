/**
 * Feature-parity coverage map (Phase 7).
 *
 * Every bullet in `features` on a tool in src/lib/tools-registry.ts is marketing
 * copy — a promise to the user. This file ties each one to the test that proves
 * it, or records honestly that nothing proves it yet.
 *
 *   covered  — a test demonstrates the capability end to end
 *   partial  — a test exercises part of the claim (e.g. 3 of 5 listed formats)
 *   unproven — no automated coverage; the claim rests on manual checking
 *
 * `partial` and `unproven` are NOT failures. The gate is that every bullet is
 * *accounted for*: parity.spec.ts fails when copy is added or reworded without a
 * matching entry here, which is how the copy-drift the audit found gets caught.
 * Tightening a `partial`/`unproven` into `covered` is ordinary follow-up work.
 */
export type CoverageState = 'covered' | 'partial' | 'unproven';

export interface Coverage {
  state: CoverageState;
  /** Spec file(s) that prove it, relative to tests/e2e. */
  specs?: string[];
  /**
   * Vitest file(s) that prove it, relative to the repo root. For claims the
   * browser suite cannot reach — the view-once backend is a Cloudflare Pages
   * Function, and the e2e suite runs against a static build with no Functions
   * runtime, so a unit test is the only honest proof available.
   */
  units?: string[];
  /** Why it is partial/unproven, or what the test actually shows. */
  note?: string;
}

const C = (specs: string[], note?: string): Coverage => ({ state: 'covered', specs, note });
const P = (specs: string[], note: string): Coverage => ({ state: 'partial', specs, note });
const U = (note: string): Coverage => ({ state: 'unproven', note });
/** Covered by unit tests rather than (or as well as) the browser suite. */
const CU = (units: string[], note: string, specs: string[] = []): Coverage =>
  ({ state: 'covered', specs, units, note });

const T = (n: string) => `tools/${n}.spec.ts`;
const GUARD = 'guards/no-external-requests.spec.ts';
const VISUAL = 'visual/operation-visibility.spec.ts';
const CLOSED = 'parity/closed-gaps.spec.ts';
const SOURCED = 'parity/source-check-closures.spec.ts';
const SIGN_PLACEMENT = 'tools/sign-pdf-placement.spec.ts';
const I2P_PREVIEW = 'tools/image-to-pdf-preview.spec.ts';
const EDIT = T('edit-pdf');
const XBROWSER = 'xbrowser/capabilities.spec.ts';

export const COVERAGE: Record<string, Record<string, Coverage>> = {
  'merge-pdf': {
    'Every page shown in the order it will be merged': C([T('merge-pdf-pages'), VISUAL], 'every page of every file is a rendered thumbnail; the grid order is compared with the page order of the downloaded file'),
    'Drag pages to reorder, even between files': C([T('merge-pdf-pages')], 'pages of two files interleaved by mouse drag; the downloaded file has exactly that order, on the fast path and on the bookmark path'),
    'Drag-and-drop file reorder': C([T('merge-pdf-pages')], 'a file moved with the keyboard equivalent of the drag (handle, Space, arrow, Space); the pages regroup by file and the download follows'),
    'Per-file page selection': C([T('merge-pdf'), T('merge-pdf-pages')], "a typed range replaces that file's pages in place; an unreadable range changes nothing and says why"),
    'Preserve bookmarks & internal links': C([CLOSED], 'opt-in MuPDF graft path; the merged outline keeps its nesting and both bookmarks and links are rebased onto the new page numbers'),
    'Optional blank page between documents': C([CLOSED], 'a blank lands between the two documents and not after the last one'),
    'Password-protected PDF support': C([CLOSED], 'an encrypted input is detected, decrypted with its password and merged; a wrong password names the file instead of merging garbage'),
    'Up to 50 files at once': U('The 50-file cap is enforced (MAX_FILES in MergePdfTool and DropZone maxFiles) but no test adds 51 files.'),
  },
  'split-pdf': {
    '5 split modes': C([T('split-pdf')], 'extract, remove, by-range, extract-each and every-N all tested'),
    'Every page shown, marked with what will happen to it': C([SOURCED, T('split-pdf-pages')], 'real page pixels and two-way sync with the range field; per mode, the marks on the pages ("Selected", "Removed", "PDF n", "Not included") are matched against the pages read back from each downloaded file'),
    'Text syntax: "1-5, 8, odd, even, last"': C(['parity/claims.spec.ts', T('split-pdf-pages')], 'odd, even and last all resolve to the right pages'),
    'A list of the files you will get, with names and pages': C([T('split-pdf-pages')], 'the listed names and pages equal the downloaded files and their pages'),
    'Several PDFs download as separate files, or as one ZIP': C([T('split-pdf'), T('split-pdf-pages')], 'Download all and per-file downloads up to 10 files, and the ZIP of 12 parts, each read back against the listed names and pages'),
    'Range input with live page count': C(['parity/claims.spec.ts']),
  },
  'compress-pdf': {
    '4 compression levels including custom': C([T('compress-pdf')]),
    'Side-by-side quality preview': C([VISUAL]),
    'Before/after file size comparison': C([T('compress-pdf')]),
    'Custom DPI and JPEG quality controls': P([T('compress-pdf')], 'controls are revealed; their effect on output is not measured'),
    'Grayscale conversion option': P([T('compress-pdf')], 'control is revealed; grayscale output is not verified'),
    'Target size mode: fit under a KB or MB limit': C([T('compress-pdf')], 'output lands under a reachable target, a looser target keeps more quality, and an unreachable one is reported rather than passed off as success'),
  },
  'rearrange-pdf-pages': {
    'Drag-and-drop page reorder': U("SOURCE CHECK — implemented at PageThumbnailGrid (DndContext + useSortable + arrayMove); needs a test."),
    'Multi-select with Ctrl+click / Shift+click': C([CLOSED], 'was implemented all along — the audit missed the modifier handling in PageThumbnailGrid; Ctrl adds and Shift extends a range'),
    'Rotate 90° CW/CCW per page or batch': C([T('organize-pages')], 'per-page, multi-selection and rotate-all are each checked against the rotation of every output page'),
    'Insert blank pages anywhere': C([CLOSED], 'the "+" affordance inserts at a chosen position and the output page really is blank'),
    'Duplicate pages': C([CLOSED], 'the copy is an independent page, so the two can be rotated separately'),
    'Undo/redo up to 20 actions': P([T('organize-pages'), CLOSED], 'undo of a delete and the Ctrl+Z / Ctrl+Shift+Z shortcuts are tested; the 20-action depth is not'),
    'Zoom control: 80 / 120 / 160px thumbnails': C(['parity/claims.spec.ts'], 'copy corrected to the sizes the control actually offers (S/M/L)'),
  },
  'sign-pdf': {
    'Draw, type, or upload signature': C([T('sign-pdf')], 'all three are driven end to end: a freehand stroke on the pad, a typed name and an uploaded picture each end up as an image in the downloaded file, trimmed to the ink and with its own proportions'),
    'See the signature on the page: drag to move, pull a corner to resize': C([SIGN_PLACEMENT, 'workspace/mobile.spec.ts'], 'a mouse drag and a corner pull each change the box on screen and the image in the downloaded file by the same amount; the shape is kept. A finger drag is covered by workspace/mobile.spec.ts with synthetic touch pointer events'),
    'Placed exactly where shown, on rotated and cropped pages too': CU(['src/lib/pdf/page-geometry.integration.test.ts'], 'a stamp set to a known rectangle is read back from the output content stream and mapped to the displayed page by pdf.js on a plain, a /Rotate 90 and an offset-CropBox fixture, to 0.4% of the page, and its four colours are found at that spot in the rendered output; the mapping itself is pixel-tested against a second renderer in the unit suite', [SIGN_PLACEMENT]),
    'Date stamp and initials support': C([CLOSED, SIGN_PLACEMENT], 'a date stamp and initials are added beside the signature; the date is real text read back out of the output, and both land in the boxes that were shown, on a /Rotate 90 page'),
    'Copy a stamp to every page in one click': C([SOURCED, SIGN_PLACEMENT], 'one click puts the stamp on all five pages of the fixture; on a three-page file every page has it at the same view position and the image is stored once'),
    'Undo, redo and remove any stamp': C([SIGN_PLACEMENT], 'Remove, the Undo and Redo buttons and Ctrl+Z / Ctrl+Shift+Z are each followed through to the downloaded file, which has the date but not the removed signature'),
  },
  'digital-signature-pdf': {
    'PKCS#7 / PAdES standard digital signatures': C([T('digital-signature')], 'the signature is cryptographically verified in the harness'),
    'In-browser RSA-2048 key & certificate generation': C([T('digital-signature')]),
    'Upload existing .p12/.pfx certificates': U("SOURCE CHECK — implemented at DigitalSignatureTool certSource=\"upload\" + loadP12(); needs a test."),
    'SHA-256 hash of document content': C([T('digital-signature')], 'messageDigest is checked against the ByteRange'),
    'Private key never stored or transmitted': C([GUARD], 'zero cross-origin requests during the flow'),
    'Verifiable in Adobe Reader / Acrobat': U('third-party reader verification cannot run headless'),
    'Combine visible + cryptographic signature': U("SOURCE CHECK — implemented: pdf-sign.ts draws a visible box + signer text on page 1 alongside the PKCS#7 dict (unconditionally); needs a test."),
  },
  'protect-pdf': {
    'AES-256 encryption (PDF 2.0)': C([T('protect-pdf-permissions')], 'the /Encrypt dictionary names AESV3 with handler V5 R6'),
    'User and owner passwords': C([T('protect-pdf-permissions')], 'MuPDF confirms the open password is the user password only and the permissions password (typed or generated) is the owner password; a file with no open password is covered too'),
    'Print, copy and edit permissions, for readers that respect them': C([T('protect-pdf-permissions')], 'every checkbox, allowed and withheld, is read back from /P and by pdf.js; whether a given reader obeys the flags is a property of the reader, not of the file'),
    'Password strength meter': U("SOURCE CHECK — implemented at ProtectPdfTool getPasswordStrength() with a 0-4 bar; needs a test."),
    'Random password generator': C([T('protect-unlock-pdf')]),
    '100% client-side — password never transmitted': C([GUARD]),
  },
  'unlock-pdf': {
    'Detects encryption automatically': C([T('protect-unlock-pdf')], 'an encrypted upload is recognised before the password is entered'),
    'Removes user and owner passwords': C([T('protect-unlock-pdf'), T('protect-pdf-permissions')], 'unlocks with the open password and with the permissions password; a restrictions-only file unlocks once its permissions password is typed'),
    'Shows original encryption details': CU(['src/lib/pdf-encryption-info.test.ts'], 'the /Encrypt dictionary is parsed and shown; the unit test pins the handler revisions and /P decoding', [CLOSED]),
    'Instant decryption in-browser': C([T('protect-unlock-pdf'), GUARD]),
  },
  'pdf-to-image': {
    'PNG, JPEG, WebP, AVIF output': P([T('pdf-to-image')], 'PNG, JPEG and AVIF tested; WebP is not'),
    '72, 150, 300 or 600 DPI': P(['parity/claims.spec.ts'], 'the 600 DPI preset yields a markedly larger raster than 72 DPI; 150 and 300 are not measured. Copy corrected: there is no custom DPI field, only these four presets'),
    'Single page, all pages, or page range': C([T('pdf-to-image')]),
    'Page preview before download': C([SOURCED], 'built on the same discarded thumbnails as split; the grid shows which pages will be exported, clicking one removes it, and the export then contains exactly the pages still highlighted'),
    'A Download button on every converted image': C([T('pdf-to-image-downloads')], 'each card shows a decoded thumbnail of the output, its name, pixel size and file size, and its button downloads that page only — checked by rendering the downloaded PNG dimensions against the card'),
    'Download all as separate files, or as one ZIP': C([T('pdf-to-image-downloads'), T('pdf-to-image')], 'three pages give three download events with valid PNG bytes on Chromium, Firefox and WebKit; the ZIP entries are read back; above 10 images the ZIP is the primary. The browser permission prompt for several downloads does not appear under automation, so that step is unproven'),
    'Save to a folder or share sheet where the browser supports it': P([T('pdf-to-image-downloads')], 'both buttons are shown only when the API is present, and against a stubbed showDirectoryPicker / navigator.share the right files are written or shared, with cancel and write errors reported. The real folder picker and a real phone share sheet cannot be driven by automation'),
    'Files named by source page number': CU(['src/lib/multi-download.test.ts'], 'pages 1, 3, 5 of a five-page PDF download as -page-1, -page-3, -page-5 (and under those names inside the ZIP); the unit test pins the zero-padding', [T('pdf-to-image-downloads')]),
  },
  'image-to-pdf': {
    'JPEG, PNG, WebP, GIF, BMP and HEIC images': C([I2P_PREVIEW], 'each format goes in and the page is read back out of the downloaded PDF: an upright JPEG is found inside it byte for byte; WebP, BMP, GIF and HEIC arrive as a JPEG stream of the right pixel size (BMP and GIF are also rendered and the picture checked); a GIF with transparency arrives as a PNG with an alpha mask'),
    'Every page shown as it will be saved, before you create the PDF': CU(['src/lib/images-to-pdf-layout.test.ts'], 'for seven option combinations over four mixed images, each previewed page’s size and draw rectangle equal the MediaBox and the image’s cm matrix in the downloaded file to a hundredth of a point, and the page is drawn on screen where those numbers say; typing a margin moves the preview before anything is clicked. The unit test pins the shared layout function to the numbers the tool produced before it had a preview, except the 40 rows the owner’s October 2026 decisions changed (Auto orientation, no margin on Fit Image), which carry their new numbers', [I2P_PREVIEW]),
    'Reorder pages by dragging or with the keyboard': C([I2P_PREVIEW, 'a11y/keyboard.spec.ts'], 'a mouse drag and the keyboard handle each change the order on screen and the order of the pages in the downloaded PDF; every keyboard move is announced by file name and position'),
    'Fit Image, A4, Letter and Legal page sizes': C([I2P_PREVIEW], 'each size is chosen and the MediaBox of every page in the downloaded PDF is read back: A4 595.28 × 841.89, Letter 612 × 792 and Legal 612 × 1008 (each way round), and for Fit Image the image’s own pixel size with the image filling the page edge to edge'),
    'Sideways phone photos turned upright': C([I2P_PREVIEW], 'a JPEG stored a quarter turn round with EXIF orientation 6 goes in; the PDF page is rendered with pdf.js and each colour of the test picture is found in its own corner. Orientations other than 6 take the same code path but are not separately tested'),
    'Pages turned to match each image, or all portrait or all landscape': CU(['src/lib/images-to-pdf-layout.test.ts'], 'with Auto, four mixed images on A4 come out landscape, portrait, portrait (square), landscape in the downloaded PDF, and Portrait and Landscape turn all four the same way — page size and image rectangle equal the preview each time; Legal and Letter are checked the same way. The unit test pins each orientation for every page size', [I2P_PREVIEW]),
    'Margin controls in mm or inches': C([SOURCED], 'built: mm/in/pt selector converts rather than reinterpreting the number (10 mm becomes 0.39 in and back to 10 mm without drift), and a 1.5 in margin positions the image 108 pt in from the page edge in the output'),
  },
  'watermark-pdf': {
    'Text and image watermarks': C([T('watermark-pdf')]),
    'Full opacity, rotation, and size control': U("SOURCE CHECK — implemented at WatermarkPdfTool sliders (opacity 5-100%, rotation -90..90 deg, font size 12-120pt); needs a test."),
    'Single placement or tiled/repeated grid': U("SOURCE CHECK — implemented at placement \"center\" | \"tiled\", both honoured by the worker; needs a test."),
    'Apply to all, odd, even, or specific pages': C([SOURCED], 'built: the worker already handled applyTo "range", so the UI now reaches it — pages 2 and 4 are watermarked and the other three are not'),
    'Layer behind or on top of content': C([SOURCED], 'built: the worker now reorders /Contents so the watermark stream paints first. Asserted structurally (behind = index 0, front = last) because the two are pixel-identical on a page with no background'),
    'Live preview on sample page': C([VISUAL]),
  },
  'edit-pdf': {
    'Text with font size, colour and opacity': C([EDIT], 'the font size field, its step buttons and a corner pull each change the Tf size read back from the downloaded file (6–144 pt bounds checked), the typed words are the Tj operand, and a colour and an opacity chosen in the pane are the rg colour and the /ca of the ExtGState in the file'),
    'Images, rectangles, ellipses, lines and arrows': C([EDIT, 'parity/claims.spec.ts'], 'each is added, resized by its corner and by the millimetre fields, and found in the downloaded file as its own clipped frame at the box shown on screen'),
    'Freehand drawing, highlight, whiteout and stamps': C([EDIT, 'parity/claims.spec.ts'], 'a mouse stroke, a highlight, a whiteout box and a stamp are each resized by handle and fields and read back from the file at the size shown'),
    'Resize anything by its corners, with Smaller and Larger, or in millimetres': C([EDIT, 'workspace/mobile.spec.ts'], 'for all ten kinds a corner drag and typed width/height/X/Y are read back from the downloaded file to 0.5% of the page; Smaller and Larger by mouse and by touch; Keep proportions on and off; undo and redo of a resize'),
    'Saved exactly where shown, on rotated and cropped pages too': CU(['src/lib/edit-pdf/write.test.ts'], 'on the /Rotate 90 and offset-CropBox fixtures text, an image, a rectangle, an arrow and a stamp are moved and resized and each frame in the downloaded file maps (through pdf.js) to the box shown, to 0.5% of the page, in both save modes; the unit test adds /Rotate 270 with an offset crop box and a page that leaves graphics states open', [EDIT]),
    'Undo and redo': C([EDIT, 'parity/claims.spec.ts'], 'the buttons and Ctrl+Z / Ctrl+Shift+Z undo and redo a resize, and the downloaded file has the redone size'),
    'Save into the page or as PDF annotations': C([EDIT], 'Part of the page leaves no /Annot objects; Separate annotations writes FreeText, Square, Line and Stamp annotations whose /Rect is the box shown'),
  },
  'add-page-numbers': {
    '6 position options': P([T('page-numbers')], 'one position asserted, not all six'),
    'Numeric, Roman, and alphabetic formats': P([T('page-numbers')], 'format switching tested; not every format is verified in output'),
    'Custom starting number': C([T('page-numbers')]),
    'Skip first N pages (for TOC/cover)': C([T('page-numbers')]),
    'Font, size, and color controls': C([SOURCED], 'font control built and the worker now honours options.font instead of always embedding Helvetica; the test reads /Courier and /Times-Roman back out of the output'),
    'Live preview on first and last page': C([VISUAL]),
  },
  'crop-pdf': {
    'Visual crop with drag handles': C(['tools/crop-pdf-handles.spec.ts', VISUAL], 'edge and corner handles are dragged with the mouse (and one by touch), the margin fields follow, and the crop box in the downloaded file matches'),
    'Numeric margin input (mm, inches, points)': P([T('crop-pdf')], 'default units and pt tested; inches are not'),
    'Auto-crop whitespace detection': C([VISUAL]),
    'CropBox (reversible) or Flatten (permanent)': C([CLOSED], 'both modes are selectable; CropBox keeps the text layer, Flatten rasterises so the trimmed content is gone rather than hidden'),
    'Apply to current page, all pages, or custom range': C([T('crop-pdf'), CLOSED], 'all three tested — current-page-only now exists and is proven to leave the other pages untouched'),
  },
  'redact-pdf': {
    'True redaction — content permanently destroyed': C([T('redact-pdf')], 'marked text is gone from the text layer while surrounding text survives'),
    'Find & Redact by text pattern': C([T('redact-pdf')]),
    'Post-redaction verification': C([T('redact-pdf')]),
    'Full metadata strip option': C([CLOSED], 'against a fixture carrying Info fields, an XMP packet and an attachment: all three are gone from the output'),
    'Two-step safety workflow': C([T('redact-pdf')], 'the confirm step is required before output'),
    'SHA-256 before/after comparison': C([T('redact-pdf')]),
  },
  'compress-image': {
    'Quality slider and target file size mode': C([T('compress-image')]),
    'JPEG, PNG, WebP, AVIF, HEIC support': P([T('compress-image')], 'the JPEG path is tested; HEIC input is not'),
    'Before/after size comparison': C([T('compress-image')]),
    'EXIF metadata stripping': C(['parity/claims.spec.ts'], 'a fixture carrying a real EXIF APP1 segment comes back stripped'),
    'Batch compression with ZIP download': C([T('compress-image')]),
  },
  'resize-image': {
    'Exact dimensions, percentage, or one-side resize': P([T('resize-image')], 'exact dimensions tested; percentage and one-side are not'),
    'Social media presets (Instagram, Twitter/X, LinkedIn, YouTube, Facebook)': C([T('resize-image')], 'one preset verified end to end'),
    'Fit, Fill, Stretch, Cover resize modes': P([T('resize-image'), XBROWSER], 'Fit and Cover verified by output dimensions; Fill and Stretch are not'),
    'Aspect ratio lock': C([T('resize-image')]),
    'Custom preset saving': C([T('resize-image')], 'persists across a reload via localStorage'),
    'Batch resize': C([T('resize-image')]),
  },
  'convert-image': {
    'JPEG, PNG, WebP, AVIF, BMP, TIFF, ICO, GIF, SVG': P([T('convert-image')], 'JPEG, PNG, WebP and AVIF tested; BMP, TIFF, ICO, GIF and SVG are not'),
    'HEIC (iPhone) conversion': C([T('convert-image')], 'a real HEVC-coded HEIC converts to JPEG and PNG through the libheif fallback, under the production CSP'),
    'Batch conversion to same format': C([T('convert-image')]),
    'Per-format quality settings': C([T('convert-image')]),
  },
  'lock-image': {
    'AES-256-GCM authenticated encryption': P([T('lock-image')], 'round-trip and wrong-password both verified; the cipher itself is not asserted'),
    'PBKDF2 key derivation (100,000 iterations)': C(['parity/claims.spec.ts'], 'the exported self-contained HTML is checked for the advertised parameters'),
    'Self-contained HTML — works offline': C([T('lock-image')], 'the produced HTML decrypts on its own'),
    'No server involved — 100% client-side': C([GUARD]),
    'Works in any modern browser': C([XBROWSER], 'the suite runs on Chromium, Firefox and WebKit'),
    'Password strength meter': U("SOURCE CHECK — implemented at LockImageTool getStrength() with a 0-4 bar; needs a test."),
  },
  'view-once-image': {
    'End-to-end encrypted before upload': C([T('view-once-image')]),
    'Decryption key only in the URL fragment': C([T('view-once-image')]),
    // The delete-on-read guarantee lives in the Pages Function, which the e2e
    // suite cannot reach — it runs against a static build with no Functions
    // runtime. A unit test against a stub KV proves it instead.
    'Automatically deleted after first view': CU(['functions/api/view-once/view-once.test.ts'], 'was implemented all along, server-side — the audit searched only client code; the handler deletes the blob on the first GET and a second read 404s'),
    'Configurable expiry: 1h, 6h, 24h, or 7 days': { state: 'partial', specs: [T('view-once-image')], units: ['functions/api/view-once/view-once.test.ts'], note: 'TTL options are shown and an out-of-range TTL is clamped to 24h; real expiry over time is not tested' },
    'Works in any modern browser': C([XBROWSER]),
    'Max 10MB image size': C([CLOSED], 'was implemented all along (VIEW_ONCE_MAX_SIZE); an 11MB file is refused before any encryption happens'),
  },
};
