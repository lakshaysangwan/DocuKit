import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  uploadFiles,
  expectDownload,
  assertPdf,
  countPdfPagesStrict,
} from '../helpers/harness';

test.describe('Sign PDF', () => {
  test('page loads with correct H1 and signature step', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/sign-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sign PDF');
    await expect(page.getByText('Step 1: Create your signature')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('typed-signature flow places on a page and applies to the PDF', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/sign-pdf');

    // Step 1: switch to the "type" method and enter a name. The signature island
    // hydrates on idle and there's no dropzone to gate on, so retry the tab click
    // until the panel actually switches (avoids a pre-hydration click being lost).
    await expect(async () => {
      await page.getByRole('button', { name: 'type', exact: true }).click();
      await expect(page.getByPlaceholder('Type your name')).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    await page.getByPlaceholder('Type your name').fill('Ada Lovelace');
    await page.getByRole('button', { name: /Use this signature/ }).click();

    // Step 2: the PDF dropzone appears — upload a document.
    await expect(page.getByText('Step 2: Upload your PDF')).toBeVisible();
    await uploadFiles(page, FIXTURE.pdf3page);

    // Step 3: page thumbnails appear for placement.
    await expect(page.getByText('Step 3: Place signature on page(s)')).toBeVisible({ timeout: 20_000 });
    // The placement buttons expose the target via title (their text content is "+ Sign").
    await page.locator('button[title="Place on page 1"]').click();
    await expect(page.getByText('1 signature placed')).toBeVisible();

    // Apply and download.
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toMatch(/-signed\.pdf$/);
    expect(await countPdfPagesStrict(bytes)).toBe(3);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('uploaded-image signature is accepted and previews', async ({ page }) => {
    await page.goto('/sign-pdf');
    await expect(async () => {
      await page.getByRole('button', { name: 'upload', exact: true }).click();
      await expect(page.getByTestId('dropzone')).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    // The signature-image dropzone is the only file input in this mode.
    await uploadFiles(page, FIXTURE.png);
    await expect(page.getByAltText('Signature preview')).toBeVisible({ timeout: 15_000 });
    // Uploading a signature advances to the PDF step automatically.
    await expect(page.getByText('Step 2: Upload your PDF')).toBeVisible();
  });
});
