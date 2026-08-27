import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { FIXTURE, CJK_TEXT, RTL_TEXT } from '../fixtures/generate';
import {
  addSingleFileAndWait,
  addFilesAndWait,
  expectDownload,
  assertPdf,
  countPdfPagesStrict,
  pdfFormFieldNames,
  extractPdfText,
  expectImageRendered,
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
 * CJK/RTL fixtures embed a real subsetted system font, so they are genuine
 * documents rather than synthetic stand-ins. They are generated only when a font
 * covering the script exists on the host; when it does not, those tests skip
 * loudly instead of quietly claiming coverage they never had. CMYK is drawn with
 * real DeviceCMYK operators via pdf-lib's cmyk().
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

  test.describe('scripts and colour spaces', () => {
    const cjk = () => existsSync(FIXTURE.pdfCjk);
    const rtl = () => existsSync(FIXTURE.pdfRtl);

    test('CJK text survives a watermark with its text layer intact', async ({ page }) => {
      test.skip(!cjk(), 'no CJK-capable font on this host; fixture not generated');
      await page.goto('/watermark-pdf');
      await addSingleFileAndWait(page, FIXTURE.pdfCjk);
      await page.getByTestId('tool-action').click();
      await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
      const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
      assertPdf(bytes);
      // The embedded CID font and its ToUnicode map must come through, or the
      // document is visually fine but no longer searchable/copyable.
      expect(await extractPdfText(bytes)).toContain(CJK_TEXT);
    });

    test('CJK page renders a real thumbnail (pdf.js cmaps + embedded font)', async ({ page }) => {
      test.skip(!cjk(), 'no CJK-capable font on this host; fixture not generated');
      await page.goto('/rearrange-pdf-pages');
      await addSingleFileAndWait(page, FIXTURE.pdfCjk);
      const thumb = page.getByTestId('page-thumb').first().locator('img').first();
      await expectImageRendered(thumb, 30_000);
    });

    test('RTL text survives a watermark with its text layer intact', async ({ page }) => {
      test.skip(!rtl(), 'no Hebrew-capable font on this host; fixture not generated');
      await page.goto('/watermark-pdf');
      await addSingleFileAndWait(page, FIXTURE.pdfRtl);
      await page.getByTestId('tool-action').click();
      await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
      const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
      assertPdf(bytes);
      expect(await extractPdfText(bytes)).toContain(RTL_TEXT);
    });

    test('RTL page renders a real thumbnail', async ({ page }) => {
      test.skip(!rtl(), 'no Hebrew-capable font on this host; fixture not generated');
      await page.goto('/rearrange-pdf-pages');
      await addSingleFileAndWait(page, FIXTURE.pdfRtl);
      await expectImageRendered(page.getByTestId('page-thumb').first().locator('img').first(), 30_000);
    });

    test('a DeviceCMYK document renders and compresses without loss of pages', async ({ page }) => {
      // Print-origin PDFs are CMYK; a renderer that assumes RGB either shifts
      // the colours or throws. pdf.js needs its ICC bundle for the conversion,
      // which is only served since P6.3.
      await page.goto('/compress-pdf');
      await addSingleFileAndWait(page, FIXTURE.pdfCmyk);
      await page.getByRole('button', { name: 'Medium' }).click();
      await page.getByTestId('tool-action').click();
      await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
      const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
      assertPdf(bytes);
      expect(await countPdfPagesStrict(bytes)).toBe(
        await countPdfPagesStrict(await readFile(FIXTURE.pdfCmyk))
      );
    });

    test('a DeviceCMYK page renders a real thumbnail, not a blank one', async ({ page }) => {
      await page.goto('/rearrange-pdf-pages');
      await addSingleFileAndWait(page, FIXTURE.pdfCmyk);
      await expectImageRendered(page.getByTestId('page-thumb').first().locator('img').first(), 30_000);
    });
  });
});
