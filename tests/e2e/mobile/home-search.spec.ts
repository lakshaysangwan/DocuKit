import { test, expect, type Page } from '@playwright/test';

/**
 * Homepage search on a phone (runs under the `mobile` project: touch, mobile
 * user agent). The viewport is narrowed to 375px — the smallest phone width the
 * site supports — because the Pixel 5 profile's 393px would hide an overflow of
 * up to 18px.
 */
test.use({ viewport: { width: 375, height: 667 } });

async function openHome(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-testid="tool-search"][data-hydrated="true"]')).toBeVisible();
  return page.getByRole('combobox', { name: 'Search tools' });
}

/** How far the document is wider than the viewport. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('Homepage search — 375px touch screen', () => {
  test('the field fits the screen and is a comfortable touch target', async ({ page }) => {
    const input = await openHome(page);
    const box = (await input.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.height).toBeGreaterThanOrEqual(44);
    // 16px text: anything smaller makes iOS Safari zoom the page when the field is focused.
    expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('tapping the field, typing and tapping a result opens that page', async ({ page }) => {
    const input = await openHome(page);
    await input.tap();
    await expect(input).toBeFocused();
    await input.pressSequentially('jpg');

    const listbox = page.getByRole('listbox', { name: 'Matching tools' });
    await expect(listbox).toBeVisible();
    // The results sit inside the screen, with no sideways scroll to reach them.
    const box = (await listbox.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect(listbox).toBeInViewport({ ratio: 1 });

    // Each result is tall enough to hit with a thumb.
    const option = page.getByRole('option', { name: /^PDF to JPG/ });
    expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await option.tap();
    await expect(page).toHaveURL(/\/pdf-to-jpg\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Convert PDF to JPG');
  });

  test('a long list scrolls inside itself to reach the last result', async ({ page }) => {
    const input = await openHome(page);
    await input.tap();
    await input.fill('pdf');
    const options = page.getByRole('option');
    const last = options.last();
    await expect(last).not.toBeInViewport();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('the "no results" message fits, however long the query', async ({ page }) => {
    const input = await openHome(page);
    await input.tap();
    await input.fill('averyveryverylongsinglewordthatcannotwrapnaturallyanywhereatall');

    const empty = page.getByTestId('tool-search-empty');
    await expect(empty).toBeVisible();
    const box = (await empty.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(await empty.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: 'Clear search' }).tap();
    await expect(input).toHaveValue('');
    await expect(empty).toBeHidden();
  });
});
