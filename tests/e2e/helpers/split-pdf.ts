import { type Page, expect } from '@playwright/test';
import { uploadFiles } from './harness';

/**
 * Helpers for Split PDF's workspace. The point of them is one comparison: what
 * the grid and the output list promise against the files actually downloaded.
 */

/** Open a Split page with a PDF and wait until all `pages` are drawn. */
export async function openSplit(page: Page, file: string, pages: number, url = '/split-pdf') {
  await page.goto(url);
  await uploadFiles(page, file);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('split-page')).toHaveCount(pages, { timeout: 30_000 });
  await expect(page.getByTestId('split-page-image')).toHaveCount(pages, { timeout: 30_000 });
}

/** Pick a mode by its name: "Split by Range". Opens the phone Options panel if it is closed. */
export async function chooseSplitMode(page: Page, label: string) {
  await openOptions(page);
  await page.getByTestId('split-modes').getByRole('button', { name: label }).click();
  await expect(page.getByTestId('split-modes').getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
}

/** On a phone the options are in a closed panel; open it. Elsewhere it does nothing. */
export async function openOptions(page: Page) {
  const toggle = page.getByTestId('options-toggle');
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

/** The tag on each page card, in page order ("" where there is none). */
export async function gridMarks(page: Page): Promise<string[]> {
  return page.getByTestId('split-page').evaluateAll((cards) => cards.map((c) => c.getAttribute('data-mark') ?? ''));
}

/** The output list: one row per file that will be produced. */
export async function outputList(page: Page): Promise<{ name: string; pages: string }[]> {
  const rows = page.getByTestId('split-output');
  const out: { name: string; pages: string }[] = [];
  for (const row of await rows.all()) {
    out.push({
      name: ((await row.getByTestId('split-output-name').textContent()) ?? '').trim(),
      pages: ((await row.getByTestId('split-output-pages').textContent()) ?? '').trim(),
    });
  }
  return out;
}

/** Turn the grid's "PDF 2" tags into the page numbers (1-based) of each output. */
export function pagesByMark(marks: string[]): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  marks.forEach((mark, i) => {
    const m = /^PDF ([\d, ]+)$/.exec(mark);
    if (!m) return;
    for (const k of m[1].split(',').map((s) => Number(s.trim()))) groups.set(k, [...(groups.get(k) ?? []), i + 1]);
  });
  return groups;
}
