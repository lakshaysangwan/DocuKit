import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, addSingleFileAndWait, uploadBuffer, expectDownload, assertPdf } from '../helpers/harness';

/** An encrypted PDF has an /Encrypt entry in its trailer dictionary. */
function assertEncrypted(bytes: Buffer, shouldBe = true) {
  const hasEncrypt = bytes.toString('latin1').includes('/Encrypt');
  expect(hasEncrypt, shouldBe ? 'expected /Encrypt marker' : 'expected NO /Encrypt marker').toBe(shouldBe);
}

const PW = 'Sup3r$ecret!2024';

test.describe('Protect PDF', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/protect-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Password Protect PDF');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('encrypts a PDF with a password (output is really encrypted)', async ({ page }) => {
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    await page.getByTestId('password').fill(PW);
    await page.getByTestId('confirm-password').fill(PW);
    // Strength meter reflects a strong password.
    await expect(page.getByText(/Strong|Good/)).toBeVisible();
    // Toggle a permission off.
    await page.getByRole('checkbox', { name: /Modify Contents/i }).setChecked(false);

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    assertEncrypted(bytes, true);
    expect(name).toMatch(/-protected\.pdf$/);
  });

  test('rejects mismatched confirm password', async ({ page }) => {
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await page.getByTestId('password').fill(PW);
    await page.getByTestId('confirm-password').fill('different');
    await page.getByTestId('tool-action').click();
    // No download button should appear; an error toast is shown instead.
    await expect(page.getByTestId('download-button')).toHaveCount(0);
  });

  test('generate-random fills both password fields', async ({ page }) => {
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await page.getByRole('button', { name: 'Generate random' }).click();
    const pw = await page.getByTestId('password').inputValue();
    expect(pw.length).toBeGreaterThanOrEqual(12);
  });
});

test.describe('Unlock PDF', () => {
  test('page loads in unlock mode', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/unlock-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Unlock PDF');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('round-trip: protect then unlock recovers a readable PDF', async ({ page }) => {
    // 1) Protect a PDF and capture the encrypted bytes.
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await page.getByTestId('password').fill(PW);
    await page.getByTestId('confirm-password').fill(PW);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const protectedPdf = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertEncrypted(protectedPdf.bytes, true);

    // 2) Feed the encrypted PDF into Unlock mode with the correct password.
    await page.goto('/unlock-pdf');
    await uploadBuffer(page, { name: 'encrypted.pdf', mimeType: 'application/pdf', buffer: protectedPdf.bytes });
    await expect(page.getByTestId('file-info')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('unlock-password').fill(PW);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const unlocked = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(unlocked.bytes);
    assertEncrypted(unlocked.bytes, false);
    expect(unlocked.name).toMatch(/-unlocked\.pdf$/);
  });

  test('wrong password surfaces an error and produces no download', async ({ page }) => {
    // Protect first to get an encrypted file.
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await page.getByTestId('password').fill(PW);
    await page.getByTestId('confirm-password').fill(PW);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const protectedPdf = await expectDownload(page, () => page.getByTestId('download-button').click());

    await page.goto('/unlock-pdf');
    await uploadBuffer(page, { name: 'encrypted.pdf', mimeType: 'application/pdf', buffer: protectedPdf.bytes });
    await expect(page.getByTestId('file-info')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('unlock-password').fill('wrong-password');
    await page.getByTestId('tool-action').click();
    await expect(page.locator('#main-content').getByText(/Incorrect password/)).toBeVisible({ timeout: 30_000 });
  });
});
