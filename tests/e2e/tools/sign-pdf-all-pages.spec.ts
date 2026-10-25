import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { MIXED_PAGES } from '../fixtures/sign-fixtures';
import { countPdfPagesStrict } from '../helpers/harness';
import {
  addUploadedSignature,
  expectSameRect,
  expectUpright,
  openSign,
  readDrawnImages,
  setStampMm,
  signAndDownload,
  stampViewRect,
  type ViewRect,
} from '../helpers/sign';

/**
 * Sign PDF: one signature on every page, or on the pages chosen, in the same
 * place on each — and linked, so changing one changes them all.
 *
 * The fixture's four pages are all different: Letter portrait, landscape, a
 * Letter page shown turned by /Rotate 90, and an A5 page with an offset
 * CropBox. "The same place" is the same size and the same distance from the
 * left and bottom edges of each page, as a "sign here" line at the foot of
 * every page. Every test reads the downloaded file: the image on each page is
 * read from the content stream and mapped to the displayed page by pdf.js, and
 * must match the box that was on screen to within 0.4% of the page.
 */

const MM_PER_PT = 25.4 / 72;
const TOLERANCE = 0.004;
const PAGES = MIXED_PAGES;
const ALL = [0, 1, 2, 3];

type Size = { widthPt: number; heightPt: number };

/** The box a 3:1 marker `widthMm` wide gets `leftMm` from the left and `bottomMm` from the bottom of `size`. */
function boxAt(leftMm: number, bottomMm: number, widthMm: number, size: Size): ViewRect {
  const widthPt = widthMm / MM_PER_PT;
  const heightPt = widthPt / 3;
  return {
    x: leftMm / MM_PER_PT / size.widthPt,
    y: 1 - (bottomMm / MM_PER_PT + heightPt) / size.heightPt,
    width: widthPt / size.widthPt,
    height: heightPt / size.heightPt,
  };
}

/** The same physical box (size, distance from left and bottom) on another page. */
function samePlace(rect: ViewRect, from: Size, to: Size): ViewRect {
  const widthPt = rect.width * from.widthPt;
  const heightPt = rect.height * from.heightPt;
  const bottomPt = (1 - rect.y - rect.height) * from.heightPt;
  return {
    x: (rect.x * from.widthPt) / to.widthPt,
    y: 1 - (bottomPt + heightPt) / to.heightPt,
    width: widthPt / to.widthPt,
    height: heightPt / to.heightPt,
  };
}

// 40 mm wide, 20 mm from the left and bottom edges: fits on every page as it is.
const LEFT = 20;
const BOTTOM = 20;
const WIDTH = 40;
const TOP_ON_PAGE_1 = PAGES[0].heightPt * MM_PER_PT - BOTTOM - WIDTH / 3;
const START = PAGES.map((size) => boxAt(LEFT, BOTTOM, WIDTH, size));

async function goTo(page: Page, n: number) {
  await page.getByTestId(`rail-page-${n}`).click();
  await expect(page.getByTestId('page-indicator')).toHaveText(`Page ${n} of 4`);
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
}

/** The stamp on the page shown, read from the screen. */
async function shownRect(page: Page): Promise<ViewRect> {
  await expect(page.getByTestId('overlay-item')).toHaveCount(1);
  return stampViewRect(page, page.getByTestId('overlay-item'));
}

/** A signature 40 mm wide, 20 mm from the left and bottom of page 1, selected. */
async function start(page: Page) {
  await openSign(page, FIXTURE.pdfMixedPages);
  await addUploadedSignature(page, FIXTURE.signMarker);
  await setStampMm(page, { x: LEFT, y: TOP_ON_PAGE_1, width: WIDTH });
  expectSameRect(await stampViewRect(page), START[0], 0.002, 'page 1 on screen');
}

/** Every page in `want` has exactly one image, in its box, upright; every other page has none. */
async function expectFile(bytes: Buffer, want: Map<number, ViewRect>) {
  expect(await countPdfPagesStrict(bytes)).toBe(4);
  for (const i of ALL) {
    const images = await readDrawnImages(bytes, i);
    const rect = want.get(i);
    if (!rect) {
      expect(images.length, `page ${i + 1} has no stamp`).toBe(0);
      continue;
    }
    expect(images.length, `page ${i + 1} has the stamp`).toBe(1);
    expectSameRect(images[0].rect, rect, TOLERANCE, `page ${i + 1} in the file`);
    expectUpright(images[0], rect, TOLERANCE);
  }
}

test.describe('Sign PDF — on every page, or the pages you choose', () => {
  test('All pages: the same place on every page, on screen and in the file', async ({ page }) => {
    await start(page);
    await expect(page.getByTestId('stamp-pages-summary')).toHaveText('Signature on 1 of 4 pages.');
    await expect(page.getByTestId('scope-this')).toBeChecked();

    await page.getByTestId('scope-all').check();
    await expect(page.getByTestId('placed-count')).toHaveText('4 stamps placed');
    await expect(page.getByTestId('stamp-pages-summary')).toContainText('Signature on 4 of 4 pages, in the same place on each');
    await expect(page.getByTestId('stamp-announce')).toHaveText('Signature on all 4 pages, in the same place on each.');
    for (const n of [1, 2, 3, 4]) await expect(page.getByTestId(`rail-badge-${n}`)).toBeVisible();

    // On screen each copy is where it should be on its own page…
    const shown = new Map<number, ViewRect>();
    for (const i of ALL) {
      await goTo(page, i + 1);
      const rect = await shownRect(page);
      expectSameRect(rect, START[i], 0.002, `page ${i + 1} on screen`);
      shown.set(i, rect);
    }
    // …and the file has it exactly there.
    await expectFile(await signAndDownload(page), shown);
  });

  test('Choose pages "1,3": only those pages carry it; the field and the ticks agree', async ({ page }) => {
    await start(page);
    await page.getByTestId('scope-choose').check();
    await page.getByTestId('scope-pages').fill('1,3');
    await page.getByTestId('scope-pages').press('Enter');
    await expect(page.getByTestId('placed-count')).toHaveText('2 stamps placed');
    await expect(page.getByTestId('scope-pages')).toHaveValue('1, 3');
    for (const [n, on] of [[1, true], [2, false], [3, true], [4, false]] as const) {
      if (on) await expect(page.getByTestId(`scope-page-${n}`)).toBeChecked();
      else await expect(page.getByTestId(`scope-page-${n}`)).not.toBeChecked();
    }
    await expect(page.getByTestId('rail-badge-2')).toHaveCount(0);
    await expect(page.getByTestId('rail-badge-3')).toBeVisible();
    await expect(page.getByTestId('stamp-pages-summary')).toContainText('Signature on 2 of 4 pages');

    // A tick changes the field, and back.
    await page.getByTestId('scope-page-4').check();
    await expect(page.getByTestId('scope-pages')).toHaveValue('1, 3-4');
    await expect(page.getByTestId('placed-count')).toHaveText('3 stamps placed');
    await page.getByTestId('scope-page-4').uncheck();
    await expect(page.getByTestId('scope-pages')).toHaveValue('1, 3');

    // Nothing that matches no page is applied.
    await page.getByTestId('scope-pages').fill('9');
    await page.getByTestId('scope-pages').press('Enter');
    await expect(page.getByTestId('scope-pages-error')).toBeVisible();
    await expect(page.getByTestId('placed-count')).toHaveText('2 stamps placed');
    await page.getByTestId('scope-pages').press('Escape');

    await goTo(page, 3);
    const onThree = await shownRect(page);
    expectSameRect(onThree, START[2], 0.002, 'page 3 on screen');
    await expectFile(await signAndDownload(page), new Map([[0, START[0]], [2, onThree]]));
  });

  test('moving it on page 3 moves the copy on every other page', async ({ page }) => {
    await start(page);
    await page.getByTestId('scope-all').check();
    await expect(page.getByTestId('placed-count')).toHaveText('4 stamps placed');

    await goTo(page, 3);
    const stamp = page.getByTestId('overlay-item');
    await stamp.click();
    await expect(page.getByTestId('step-prompt')).toContainText('the copies on the other 3 pages follow');
    const box = (await stamp.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 - 80, { steps: 10 });
    await page.mouse.up();
    const moved = await shownRect(page);
    expect(moved.x - START[2].x, 'it moved right').toBeGreaterThan(0.05);
    await expect(page.getByTestId('stamp-announce')).toHaveText('Signature moved on all 4 pages it is on.');

    const want = new Map<number, ViewRect>();
    for (const i of ALL) {
      const expected = samePlace(moved, PAGES[2], PAGES[i]);
      await goTo(page, i + 1);
      expectSameRect(await shownRect(page), expected, 0.002, `page ${i + 1} followed`);
      want.set(i, expected);
    }
    await expectFile(await signAndDownload(page), want);
  });

  test('Unlink page 2, then move it: only page 2 differs', async ({ page }) => {
    await start(page);
    await page.getByTestId('scope-all').check();
    await expect(page.getByTestId('placed-count')).toHaveText('4 stamps placed');

    await goTo(page, 2);
    await page.getByTestId('overlay-item').click();
    await page.getByTestId('stamp-unlink').click();
    await expect(page.getByTestId('stamp-pages-summary')).toHaveText('Signature on 1 of 4 pages.');
    await expect(page.getByTestId('stamp-announce')).toContainText('page 2 is now separate');
    await setStampMm(page, { x: 120 });
    const onTwo = await shownRect(page);
    expect(onTwo.x).toBeCloseTo(120 / MM_PER_PT / PAGES[1].widthPt, 3);

    // The others stayed put.
    for (const i of [0, 2, 3]) {
      await goTo(page, i + 1);
      expectSameRect(await shownRect(page), START[i], 0.002, `page ${i + 1} unchanged`);
    }
    await expectFile(await signAndDownload(page), new Map([[0, START[0]], [1, onTwo], [2, START[2]], [3, START[3]]]));
  });

  test('Undo takes a change to every copy back in one step; Remove asks which pages', async ({ page }) => {
    await start(page);
    await page.getByTestId('scope-all').check();
    await expect(page.getByTestId('placed-count')).toHaveText('4 stamps placed');

    await setStampMm(page, { x: 60 });
    await goTo(page, 4);
    const movedOnFour = await shownRect(page);
    expect(movedOnFour.x).toBeCloseTo(60 / MM_PER_PT / PAGES[3].widthPt, 3);

    // One undo restores every page.
    await page.getByTestId('undo').click();
    expectSameRect(await shownRect(page), START[3], 0.002, 'page 4 after undo');
    await goTo(page, 2);
    expectSameRect(await shownRect(page), START[1], 0.002, 'page 2 after undo');

    // Remove on a linked copy asks: this page, or all of them.
    await page.getByTestId('overlay-item').click();
    await page.getByTestId('overlay-remove').click();
    await expect(page.getByTestId('remove-ask')).toBeVisible();
    await expect(page.getByTestId('remove-all-pages')).toHaveText('All 4 pages');
    await page.getByTestId('remove-this-page').click();
    await expect(page.getByTestId('placed-count')).toHaveText('3 stamps placed');
    await expect(page.getByTestId('rail-badge-2')).toHaveCount(0);
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('placed-count')).toHaveText('4 stamps placed');

    // "This page only" takes the copies off the other pages; undo puts them back.
    await page.getByTestId('overlay-item').click();
    await page.getByTestId('scope-this').check();
    await expect(page.getByTestId('placed-count')).toHaveText('1 stamp placed');
    await expect(page.getByTestId('rail-badge-1')).toHaveCount(0);
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('placed-count')).toHaveText('4 stamps placed');

    await page.getByTestId('overlay-item').click();
    await page.getByTestId('overlay-remove').click();
    await page.getByTestId('remove-all-pages').click();
    await expect(page.getByTestId('placed-count')).toHaveCount(0);
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('placed-count')).toHaveText('4 stamps placed');

    await expectFile(await signAndDownload(page), new Map(ALL.map((i) => [i, START[i]])));
  });

  test('the keyboard alone can put it on every page, move every copy and remove one', async ({ page }) => {
    await start(page);
    // The radios are one group: an arrow key picks the next choice.
    await page.getByTestId('scope-this').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('scope-all')).toBeChecked();
    await expect(page.getByTestId('placed-count')).toHaveText('4 stamps placed');

    const stamp = page.getByTestId('overlay-item');
    await stamp.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('stamp-announce')).toContainText('The same on all 4 pages it is on.');
    const moved = await shownRect(page);
    expect(moved.x - START[0].x).toBeCloseTo(5 / 200, 3);

    // Delete on a linked copy asks, with the keyboard on the first answer.
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('remove-this-page')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('placed-count')).toHaveText('3 stamps placed');
    await expect(stamp).toHaveCount(0);

    const want = new Map<number, ViewRect>();
    for (const i of [1, 2, 3]) want.set(i, samePlace(moved, PAGES[0], PAGES[i]));
    await expectFile(await signAndDownload(page), want);
  });
});
