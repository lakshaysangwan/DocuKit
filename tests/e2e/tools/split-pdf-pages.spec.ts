import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { expectDownload, expectDownloads, assertPdf, countPdfPagesStrict, extractPdfText } from '../helpers/harness';
import { openSplit, chooseSplitMode, gridMarks, outputList, pagesByMark, openOptions } from '../helpers/split-pdf';

/**
 * Split PDF in the workspace: every page is on screen, marked with what will
 * become of it in the chosen mode, and a list says which files will be made.
 *
 * Each test holds the grid and the list to the files actually downloaded:
 * their number, their names, and — read back from each file's text — exactly
 * which pages are in them. The fixture's pages say "Page N of 5".
 */

const field = (page: Page) => page.locator('#split-range');

/** The original page numbers inside a downloaded PDF, read from its text. */
async function pagesIn(bytes: Buffer): Promise<number[]> {
  const count = await countPdfPagesStrict(bytes);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const m = /Page (\d+) of 5/.exec(await extractPdfText(bytes, i));
    out.push(m ? Number(m[1]) : -1);
  }
  return out;
}

async function run(page: Page) {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
}

/** Download every output with the action-bar button and check them against the grid. */
async function downloadAllAndMatch(page: Page, expected: { name: string; pages: number[] }[]) {
  const files =
    expected.length === 1
      ? [await expectDownload(page, () => page.getByTestId('download-button').click())]
      : await expectDownloads(page, () => page.getByTestId('download-button').click(), expected.length);
  const byName = new Map(files.map((f) => [f.name, f.bytes]));
  expect([...byName.keys()].sort()).toEqual(expected.map((e) => e.name).sort());
  for (const e of expected) {
    const bytes = byName.get(e.name)!;
    assertPdf(bytes);
    expect(await pagesIn(bytes), e.name).toEqual(e.pages);
  }
}

test.describe('Split PDF — the pages and the outcome, per mode', () => {
  test('Extract: clicked pages are highlighted, the rest dimmed, and exactly those pages are delivered', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf5page, 5);
    // Nothing chosen yet: the action says why it waits.
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('Choose at least one page to extract');

    await page.getByTestId('page-select-1').click();
    await page.getByTestId('page-select-3').click();
    await expect(field(page)).toHaveValue('2, 4');
    await expect(page.getByTestId('page-select-1')).toHaveAttribute('aria-pressed', 'true');
    expect(await gridMarks(page)).toEqual(['Not included', 'Selected', 'Not included', 'Selected', 'Not included']);
    await expect(page.getByTestId('step-prompt')).toContainText("You'll get 1 PDF with 2 pages");
    expect(await outputList(page)).toEqual([{ name: 'doc-5page-split.pdf', pages: 'Pages 2, 4 · 2 pages' }]);
    await expect(page.getByTestId('tool-action')).toHaveText('Extract 2 pages');

    // Clicking a chosen page again takes it out.
    await page.getByTestId('page-select-3').click();
    await expect(field(page)).toHaveValue('2');
    await page.getByTestId('page-select-2').click();
    await expect(field(page)).toHaveValue('2-3');

    await run(page);
    // One file: the button downloads it directly.
    await expect(page.getByTestId('download-button')).toHaveText('Download PDF');
    await expect(page.getByTestId('result-download')).toHaveCount(0);
    await downloadAllAndMatch(page, [{ name: 'doc-5page-split.pdf', pages: [2, 3] }]);
  });

  test('Remove: chosen pages are marked Removed and the download keeps the others', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf5page, 5);
    await chooseSplitMode(page, 'Remove Pages');
    await field(page).fill('1, last');
    expect(await gridMarks(page)).toEqual(['Removed', 'Kept', 'Kept', 'Kept', 'Removed']);
    await expect(page.locator('[data-testid="split-page"][data-mark-state="removed"]')).toHaveCount(2);
    expect(await outputList(page)).toEqual([{ name: 'doc-5page-split.pdf', pages: 'Pages 2–4 · 3 pages' }]);
    await expect(page.getByTestId('tool-action')).toHaveText('Remove 2 pages');

    await run(page);
    await downloadAllAndMatch(page, [{ name: 'doc-5page-split.pdf', pages: [2, 3, 4] }]);
  });

  test('Remove: marking every page is refused with a reason', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf3page, 3);
    await chooseSplitMode(page, 'Remove Pages');
    await field(page).fill('all');
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('That removes every page. Leave at least one');
    await expect(page.getByTestId('split-output')).toHaveCount(0);
  });

  test('Split by Range: each range is labelled "PDF n", pages in none are "Not included", and the files match', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf5page, 5);
    await chooseSplitMode(page, 'Split by Range');
    await field(page).fill('1-2, 3, 5');

    const marks = await gridMarks(page);
    expect(marks).toEqual(['PDF 1', 'PDF 1', 'PDF 2', 'Not included', 'PDF 3']);
    // Colour and label together: each group's cards share a top edge colour.
    const colours = await page
      .getByTestId('split-page')
      .evaluateAll((cards) => cards.map((c) => getComputedStyle(c).borderTopColor));
    expect(colours[0]).toBe(colours[1]);
    expect(colours[0]).not.toBe(colours[2]);
    await expect(page.getByTestId('split-page').nth(3)).toHaveAttribute('data-mark-state', 'dimmed');

    expect(await outputList(page)).toEqual([
      { name: 'doc-5page-part1.pdf', pages: 'Pages 1–2 · 2 pages' },
      { name: 'doc-5page-part2.pdf', pages: 'Page 3 · 1 page' },
      { name: 'doc-5page-part3.pdf', pages: 'Page 5 · 1 page' },
    ]);
    await expect(page.getByTestId('tool-action')).toHaveText('Split into 3 PDFs');

    // Here a click is not a selection: it shows the page larger, and the field is untouched.
    await expect(page.getByTestId('page-select-0')).toHaveCount(0);
    await expect(page.getByTestId('page-grid-caption')).toContainText('Clicking a page shows it larger');
    await page.getByTestId('split-page').nth(3).getByTestId('page-thumb').click();
    await expect(page.getByTestId('page-preview-dialog')).toBeVisible();
    await expect(page.getByTestId('page-preview-title')).toContainText('Page 4 of 5');
    await page.getByTestId('page-preview-close').click();
    await expect(field(page)).toHaveValue('1-2, 3, 5');

    await run(page);
    const groups = pagesByMark(marks);
    await downloadAllAndMatch(
      page,
      [1, 2, 3].map((k) => ({ name: `doc-5page-part${k}.pdf`, pages: groups.get(k)! })),
    );
  });

  test('Split Every N: groups alternate with a divider, and a short last group is its own file', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf5page, 5);
    await chooseSplitMode(page, 'Split Every N');
    await page.getByLabel('Pages per PDF').fill('2');

    expect(await gridMarks(page)).toEqual(['PDF 1', 'PDF 1', 'PDF 2', 'PDF 2', 'PDF 3']);
    const dividers = page.getByTestId('page-grid-divider');
    await expect(dividers).toHaveCount(3);
    await expect(dividers.nth(2)).toContainText('PDF 3 · pages 5');
    expect(await outputList(page)).toEqual([
      { name: 'doc-5page-part1.pdf', pages: 'Pages 1–2 · 2 pages' },
      { name: 'doc-5page-part2.pdf', pages: 'Pages 3–4 · 2 pages' },
      { name: 'doc-5page-part3.pdf', pages: 'Page 5 · 1 page' },
    ]);
    await expect(page.getByTestId('step-prompt')).toContainText('the last has 1 page');

    await run(page);
    await downloadAllAndMatch(page, [
      { name: 'doc-5page-part1.pdf', pages: [1, 2] },
      { name: 'doc-5page-part2.pdf', pages: [3, 4] },
      { name: 'doc-5page-part3.pdf', pages: [5] },
    ]);
  });

  test('Split Every N: a number that is not one is flagged and changes nothing', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf5page, 5);
    await chooseSplitMode(page, 'Split Every N');
    await page.getByLabel('Pages per PDF').fill('3');
    expect(await gridMarks(page)).toEqual(['PDF 1', 'PDF 1', 'PDF 1', 'PDF 2', 'PDF 2']);
    await page.getByLabel('Pages per PDF').fill('0');
    await expect(page.getByTestId('split-n-error')).toBeVisible();
    await expect(page.getByLabel('Pages per PDF')).toHaveAttribute('aria-invalid', 'true');
    expect(await gridMarks(page)).toEqual(['PDF 1', 'PDF 1', 'PDF 1', 'PDF 2', 'PDF 2']);
    await expect(page.getByTestId('tool-action')).toBeDisabled();
  });

  test('Extract Each Page: every page is labelled with its own PDF, and each file holds that page', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf5page, 5);
    await chooseSplitMode(page, 'Extract Each Page');
    expect(await gridMarks(page)).toEqual(['PDF 1', 'PDF 2', 'PDF 3', 'PDF 4', 'PDF 5']);
    await expect(page.getByTestId('split-output')).toHaveCount(5);
    await run(page);
    await downloadAllAndMatch(
      page,
      [1, 2, 3, 4, 5].map((k) => ({ name: `doc-5page-part${k}.pdf`, pages: [k] })),
    );
  });
});

test.describe('Split PDF — the page field stays the source of truth', () => {
  test('odd, even and last select the right pages, and survive until a page is clicked', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf5page, 5);
    const pressed = () =>
      page.locator('[data-testid^="page-select-"][aria-pressed="true"]').evaluateAll((els) =>
        els.map((e) => Number(e.getAttribute('data-testid')!.replace('page-select-', '')) + 1),
      );

    await field(page).fill('odd');
    expect(await pressed()).toEqual([1, 3, 5]);
    await field(page).fill('even');
    expect(await pressed()).toEqual([2, 4]);
    await field(page).fill('last');
    expect(await pressed()).toEqual([5]);
    // The keyword is kept as typed…
    await expect(field(page)).toHaveValue('last');
    // …until a click rewrites the field as page numbers.
    await page.getByTestId('page-select-0').click();
    await expect(field(page)).toHaveValue('1, 5');

    await field(page).fill('odd');
    await run(page);
    await downloadAllAndMatch(page, [{ name: 'doc-5page-split.pdf', pages: [1, 3, 5] }]);
  });

  test('a field that cannot be read is flagged, announced and changes nothing', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf5page, 5);
    await field(page).fill('1-2');
    const before = await gridMarks(page);
    const listBefore = await outputList(page);

    for (const bad of ['1-9', '4-2', 'abc']) {
      await field(page).fill(bad);
      await expect(field(page)).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByTestId('split-range-error')).toBeVisible();
      await expect(page.getByTestId('split-range-error')).toContainText('The pages shown have not changed');
      // Announced in the prompt, which is a status region.
      await expect(page.getByTestId('step-prompt')).toContainText('The page field cannot be read');
      await expect(page.getByTestId('step-prompt')).toHaveAttribute('role', 'status');
      expect(await gridMarks(page)).toEqual(before);
      expect(await outputList(page)).toEqual(listBefore);
      await expect(page.getByTestId('tool-action')).toBeDisabled();
      await expect(page.getByTestId('action-hint')).toContainText('Fix the page field');
    }

    // Fixing it clears the flag.
    await field(page).fill('1-3');
    await expect(field(page)).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('split-range-error')).toHaveCount(0);
    expect(await outputList(page)).toEqual([{ name: 'doc-5page-split.pdf', pages: 'Pages 1–3 · 3 pages' }]);
  });
});

test.describe('Split PDF — handing over the files', () => {
  test('several files: per-file Download buttons and Download all, no forced ZIP', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf5page, 5);
    await chooseSplitMode(page, 'Split by Range');
    await field(page).fill('1-2, 3-4, 5');
    await run(page);

    await expect(page.getByTestId('download-button')).toHaveText('Download all (3 PDFs)');
    await expect(page.getByTestId('result-summary')).toContainText('3 PDFs');
    // Every file has its own Download, and the ZIP is only an option.
    await expect(page.getByTestId('result-card')).toHaveCount(3);
    await expect(page.getByTestId('result-name')).toHaveText(['doc-5page-part1.pdf', 'doc-5page-part2.pdf', 'doc-5page-part3.pdf']);
    await expect(page.getByTestId('download-zip')).toBeVisible();
    // Only one filled button: the result panel does not repeat the primary download.
    await expect(page.getByTestId('download-button')).toHaveCount(1);

    const one = await expectDownload(page, () => page.getByTestId('result-download').nth(1).click());
    expect(one.name).toBe('doc-5page-part2.pdf');
    expect(await pagesIn(one.bytes)).toEqual([3, 4]);
  });

  test('the output list names exactly the files that download', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf5page, 5);
    await chooseSplitMode(page, 'Split by Range');
    await field(page).fill('4-5, 1');
    const listed = await outputList(page);
    expect(listed).toEqual([
      { name: 'doc-5page-part1.pdf', pages: 'Pages 4–5 · 2 pages' },
      { name: 'doc-5page-part2.pdf', pages: 'Page 1 · 1 page' },
    ]);
    await run(page);
    await downloadAllAndMatch(page, [
      { name: 'doc-5page-part1.pdf', pages: [4, 5] },
      { name: 'doc-5page-part2.pdf', pages: [1] },
    ]);
  });

  test('any change after a split invalidates the result', async ({ page }) => {
    await openSplit(page, FIXTURE.pdf5page, 5);
    await page.getByTestId('page-select-0').click();
    await run(page);

    // A page clicked on the grid: the result is gone and the action counts the new choice.
    await page.getByTestId('page-select-1').click();
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toHaveText('Extract 2 pages');

    // Make changes brings the options back in place of the result…
    await run(page);
    await page.getByTestId('edit-again').click();
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await openOptions(page);
    // …and what is changed there is what the next run produces.
    await field(page).fill('3');
    await chooseSplitMode(page, 'Remove Pages');
    await expect(page.getByTestId('tool-action')).toHaveText('Remove 1 page');
    await run(page);
    await downloadAllAndMatch(page, [{ name: 'doc-5page-split.pdf', pages: [1, 2, 4, 5] }]);
  });
});
