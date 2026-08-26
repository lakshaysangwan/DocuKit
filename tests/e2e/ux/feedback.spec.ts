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
  test('image-to-pdf: toast confirms, panel persists — different text', async ({ page }) => {
    await page.goto('/image-to-pdf');
    await addFilesAndWait(page, [FIXTURE.jpg, FIXTURE.png], 2);
    await page.getByTestId('tool-action').click();

    // Persistent panel headline lives inside the main content region.
    await expect(page.locator('#main-content').getByText('PDF created!')).toBeVisible({ timeout: 45_000 });

    // The transient toast is a different, action-oriented confirmation.
    const toast = page.locator('[data-sonner-toast]');
    await expect(toast).toContainText('PDF ready to download');
    await expect(toast).not.toContainText('PDF created!');
  });

  // P5.5 — the success panel offers a consistent in-flow cross-tool next step.
  test('image-to-pdf: success offers a cross-tool next step', async ({ page }) => {
    await page.goto('/image-to-pdf');
    await addFilesAndWait(page, [FIXTURE.jpg, FIXTURE.png], 2);
    await page.getByTestId('tool-action').click();

    const nextStep = page.getByTestId('next-step');
    await expect(nextStep).toBeVisible({ timeout: 45_000 });
    await expect(nextStep.getByRole('link', { name: 'Compress PDF' })).toHaveAttribute('href', '/compress-pdf');
  });
});
