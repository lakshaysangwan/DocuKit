import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, countPdfPagesStrict, readPdfContentStreams } from '../helpers/harness';
import {
  openSign,
  readDrawnImages,
  signAndDownload,
  stampViewRect,
  addTypedSignature,
  addUploadedSignature,
} from '../helpers/sign';

/**
 * Sign PDF: the flow a first-time visitor walks through.
 *
 * The PDF comes first; the signature is made beside the page and appears ON the
 * page at once. Where exactly it lands in the file is the business of
 * sign-pdf-placement.spec.ts — this file is about the steps, the words on
 * screen, and the three ways of making a signature.
 */
test.describe('Sign PDF', () => {
  test('opens on one dropzone that asks for the PDF', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/sign-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sign PDF');

    const dropzone = page.getByTestId('dropzone');
    await expect(dropzone).toHaveCount(1);
    await expect(dropzone).toContainText('Drop the PDF you want to sign');
    // No workspace, and nothing asking for a signature, until there is a document.
    await expect(page.getByTestId('workspace')).toHaveCount(0);
    await expect(page.getByTestId('signature-creator')).toHaveCount(0);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('says what to do at every step, and never shows a dead button without a reason', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await openSign(page, FIXTURE.pdf3page);

    // Entering the workspace: focus is on its heading, the page is on screen.
    await expect(page.getByTestId('workspace-title')).toHaveText('Sign this PDF');
    await expect(page.getByTestId('workspace-title')).toBeFocused();
    await expect(page.getByTestId('file-info')).toHaveAttribute('data-filename', 'doc-3page.pdf');
    await expect(page.getByTestId('page-indicator')).toHaveText('Page 1 of 3');

    // Step 2: make the signature. Both disabled buttons say why.
    await expect(page.getByTestId('step-prompt')).toHaveText('Create your signature on the right.');
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('tool-action')).toHaveText('Sign PDF');
    await expect(page.getByTestId('action-hint')).toHaveText('Add your signature to the page first');
    await expect(page.getByTestId('use-signature')).toBeDisabled();
    await expect(page.getByTestId('use-signature-hint')).toHaveText('Draw your signature first');

    await page.getByTestId('signature-mode-type').click();
    await expect(page.getByTestId('use-signature-hint')).toHaveText('Type your name first');
    await page.getByLabel('Signature text').fill('Ada Lovelace');
    await expect(page.getByTestId('use-signature')).toBeEnabled();
    await expect(page.getByTestId('use-signature-hint')).toHaveText('');

    // Step 3: the signature is on the page straight away, selected, with handles.
    await page.getByTestId('use-signature').click();
    const stamp = page.getByTestId('overlay-item');
    await expect(stamp).toHaveCount(1);
    await expect(stamp).toHaveAttribute('data-selected', 'true');
    await expect(stamp).toHaveAttribute('aria-label', 'Signature, page 1');
    await expect(page.getByTestId('overlay-hint')).toHaveText('Drag to move · corners to resize');
    for (const corner of ['top-left', 'top-right', 'bottom-right', 'bottom-left']) {
      await expect(page.getByTestId(`overlay-handle-${corner}`)).toBeVisible();
    }
    await expect(page.getByTestId('step-prompt')).toHaveText(
      'Drag your signature into place, or click the spot where it should go.',
    );
    await expect(page.getByTestId('placed-count')).toHaveText('1 stamp placed');
    await expect(page.getByTestId('rail-badge-1')).toBeVisible();
    await expect(page.getByTestId('tool-action')).toBeEnabled();
    await expect(page.getByTestId('action-hint')).toHaveText('1 stamp on 1 page will be added to your PDF.');

    // It starts about a third of the page wide, in the lower middle, undistorted.
    const rect = await stampViewRect(page);
    expect(rect.width).toBeCloseTo(0.35, 2);
    expect(rect.x + rect.width / 2).toBeCloseTo(0.5, 2);
    expect(rect.y + rect.height / 2).toBeGreaterThan(0.6);

    // Step 4: one slot. The action becomes the download, in the same place.
    const bytes = await signAndDownload(page);
    expect(await countPdfPagesStrict(bytes)).toBe(3);
    await expect(page.getByTestId('tool-action')).toHaveCount(0);
    await expect(page.getByTestId('download-button')).toHaveText('Download signed PDF');
    await expect(page.getByTestId('result-summary')).toContainText('doc-3page-signed.pdf');
    await expect(page.getByTestId('result-summary')).toContainText('3 pages');
    await expect(page.getByTestId('step-prompt')).toHaveText('Your signed PDF is ready. Download it, or make changes.');

    // The signature is on page 1 and only there. The fixture's pages hold text
    // and a rectangle, so an XObject paint ("Do") can only be the signature.
    expect((await readDrawnImages(bytes, 0)).length).toBe(1);
    for (const i of [1, 2]) {
      expect((await readPdfContentStreams(bytes, i)).join('\n')).not.toMatch(/\/\S+\s+Do\b/);
    }
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('a drawn signature is trimmed to its ink and placed on the page', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);

    const pad = page.getByLabel('Signature drawing area');
    await expect(pad).toBeVisible();
    const box = (await pad.boundingBox())!;
    // A long, shallow squiggle across the middle of the pad: about 160 × 20
    // CSS pixels of ink, nothing like the shape of the pad itself.
    const x0 = box.x + box.width * 0.2;
    const y0 = box.y + box.height * 0.5;
    await expect(async () => {
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move(x0 + 50, y0 - 10, { steps: 6 });
      await page.mouse.move(x0 + 110, y0 + 10, { steps: 6 });
      await page.mouse.move(x0 + 160, y0 - 5, { steps: 6 });
      await page.mouse.up();
      await expect(page.getByTestId('use-signature')).toBeEnabled({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    const padBitmap = await pad.evaluate((c: HTMLCanvasElement) => ({ width: c.width, height: c.height }));
    await page.getByTestId('use-signature').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);

    // The image is the squiggle, not the whole pad: well under the pad's bitmap
    // in both directions, and much wider than tall where the pad is about 2:1.
    const image = await page
      .getByTestId('stamp-image')
      .evaluate((img: HTMLImageElement) => ({ width: img.naturalWidth, height: img.naturalHeight }));
    expect(image.width).toBeGreaterThan(padBitmap.width * 0.3);
    expect(image.width).toBeLessThan(padBitmap.width * 0.75);
    expect(image.height).toBeLessThan(padBitmap.height * 0.4);
    const aspect = image.width / image.height;
    expect(box.width / box.height).toBeLessThan(3);
    expect(aspect).toBeGreaterThan(4);

    // The box on the page has the squiggle's shape — nothing is stretched.
    const shown = (await page.getByTestId('overlay-item').boundingBox())!;
    expect(Math.abs(shown.width / shown.height / aspect - 1)).toBeLessThan(0.08);

    const bytes = await signAndDownload(page);
    expect((await readDrawnImages(bytes, 0)).length).toBe(1);
  });

  test('an uploaded picture keeps its own shape — it is not squeezed into a fixed box', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    // An 800 × 800 picture. The old tool forced every signature into 200 × 60pt.
    await addUploadedSignature(page, FIXTURE.png);

    const rect = await stampViewRect(page);
    const bytes = await signAndDownload(page);
    const [image] = await readDrawnImages(bytes, 0);
    // Letter is 612 × 792pt: turn the fractions back into points.
    const widthPt = image.rect.width * 612;
    const heightPt = image.rect.height * 792;
    expect(widthPt / heightPt).toBeCloseTo(1, 1);
    expect(image.rect.width).toBeCloseTo(rect.width, 2);
  });

  test('a long typed name is not cut off', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    const aspect = async () =>
      page.getByTestId('stamp-image').evaluate((img: HTMLImageElement) => img.naturalWidth / img.naturalHeight);

    await addTypedSignature(page, 'Ada');
    const short = await aspect();

    // The old tool drew typed text on a fixed 400px canvas, so this lost its end.
    const long = 'Augusta Ada King, Countess of Lovelace';
    await page.getByTestId('change-signature').click();
    await page.getByLabel('Signature text').fill(long);
    await page.getByTestId('use-signature').click();
    await expect(page.getByTestId('signature-creator')).toHaveCount(0);

    // Twelve times the letters: the image must be several times wider for its
    // height, not capped at whatever a fixed canvas allowed.
    await expect.poll(aspect).toBeGreaterThan(short * 4);
    // And still one stamp: changing the signature updates it, it does not add one.
    await expect(page.getByTestId('placed-count')).toHaveText('1 stamp placed');
  });

  test('the signature made earlier in this tab is offered back', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    await expect(page.getByTestId('use-saved-signature')).toHaveCount(0);
    await addTypedSignature(page);

    // Come back later in the same tab, with another document.
    await openSign(page, FIXTURE.pdf3page);
    await expect(page.getByTestId('use-saved-signature')).toBeVisible();
    await page.getByTestId('use-saved-signature').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);
    await expect(page.getByTestId('placed-count')).toHaveText('1 stamp placed');

    const bytes = await signAndDownload(page);
    expect((await readDrawnImages(bytes, 0)).length).toBe(1);
  });

  test('"Forget" removes the saved signature', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    await addTypedSignature(page);
    await openSign(page, FIXTURE.pdf1page);
    await page.getByTestId('forget-saved-signature').click();
    await expect(page.getByTestId('use-saved-signature')).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('docukit-signature'))).toBeNull();
  });

  test('changing or removing the file starts again without losing the signature', async ({ page }) => {
    await openSign(page, FIXTURE.pdf3page);
    await addTypedSignature(page);

    // "Change file": the first file input in the workspace is the document's.
    await page.locator('input[type="file"]').first().setInputFiles(FIXTURE.pdf5page);
    await expect(page.getByTestId('file-info')).toHaveAttribute('data-filename', 'doc-5page.pdf');
    await expect(page.getByTestId('page-indicator')).toHaveText('Page 1 of 5');
    // The stamps belonged to the other document; the signature itself is kept.
    await expect(page.getByTestId('overlay-item')).toHaveCount(0);
    await expect(page.getByTestId('signature-preview')).toBeVisible();
    await expect(page.getByTestId('tool-action')).toBeDisabled();

    await page.getByTestId('remove-file').click();
    await expect(page.getByTestId('workspace')).toHaveCount(0);
    await expect(page.getByTestId('dropzone')).toContainText('Drop the PDF you want to sign');
  });

  test('a file that is not a PDF is turned away at the door', async ({ page }) => {
    await page.goto('/sign-pdf');
    await expect(page.locator('[data-testid="dropzone"][data-hydrated="true"]')).toBeVisible();
    await page.locator('input[type="file"]').first().setInputFiles(FIXTURE.png);
    await expect(page.getByTestId('dropzone')).toHaveAttribute('data-state', 'rejected');
    await expect(page.getByTestId('workspace')).toHaveCount(0);
  });
});
