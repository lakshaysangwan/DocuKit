import { test, expect } from '@playwright/test';
import { uploadBuffer } from '../helpers/harness';

/**
 * P5.2 — robust error states. An unreadable PDF (corrupt, or — the common case —
 * password-protected) must never fail silently. Previously the thumbnail loader
 * swallowed the failure and left the tool blank; now every PDF tool surfaces a
 * single, consistent, *actionable* error with a one-click deep-link to Unlock.
 */

test.describe('P5.2 — actionable PDF load errors', () => {
  test('pdf-to-image: an unreadable PDF surfaces an actionable Unlock link', async ({ page }) => {
    await page.goto('/pdf-to-image');
    await uploadBuffer(page, {
      name: 'broken.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\nthis is not a valid PDF body'),
    });

    const toast = page.locator('[data-sonner-toast]');
    await expect(toast).toContainText("Couldn't open this PDF");
    await expect(toast.getByRole('button', { name: 'Unlock PDF' })).toBeVisible();
  });
});
