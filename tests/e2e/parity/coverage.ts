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
const WM_PLACEMENT = T('watermark-pdf-placement');
const PN_PLACEMENT = T('page-numbers-placement');
const P2I_WS = T('pdf-to-image-workspace');
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
    'Five settings: Low (lossless), Medium, High, Custom and Target size': C([T('compress-pdf'), T('compress-pdf-image-safety')], 'each of the five is run and its output checked'),
    'Side-by-side quality preview': C([VISUAL, T('compress-preview')], 'before compressing, a one-page preview at the chosen level beside the original (Low pixel-identical, Medium changed, High more; matches the real output within 0.5 per channel); after it, the real output beside the original'),
    'Any page compared with your original at Fit, 100% or 200%': C([T('compress-preview')], 'page change, rail, zoom sizes, split, side by side and hold, never cropped'),
    'A warning when a page comes out badly wrong': C([T('compress-preview')], 'absent at High and at the harshest target; shown, with "Download anyway", on output from a stubbed encoder that blackens images'),
    'Before/after file size comparison': C([T('compress-pdf')]),
    'An image the file repeats is stored once, at every level': CU(['src/lib/pdf-dedupe.test.ts'], 'a seeded file with the same logo, photo and masked stamp as separate objects on three pages: at Low the output has one object per distinct image, is smaller by about the copies, and MuPDF renders every page pixel-identical; at Medium they stay one object each; same bytes under another /Decode or mask are kept apart', [T('compress-pdf-dedupe')]),
    'Images with a soft mask are re-encoded with their transparency kept': CU(['src/lib/pdf-compress.test.ts'], 'a seeded page with two photo-like images (RGB and grey) and a full-page overlay, each under a plain soft mask with black hidden under its clear pixels, drawn over white and a coloured band: at Low, Medium, High, Custom 36 DPI / quality 25 and the harshest target, MuPDF renders of the download are no darker, clear corners and the band under clear parts match the original within 2, every 15 × 10 pt cell of each image within 10 and the page within 16; each image keeps the very same /SMask bytes, and the photo-like ones become smaller JPEGs. The unit suite pins the shape: a JPEG under a mask, a /Mask as well, a mask of another size, /Matte, an inverting /Decode, a predictor, 1-bit and non-grey masks are all left alone', [T('compress-pdf-alpha')]),
    'Custom image resolution (DPI) and JPEG quality controls': CU(['src/lib/pdf-image-placement.test.ts'], 'a real DPI: on the photo fixture (1200 × 800 px stretched over a 612 × 792 pt page, 141 DPI across and 73 down) High (96 DPI) writes images 816 px wide and keeps their 800 px height, Medium (150) keeps both, and the facts name the DPI; a lower Custom value reduces JPEGs even at high quality; the chosen quality is the one the preview reports. The unit suite works the resolution out through nested q/Q, rotation, forms and inline images, and gives no figure where an annotation can also draw the image', [T('compress-pdf'), T('compress-pdf-image-safety'), T('compress-preview')]),
    'Grayscale conversion option': P([T('compress-pdf')], 'control is revealed; grayscale output is not verified'),
    'Target size mode: fit under a KB or MB limit': C([T('compress-pdf'), T('compress-preview')], 'output lands under a reachable target, a looser target keeps more quality, and an unreachable one is reported rather than passed off as success; what it took is stated, with a warning at the harsh end'),
  },
  'rearrange-pdf-pages': {
    'Drag-and-drop page reorder': C([T('organize-pages-workspace')], 'a mouse drag and a keyboard move on the handle each put the pages of the downloaded file in the order shown'),
    'Select pages by click or Shift-click': C([T('organize-pages-workspace'), CLOSED], 'click, Shift-click and Space on a page build the selection; Rotate selected and Delete selected act on exactly those pages in the file'),
    'Rotate 90° CW/CCW per page or batch': C([T('organize-pages'), T('organize-pages-workspace')], 'per-page (mouse, keyboard and touch), Rotate selected and Rotate all are each checked against the /Rotate of every output page'),
    'Turns add to a page’s own rotation': C([T('organize-pages-workspace')], 'on the /Rotate 90 fixture, rotating right writes 180 and rotating left writes 0; the writer is unit-tested on every /Rotate'),
    'Insert blank pages anywhere': C([CLOSED, T('organize-pages-workspace')], '"Add a blank page" inserts after the selected page; the output page there is blank and the same shape as the page before it'),
    'Duplicate pages': C([CLOSED, T('organize-pages-workspace')], 'the copy is an independent page, so the two can be rotated separately'),
    'Undo and redo every change': C([T('organize-pages'), T('organize-pages-workspace'), CLOSED], 'the Undo and Redo buttons, Ctrl+Z / Ctrl+Shift+Z and Reset are each followed through to the downloaded file'),
    'Small, medium and large pages, and any page enlarged': C(['parity/claims.spec.ts', T('organize-pages-workspace')], 'L draws pages wider than S; a page opens large with Previous / Next and shows its turn'),
  },
  'sign-pdf': {
    'Draw, type, or upload signature': C([T('sign-pdf'), T('sign-pdf-fonts')], 'all three are driven end to end: a freehand stroke on the pad, a typed name and an uploaded picture each end up as an image in the downloaded file, trimmed to the ink and with its own proportions; each of the four handwriting styles has the Latin letters, and the typed image in the file is drawn in the style picked, not a fallback font'),
    'Upload a photo of your signature: the paper is taken out, and it is cropped to the ink': CU(['src/lib/sign/signature-extract.test.ts'], 'a seeded JPEG of blue ink on yellowish, unevenly lit paper with specks is uploaded, used and signed; the image read out of the downloaded file has a soft mask, is clear at its corners and everywhere away from the strokes, is opaque and blue along the stroke and in the dot of the i, has the shape of the ink box (not the photo), and a MuPDF render shows the page unchanged under its clear parts; "Make ink black" gives black ink; the Sensitivity slider changes what is kept; no request is made while the photo is cleaned; a sideways (EXIF) photo comes out upright and a HEIC is accepted. The unit tests cover the lighting gradient, faint ink, specks and blank paper', [T('sign-pdf-upload')]),
    'See the signature on the page: drag to move, pull a corner to resize': C([SIGN_PLACEMENT, 'workspace/mobile.spec.ts'], 'a mouse drag and a corner pull each change the box on screen and the image in the downloaded file by the same amount; the shape is kept. A finger drag is covered by workspace/mobile.spec.ts with synthetic touch pointer events'),
    'Placed exactly where shown, on rotated and cropped pages too': CU(['src/lib/pdf/page-geometry.integration.test.ts'], 'a stamp set to a known rectangle is read back from the output content stream and mapped to the displayed page by pdf.js on a plain, a /Rotate 90 and an offset-CropBox fixture, to 0.4% of the page, and its four colours are found at that spot in the rendered output; the mapping itself is pixel-tested against a second renderer in the unit suite', [SIGN_PLACEMENT]),
    'Date stamp and initials support': C([CLOSED, SIGN_PLACEMENT], 'a date stamp and initials are added beside the signature; the date is real text read back out of the output, and both land in the boxes that were shown, on a /Rotate 90 page'),
    'Put the signature on every page or the pages you choose, in the same place on each': C([T('sign-pdf-all-pages'), SOURCED, SIGN_PLACEMENT], 'on a four-page file of unlike pages (portrait, landscape, /Rotate 90, offset-CropBox A5) All pages puts it on each at the same size and distance from the left and bottom edges, and each image read from the downloaded file matches the box on screen; Choose pages "1,3" (typed, and by ticks that update the field) leaves pages 2 and 4 without it; "This page only" takes the copies off; the keyboard alone picks All pages with the arrow keys. "Copy to all pages" in the selection bar still puts it on all five pages of a fixture, with the image stored once'),
    'Copies stay linked: move or resize one and every page follows': C([T('sign-pdf-all-pages')], 'a mouse drag on page 3 and arrow-key nudges on page 1 move every copy to the matching place, read back from each page of the downloaded file; after "Unlink page 2" a millimetre edit moves page 2 only; one Undo restores every page; Remove on a linked copy asks This page / All pages and each is followed through'),
    'Undo, redo and remove any stamp': C([SIGN_PLACEMENT], 'Remove, the Undo and Redo buttons and Ctrl+Z / Ctrl+Shift+Z are each followed through to the downloaded file, which has the date but not the removed signature'),
  },
  'digital-signature-pdf': {
    'PKCS#7 detached digital signatures': C([T('digital-signature')], 'the downloaded file has a /Sig dictionary with SubFilter adbe.pkcs7.detached, a PKCS#7 DER blob in /Contents, and the signature is cryptographically verified in the harness'),
    'In-browser RSA-2048 key & certificate generation': C([T('digital-signature')]),
    'Upload existing .p12/.pfx certificates': C([T('digital-signature')], 'a password-protected .p12 is refused with the exact wrong-password message, then opened with the right one; the file is signed by that certificate (signer CN read from the PKCS#7)'),
    'SHA-256 hash of document content': C([T('digital-signature')], 'messageDigest is checked against the ByteRange'),
    'Private key never stored or transmitted': C([T('digital-signature')], 'every request made from opening the page to downloading the signed file is to the site itself, and none is a POST'),
    'Visible signature box you place on any page, or none at all': C([T('digital-signature')], 'invisible: every signature widget has a zero /Rect and no appearance, and nothing is drawn; visible: moved to page 2 by mouse drag and corner, and by the millimetre fields, the widget /Rect on page 2 (mapped by pdf.js) matches the box on screen within 0.5% of the page'),
    'Placed exactly where shown, on rotated and cropped pages too': CU(['src/lib/pdf-sign.integration.test.ts'], 'the widget /Rect matches the on-screen box on a /Rotate 90 page, an offset-CropBox page and a page that leaves its coordinates transformed; in the unit suite MuPDF renders the box at the placed rectangle with its text upright on /Rotate 0/90/180/270 and offset-CropBox pages', [T('digital-signature')]),
    'Checks the signed file: whole-file byte range, digest, RSA signature': CU(['src/lib/pdf-sign.integration.test.ts'], 'the result pane shows signer, signing time, issuer and the three checks for the downloaded file (its byte count is the downloaded file\'s); the checker is unit-tested against real signed files', [T('digital-signature')]),
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
    'Detects encryption automatically': C([T('protect-unlock-pdf'), T('protect-unlock-workspace')], 'a file that asks for a password shows a locked placeholder and asks for it; a restrictions-only file opens at once with its restrictions shown; an unencrypted file and a non-PDF are each named as such'),
    'Removes user and owner passwords': C([T('protect-unlock-pdf'), T('protect-pdf-permissions'), T('protect-unlock-workspace')], 'unlocks with the open password and with the permissions password; a restrictions-only file unlocks with no password (qpdf removes encryption with any password that opens the file); every download has no /Encrypt and pdf.js reports no permissions'),
    'Shows original encryption details': CU(['src/lib/pdf-encryption-info.test.ts'], 'the /Encrypt dictionary is parsed and shown; the unit test pins the handler revisions and /P decoding', [CLOSED]),
    'Instant decryption in-browser': C([T('protect-unlock-pdf'), GUARD]),
  },
  'pdf-to-image': {
    'PNG, JPEG, WebP, AVIF output': C([T('pdf-to-image'), P2I_WS], 'a download in each of the four formats is checked by its magic bytes (WebP in the workspace spec, which also checks the WebP preview)'),
    '72, 150, 300 or 600 DPI': C([P2I_WS, 'parity/claims.spec.ts'], 'at 72, 150 and 300 DPI three pages of a Letter PDF download at exactly the pixel sizes listed (612 × DPI / 72 wide), and at 600 DPI the downloaded image is the size listed. Copy corrected earlier: there is no custom DPI field, only these four presets'),
    'Single page, all pages, or page range': C([T('pdf-to-image'), P2I_WS], 'clicking pages rewrites the range field and odd, even, last and mixed ranges drive the grid; the downloads contain exactly the pages chosen'),
    'Each page previewed as the image you will get, with its pixel size and file size': C([P2I_WS, SOURCED], 'the enlarged page is drawn by the same function as the export: at 150 and 300 DPI its pixel size equals the downloaded PNG’s, its pixels match (mean difference under 1/255, in fact the same bytes), and the file size it shows is the downloaded file’s; a JPEG previewed at quality 20 is byte for byte the JPEG downloaded, and quality and format changes show in the preview. At 600 DPI the preview is drawn at a lower DPI within a 12-megapixel budget (6 on low-memory devices), says so, and labels its file size an estimate; the pixel size it reports is the downloaded image’s'),
    'A Download button on every converted image': C([T('pdf-to-image-downloads')], 'each card shows a decoded thumbnail of the output, its name, pixel size and file size, and its button downloads that page only — checked by rendering the downloaded PNG dimensions against the card'),
    'Download all as separate files, or as one ZIP': C([T('pdf-to-image-downloads'), T('pdf-to-image')], 'three pages give three download events with valid PNG bytes on Chromium, Firefox and WebKit; the ZIP entries are read back; above 10 images the ZIP is the primary. The browser permission prompt for several downloads does not appear under automation, so that step is unproven'),
    'Save to a folder or share sheet where the browser supports it': P([T('pdf-to-image-downloads')], 'both buttons are shown only when the API is present, and against a stubbed showDirectoryPicker / navigator.share the right files are written or shared, with cancel and write errors reported. The real folder picker and a real phone share sheet cannot be driven by automation'),
    'Files named by source page number': CU(['src/lib/multi-download.test.ts'], 'pages 1, 3, 5 of a five-page PDF download as -page-1, -page-3, -page-5 (and under those names inside the ZIP); the unit test pins the zero-padding', [T('pdf-to-image-downloads')]),
  },
  'image-to-pdf': {
    'JPEG, PNG, WebP, GIF, BMP and HEIC images': C([I2P_PREVIEW], 'each format goes in and the page is read back out of the downloaded PDF: an upright JPEG is found inside it byte for byte; WebP, BMP, GIF and HEIC arrive as a JPEG stream of the right pixel size (BMP and GIF are also rendered and the picture checked); a GIF with transparency arrives as a PNG with an alpha mask'),
    'Every page shown as it will be saved, before you create the PDF': CU(['src/lib/images-to-pdf-layout.test.ts'], 'for seven option combinations over four mixed images, each previewed page’s size and draw rectangle equal the MediaBox and the image’s cm matrix in the downloaded file to a hundredth of a point, and the page is drawn on screen where those numbers say; typing a margin moves the preview before anything is clicked. The unit test pins the shared layout function to the numbers the tool produced before it had a preview, except the 40 rows the owner’s October 2026 decisions changed (Auto orientation, no margin on Fit Image, Fit Image at 150 DPI or the stated DPI with an A3 cap), which carry their new numbers', [I2P_PREVIEW]),
    'Reorder pages by dragging or with the keyboard': C([I2P_PREVIEW, 'a11y/keyboard.spec.ts'], 'a mouse drag and the keyboard handle each change the order on screen and the order of the pages in the downloaded PDF; every keyboard move is announced by file name and position'),
    'Fit Image, A4, Letter and Legal page sizes': C([I2P_PREVIEW], 'each size is chosen and the MediaBox of every page in the downloaded PDF is read back: A4 595.28 × 841.89, Letter 612 × 792 and Legal 612 × 1008 (each way round), and for Fit Image the image’s own shape at 150 DPI (four mixed images), at the 300 DPI a 4000 × 3000 JPEG states (960 × 720 pt, “339 × 254 mm”), and capped at A3’s 420 mm long edge for a 4000 × 3000 photo stating none (1190.55 × 892.91 pt), each with the image filling the page edge to edge, its proportions exact and its 4000 × 3000 pixels embedded untouched'),
    'Sideways phone photos turned upright': C([I2P_PREVIEW], 'a JPEG stored a quarter turn round with EXIF orientation 6 goes in; the PDF page is rendered with pdf.js and each colour of the test picture is found in its own corner. Orientations other than 6 take the same code path but are not separately tested'),
    'Pages turned to match each image, or all portrait or all landscape': CU(['src/lib/images-to-pdf-layout.test.ts'], 'with Auto, four mixed images on A4 come out landscape, portrait, portrait (square), landscape in the downloaded PDF, and Portrait and Landscape turn all four the same way — page size and image rectangle equal the preview each time; Legal and Letter are checked the same way. The unit test pins each orientation for every page size', [I2P_PREVIEW]),
    'Margin controls in mm or inches': C([SOURCED], 'built: mm/in/pt selector converts rather than reinterpreting the number (10 mm becomes 0.39 in and back to 10 mm without drift), and a 1.5 in margin positions the image 108 pt in from the page edge in the output'),
  },
  'watermark-pdf': {
    'Text and image watermarks': C([T('watermark-pdf'), WM_PLACEMENT], 'a text watermark and a PNG image watermark are each added and read back out of the downloaded file at the corners shown on screen'),
    'Font, colour, size, opacity and rotation controls': C([WM_PLACEMENT], 'Times Bold at 40 pt in red at 45% is read back as /Times-Bold, a 40 Tf, a 1 0 0 rg fill and an ExtGState with /ca 0.45; rotations of -45, 0 and 30 degrees and the image width slider are read back as the frame of every copy, to 0.5% of the page'),
    'Drag the watermark anywhere on the page, or pick one of nine positions': CU(['src/lib/watermark-layout.test.ts', 'src/lib/watermark-write.test.ts'], 'a mouse drag puts the watermark’s centre in the downloaded file where it was dropped and where the preview shows it (four corners to 0.5% of the page) on a plain page, a /Rotate 90 scan and an offset crop box; a touch drag does the same on a phone; an arrow key moves it 0.5% of the page width and Shift+arrow 5%, read back from the file; typed centre millimetres land at those millimetres; a preset after a custom position snaps back; tiled mode has no drag box; a custom position is at the same fraction of every page “Apply to” selects. A bottom-right watermark keeps the 72 pt chosen from both edges of a /Rotate 90 page; the unit tests pin every preset and margin, the custom centre on three page shapes, its clamp to the page, and the written frame on every /Rotate, an offset crop box and UserUnit', [T('watermark-pdf-position'), WM_PLACEMENT, 'workspace/mobile.spec.ts']),
    'Tile it across the page with adjustable spacing': CU(['src/lib/watermark-layout.test.ts'], 'tiled copies on screen are the copies in the file, corner for corner, and a wider spacing gives fewer copies; the unit test pins the tile steps (width or height plus the spacing, every other row shifted half a step) and the turned lattice', [WM_PLACEMENT]),
    'Apply to all, odd, even, or specific pages': C([SOURCED, WM_PLACEMENT, T('watermark-pdf')], 'pages 2 and 4 of five carry the watermark and the other three do not, in the text layer and in the content; the left-out pages are badged "Not watermarked" and shown without it; odd pages run end to end; a range that selects nothing disables the action and says why'),
    'Layer behind or on top of content': C([SOURCED, WM_PLACEMENT], 'on a page covered by an opaque shape the rendered output shows the marker image on top and none of it behind; structurally the watermark stream is first for behind and last for on top'),
    'Any page previewed with the watermark where the file will have it, on rotated and cropped pages too': CU(['src/lib/watermark-write.test.ts', 'src/lib/watermark-layout.test.ts'], 'for text and image, single and tiled, turned and not, every copy drawn over the page (read from the SVG’s screen transform) is at the same four corners in the downloaded file (content stream mapped by pdf.js), to 0.5% of the page, on page 2 of a plain file, a /Rotate 90 scan, an offset crop box and a page that leaves graphics states open, where the rendered output is also checked by its pixels; the unit test adds /Rotate 180 and 270, UserUnit and an offset box under /Rotate 90', [WM_PLACEMENT, VISUAL]),
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
    '6 position options': CU(['src/lib/page-number-layout.test.ts', 'src/lib/page-number-write.test.ts'], 'each of the six positions is chosen and the number on pages 1, 3 and 5 is read back from the downloaded file at the corners shown on screen, to 0.5% of the page; the unit tests pin every position against the original placement and write it on every /Rotate, an offset crop box and UserUnit', [PN_PLACEMENT, T('page-numbers')]),
    'Numeric, Roman, and alphabetic formats': C([PN_PLACEMENT, T('page-numbers')], 'all six formats ("1", "Page 1", "Page 1 of N", "1/N", i, a) are read back from the file, by the content stream and by pdf.js text extraction, on pages 1, 3 and 5'),
    'Custom starting number': C([PN_PLACEMENT, T('page-numbers')], 'start 7 after skipping two pages gives 7, 8, 9 on pages 3–5 of the downloaded file; start 3 with roman gives iii–vi'),
    'Skip first N pages (for TOC/cover)': C([PN_PLACEMENT, T('page-numbers')], 'skipped pages carry no number in the file, are badged "No number on this page" in the rail and say so on the stage; "of N" counts the numbered pages; skipping every page disables the action and says why'),
    'Font, size, and color controls': C([SOURCED, PN_PLACEMENT], 'Times at 18 pt in red is read back as /Times-Roman, an 18 Tf and a 1 0 0 rg fill, at the box shown; /Courier is read back too'),
    'Adjustable distance from the page edges': CU(['src/lib/page-number-layout.test.ts'], 'bottom right at 30 mm and 25 mm: the number ends 30 mm from the right edge and its baseline is 25 mm above the bottom, on screen and in the file', [PN_PLACEMENT]),
    'Any page previewed with its own number, where the file will have it': CU(['src/lib/page-number-write.test.ts'], 'the number drawn over pages 1, 3 and 5 (read from the SVG’s screen transform) has the same text and four corners in the downloaded file (content stream mapped by pdf.js), to 0.5% of the page; on a /Rotate 90 scan it reads upright at the visual bottom centre, in the file and in the rendered output; an offset crop box and a page that leaves graphics states open are checked too, the latter by its rendered pixels and by the Q operators that close the page’s states', [PN_PLACEMENT, VISUAL]),
  },
  'crop-pdf': {
    'Visual crop with drag handles': C(['tools/crop-pdf-handles.spec.ts', T('crop-pdf-pages'), VISUAL], 'edge and corner handles are dragged with the mouse (and one by touch), and the whole box by mouse and by touch; the margin fields follow, and the crop box in the downloaded file shows the area dragged, on a plain page, a /Rotate 90 scan and an offset crop box'),
    'Numeric margin input (mm, inches, points)': CU(['src/lib/crop-layout.test.ts'], 'margins typed in inches read back exactly in points, millimetres and inches again, and the crop box in the downloaded file is exactly that many points; mm and pt are typed in the other specs', [T('crop-pdf'), T('crop-pdf-pages')]),
    'Auto-crop whitespace detection': C([VISUAL, T('crop-pdf-pages')], 'on page 2 of a file whose pages have their content in different places, the margins land on page 2’s content (within the 4px padding) and the file is cropped to them'),
    'CropBox (reversible) or Flatten (permanent)': C([CLOSED, T('crop-pdf-pages')], 'both modes are selectable; CropBox keeps the text layer, Flatten rasterises so the trimmed content is gone rather than hidden; on a /Rotate 90 scan and an offset crop box the flattened page is the size of the area kept and two marker squares are found in its rendered pixels where the crop puts them, to 0.8% of the page. The copy no longer says Flatten makes the file smaller: measured on five fixtures it made every one larger'),
    'Apply to the page shown, all pages, or a page range': C([T('crop-pdf'), T('crop-pdf-pages'), CLOSED], '"Current page" with page 3 shown crops page 3 alone; a range crops just its pages, the others are marked “Not cropped” in the rail and keep their boxes in the file'),
    'Crops the edges you see, on rotated and cropped pages too': CU(['src/lib/crop-layout.test.ts'], 'typed and dragged margins on the /Rotate 90 and offset-CropBox fixtures: each output CropBox, mapped to the original displayed page by pdf.js, is the area chosen to 0.5% of the page, in CropBox mode; Flatten is checked by pixels; the unit test writes the box on every /Rotate, an offset box and UserUnit', [T('crop-pdf-pages')]),
  },
  'redact-pdf': {
    'True redaction: text and image pixels under a mark are removed, not covered': C([T('redact-pdf'), T('redact-pdf-marks')], 'text under each mark is gone from the downloaded file (pdf.js) while text beside it survives; the image data stored in the file (read with MuPDF) has the pixels under a mark blanked and the rest of the photo unchanged; a stroke the mark covers completely is gone from the drawing'),
    'Mark with a mouse, a finger or a pen': C([T('redact-pdf-marks')], 'a mark drawn with a real mouse, and with pointer events of pointerType touch and pen, each removes exactly the text under it; the drawing layer is touch-action none only while Draw marks is on'),
    'Find & mark every place a phrase appears': CU(['src/lib/redact/find-phrase.integration.test.ts', 'src/lib/redact/phrase-marks.test.ts'], 'every match on every page is marked (rail badges on the right pages), removed from the file, and reported gone by the result panel; a phrase with no match says so. Searched in other capitals in the middle of a line, the mark covers the phrase only and the rest of the line is still text in the downloaded file, on a /Rotate 90 scan too. The integration test redacts real PDFs with MuPDF and reads them back: letters touching the match, the lines above and below on single-spaced text, a match across two text items and one running onto the next line all come out right', [T('redact-pdf'), T('redact-pdf-marks'), CLOSED]),
    'Removes the area shown, on rotated and cropped pages too': C([T('redact-pdf-marks')], 'on a /Rotate 90 scan, an offset CropBox and a /UserUnit 2 page: the black area MuPDF renders from the downloaded file is the mark shown on screen to 0.5% of the page, and no text is left under it'),
    'See the redacted pages before you download': C([T('redact-pdf'), T('redact-pdf-marks')], 'after Redact PDF the stage shows the output file (alt "Redacted page"), with Before/After; the result panel reports no text found under the marks and searched phrases gone'),
    'Undo and redo': C([T('redact-pdf-marks')], 'remove, undo, redo, undo of a mark, then a move and a corner resize, are all reflected in the downloaded file'),
    'Full metadata strip option': C([CLOSED], 'against a fixture carrying Info fields, an XMP packet and an attachment: all three are gone from the output'),
    'Two-step safety workflow': C([T('redact-pdf'), T('redact-pdf-marks')], 'the action is disabled, saying why, until the confirmation is ticked; any change after a run (Make changes, then a move) invalidates the result'),
    'SHA-256 before/after comparison': C([T('redact-pdf')]),
  },
  'compress-image': {
    'Quality slider and target file size mode': C([T('compress-image'), T('compress-image-preview')], 'quality 20 is smaller than 80; a target is met with the quality it needed reported, and a missed target reports the smallest size reached, which is the file'),
    'JPEG, PNG, WebP, AVIF, HEIC support': C([T('compress-image'), T('compress-image-preview')], 'JPEG, PNG and HEIC inputs compress; JPEG, WebP, AVIF and PNG outputs are checked by signature and name, and by pixel size where they are compressed'),
    'See the quality before you download: original and compressed side by side, uncropped, with zoom': C([T('compress-image-preview')], 'the compare view’s after image is byte-for-byte the downloaded file (live preview, Target size); live update settles on the last slider value; 100% is one image pixel per CSS pixel'),
    'Re-encoded images carry no EXIF metadata': C(['parity/claims.spec.ts', T('compress-image-preview')], 'a fixture carrying a real EXIF APP1 segment comes back stripped, as WebP and as JPEG'),
    'Batch compression: separate downloads or one ZIP': C([T('compress-image'), T('compress-image-preview')], 'three images download as three files of the right format and size; two also as one ZIP'),
  },
  'resize-image': {
    'Exact width and height, or a percentage': C([T('resize-image'), XBROWSER], 'typed width and height, a width with the height following, 25% and 50% are each read back from the downloaded file\'s decoded pixel size'),
    'See the new size before you download, with the image placed as it will be saved': CU(['src/lib/resize-image.test.ts'], 'the frame\'s size and image box (and the box the image is drawn at on screen) are checked against the downloaded file: the bar colour, and where the red and blue halves of a test image meet, in Fit, Cover (centred, dragged, by slider) and Stretch; the unit test pins the one layout the preview and the writer share', [T('resize-image')]),
    'Social media presets (Instagram, Twitter/X, LinkedIn, YouTube, Facebook)': C([T('resize-image')], 'YouTube Thumbnail sets 1280×720; the file is that size with the white bars the frame showed. The other presets are the same code path with other numbers'),
    'Fit, Cover and Stretch, with a crop position you can drag': C([T('resize-image')], 'each mode is checked by pixels in the downloaded file; a mouse drag and the Crop position slider each move the kept part in the file as on screen; Black, White and Transparent backgrounds are read back'),
    'Aspect ratio lock': C([T('resize-image'), XBROWSER], 'with Keep proportions a typed width sets the height (600 → 400 for 3:2) and the file is that size'),
    'Custom preset saving': C([T('resize-image')], 'a saved size persists across a reload via localStorage and applies again'),
    'Batch resize: separate downloads or one ZIP': C([T('resize-image')], 'two images of different shapes download as two separate files, each decoded at the frame size, and as one ZIP'),
  },
  'convert-image': {
    'Save as JPG, PNG, WebP or AVIF': C([T('convert-image'), T('landing-pages')], 'each output is checked by its magic bytes, its .jpg/.png/.webp/.avif name and the pixel size it decodes to; every task page starts on its own format'),
    'Opens JPEG, PNG, WebP, AVIF, GIF and BMP': P([T('convert-image')], 'JPEG, PNG, WebP and BMP (a hand-built 24-bit file, pixels checked) inputs convert; GIF and AVIF inputs go through the same decodeToBitmap path but no test feeds one in'),
    'HEIC (iPhone) conversion': C([T('convert-image'), T('landing-pages')], 'a real HEVC-coded HEIC is shown on the stage and converts to JPEG and PNG at its 600 × 400 size through the libheif fallback, under the production CSP'),
    'See the result next to your original before you download': C([T('convert-image')], 'the compare view’s after image is byte-for-byte the downloaded file (JPG live preview); AVIF waits for Preview; after the run the stage compares the original with the output'),
    'Quality setting for JPG, WebP and AVIF': C([T('convert-image')], 'quality 30 and 95 previews differ in size and the download is the quality-95 file; the slider is not shown for PNG'),
    'Transparency kept in PNG, WebP and AVIF': P([T('convert-image')], 'a half-transparent PNG keeps its clear pixels as PNG and WebP (read back from the file), and becomes white as JPG; AVIF keeps alpha through the same path but is not read back, as not every engine here decodes AVIF'),
    'Batch conversion: separate downloads or one ZIP': C([T('convert-image')], 'two images download as two separate files of the right format, names and pixel sizes, and as one ZIP with the same entries; clashing names get "(2)"'),
  },
  'lock-image': {
    'AES-256-GCM authenticated encryption': CU(['src/lib/lock-image.test.ts'], 'the downloaded file is parsed and decrypted in Node with WebCrypto AES-GCM (256-bit key) back to the exact original bytes, and a wrong password fails; the unit test also checks the 16-byte GCM tag', [T('lock-image')]),
    'PBKDF2-SHA-256 key derivation (600,000 iterations)': C(['parity/claims.spec.ts', T('lock-image')], "the downloaded file's header names PBKDF2 / SHA-256 / 600000, and the Node-side decryption derives the key with exactly those parameters"),
    'One self-contained HTML file that opens offline': C([T('lock-image')], 'the downloaded file is opened from disk (file://) with all network blocked; the password unlocks it and Save image gives back the original bytes'),
    'Nothing uploaded: encrypted in your browser': C([T('lock-image')], 'every request made while locking is recorded; none leaves the page origin and none carries a body'),
    'Works in any modern browser': C([XBROWSER, T('lock-image')], 'the lock and unlock round trip runs on Chromium, Firefox and WebKit'),
    'Password strength meter': CU(['src/lib/lock-image.test.ts'], 'the grading is unit-tested; the spec checks the bar appears and rises from a short to a long password', [T('lock-image')]),
    'Unlocking gives back the original image, byte for byte': C([T('lock-image')], 'the image saved from the unlocked file equals the uploaded fixture byte for byte'),
  },
  'view-once-image': {
    'End-to-end encrypted before upload': C([T('view-once-image')], 'the upload is intercepted: its body is AES-GCM ciphertext (image size + type header + 16-byte tag) containing no run of the image bytes, and it decrypts with the key from the link to the exact image'),
    'Decryption key only in the URL fragment': C([T('view-once-image')], 'the key appears only after the #; no request (upload or fetch) carries it in its URL, headers or body'),
    // The delete-on-read guarantee lives in the Pages Function, which the e2e
    // suite cannot reach — it runs against a static build with no Functions
    // runtime. A unit test against a stub KV proves it instead.
    'Deleted from the server the first time it is opened': CU(['functions/api/view-once/view-once.test.ts'], 'the handler deletes the blob on the first GET and a second read 404s; the e2e spec opens a link against a stubbed API that does the same and sees "no longer available" the second time', [T('view-once-image')]),
    'Nothing is fetched until the recipient presses Open image': C([T('view-once-image')], 'the /view/ page is loaded and no API request is made until the button is pressed'),
    'Configurable expiry: 1h, 6h, 24h, or 7 days': { state: 'partial', specs: [T('view-once-image')], units: ['functions/api/view-once/view-once.test.ts'], note: 'each choice is sent as X-TTL in the intercepted upload, and an out-of-range TTL is clamped to 24h by the function; real expiry over time is not tested' },
    'Works in any modern browser': C([XBROWSER, T('view-once-image')], 'create and open run on Chromium, Firefox and WebKit'),
    'Max 10MB image size': C([CLOSED], 'was implemented all along (VIEW_ONCE_MAX_SIZE); an 11MB file is refused before any encryption happens'),
  },
};
