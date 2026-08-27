import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  addFilesAndWait,
  addSingleFileAndWait,
  uploadFiles,
  uploadBuffer,
  expectDownload,
  assertPdf,
  countPdfPagesStrict,
  extractPdfText,
  readPdfOutline,
  readPdfInternalLinkTargets,
  readPdfMetadataArtifacts,
  readPdfCropBoxes,
} from '../helpers/harness';

/**
 * The copy-drift closures.
 *
 * FIX-PLAN listed thirteen advertised bullets that were absent, unreachable or
 * inaccurate. Each test here covers one of the features built to close that
 * list, so the marketing copy has something behind it rather than being quietly
 * deleted. Three of the thirteen turned out to be implemented all along and are
 * proven here too — the audit had only searched client-side code.
 */

test.describe('Copy-drift closures — merge', () => {
  test('inserts a blank page between documents when asked', async ({ page }) => {
    await page.goto('/merge-pdf');
    await addFilesAndWait(page, [FIXTURE.pdf3page, FIXTURE.pdf3page], 2);

    // Baseline: no option set, the two 3-page files merge to 6.
    await page.getByTestId('tool-action').click();
    const plain = await expectDownload(page, () => page.getByTestId('download-button').click());
    expect(await countPdfPagesStrict(plain.bytes)).toBe(6);

    await page.goto('/merge-pdf');
    await addFilesAndWait(page, [FIXTURE.pdf3page, FIXTURE.pdf3page], 2);
    await page.locator('details[data-testid="merge-options"] summary').click();
    await page.getByTestId('insert-blank-pages').check();

    await page.getByTestId('tool-action').click();
    const spaced = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(spaced.bytes);
    // One blank between the two documents — not after the last one.
    expect(await countPdfPagesStrict(spaced.bytes)).toBe(7);
  });

  test('preserves bookmarks and internal links, remapped to merged page numbers', async ({ page }) => {
    test.setTimeout(120_000); // MuPDF's WASM is ~10MB and loads on demand.

    await page.goto('/merge-pdf');
    await addFilesAndWait(page, [FIXTURE.pdfBookmarks, FIXTURE.pdfBookmarks2], 2);
    await page.locator('details[data-testid="merge-options"] summary').click();
    await page.getByTestId('preserve-bookmarks').check();

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 90_000 }
    );
    assertPdf(bytes);
    expect(await countPdfPagesStrict(bytes)).toBe(6);

    const outline = await readPdfOutline(bytes);
    expect(outline.map((o) => o.title)).toEqual([
      'Alpha Chapter 1',
      'Alpha Section 1.1',
      'Alpha Chapter 2',
      'Beta Chapter 1',
      'Beta Section 1.1',
      'Beta Chapter 2',
    ]);

    // The nesting survives, and — the part that actually matters — the second
    // document's bookmarks point at its pages in their NEW positions (3-5), not
    // the 0-2 they had before the merge.
    expect(outline.map((o) => o.depth)).toEqual([0, 1, 0, 0, 1, 0]);
    expect(outline.map((o) => o.page)).toEqual([0, 1, 2, 3, 4, 5]);

    // Each document's internal link is likewise rebased: Alpha's page-3 link
    // still lands on page 3 (index 2), Beta's now lands on index 5.
    expect(await readPdfInternalLinkTargets(bytes)).toEqual([2, 5]);
  });

  test('default merge stays on the fast path and drops bookmarks', async ({ page }) => {
    // Guards the trade-off deliberately: preserving outlines costs a large WASM
    // download, so it must stay opt-in rather than becoming the default.
    await page.goto('/merge-pdf');
    await addFilesAndWait(page, [FIXTURE.pdfBookmarks, FIXTURE.pdfBookmarks2], 2);

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    expect(await countPdfPagesStrict(bytes)).toBe(6);
    expect(await readPdfOutline(bytes)).toEqual([]);
  });

  test('merges a password-protected PDF once its password is supplied', async ({ page }) => {
    test.setTimeout(120_000);

    // Build a genuinely encrypted input with the product's own protect tool,
    // rather than committing a binary fixture that nothing else would exercise.
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await page.getByTestId('password').fill('correct horse');
    await page.getByTestId('confirm-password').fill('correct horse');
    await page.getByTestId('tool-action').click();
    const encrypted = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 60_000 }
    );

    await page.goto('/merge-pdf');
    await uploadFiles(page, FIXTURE.pdf3page);
    await uploadBuffer(page, {
      name: 'locked.pdf',
      mimeType: 'application/pdf',
      buffer: encrypted.bytes,
    });
    await expect(page.locator('[data-testid="file-card"], [data-testid="file-row"]')).toHaveCount(2);

    // The tool notices the encryption on its own and asks for the password.
    await expect(page.getByTestId('merge-passwords')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('merge-password-input').fill('correct horse');

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 90_000 }
    );
    assertPdf(bytes);
    expect(await countPdfPagesStrict(bytes)).toBe(6);
    // Real decryption, not a pass-through of scrambled bytes.
    expect(await extractPdfText(bytes)).toContain('Test Document');
  });

  test('says which file needs a password instead of merging garbage', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await page.getByTestId('password').fill('correct horse');
    await page.getByTestId('confirm-password').fill('correct horse');
    await page.getByTestId('tool-action').click();
    const encrypted = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 60_000 }
    );

    await page.goto('/merge-pdf');
    await uploadFiles(page, FIXTURE.pdf3page);
    await uploadBuffer(page, {
      name: 'locked.pdf',
      mimeType: 'application/pdf',
      buffer: encrypted.bytes,
    });
    await expect(page.getByTestId('merge-passwords')).toBeVisible({ timeout: 30_000 });

    // Deliberately wrong password — the failure must name the file.
    await page.getByTestId('merge-password-input').fill('not the password');
    await page.getByTestId('tool-action').click();
    // Scoped to the page body: the same message also appears in a toast.
    await expect(
      page.locator('#main-content').getByText(/Incorrect password for "locked\.pdf"/)
    ).toBeVisible({ timeout: 60_000 });
  });
});

test.describe('Copy-drift closures — rearrange', () => {
  test('inserts a blank page at a chosen position', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(page.getByTestId('page-thumb')).toHaveCount(3);

    // Insert between pages 1 and 2.
    await page.locator('[data-testid="insert-blank"][data-position="1"]').click();
    await expect(page.getByTestId('page-thumb')).toHaveCount(4);
    await expect(page.locator('[data-testid="page-thumb"][data-blank="true"]')).toHaveCount(1);

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 60_000 }
    );
    assertPdf(bytes);
    expect(await countPdfPagesStrict(bytes)).toBe(4);

    // The blank really is blank, and it landed in the middle.
    const text = await extractPdfText(bytes, 1);
    expect(text.trim()).toBe('');
    expect((await extractPdfText(bytes, 0)).trim()).not.toBe('');
  });

  test('duplicates a page', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(page.getByTestId('page-thumb')).toHaveCount(3);

    await page.getByTestId('page-thumb').first().hover();
    await page.getByTestId('duplicate-page').first().click();
    await expect(page.getByTestId('page-thumb')).toHaveCount(4);

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 60_000 }
    );
    expect(await countPdfPagesStrict(bytes)).toBe(4);

    // Page 1 appears twice, back to back.
    const first = (await extractPdfText(bytes, 0)).trim();
    const second = (await extractPdfText(bytes, 1)).trim();
    expect(first).toContain('Page 1 of 3');
    expect(second).toBe(first);
  });

  test('Ctrl+click and Shift+click build a multi-page selection', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);
    await expect(page.getByTestId('page-thumb')).toHaveCount(5);

    const thumbs = page.getByTestId('page-thumb');
    await thumbs.nth(0).click();
    await expect(page.getByText('5 pages · 1 selected')).toBeVisible();

    await thumbs.nth(2).click({ modifiers: ['Control'] });
    await expect(page.getByText('5 pages · 2 selected')).toBeVisible();

    // Shift extends from the last click (index 2) through index 4.
    await thumbs.nth(4).click({ modifiers: ['Shift'] });
    await expect(page.getByText('5 pages · 4 selected')).toBeVisible();
  });

  test('Ctrl+Z undoes without touching the toolbar', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(page.getByTestId('page-thumb')).toHaveCount(3);

    await page.locator('[data-testid="insert-blank"][data-position="0"]').click();
    await expect(page.getByTestId('page-thumb')).toHaveCount(4);

    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('page-thumb')).toHaveCount(3);

    await page.keyboard.press('Control+Shift+z');
    await expect(page.getByTestId('page-thumb')).toHaveCount(4);
  });
});

test.describe('Copy-drift closures — crop, redact, unlock, sign', () => {
  test('crop Flatten is reachable and destroys the trimmed content', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/crop-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    await page.getByTestId('crop-mode-flatten').click();
    await expect(page.getByTestId('crop-mode-flatten')).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('top margin').fill('40');

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 90_000 }
    );
    assertPdf(bytes);
    expect(await countPdfPagesStrict(bytes)).toBe(3);

    // Flatten rasterises: the page becomes an image, so no text layer survives.
    // That is precisely what makes the removal permanent rather than hidden.
    expect((await extractPdfText(bytes)).trim()).toBe('');
  });

  test('crop CropBox stays reversible and keeps the text layer', async ({ page }) => {
    await page.goto('/crop-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    await expect(page.getByTestId('crop-mode-cropbox')).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('top margin').fill('40');

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 60_000 }
    );
    // Body text inside the crop window is still selectable — the page is real
    // content, not a picture of it. (The title sits above the 40mm crop, so it
    // is hidden by the new CropBox even though its bytes remain in the file.)
    expect(await extractPdfText(bytes)).toContain('This is sample body text');
  });

  test('crop applies to the current page only, leaving the others alone', async ({ page }) => {
    await page.goto('/crop-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    await page.getByTestId('apply-to-current').click();
    await expect(page.getByTestId('apply-to-current')).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('top margin').fill('40');

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 60_000 }
    );
    assertPdf(bytes);

    const boxes = await readPdfCropBoxes(bytes);
    expect(boxes).toHaveLength(3);
    // Page 1 is shorter by the 40mm margin; pages 2 and 3 are untouched.
    expect(boxes[0][1]).toBeLessThan(boxes[1][1]);
    expect(boxes[1]).toEqual(boxes[2]);
  });

  test('redact full metadata strip clears XMP and attachments too', async ({ page }) => {
    test.setTimeout(120_000);

    const before = await readPdfMetadataArtifacts(
      await import('node:fs/promises').then((fs) => fs.readFile(FIXTURE.pdfXmp))
    );
    expect(before.hasXmp, 'fixture starts with an XMP packet').toBe(true);
    expect(before.attachments).toContain('notes.txt');

    await page.goto('/redact-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdfXmp);

    // Mark a region so the redaction has something to do. Find-and-redact rather
    // than a pointer drag: this test is about the metadata strip, and text search
    // marks deterministically instead of depending on drag geometry that behaves
    // differently across engines.
    await expect(page.getByTestId('redact-page').first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('redact-search').fill('Quarterly');
    await page.getByTestId('redact-find').click();
    await expect(page.getByText(/area(s)? marked for redaction/)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('strip-metadata').check();
    await page.getByTestId('confirm-redaction').check();

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 90_000 }
    );
    assertPdf(bytes);

    const after = await readPdfMetadataArtifacts(bytes);
    expect(after.hasXmp, 'XMP packet removed').toBe(false);
    expect(after.attachments, 'embedded attachments removed').toEqual([]);
    expect(after.title).toBe('');
    expect(after.author).toBe('');
  });

  test('unlock shows the original encryption details', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await page.getByTestId('password').fill('hunter2hunter2');
    await page.getByTestId('confirm-password').fill('hunter2hunter2');
    await page.getByTestId('tool-action').click();
    const encrypted = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 60_000 }
    );

    await page.goto('/unlock-pdf');
    await uploadBuffer(page, {
      name: 'locked.pdf',
      mimeType: 'application/pdf',
      buffer: encrypted.bytes,
    });

    const details = page.getByTestId('encryption-details');
    await expect(details).toBeVisible({ timeout: 30_000 });
    // protect-pdf encrypts with AES-256, so that is what unlock must report.
    await expect(page.getByTestId('encryption-algorithm')).toHaveText('AES-256');
    await expect(details).toContainText('256-bit');
  });

  test('sign places a date stamp and initials alongside the signature', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/sign-pdf');
    // Retry the tab click until the panel switches — the island hydrates on idle
    // and a pre-hydration click is silently lost (same as tools/sign-pdf.spec.ts).
    await expect(async () => {
      await page.getByRole('button', { name: 'type', exact: true }).click();
      await expect(page.getByPlaceholder('Type your name')).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    await page.getByPlaceholder('Type your name').fill('Ada Lovelace');
    await page.getByRole('button', { name: /Use this signature/ }).click();

    await uploadFiles(page, FIXTURE.pdf3page);
    await expect(page.getByText('Step 3: Place signature on page(s)')).toBeVisible({ timeout: 30_000 });

    await page.locator('button[title="Place on page 1"]').click();
    await expect(page.getByTestId('placed-count')).toHaveText('1 stamp placed');

    await page.getByTestId('stamp-date').click();
    await page.locator('button[title="Place on page 1"]').click();
    await expect(page.getByTestId('placed-count')).toHaveText('2 stamps placed');

    await page.getByTestId('stamp-initials').click();
    await page.getByTestId('initials-input').fill('AL');
    await page.locator('button[title="Place on page 1"]').click();
    await expect(page.getByTestId('placed-count')).toHaveText('3 stamps placed');

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 90_000 }
    );
    assertPdf(bytes);

    // The date stamp is drawn as real text, so it is readable back out. Take the
    // expected string from the browser, not from Node — the two default to
    // different locales, so `toLocaleDateString()` disagrees across the boundary.
    const text = await extractPdfText(bytes, 0);
    const today = await page.evaluate(() => new Date().toLocaleDateString());
    expect(text).toContain(today);
  });
});

test.describe('Copy-drift closures — view-once', () => {
  test('rejects an image over the advertised 10MB limit', async ({ page }) => {
    await page.goto('/view-once-image');

    // 11MB — over the cap. Contents don't matter: the guard is on file size and
    // runs before anything is read or encrypted.
    await uploadBuffer(page, {
      name: 'too-big.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(11 * 1024 * 1024, 1),
    });

    await expect(page.getByText(/exceeds the 10MB limit/)).toBeVisible({ timeout: 15_000 });
    // The file is refused outright rather than accepted and failed on upload.
    await expect(page.getByTestId('file-info')).toBeHidden();
  });

  test('accepts an image under the limit', async ({ page }) => {
    await page.goto('/view-once-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await expect(page.getByTestId('tool-action')).toBeVisible();
  });
});
