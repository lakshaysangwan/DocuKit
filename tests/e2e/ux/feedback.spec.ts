import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { addFilesAndWait } from '../helpers/harness';

/**
 * P5.1 — feedback consistency. A tool's transient toast (sonner, rendered in a
 * portal outside #main-content) confirms the action, while the persistent result
 * panel inside #main-content states the result and offers the next step. The two
 * must never be the *same* string, so the toast doesn't read as a duplicate of
 * the panel already on screen.
 */

test.describe('P5.1 — toast is distinct from the persistent result panel', () => {
  // Image to PDF lives in the tool workspace, which confirms a result in place:
  // the panel states it, the step prompt (a live region) announces it, and the
  // download takes the action's place. There is no toast — it would sit on top
  // of the download button it is announcing — so there is nothing to duplicate.
  test('image-to-pdf: the result is confirmed in place, in three different sentences, with no toast', async ({ page }) => {
    await page.goto('/image-to-pdf');
    await addFilesAndWait(page, [FIXTURE.jpg, FIXTURE.png], 2);
    await page.getByTestId('tool-action').click();

    // Persistent panel headline lives inside the main content region.
    await expect(page.locator('#main-content').getByText('PDF created!')).toBeVisible({ timeout: 45_000 });

    const prompt = page.getByTestId('step-prompt');
    await expect(prompt).toHaveAttribute('role', 'status');
    await expect(prompt).toHaveText('Your PDF is ready. Download it, or make changes.');
    await expect(page.getByTestId('result-summary')).toContainText('images.pdf');
    await expect(prompt).not.toContainText('PDF created!');

    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  });

  // P5.5 — the success panel offers a consistent in-flow cross-tool next step.
  test('image-to-pdf: success offers a cross-tool next step', async ({ page }) => {
    await page.goto('/image-to-pdf');
    await addFilesAndWait(page, [FIXTURE.jpg, FIXTURE.png], 2);
    await page.getByTestId('tool-action').click();

    const nextStep = page.getByTestId('next-step');
    await expect(nextStep).toBeVisible({ timeout: 45_000 });
    await expect(nextStep.getByRole('link', { name: 'Compress PDF' })).toHaveAttribute('href', '/compress-pdf/');
  });
});
