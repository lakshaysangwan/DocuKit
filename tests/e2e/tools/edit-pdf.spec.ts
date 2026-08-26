import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  uploadFiles,
  expectDownload,
  assertPdf,
  countPdfPagesStrict,
  readPdfAnnotationSubtypes,
} from '../helpers/harness';

/** Upload and wait for the annotation editor to open (Save action appears). */
async function openEditor(page: import('@playwright/test').Page, file: string) {
  await uploadFiles(page, file);
  await expect(page.getByTestId('tool-action')).toBeVisible({ timeout: 30_000 });
}

test.describe('Edit PDF', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/edit-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Edit PDF');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('opens the annotation editor and saves an unmodified PDF', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/edit-pdf');
    await openEditor(page, FIXTURE.pdf3page);

    // Toolbar + save-mode options are present.
    await expect(page.locator('button[title="Text Box (T)"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Flatten (permanent)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep as Annotations' })).toBeVisible();

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('tool-action').click());
    assertPdf(bytes);
    expect(name).toMatch(/-edited\.pdf$/);
    expect(await countPdfPagesStrict(bytes)).toBe(3);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('adding a text annotation still exports a valid PDF with all pages', async ({ page }) => {
    await page.goto('/edit-pdf');
    await openEditor(page, FIXTURE.pdf3page);

    // Activate the Text tool — it programmatically drops a "Text" object on the canvas.
    await page.locator('button[title="Text Box (T)"]').click();
    // Give the canvas a moment to register the object + history push.
    await page.waitForTimeout(500);

    const { bytes } = await expectDownload(page, () => page.getByTestId('tool-action').click());
    assertPdf(bytes);
    expect(await countPdfPagesStrict(bytes)).toBe(3);
  });

  test('Flatten mode bakes annotations into the page (no /Annot objects)', async ({ page }) => {
    await page.goto('/edit-pdf');
    await openEditor(page, FIXTURE.pdf3page);

    // Flatten is the default save mode. Add a text annotation, then save.
    await page.locator('button[title="Text Box (T)"]').click();
    await page.waitForTimeout(500);

    const { bytes } = await expectDownload(page, () => page.getByTestId('tool-action').click());
    assertPdf(bytes);
    // The fixture has no annotations and Flatten composites onto the page,
    // so the output must contain zero annotation objects.
    expect(await readPdfAnnotationSubtypes(bytes)).toEqual([]);
  });

  test('Keep-as-Annotations emits real editable /Annot objects', async ({ page }) => {
    await page.goto('/edit-pdf');
    await openEditor(page, FIXTURE.pdf3page);

    // Switch to the annotations save mode…
    await page.getByRole('button', { name: 'Keep as Annotations' }).click();
    // …then drop a text annotation.
    await page.locator('button[title="Text Box (T)"]').click();
    await page.waitForTimeout(500);

    const { bytes } = await expectDownload(page, () => page.getByTestId('tool-action').click());
    assertPdf(bytes);
    expect(await countPdfPagesStrict(bytes)).toBe(3);

    // The text object must survive as a real FreeText annotation object,
    // not be flattened into the page content.
    const subtypes = await readPdfAnnotationSubtypes(bytes);
    expect(subtypes).toContain('FreeText');
  });
});
