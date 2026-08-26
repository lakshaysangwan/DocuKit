import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  expectDownload,
  assertPdf,
  verifyPdfSignature,
} from '../helpers/harness';

test.describe('Digital Signature PDF', () => {
  test('page loads with correct H1 and certificate options', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/digital-signature-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Digitally Sign PDF');
    await expect(page.getByRole('button', { name: 'Generate New' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload Existing' })).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('generates a self-signed cert and embeds a real PKCS#7 signature', async ({ page }) => {
    // RSA-2048 keygen + PKCS#7 signing is CPU-heavy; give it room.
    test.setTimeout(120_000);
    await page.goto('/digital-signature-pdf');

    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    // Generate mode is default — enter the Common Name.
    await page.getByPlaceholder('John Doe').fill('Ada Lovelace');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toMatch(/-signed\.pdf$/);

    // The output must contain a real signature dictionary (PKCS#7 detached).
    const text = bytes.toString('latin1');
    expect(text, 'signature dict').toContain('/Type /Sig');
    expect(text, 'PKCS#7 subfilter').toContain('adbe.pkcs7.detached');
    expect(text, 'ByteRange present').toContain('/ByteRange');
    expect(text, 'signer name embedded').toContain('Ada Lovelace');

    // …and it must be a *cryptographically valid* signature, not just markers:
    // the digest covers the document and the RSA signature verifies.
    const v = await verifyPdfSignature(bytes);
    expect(v.contentDigestMatches, 'messageDigest covers the ByteRange content').toBe(true);
    expect(v.signatureValid, 'RSA signature over authenticated attributes verifies').toBe(true);
    expect(v.signerCN).toBe('Ada Lovelace');
  });
});
