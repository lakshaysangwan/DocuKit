import { test, expect, type Locator } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { addFilesAndWait } from '../helpers/harness';

/**
 * Once files are queued, nothing below the upload box may move on its own.
 *
 * The box flashes "Files added" for 1.5s and then returns to its idle row. When
 * that flash was taller than the idle row, every control underneath jumped up
 * just as the user reached for it — and clicks landed on the wrong button.
 */
const CASES = [
  { route: '/convert-image', file: FIXTURE.png },
  { route: '/image-to-pdf', file: FIXTURE.jpg },
  { route: '/merge-pdf', file: FIXTURE.pdf3page },
];

/** The element's vertical position once two reads 100ms apart agree. */
async function settledY(locator: Locator): Promise<number> {
  let previous = Number.NaN;
  await expect
    .poll(async () => {
      const y = (await locator.boundingBox())!.y;
      const settled = y === previous;
      previous = y;
      return settled;
    }, { intervals: [100], timeout: 1_200 })
    .toBe(true);
  return previous;
}

for (const { route, file } of CASES) {
  test(`${route}: the action button stays put after the "Files added" flash ends`, async ({ page }) => {
    await page.goto(route);
    await addFilesAndWait(page, file, 1);

    const dropzone = page.getByTestId('dropzone');
    const action = page.getByTestId('tool-action');
    await expect(action).toBeVisible();
    await expect(dropzone).toHaveAttribute('data-state', 'accepted');
    // Adding the first file legitimately collapses the box (a 150ms transition)
    // — let that settle, so only movement *after* it is measured.
    const during = await settledY(action);
    await expect(dropzone).toHaveAttribute('data-state', 'accepted');

    await expect(dropzone).toHaveAttribute('data-state', 'idle', { timeout: 5_000 });
    const after = (await action.boundingBox())!.y;

    expect(Math.abs(after - during), 'vertical shift in px').toBeLessThan(1);
  });
}
