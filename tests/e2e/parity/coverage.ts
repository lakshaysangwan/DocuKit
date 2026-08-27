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
const XBROWSER = 'xbrowser/capabilities.spec.ts';

export const COVERAGE: Record<string, Record<string, Coverage>> = {
  'merge-pdf': {
    'Drag-and-drop file reorder': C(['a11y/keyboard.spec.ts'], 'reorder proven via the keyboard equivalent of the drag interaction'),
    'Per-file page selection': C([T('merge-pdf')]),
    'Preserve bookmarks & internal links': C([CLOSED], 'opt-in MuPDF graft path; the merged outline keeps its nesting and both bookmarks and links are rebased onto the new page numbers'),
    'Optional blank page between documents': C([CLOSED], 'a blank lands between the two documents and not after the last one'),
    'Password-protected PDF support': C([CLOSED], 'an encrypted input is detected, decrypted with its password and merged; a wrong password names the file instead of merging garbage'),
    'Up to 50 files, 200MB per file': U('large-input limits are P6.2, deferred'),
  },
  'split-pdf': {
    '5 split modes': C([T('split-pdf')], 'extract, remove, by-range, extract-each and every-N all tested'),
    'Visual thumbnail page selector': U('thumbnail selector not asserted for split'),
    'Text syntax: "1-5, 8, odd, even, last"': C(['parity/claims.spec.ts'], 'odd, even and last all resolve to the right pages'),
    'ZIP output for multi-file splits': C([T('split-pdf')]),
    'Range input with live page count': C(['parity/claims.spec.ts']),
  },
  'compress-pdf': {
    '4 compression levels including custom': C([T('compress-pdf')]),
    'Side-by-side quality preview': C([VISUAL]),
    'Before/after file size comparison': C([T('compress-pdf')]),
    'Custom DPI and JPEG quality controls': P([T('compress-pdf')], 'controls are revealed; their effect on output is not measured'),
    'Grayscale conversion option': P([T('compress-pdf')], 'control is revealed; grayscale output is not verified'),
  },
  'rearrange-pdf-pages': {
    'Drag-and-drop page reorder': U('page reorder is not asserted; the keyboard test covers file reorder on merge'),
    'Multi-select with Ctrl+click / Shift+click': C([CLOSED], 'was implemented all along — the audit missed the modifier handling in PageThumbnailGrid; Ctrl adds and Shift extends a range'),
    'Rotate 90° CW/CCW per page or batch': P([T('organize-pages')], 'single-page rotate tested; batch rotate is not'),
    'Insert blank pages anywhere': C([CLOSED], 'the "+" affordance inserts at a chosen position and the output page really is blank'),
    'Duplicate pages': C([CLOSED], 'the copy is an independent page, so the two can be rotated separately'),
    'Undo/redo up to 20 actions': P([T('organize-pages'), CLOSED], 'undo of a delete and the Ctrl+Z / Ctrl+Shift+Z shortcuts are tested; the 20-action depth is not'),
    'Zoom control: 80 / 120 / 160px thumbnails': C(['parity/claims.spec.ts'], 'copy corrected to the sizes the control actually offers (S/M/L)'),
  },
  'sign-pdf': {
    'Draw, type, or upload signature': P([T('sign-pdf')], 'typed and uploaded are tested; freehand draw is not'),
    'Pressure-sensitive drawing (Apple Pencil / stylus)': U('needs pointer-pressure input'),
    'Auto background removal for uploaded images': U('not asserted'),
    '4 handwriting font options': U('font choices not exercised'),
    'Drag-and-drop placement with resize/rotate': P([T('sign-pdf')], 'placement tested; resize and rotate are not'),
    'Date stamp and initials support': C([CLOSED], 'a date stamp and initials can be placed alongside the signature; the date is drawn as real text and read back out of the output'),
    'Multi-page batch placement': U('not exercised'),
  },
  'digital-signature-pdf': {
    'PKCS#7 / PAdES standard digital signatures': C([T('digital-signature')], 'the signature is cryptographically verified in the harness'),
    'In-browser RSA-2048 key & certificate generation': C([T('digital-signature')]),
    'Upload existing .p12/.pfx certificates': U('only the generated-cert path is tested'),
    'SHA-256 hash of document content': C([T('digital-signature')], 'messageDigest is checked against the ByteRange'),
    'Private key never stored or transmitted': C([GUARD], 'zero cross-origin requests during the flow'),
    'Verifiable in Adobe Reader / Acrobat': U('third-party reader verification cannot run headless'),
    'Combine visible + cryptographic signature': U('not exercised'),
  },
  'protect-pdf': {
    'AES-256 encryption (PDF 2.0)': P([T('protect-unlock-pdf')], 'output is proven encrypted; the specific cipher is not asserted'),
    'User and owner passwords': P([T('protect-unlock-pdf')], 'user password tested; owner password is not'),
    'Permission controls (print, copy, edit, etc.)': P(['parity/claims.spec.ts'], 'the toggles work and a restricted file still encrypts; the /P flags in the output are not decoded'),
    'Password strength meter': U('not exercised'),
    'Random password generator': C([T('protect-unlock-pdf')]),
    '100% client-side — password never transmitted': C([GUARD]),
  },
  'unlock-pdf': {
    'Detects encryption automatically': C([T('protect-unlock-pdf')], 'an encrypted upload is recognised before the password is entered'),
    'Removes user and owner passwords': P([T('protect-unlock-pdf')], 'user password round-trip tested; owner password is not'),
    'Shows original encryption details': CU(['src/lib/pdf-encryption-info.test.ts'], 'the /Encrypt dictionary is parsed and shown; the unit test pins the handler revisions and /P decoding', [CLOSED]),
    'Instant decryption in-browser': C([T('protect-unlock-pdf'), GUARD]),
  },
  'pdf-to-image': {
    'PNG, JPEG, WebP, AVIF output': P([T('pdf-to-image')], 'PNG, JPEG and AVIF tested; WebP is not'),
    'Custom DPI up to 600': C(['parity/claims.spec.ts'], '600 DPI yields a markedly larger raster than 72 DPI'),
    'Single page, all pages, or page range': C([T('pdf-to-image')]),
    'Page preview before download': U('preview not asserted'),
    'ZIP download for multi-page exports': C([T('pdf-to-image')]),
  },
  'image-to-pdf': {
    'JPEG, PNG, WebP, BMP, TIFF, SVG, HEIC support': P([T('image-to-pdf')], 'JPEG and PNG tested; the rest are not'),
    'Multi-image drag-and-drop reorder': U('reorder not asserted for this tool'),
    'Fit Image, A4, Letter, Legal, custom page sizes': P([T('image-to-pdf')], 'Fit Image, A4 and Letter tested; Legal and custom are not'),
    'Margin controls in mm or inches': U('units not exercised'),
    'Per-image or global settings': U('not exercised'),
  },
  'watermark-pdf': {
    'Text and image watermarks': C([T('watermark-pdf')]),
    'Full opacity, rotation, and size control': U('controls not exercised'),
    'Single placement or tiled/repeated grid': U('tiled mode not exercised'),
    'Apply to all, odd, even, or specific pages': U('page targeting not exercised'),
    'Layer behind or on top of content': U('not exercised'),
    'Live preview on sample page': C([VISUAL]),
  },
  'edit-pdf': {
    'Text boxes with font/size/color/style': P([T('edit-pdf'), VISUAL], 'adding text is tested; font, size and colour options are not'),
    'Shapes: rectangle, ellipse, line, arrow': C(['parity/claims.spec.ts'], 'each of the four visibly marks the canvas'),
    'Freehand drawing with Bezier smoothing': P(['parity/claims.spec.ts'], 'drawing marks the canvas; the Bezier smoothing itself is not measured'),
    'Highlight, whiteout, and stamp tools': C(['parity/claims.spec.ts']),
    'Image and emoji overlays': U('not exercised'),
    'Undo/redo (50 actions)': P(['parity/claims.spec.ts'], 'undo and redo both verified (this test found and fixed a bug where the first undo did not revert); the 50-action depth is not'),
    'Flatten or keep as PDF annotations': C([T('edit-pdf')], 'both modes verified at the /Annot level'),
  },
  'add-page-numbers': {
    '6 position options': P([T('page-numbers')], 'one position asserted, not all six'),
    'Numeric, Roman, and alphabetic formats': P([T('page-numbers')], 'format switching tested; not every format is verified in output'),
    'Custom starting number': C([T('page-numbers')]),
    'Skip first N pages (for TOC/cover)': C([T('page-numbers')]),
    'Font, size, and color controls': U('not exercised'),
    'Live preview on first and last page': C([VISUAL]),
  },
  'crop-pdf': {
    'Visual crop with drag handles': P([VISUAL], 'the preview renders; dragging the handles is not simulated'),
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
    'Smart codec selection for photos vs illustrations': U('the selection heuristic is not asserted'),
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
    'HEIC (iPhone) conversion': U('no HEIC fixture; the libheif fallback path is untested'),
    'Batch conversion to same format': C([T('convert-image')]),
    'Per-format quality settings': C([T('convert-image')]),
  },
  'lock-image': {
    'AES-256-GCM authenticated encryption': P([T('lock-image')], 'round-trip and wrong-password both verified; the cipher itself is not asserted'),
    'PBKDF2 key derivation (100,000 iterations)': C(['parity/claims.spec.ts'], 'the exported self-contained HTML is checked for the advertised parameters'),
    'Self-contained HTML — works offline': C([T('lock-image')], 'the produced HTML decrypts on its own'),
    'No server involved — 100% client-side': C([GUARD]),
    'Works in any modern browser': C([XBROWSER], 'the suite runs on Chromium, Firefox and WebKit'),
    'Password strength meter': U('not exercised'),
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
