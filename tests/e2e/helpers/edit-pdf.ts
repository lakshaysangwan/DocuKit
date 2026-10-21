import { type Page, type Locator, expect } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { uploadFiles, expectDownload, assertPdf, readPdfContentStreams } from './harness';
import type { ViewRect } from './sign';

/**
 * Helpers for the Edit PDF workspace, and — the part that matters — reading
 * back from the DOWNLOADED file where each added object was drawn, as a box of
 * the displayed page, with pdf.js's own viewport as the oracle.
 *
 * The tool draws every object in its own frame: `q a b c d e f cm` then
 * `0 0 W H re W n` (a clip to the object's box), then the object. The frame's
 * four corners, mapped through pdf.js, are the box the object occupies on the
 * displayed page — independent of the app's own geometry code.
 */

export type EditKind =
  | 'text'
  | 'image'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'draw'
  | 'highlight'
  | 'whiteout'
  | 'stamp';

/** Open Edit PDF with a document and wait for its first page to be drawn. */
export async function openEdit(page: Page, pdf: string) {
  await page.goto('/edit-pdf');
  await uploadFiles(page, pdf);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('add-text')).toBeEnabled();
}

/** The selected object on the page. */
export const selectedObject = (page: Page) => page.locator('[data-testid="overlay-item"][data-selected="true"]');

/**
 * Add an object from the palette. It appears selected. A freehand drawing is
 * drawn with the mouse across the middle of the page; an image needs `image`.
 */
export async function addObject(page: Page, kind: EditKind, image?: string) {
  const before = await page.getByTestId('overlay-item').count();
  if (kind === 'image') {
    await page.getByTestId('add-image-input').setInputFiles(image!);
  } else if (kind === 'draw') {
    await page.getByTestId('add-draw').click();
    const surface = page.getByTestId('draw-surface');
    await expect(surface).toBeVisible();
    const box = (await surface.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.waitForTimeout(20);
      await page.mouse.move(box.x + box.width * (0.3 + i * 0.02), box.y + box.height * (0.3 + Math.sin(i / 2) * 0.03));
    }
    await page.mouse.up();
    await page.getByTestId('draw-done').click();
  } else {
    await page.getByTestId(`add-${kind}`).click();
  }
  await expect(page.getByTestId('overlay-item')).toHaveCount(before + 1);
  const item = selectedObject(page);
  await expect(item).toHaveAttribute('data-kind', kind);
  return item;
}

/** Where an object is on screen: its box as fractions of the page it sits on. */
export async function objectViewRect(item: Locator): Promise<ViewRect> {
  await expect(item).toBeVisible();
  return item.evaluate((el) => {
    const canvas = el.closest('[data-testid="page-canvas"]')!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      x: (box.left - canvas.left) / canvas.width,
      y: (box.top - canvas.top) / canvas.height,
      width: box.width / canvas.width,
      height: box.height / canvas.height,
    };
  });
}

/** Pull the selected object's bottom-right corner by `dx`, `dy` CSS pixels with the mouse. */
export async function dragCorner(page: Page, dx: number, dy: number, corner = 'bottom-right') {
  const handle = selectedObject(page).getByTestId(`overlay-handle-${corner}`);
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
}

/** Drag the selected object by its middle. */
export async function dragObject(page: Page, dx: number, dy: number) {
  const box = (await selectedObject(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
}

/** Type into one of the millimetre fields of the selected object. */
export async function setField(page: Page, testId: string, value: number) {
  const field = page.getByTestId(testId);
  await field.fill(String(value));
  await field.blur();
}

/** Press Save PDF, wait for the download to replace it, and fetch the file. */
export async function saveAndDownload(page: Page): Promise<Buffer> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
  const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
  assertPdf(bytes);
  expect(name).toMatch(/-edited\.pdf$/);
  return bytes;
}

type Point = [number, number];

/** Map PDF user-space points to fractions of the displayed page with pdf.js. */
export async function userToView(bytes: Buffer, pageIndex: number, points: Point[]): Promise<Point[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise;
  try {
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    return points.map(([x, y]) => {
      const [vx, vy] = viewport.convertToViewportPoint(x, y);
      return [vx / viewport.width, vy / viewport.height];
    });
  } finally {
    await doc.destroy();
  }
}

const NUM = '(-?\\d*\\.?\\d+(?:e-?\\d+)?)';

/** An object the tool drew into a page, as the reader sees it. */
export interface DrawnObject {
  /** The object's box on the displayed page. */
  rect: ViewRect;
  /** The ops inside the frame, to tell what kind of object it is. */
  body: string;
  /** `Tf` size inside the frame, for text and stamps. */
  fontSize: number | null;
  /** Size of one frame unit on the displayed page, in points (1 unless UserUnit). */
  scale: number;
}

/** Every object frame in a page's content, in drawing order. */
export async function readDrawnObjects(bytes: Buffer, pageIndex = 0): Promise<DrawnObject[]> {
  const content = (await readPdfContentStreams(bytes, pageIndex)).join('\n');
  const frame = new RegExp(`q\\s+${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} cm\\s+0 0 ${NUM} ${NUM} re W n`, 'g');
  const matches = [...content.matchAll(frame)];
  const out: DrawnObject[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const [a, b, c, d, e, f, w, h] = m.slice(1, 9).map(Number);
    const at = (u: number, v: number): Point => [a * u + c * v + e, b * u + d * v + f];
    const corners = await userToView(bytes, pageIndex, [at(0, 0), at(w, 0), at(0, h), at(w, h)]);
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const body = content.slice(m.index! + m[0].length, end);
    const tf = body.match(new RegExp(`/\\S+ ${NUM} Tf`));
    out.push({
      rect: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
      body,
      fontSize: tf ? Number(tf[1]) : null,
      scale: Math.hypot(a, b),
    });
  }
  return out;
}

/** The fill opacity (`/ca`) of a named ExtGState in a page's resources. */
export async function readExtGStateAlpha(bytes: Buffer, name: string, pageIndex = 0): Promise<number | null> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const resources = doc.getPages()[pageIndex].node.Resources();
  const states = resources?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  const state = states?.lookupMaybe(PDFName.of(name), PDFDict);
  const ca = state?.lookupMaybe(PDFName.of('ca'), PDFNumber);
  return ca ? ca.asNumber() : null;
}

/** Every annotation on a page: its subtype and the box its /Rect covers on the displayed page. */
export async function readAnnotations(bytes: Buffer, pageIndex = 0): Promise<{ subtype: string; rect: ViewRect }[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const annots = doc.getPages()[pageIndex].node.Annots();
  if (!annots) return [];
  const out: { subtype: string; rect: ViewRect }[] = [];
  for (const ref of annots.asArray()) {
    const dict = doc.context.lookup(ref, PDFDict);
    const subtype = dict.lookup(PDFName.of('Subtype'), PDFName).asString().slice(1);
    const [x1, y1, x2, y2] = dict
      .lookup(PDFName.of('Rect'), PDFArray)
      .asArray()
      .map((v) => (v as PDFNumber).asNumber());
    const [p, q] = await userToView(bytes, pageIndex, [
      [x1, y1],
      [x2, y2],
    ]);
    out.push({
      subtype,
      rect: { x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), width: Math.abs(q[0] - p[0]), height: Math.abs(q[1] - p[1]) },
    });
  }
  return out;
}
