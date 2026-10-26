import { type Page, type Download, type Locator, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Dev-server artifacts (Vite optimize-dep re-bundling, Astro dev toolbar). */
function isDevNoise(url: string): boolean {
  return (
    url.includes('/@id/') ||
    url.includes('/@vite/') ||
    url.includes('dev-toolbar') ||
    url.includes('/@fs/') ||
    url.includes('?v=') // Vite dep-cache busting URLs during re-optimization
  );
}

/** Collects console errors and failed network requests for a page. */
export class PageDiagnostics {
  consoleErrors: string[] = [];
  pageErrors: string[] = [];
  failedRequests: string[] = [];

  constructor(page: Page) {
    page.on('console', (msg) => {
      if (msg.type() === 'error') this.consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      this.pageErrors.push(err.message);
    });
    page.on('requestfailed', (req) => {
      // Ignore benign aborts (e.g. prefetch cancellations).
      const failure = req.failure()?.errorText ?? '';
      // Abort/cancel wording is engine-specific: Chromium ERR_ABORTED, Gecko
      // NS_BINDING_ABORTED, WebKit "cancelled". None of them is a real failure.
      if (/abort|cancel/i.test(failure)) return;
      if (isDevNoise(req.url())) return;
      this.failedRequests.push(`${req.url()} — ${failure}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 500 && !isDevNoise(res.url())) {
        this.failedRequests.push(`${res.url()} — HTTP ${res.status()}`);
      }
    });
  }

  /** Console errors that aren't known-benign noise. */
  get meaningfulConsoleErrors(): string[] {
    const benign = [
      'favicon',
      'manifest',
      // pdf.js emits a harmless warning on some fonts
      'Warning:',
      'sw.js',
      'ServiceWorker',
      'workbox',
      // Vite dev-server dependency re-optimization after source edits (dev only)
      'Outdated Optimize Dep',
      'dev-toolbar',
      '@id/astro',
      '@vite',
      '504 (Outdated',
    ];
    return this.consoleErrors.filter((e) => !benign.some((b) => e.includes(b)));
  }

  get allErrors(): string[] {
    return [...this.meaningfulConsoleErrors, ...this.pageErrors, ...this.failedRequests];
  }
}

/** Navigate and return time-to-DOMContentLoaded + full load, plus diagnostics. */
export async function gotoTimed(page: Page, url: string) {
  const diag = new PageDiagnostics(page);
  const start = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const domContentLoaded = Date.now() - start;
  await page.waitForLoadState('load');
  const fullLoad = Date.now() - start;

  // Pull Navigation Timing + paint metrics from the browser.
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
    return {
      ttfb: nav ? Math.round(nav.responseStart) : null,
      domInteractive: nav ? Math.round(nav.domInteractive) : null,
      fcp: fcp ? Math.round(fcp) : null,
    };
  });

  return { diag, domContentLoaded, fullLoad, ...metrics };
}

/** Upload files to the (hidden) file input inside a dropzone. */
export async function uploadFiles(page: Page, files: string | string[]) {
  // Wait for the DropZone island to hydrate. Its change handler is a React
  // listener; setting files before hydration fires a change event with no
  // listener attached, so the files are silently dropped.
  await expect(page.locator('[data-testid="dropzone"][data-hydrated="true"]').first()).toBeVisible({
    timeout: 15_000,
  });
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(files);
}

/**
 * Upload files and wait for the queue to reflect the expected total, so
 * subsequent assertions don't race with React state updates. Works with both
 * card and row variants of FileList.
 */
export async function addFilesAndWait(page: Page, files: string | string[], expectedTotal: number) {
  await uploadFiles(page, files);
  const items = page.locator('[data-testid="file-card"], [data-testid="file-row"]');
  await expect(items).toHaveCount(expectedTotal);
}

/**
 * Upload a single file to a tool that uses FileInfoCard (not FileList), and
 * wait for it to register (the file-info card appears). Many single-file tools
 * also do async work (load page count / thumbnails) before enabling the action
 * button, so callers typically follow this by waiting on the tool-action.
 */
export async function addSingleFileAndWait(page: Page, file: string) {
  await uploadFiles(page, file);
  await expect(page.getByTestId('file-info')).toBeVisible({ timeout: 15_000 });
}

/**
 * Upload an in-memory buffer (e.g. output captured from another tool) as a file,
 * waiting for DropZone hydration first so the change handler is wired up.
 */
export async function uploadBuffer(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer }
) {
  await expect(page.locator('[data-testid="dropzone"][data-hydrated="true"]').first()).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('input[type="file"]').first().setInputFiles(file);
}

/**
 * Drag and drop a file onto `target` the way a desktop does, with the MIME
 * type given — `''` for a file the system has no type for, such as a .heic on
 * Windows. Fails unless the browser really hands the page a file of that type.
 */
export async function dropFile(target: Locator, file: { name: string; mimeType: string; buffer: Buffer }) {
  await expect(target).toHaveAttribute('data-hydrated', 'true', { timeout: 15_000 });
  const dataTransfer = await target.page().evaluateHandle(
    ({ name, type, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type }));
      return dt;
    },
    { name: file.name, type: file.mimeType, base64: file.buffer.toString('base64') },
  );
  expect(await dataTransfer.evaluate((dt) => dt.files[0].type)).toBe(file.mimeType);
  for (const type of ['dragenter', 'dragover', 'drop']) await target.dispatchEvent(type, { dataTransfer });
  await dataTransfer.dispose();
}

/** Click something and capture the resulting download; assert it's non-empty. */
export async function expectDownload(
  page: Page,
  trigger: () => Promise<void>,
  opts: { timeout?: number } = {}
): Promise<{ download: Download; bytes: Buffer; name: string }> {
  const waitPromise = page.waitForEvent('download', { timeout: opts.timeout ?? 45_000 });
  await trigger();
  const download = await waitPromise;
  const stream = await download.path();
  const bytes = await readFile(stream);
  expect(bytes.length, 'downloaded file should be non-empty').toBeGreaterThan(0);
  return { download, bytes, name: download.suggestedFilename() };
}

/**
 * Click something that starts several downloads and capture all of them.
 *
 * Waits for `count` download events, then keeps listening for a further
 * second so an unexpected extra download (a stray ZIP, a duplicate) fails the
 * test instead of slipping past. Returned in arrival order.
 */
export async function expectDownloads(
  page: Page,
  trigger: () => Promise<void>,
  count: number,
  opts: { timeout?: number } = {}
): Promise<{ bytes: Buffer; name: string }[]> {
  const downloads: Download[] = [];
  const onDownload = (d: Download) => { downloads.push(d); };
  page.on('download', onDownload);
  try {
    await trigger();
    await expect
      .poll(() => downloads.length, { timeout: opts.timeout ?? 45_000, message: `expected ${count} downloads` })
      .toBeGreaterThanOrEqual(count);
    await page.waitForTimeout(1_000);
    expect(downloads.map((d) => d.suggestedFilename()), 'exactly the expected number of downloads').toHaveLength(count);
  } finally {
    page.off('download', onDownload);
  }
  const out: { bytes: Buffer; name: string }[] = [];
  for (const download of downloads) {
    const bytes = await readFile(await download.path());
    expect(bytes.length, `${download.suggestedFilename()} should be non-empty`).toBeGreaterThan(0);
    out.push({ bytes, name: download.suggestedFilename() });
  }
  return out;
}

/** The entries of a ZIP archive, in stored order, with their bytes. */
export async function readZipEntries(bytes: Buffer): Promise<{ name: string; bytes: Buffer }[]> {
  const mod = (await import('jszip')) as any;
  const JSZip = mod.default ?? mod;
  const zip = await JSZip.loadAsync(bytes);
  const out: { name: string; bytes: Buffer }[] = [];
  for (const name of Object.keys(zip.files)) {
    out.push({ name, bytes: Buffer.from(await zip.files[name].async('uint8array')) });
  }
  return out;
}

/** Pixel size of a PNG, read from its IHDR chunk. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(12, 16).toString('latin1'), 'IHDR chunk').toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Assert an <img> locator is not just in the DOM but actually decoded and
 * painted (real pixels). Used to prove that page/thumbnail previews are
 * *visibly* rendered, not blank placeholders.
 */
export async function expectImageRendered(
  img: import('@playwright/test').Locator,
  timeout = 20_000
) {
  await expect(img).toBeVisible({ timeout });
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), {
      timeout,
    })
    .toBeGreaterThan(0);
}

/** Assert a Buffer is a real PDF (header %PDF- and EOF marker). */
export function assertPdf(bytes: Buffer) {
  expect(bytes.subarray(0, 5).toString('latin1'), 'PDF header').toBe('%PDF-');
  expect(bytes.subarray(-1024).toString('latin1'), 'PDF should contain EOF marker').toContain('%%EOF');
}

/**
 * Cryptographically verify the first PKCS#7 signature in a signed PDF:
 *   1. the `messageDigest` authenticated attribute equals SHA-256 over the
 *      ByteRange-covered bytes (the signature actually covers the document), and
 *   2. the RSA signature verifies over the DER of the authenticated attributes
 *      (the private key really signed it).
 * Returns both booleans plus the signer's CN. Node-only (uses node-forge).
 */
export async function verifyPdfSignature(
  bytes: Buffer
): Promise<{ contentDigestMatches: boolean; signatureValid: boolean; signerCN: string | null }> {
  const mod = (await import('node-forge')) as any;
  const forge = mod.default ?? mod;

  const str = bytes.toString('latin1');
  const br = str.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
  if (!br) throw new Error('No ByteRange found in signed PDF');
  const [a, b, c, d] = [Number(br[1]), Number(br[2]), Number(br[3]), Number(br[4])];

  const contentsHex = str.slice(b + 1, c - 1).replace(/[^0-9a-fA-F]/g, '');
  const der = contentsHex
    .match(/.{1,2}/g)!
    .map((h: string) => String.fromCharCode(parseInt(h, 16)))
    .join('');

  const signedContent =
    bytes.subarray(a, a + b).toString('latin1') + bytes.subarray(c, c + d).toString('latin1');

  // The /Contents blob is zero-padded to a fixed length, so DER bytes remain
  // after the signature structure — parse non-strict to ignore the padding.
  const p7 = forge.pkcs7.messageFromAsn1(
    forge.asn1.fromDer(der, { strict: false, parseAllBytes: false }),
  );
  const attrs = p7.rawCapture.authenticatedAttributes;

  const findAttr = (oid: string): string | null => {
    for (const at of attrs) {
      const type = forge.asn1.derToOid(at.value[0].value);
      if (type === oid) return at.value[1].value[0].value;
    }
    return null;
  };

  const mdAttr = findAttr(forge.pki.oids.messageDigest);
  const contentMd = forge.md.sha256.create();
  contentMd.update(signedContent);
  const contentDigestMatches = mdAttr === contentMd.digest().bytes();

  const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
  const sigMd = forge.md.sha256.create();
  sigMd.update(forge.asn1.toDer(set).getBytes());
  const cert = p7.certificates[0];
  const signatureValid: boolean = cert.publicKey.verify(sigMd.digest().bytes(), p7.rawCapture.signature);

  return { contentDigestMatches, signatureValid, signerCN: cert.subject.getField('CN')?.value ?? null };
}

/**
 * Extract all selectable text from a PDF with pdf.js (Node legacy build). Used
 * to prove true redaction: the redacted string is gone from the text layer while
 * other text survives — and that a text layer exists at all (not rasterized).
 */
export async function extractPdfText(bytes: Buffer, pageIndex?: number): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const from = pageIndex === undefined ? 1 : pageIndex + 1;
  const to = pageIndex === undefined ? doc.numPages : pageIndex + 1;
  let text = '';
  for (let i = from; i <= to; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n';
  }
  await doc.destroy();
  return text;
}

/**
 * Return the outerHTML (truncated) of every *visible* form control
 * (input/select/textarea, excluding file/hidden) that lacks an accessible name:
 * no `aria-label`/`aria-labelledby`, no matching `<label for>`, and not wrapped
 * in a `<label>`. An empty array means every control is labelled. Mirrors the
 * `inputsMissingLabel` heuristic in the site sweep, but returns identifying
 * markup so failures point at the offending field. Used by the P4.1 label audit
 * to assert zero unlabelled controls once a tool's options are open.
 */
export async function unlabelledFormControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        'input:not([type=hidden]):not([type=file]), select, textarea'
      )
    );
    const visible = (el: Element) => {
      const s = getComputedStyle(el as HTMLElement);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    };
    return controls
      .filter(visible)
      .filter((el) => {
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
        const id = el.getAttribute('id');
        if (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) return false;
        if (el.closest('label')) return false;
        return true;
      })
      .map((el) => el.outerHTML.replace(/\s+/g, ' ').slice(0, 140));
  });
}

/**
 * Return a description of every heading-level *skip* in document order (e.g.
 * `h1 -> h3` with no intervening `h2`). An empty array means the heading outline
 * is well-formed (WCAG 1.3.1 / best-practice heading order). Mirrors the sweep's
 * `headingSkips` logic. Used by the P4.2 heading-hierarchy assertion.
 */
export async function collectHeadingSkips(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6'));
    const skips: string[] = [];
    let prev = 0;
    for (const h of headings) {
      const level = Number(h.tagName[1]);
      if (prev && level > prev + 1) {
        skips.push(`h${prev} -> h${level} ("${(h.textContent ?? '').trim().slice(0, 40)}")`);
      }
      prev = level;
    }
    return skips;
  });
}

/** Assert a Buffer is a real ZIP archive (PK header). */
export function assertZip(bytes: Buffer) {
  expect(bytes.subarray(0, 2).toString('latin1'), 'ZIP header').toBe('PK');
}

/** Assert image magic bytes by format. */
export function assertImage(bytes: Buffer, format: 'jpeg' | 'png' | 'webp' | 'avif') {
  if (format === 'jpeg') {
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  } else if (format === 'png') {
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n');
  } else if (format === 'webp') {
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
  } else if (format === 'avif') {
    // ISO-BMFF: an `ftyp` box whose brand set includes "avif".
    expect(bytes.subarray(4, 8).toString('latin1'), 'ftyp box').toBe('ftyp');
    expect(bytes.subarray(8, 24).toString('latin1'), 'avif brand').toContain('avif');
  }
}

/**
 * Count PDF pages by scanning for /Type /Page objects (cheap, no parser).
 * NOTE: only works when pages are stored as plaintext objects. PDFs saved by
 * pdf-lib with object streams (the default for direct `.save()`) compress these
 * markers — use countPdfPagesStrict for those. Worker-produced output here keeps
 * them in plaintext, so this heuristic is fine for most tools.
 */
export function countPdfPages(bytes: Buffer): number {
  const text = bytes.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

/** Accurate page count via a real parser — handles object-stream PDFs. */
export async function countPdfPagesStrict(bytes: Buffer): Promise<number> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}

/**
 * Return the `/Subtype` of every annotation across all pages (e.g.
 * `['FreeText', 'Square']`), resolved with a real parser so it works even when
 * the PDF uses object streams. An empty array means the document has no
 * annotation objects — used to prove Flatten bakes content into the page while
 * Keep-as-Annotations emits editable `/Annot` objects.
 */
export async function readPdfAnnotationSubtypes(bytes: Buffer): Promise<string[]> {
  const { PDFDocument, PDFName, PDFDict } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const subtypes: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookup(i, PDFDict);
      if (!dict) continue;
      const sub = dict.get(PDFName.of('Subtype'));
      subtypes.push(sub ? sub.toString().replace(/^\//, '') : 'Unknown');
    }
  }
  return subtypes;
}

/**
 * Names of every interactive AcroForm field in a PDF, via a real parser.
 *
 * A plaintext scan for "/AcroForm" is unreliable: pdf-lib writes object streams
 * by default, so the form dictionary is compressed and invisible to a substring
 * match even when the fields are perfectly intact.
 */
export async function pdfFormFieldNames(bytes: Buffer): Promise<string[]> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  try {
    return doc.getForm().getFields().map((f) => f.getName()).sort();
  } catch {
    return []; // no AcroForm at all
  }
}

/**
 * Flatten a PDF's bookmark tree to `{ title, depth, page }`, resolved with a
 * real parser so it works regardless of object streams.
 *
 * `page` is the 0-based index the bookmark jumps to, resolved by matching the
 * /Dest page reference against the document's page refs — which is what makes
 * this useful for merge: a preserved bookmark must point at the page's *new*
 * position, not its original one.
 */
export async function readPdfOutline(
  bytes: Buffer
): Promise<{ title: string; depth: number; page: number | null }[]> {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });

  // `lookup(key, type)` throws when the key is absent, and "no outline at all"
  // is a perfectly normal answer here — check for the entry first.
  if (doc.catalog.get(PDFName.of('Outlines')) === undefined) return [];
  const outlinesDict = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
  if (!outlinesDict) return [];

  const pageRefs = doc.getPages().map((p) => p.ref.toString());
  const out: { title: string; depth: number; page: number | null }[] = [];

  const destPage = (item: import('pdf-lib').PDFDict): number | null => {
    const dest = item.lookup(PDFName.of('Dest'));
    if (!(dest instanceof PDFArray) || dest.size() === 0) return null;
    const target = dest.get(0);
    if (!(target instanceof PDFRef)) return null;
    const idx = pageRefs.indexOf(target.toString());
    return idx === -1 ? null : idx;
  };

  const walk = (firstRef: unknown, depth: number): void => {
    let current = firstRef instanceof PDFRef ? doc.context.lookup(firstRef, PDFDict) : undefined;
    // Guard against a malformed /Next cycle rather than hanging the suite.
    let guard = 0;
    while (current && guard++ < 500) {
      const rawTitle = current.lookup(PDFName.of('Title'));
      const title =
        rawTitle instanceof PDFString || rawTitle instanceof PDFHexString
          ? rawTitle.decodeText()
          : '';
      out.push({ title, depth, page: destPage(current) });

      const first = current.get(PDFName.of('First'));
      if (first) walk(first, depth + 1);

      const next = current.get(PDFName.of('Next'));
      current = next instanceof PDFRef ? doc.context.lookup(next, PDFDict) : undefined;
    }
  };

  walk(outlinesDict.get(PDFName.of('First')), 0);
  return out;
}

/**
 * 0-based page indices targeted by every internal Link annotation in the file.
 * Used to show a merge rewrote link destinations to the merged page numbering
 * instead of leaving them pointing at the wrong page.
 */
export async function readPdfInternalLinkTargets(bytes: Buffer): Promise<number[]> {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pageRefs = doc.getPages().map((p) => p.ref.toString());
  const targets: number[] = [];

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i, PDFDict);
      if (!annot) continue;
      if (annot.get(PDFName.of('Subtype'))?.toString() !== '/Link') continue;

      // A link's target is either a direct /Dest or a /GoTo action's /D. MuPDF
      // normalises to one form and pdf-lib to the other, so accept both.
      let dest = annot.lookup(PDFName.of('Dest'));
      if (!(dest instanceof PDFArray)) {
        const action = annot.lookup(PDFName.of('A'), PDFDict);
        dest = action?.lookup(PDFName.of('D'));
      }
      if (!(dest instanceof PDFArray) || dest.size() === 0) continue;

      const target = dest.get(0);
      if (!(target instanceof PDFRef)) continue;
      const idx = pageRefs.indexOf(target.toString());
      if (idx !== -1) targets.push(idx);
    }
  }
  return targets;
}

/**
 * The identifying metadata a PDF carries, across all the places it hides.
 *
 * "Full metadata strip" has to clear more than the Info dictionary: the XMP
 * packet holds a second copy of title/author, and an embedded attachment can
 * carry anything. Reporting all three lets a test show each one is gone.
 */
export async function readPdfMetadataArtifacts(bytes: Buffer): Promise<{
  title: string;
  author: string;
  hasXmp: boolean;
  attachments: string[];
}> {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });

  const names = doc.catalog.lookup(PDFName.of('Names'), PDFDict);
  const embedded = names?.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
  const namesArray = embedded?.lookup(PDFName.of('Names'), PDFArray);
  const attachments: string[] = [];
  if (namesArray) {
    // The name tree alternates [name, fileSpec, name, fileSpec, …]. Names are
    // written as hex strings by pdf-lib, so decode rather than stringify.
    for (let i = 0; i < namesArray.size(); i += 2) {
      const entry = namesArray.get(i);
      if (entry instanceof PDFString || entry instanceof PDFHexString) {
        attachments.push(entry.decodeText());
      }
    }
  }

  return {
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    hasXmp: doc.catalog.get(PDFName.of('Metadata')) !== undefined,
    attachments,
  };
}

/**
 * Each page's CropBox as [width, height] in points.
 *
 * Cropping in CropBox mode changes only this box, leaving the MediaBox and the
 * content untouched — so comparing boxes per page is how "applied to the current
 * page only" is distinguished from "applied to all pages".
 */
export async function readPdfCropBoxes(bytes: Buffer): Promise<[number, number][]> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPages().map((p) => {
    const box = p.getCropBox();
    return [Math.round(box.width), Math.round(box.height)] as [number, number];
  });
}

/**
 * The decoded text of each content stream on a page, in paint order.
 *
 * A page's /Contents is an array of streams painted in array order, which makes
 * this the place to ask structural questions the rendered pixels cannot answer:
 * which stream paints first, or where exactly an image was positioned.
 */
export async function readPdfContentStreams(bytes: Buffer, pageIndex = 0): Promise<string[]> {
  const { PDFDocument, PDFArray, PDFStream, PDFRef } = await import('pdf-lib');
  const { inflateSync } = await import('node:zlib');

  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const contents = doc.getPages()[pageIndex].node.Contents();
  const entries = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];

  return entries.map((entry) => {
    const stream = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (!(stream instanceof PDFStream)) return '';
    const raw = Buffer.from(stream.getContents());
    // Streams are usually Flate-compressed but need not be — inflate when that
    // works and take the bytes as they are when it does not.
    try { return inflateSync(raw).toString('latin1'); } catch { return raw.toString('latin1'); }
  });
}

/**
 * Where a page's drawn text sits in the z-order.
 *
 * "Behind the content" means the watermark's stream comes first and "on top"
 * means it comes last. Returns the index of the first stream containing `needle`
 * and how many streams the page has, which is what distinguishes the two layer
 * modes — the pixels alone can't, since both look identical on a page with no
 * background.
 */
export async function findPdfContentStreamIndex(
  bytes: Buffer,
  needle: string,
  pageIndex = 0,
): Promise<{ index: number; total: number }> {
  const streams = await readPdfContentStreams(bytes, pageIndex);

  // pdf-lib writes show-text operands as PDF hex strings, not literals, so
  // "CONFIDENTIAL" appears as <434F4E...>. Look for either form.
  const hex = Buffer.from(needle, 'latin1').toString('hex').toLowerCase();
  const index = streams.findIndex(
    (text) => text.includes(needle) || text.toLowerCase().includes(hex),
  );

  return { index, total: streams.length };
}
