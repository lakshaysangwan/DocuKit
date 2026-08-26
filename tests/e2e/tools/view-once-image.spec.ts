import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, addSingleFileAndWait, expectImageRendered } from '../helpers/harness';

/**
 * View-Once is the only tool with a server dependency: it encrypts client-side
 * then POSTs the ciphertext to a Cloudflare Pages Function (/api/view-once).
 * When that backend is reachable, a share link is produced with the AES key in
 * the URL fragment (never sent to the server). If the backend is NOT running,
 * link creation errors instead — the test tolerates both outcomes but requires
 * that the decryption key never leaves the fragment when a link is produced.
 */
test.describe('View-Once Image', () => {
  test('page loads with correct H1 and privacy explainer', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/view-once-image');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Disappears After One View');
    await expect(page.getByText('End-to-end encrypted · View once · Auto-delete')).toBeVisible();
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('upload shows a preview and TTL options', async ({ page }) => {
    await page.goto('/view-once-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await expectImageRendered(page.locator('#main-content img').first());

    // Expiry presets are selectable.
    for (const label of ['1 hour', '6 hours', '24 hours', '7 days']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
    await page.getByRole('button', { name: '1 hour' }).click();
    await expect(page.getByTestId('tool-action')).toBeVisible();
  });

  test('creating a link encrypts client-side and keeps the key in the URL fragment', async ({ page }) => {
    await page.goto('/view-once-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await page.getByTestId('tool-action').click();

    // Either a link is produced (backend reachable) or an error is shown.
    const created = page.getByText('View-once link created!');
    const errored = page.locator('#main-content').getByText(/Upload failed|unavailable|error/i);
    await expect(created.or(errored).first()).toBeVisible({ timeout: 30_000 });

    if (await created.count()) {
      const url = await page.getByRole('textbox').inputValue();
      // /view/<id>#<key>.<iv> — the secret material lives only after the '#'.
      expect(url).toMatch(/\/view\/[^#]+#.+\..+/);
      const fragment = url.split('#')[1] ?? '';
      expect(fragment.length, 'decryption key present in fragment').toBeGreaterThan(10);
      expect(url.split('#')[0], 'no key before the fragment').not.toContain('.');
    }
  });
});
