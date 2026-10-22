import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, verifyPdfSignature } from '../helpers/harness';
import {
  boxViewRect,
  dragBox,
  enterName,
  expectSameRect,
  goToPage,
  makeP12,
  openDigitalSignature,
  openOptions,
  readByteRange,
  readSignatureFields,
  readSignatureWidgets,
  setBoxMm,
  signAndDownload,
  signatureBox,
} from '../helpers/digital-signature';

/**
 * Digital Signature PDF. Every test reads the DOWNLOADED file: the signature
 * dictionary, the /ByteRange, the PKCS#7 blob in /Contents (verified
 * cryptographically by the harness), and the signature widget's /Rect mapped
 * to the displayed page by pdf.js — compared with the box that was on screen.
 */

// RSA-2048 keygen + PKCS#7 signing is CPU-heavy; give it room.
test.setTimeout(150_000);

/** The /ByteRange covers the whole file except the /Contents hex string, which holds the PKCS#7 blob. */
function expectWholeFileSigned(bytes: Buffer) {
  const { range, gap } = readByteRange(bytes);
  expect(range[0]).toBe(0);
  expect(range[2] + range[3], 'the second range ends at the end of the file').toBe(bytes.length);
  expect(gap, 'only the /Contents string is left out').toMatch(/^<[0-9a-f]+>$/);
  // A DER SEQUENCE (30 82 …) at the start of the blob: a PKCS#7 ContentInfo.
  expect(gap.slice(1, 5)).toBe('3082');
}

test.describe('Digital Signature PDF', () => {
  test('page loads with correct H1; the certificate options appear with the document', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/digital-signature-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Digitally Sign PDF');
    await openDigitalSignature(page, FIXTURE.pdf3page);
    await openOptions(page);
    await expect(page.getByRole('button', { name: 'Generate New' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload Existing' })).toBeVisible();
    await expect(page.getByTestId('appearance-visible')).toBeChecked();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('generates a self-signed cert and embeds a real PKCS#7 signature', async ({ page }) => {
    await openDigitalSignature(page, FIXTURE.pdf3page);
    // The action waits for a name, and says so.
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('Enter your name for the certificate.');
    await enterName(page, 'Ada Lovelace');
    await expect(page.getByTestId('tool-action')).toHaveText('Add digital signature');

    const bytes = await signAndDownload(page);
    const text = bytes.toString('latin1');
    expect(text, 'signature dict').toContain('/Type /Sig');
    expect(text, 'PKCS#7 subfilter').toContain('adbe.pkcs7.detached');
    expect(text, 'signer name embedded').toContain('Ada Lovelace');
    expectWholeFileSigned(bytes);

    // …and it must be a *cryptographically valid* signature, not just markers.
    const v = await verifyPdfSignature(bytes);
    expect(v.contentDigestMatches, 'messageDigest covers the ByteRange content').toBe(true);
    expect(v.signatureValid, 'RSA signature over authenticated attributes verifies').toBe(true);
    expect(v.signerCN).toBe('Ada Lovelace');

    // The result pane says what was checked on that same file.
    await openOptions(page);
    await expect(page.getByTestId('check-signer')).toHaveText('Ada Lovelace');
    await expect(page.getByTestId('check-issuer')).toContainText('Self-signed');
    await expect(page.getByTestId('check-time')).toHaveText(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/);
    await expect(page.getByTestId('check-byte-range')).toContainText(
      `all ${bytes.length.toLocaleString('en-GB')} bytes except the 16,386-byte space`,
    );
    await expect(page.getByTestId('check-digest')).toContainText('matches');
    await expect(page.getByTestId('check-rsa')).toContainText('verifies');
    await expect(page.getByTestId('download-p12')).toBeVisible();
  });

  test('the default is a visible box at the old spot on page 1, written exactly where it is shown', async ({ page }) => {
    await openDigitalSignature(page, FIXTURE.pdf3page);
    await expect(signatureBox(page)).toBeVisible();
    await expect(page.getByTestId('placement-hint')).toContainText('This box goes into the file here');
    // Letter: 250 × 60 pt, 20 pt from the right and bottom edges.
    const shown = await boxViewRect(page);
    expectSameRect(shown, { x: (612 - 270) / 612, y: (792 - 80) / 792, width: 250 / 612, height: 60 / 792 });
    await expect(signatureBox(page)).toContainText('Digitally signed by: Your name');

    await enterName(page, 'Ada Lovelace');
    await expect(signatureBox(page)).toContainText('Digitally signed by: Ada Lovelace');
    const bytes = await signAndDownload(page);

    const widgets = await readSignatureWidgets(bytes);
    expect(widgets.map((w) => w.pageIndex)).toEqual([0]);
    expectSameRect(widgets[0].rect, shown);
    const [field] = await readSignatureFields(bytes);
    expect(field.appearance, 'the box is the field appearance').not.toBeNull();
    expect(field.appearance!.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(field.appearance!.bbox.map(Math.round)).toEqual([0, 0, 250, 60]);
    // The page shown afterwards is the signed file, on the page with the box.
    await expect(page.getByTestId('output-caption')).toHaveText('Signed — this is your file');
    await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toHaveAttribute('data-page', '1');
  });

  test('invisible signature: no visible widget on any page, and a valid signature dictionary', async ({ page }) => {
    await openDigitalSignature(page, FIXTURE.pdf3page);
    await enterName(page, 'Grace Hopper');
    await page.getByTestId('appearance-invisible').check();
    await expect(signatureBox(page)).toHaveCount(0);
    await expect(page.getByTestId('placement-hint')).toHaveText('Invisible signature: nothing is added to any page.');
    await expect(page.getByTestId('action-hint')).toHaveText('A PKCS#7 signature, with no box on any page.');

    const bytes = await signAndDownload(page);
    const widgets = await readSignatureWidgets(bytes);
    expect(widgets.length).toBe(1);
    expect(widgets.every((w) => w.empty), 'every signature widget has zero size').toBe(true);
    const fields = await readSignatureFields(bytes);
    expect(fields).toHaveLength(1);
    expect(fields[0].appearance).toBeNull();
    expect(fields[0].type).toBe('/Sig');
    expect(fields[0].subFilter).toBe('/adbe.pkcs7.detached');
    expect(fields[0].contentsHexLength).toBe(16384);
    expectWholeFileSigned(bytes);
    const v = await verifyPdfSignature(bytes);
    expect(v.contentDigestMatches && v.signatureValid).toBe(true);
    expect(v.signerCN).toBe('Grace Hopper');
    await openOptions(page);
    await expect(page.getByTestId('result-appearance')).toHaveText('Invisible signature: no box on any page.');
  });

  test('visible box moved to page 2 by drag and corner: the widget on page 2 is the box on screen', async ({ page }) => {
    await openDigitalSignature(page, FIXTURE.pdf3page);
    await enterName(page);
    await goToPage(page, 2);
    await expect(signatureBox(page)).toHaveCount(0);
    await expect(page.getByTestId('placement-hint')).toHaveText('The signature box is on page 1.');
    await page.getByTestId('move-box-here').click();
    await expect(signatureBox(page)).toBeVisible();
    const before = await boxViewRect(page);
    await dragBox(page, -180, -260, 40, 30);
    const shown = await boxViewRect(page);
    expect(shown.x).toBeLessThan(before.x - 0.1);
    expect(shown.y).toBeLessThan(before.y - 0.1);
    expect(shown.width).toBeGreaterThan(before.width);
    expect(shown.height).toBeGreaterThan(before.height);

    const bytes = await signAndDownload(page);
    const widgets = await readSignatureWidgets(bytes);
    expect(widgets.map((w) => w.pageIndex)).toEqual([1]);
    expectSameRect(widgets[0].rect, shown);
    expectWholeFileSigned(bytes);
    expect((await verifyPdfSignature(bytes)).signatureValid).toBe(true);
  });

  test('visible box on page 2 set with the millimetre fields', async ({ page }) => {
    await openDigitalSignature(page, FIXTURE.pdf3page);
    await enterName(page);
    await goToPage(page, 2);
    await page.getByTestId('move-box-here').click();
    await setBoxMm(page, { width: 80, height: 25, x: 30, y: 40 });
    const MM = 72 / 25.4;
    const expected = { x: (30 * MM) / 612, y: (40 * MM) / 792, width: (80 * MM) / 612, height: (25 * MM) / 792 };
    expectSameRect(await boxViewRect(page), expected);

    const bytes = await signAndDownload(page);
    const widgets = await readSignatureWidgets(bytes);
    expect(widgets.map((w) => w.pageIndex)).toEqual([1]);
    expectSameRect(widgets[0].rect, expected);
  });

  for (const [name, fixture, pageNumber] of [
    ['a /Rotate 90 page', FIXTURE.pdfRotate90, 2],
    ['a page with an offset CropBox', FIXTURE.pdfCropOffset, 1],
    ['a page that leaves its coordinates transformed', FIXTURE.pdfUnbalanced, 1],
  ] as const) {
    test(`on ${name}: drag and millimetres both land where shown, and the box reads upright`, async ({ page }) => {
      await openDigitalSignature(page, fixture);
      await enterName(page);
      if (pageNumber > 1) {
        await goToPage(page, pageNumber);
        await page.getByTestId('move-box-here').click();
      }
      await dragBox(page, -120, -150, 30, 20);
      const dragged = await boxViewRect(page);
      let bytes = await signAndDownload(page);
      let widgets = await readSignatureWidgets(bytes);
      expect(widgets.map((w) => w.pageIndex)).toEqual([pageNumber - 1]);
      expectSameRect(widgets[0].rect, dragged);
      const [field] = await readSignatureFields(bytes);
      // Turned with the page, so the reader sees it upright: /Rotate 90 → 90° counter-clockwise.
      expect(field.appearance!.matrix).toEqual(name.includes('Rotate') ? [0, 1, -1, 0, 0, 0] : [1, 0, 0, 1, 0, 0]);

      await page.getByTestId('edit-again').click();
      await setBoxMm(page, { width: 70, height: 20, x: 15, y: 25 });
      const typed = await boxViewRect(page);
      bytes = await signAndDownload(page);
      widgets = await readSignatureWidgets(bytes);
      expectSameRect(widgets[0].rect, typed);
      expect((await verifyPdfSignature(bytes)).signatureValid).toBe(true);
    });
  }

  test('an uploaded .p12: a wrong password is refused with an exact message; the right one signs', async ({ page }) => {
    const p12 = await makeP12('Katherine Johnson', 'orbit-1962');
    await openDigitalSignature(page, FIXTURE.pdf1page);
    await openOptions(page);
    await page.getByTestId('cert-upload').click();
    await expect(page.getByTestId('action-hint')).toHaveText('Choose your .p12 or .pfx certificate file.');
    const zone = page.getByTestId('pfx-upload');
    await expect(zone.locator('[data-testid="dropzone"][data-hydrated="true"]')).toBeVisible();
    await zone.locator('input[type="file"]').setInputFiles({ name: 'kj.p12', mimeType: 'application/x-pkcs12', buffer: p12 });
    await expect(page.getByTestId('action-hint')).toHaveText('Enter the certificate password and press Load.');

    await page.getByTestId('pfx-password').fill('wrong');
    await page.getByTestId('pfx-load').click();
    await expect(page.getByTestId('pfx-error')).toHaveText('That password does not open this certificate file. Check it and try again.');
    await expect(page.getByTestId('tool-action')).toBeDisabled();

    await page.getByTestId('pfx-password').fill('orbit-1962');
    await expect(page.getByTestId('pfx-error')).toHaveCount(0);
    await page.getByTestId('pfx-password').press('Enter');
    await expect(page.getByTestId('pfx-details')).toContainText('CN: Katherine Johnson');
    await expect(signatureBox(page)).toContainText('Digitally signed by: Katherine Johnson');

    const bytes = await signAndDownload(page);
    const v = await verifyPdfSignature(bytes);
    expect(v.signatureValid && v.contentDigestMatches).toBe(true);
    expect(v.signerCN).toBe('Katherine Johnson');
    await expect(page.getByTestId('download-p12')).toHaveCount(0);
  });

  test('a change drops the result: Make changes, then the next file has the change; another file drops it at once', async ({ page }) => {
    await openDigitalSignature(page, FIXTURE.pdf3page);
    await enterName(page);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });

    // Make changes, then move the box: the next file has the new box.
    await page.getByTestId('edit-again').click();
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await setBoxMm(page, { x: 20, y: 20 });
    const moved = await boxViewRect(page);
    const bytes = await signAndDownload(page);
    expectSameRect((await readSignatureWidgets(bytes))[0].rect, moved);

    // Choosing another file while the result is shown drops it.
    await page.getByTestId('change-file-input').setInputFiles(FIXTURE.pdf1page);
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toBeEnabled();
    await expect(page.getByTestId('signature-result')).toHaveCount(0);
  });
});
