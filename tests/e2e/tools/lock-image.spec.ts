import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, addSingleFileAndWait, expectDownload } from '../helpers/harness';

const PW = 'Corr3ct-Horse!';

test.describe('Lock Image', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/lock-image');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Lock Image with Password');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('locks an image into a self-contained HTML that decrypts with the password', async ({ page }) => {
    await page.goto('/lock-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);

    await page.getByTestId('password').fill(PW);
    await page.getByTestId('confirm-password').fill(PW);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    expect(name).toMatch(/-locked\.html$/);
    const html = bytes.toString('utf8');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('AES-GCM');
    expect(html).toContain('PBKDF2');

    // Round-trip: load the generated HTML and decrypt it with the right password.
    await page.setContent(html);
    await page.getByPlaceholder('Enter password').fill(PW);
    await page.getByRole('button', { name: 'Unlock Image' }).click();
    // On success the card is replaced by the decrypted <img>.
    await expect(page.getByAltText('Decrypted image')).toBeVisible({ timeout: 10_000 });
  });

  test('wrong password does not decrypt', async ({ page }) => {
    await page.goto('/lock-image');
    await addSingleFileAndWait(page, FIXTURE.png);
    await page.getByTestId('password').fill(PW);
    await page.getByTestId('confirm-password').fill(PW);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());

    await page.setContent(bytes.toString('utf8'));
    await page.getByPlaceholder('Enter password').fill('wrong-password');
    await page.getByRole('button', { name: 'Unlock Image' }).click();
    await expect(page.getByText(/Incorrect password/)).toBeVisible();
    await expect(page.getByAltText('Decrypted image')).toHaveCount(0);
  });
});
