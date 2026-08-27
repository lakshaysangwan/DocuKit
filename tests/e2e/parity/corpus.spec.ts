import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { FIXTURE } from '../fixtures/generate';
import {
  addSingleFileAndWait,
  addFilesAndWait,
  expectDownload,
  assertPdf,
  countPdfPagesStrict,
  pdfFormFieldNames,
} from '../helpers/harness';

/**
 * Phase 7 — awkward-document corpus.
 *
 * The release gate asks for a pass over documents that are not the clean,
 * text-only PDFs the rest of the suite uses: scanned pages, interactive forms,
 * CJK/RTL scripts, CMYK colour. Those are where a browser-side PDF stack
 * usually breaks.
 *
 * WHAT THIS COVERS: the two categories that can be generated faithfully —
 * image-only ("scanned") pages and real AcroForm fields.
 *
 * WHAT IT DOES NOT COVER, and why: CJK/RTL text needs an embedded CJK or Arabic
 * font (a multi-MB binary this repo does not carry), and CMYK needs a document
 * authored in a CMYK colour space, which pdf-lib cannot produce. Synthesising
 * fakes for those would test the fake, not the capability. They need real sample
 * documents dropped into tests/e2e/fixtures/files — see FIX-PLAN. Note that
 * pdf.js can only render CJK correctly now that the cmaps bundle is served
 * (P6.3), so that path is newly plausible but still unverified.
 */
test.describe('P7 — corpus: scanned pages and interactive forms', () => {
  test('scanned (image-only) PDF survives a merge with its pages intact', async ({ page }) => {
    await page.goto('/merge-pdf');
    await addFilesAndWait(page, [FIXTURE.pdfPhoto, FIXTURE.pdf1page], 2);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);

    const photoPages = await countPdfPagesStrict(await readFile(FIXTURE.pdfPhoto));
    const onePage = await countPdfPagesStrict(await readFile(FIXTURE.pdf1page));
    expect(await countPdfPagesStrict(bytes)).toBe(photoPages + onePage);
  });

  test('scanned (image-only) PDF renders a real thumbnail, not a blank page', async ({ page }) => {
    // An image-only page has no text layer; a renderer that only draws text
    // would produce a blank-but-valid thumbnail, which is worse than an error.
    await page.goto('/rearrange-pdf-pages');
    await addSingleFileAndWait(page, FIXTURE.pdfPhoto);
    const thumb = page.getByTestId('page-thumb').first().locator('img').first();
    await expect(thumb).toBeVisible({ timeout: 30_000 });
    const painted = await thumb.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0));
    expect(painted, 'thumbnail should be decoded with real pixels').toBeGreaterThan(0);
  });

  test('a form PDF keeps its AcroForm fields through a watermark', async ({ page }) => {
    // Watermarking is additive — it has no reason to touch form fields, so
    // losing them here would mean the save path is dropping the AcroForm.
    const original = await readFile(FIXTURE.pdfForm);
    const originalFields = await pdfFormFieldNames(original);
    expect(originalFields, 'fixture should carry interactive fields').toEqual([
      'applicant.name',
      'applicant.plan',
      'applicant.subscribe',
    ]);

    await page.goto('/watermark-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdfForm);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());

    assertPdf(bytes);
    expect(await countPdfPagesStrict(bytes)).toBe(await countPdfPagesStrict(original));
    expect(
      await pdfFormFieldNames(bytes),
      'watermarking should not strip the interactive form'
    ).toEqual(originalFields);
  });

  test('a form PDF can be encrypted and recovered without losing its fields', async ({ page }) => {
    const PW = 'corpus-pw-123';
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdfForm);
    await page.getByTestId('password').fill(PW);
    await page.getByTestId('confirm-password').fill(PW);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const locked = await expectDownload(page, () => page.getByTestId('download-button').click());

    await page.goto('/unlock-pdf');
    await expect(page.locator('[data-testid="dropzone"][data-hydrated="true"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: 'form-locked.pdf', mimeType: 'application/pdf', buffer: locked.bytes });
    await expect(page.getByTestId('file-info')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('unlock-password').fill(PW);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());

    assertPdf(bytes);
    expect(
      await pdfFormFieldNames(bytes),
      'an encrypt/decrypt round-trip should preserve the interactive form'
    ).toEqual(await pdfFormFieldNames(await readFile(FIXTURE.pdfForm)));
  });
});
