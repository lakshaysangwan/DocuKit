import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, expectDownload, expectImageRendered, uploadBuffer } from '../helpers/harness';
import { decryptLocked, lockAndDownload, openLock, readLockedHtml, typePasswords } from '../helpers/lock-image';

const PW = 'Corr3ct-Horse-Battery!';

/**
 * Lock Image encrypts the image's own bytes into one HTML file. These tests
 * read that file: decrypt it here with the parameters its header names, and
 * open it from disk with the network cut off, unlock it and save the image —
 * which must be the uploaded file, byte for byte.
 */
test.describe('Lock Image', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/lock-image');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Lock Image with Password');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('the image is shown large and the action waits for a password, saying why', async ({ page }) => {
    await openLock(page, FIXTURE.jpg);
    await expect(page.getByTestId('file-info')).toHaveAttribute('data-filename', 'photo.jpg');
    await expect(page.getByTestId('stage-status')).toContainText('JPEG, 1200 × 800 px');
    const action = page.getByTestId('tool-action');
    const hint = page.getByTestId('action-hint');
    await expect(action).toBeDisabled();
    await expect(hint).toHaveText('Type a password to lock the image with');

    await page.getByTestId('password').fill('short');
    await expect(hint).toHaveText('Type the password again to confirm it');
    await page.getByTestId('confirm-password').fill('shorx');
    await expect(hint).toHaveText('The two passwords do not match');
    await expect(page.getByTestId('password-mismatch')).toBeVisible();

    // The strength bar rises with a longer, mixed password.
    const weak = Number(await page.getByTestId('password-strength').getAttribute('data-score'));
    await typePasswords(page, PW);
    await expect(action).toBeEnabled();
    const strong = Number(await page.getByTestId('password-strength').getAttribute('data-score'));
    expect(weak).toBeLessThanOrEqual(1);
    expect(strong).toBe(4);
    await expect(page.getByTestId('lock-explainer')).toContainText('photo-locked.html');
    await expect(page.getByTestId('lock-explainer')).toContainText('600,000 rounds');
  });

  test('the download decrypts, with the password and the parameters it names, to the exact original; nothing is sent', async ({
    page,
    baseURL,
  }) => {
    await openLock(page, FIXTURE.jpg);
    await typePasswords(page, PW);

    const sent: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('blob:') || url.startsWith('data:')) return;
      if (!url.startsWith(baseURL!) || req.postDataBuffer()) sent.push(`${req.method()} ${url}`);
    });
    const { bytes, name } = await lockAndDownload(page);
    expect(sent, 'requests that left the page or carried data').toEqual([]);

    expect(name).toBe('photo-locked.html');
    const html = bytes.toString('utf8');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).not.toContain(PW);
    const locked = readLockedHtml(html);
    expect(locked.header).toMatchObject({
      v: 2,
      kdf: 'PBKDF2',
      hash: 'SHA-256',
      iterations: 600000,
      cipher: 'AES-GCM',
      type: 'image/jpeg',
      ext: 'jpg',
    });
    expect(Buffer.from(locked.header.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(locked.header.iv, 'base64')).toHaveLength(12);

    const original = await readFile(FIXTURE.jpg);
    // AES-GCM: same length as the image plus the 16-byte tag, none of the image in the clear.
    expect(locked.cipher.length).toBe(original.length + 16);
    expect(locked.cipher.includes(original.subarray(200, 232))).toBe(false);
    expect((await decryptLocked(locked, PW)).equals(original), 'decrypts to the uploaded bytes').toBe(true);
    await expect(decryptLocked(locked, `${PW}x`)).rejects.toThrow();

    // The result pane says what the file is and how it is opened.
    await expect(page.getByTestId('facts-heading')).toHaveText('photo-locked.html');
    await expect(page.getByTestId('lock-facts')).toContainText('open the file in a web browser');
    await expect(page.getByTestId('result-summary')).toContainText('photo-locked.html');
  });

  test('the file opens from disk with no network: a wrong password shows nothing, the right one gives back the original', async ({
    page,
  }, testInfo) => {
    await openLock(page, FIXTURE.png);
    await typePasswords(page, PW);
    const { bytes } = await lockAndDownload(page);

    const file = testInfo.outputPath('graphic-locked.html');
    await writeFile(file, bytes);
    const network: string[] = [];
    await page.route(/^https?:/, (route) => {
      network.push(route.request().url());
      return route.abort();
    });
    await page.goto(pathToFileURL(file).toString());
    await expect(page.getByRole('heading', { name: 'Locked image' })).toBeVisible();

    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Unlock image' }).click();
    await expect(page.getByRole('alert')).toContainText('Wrong password', { timeout: 20_000 });
    await expect(page.locator('#out')).toBeHidden();

    await page.getByLabel('Password').fill(PW);
    await page.getByRole('button', { name: 'Unlock image' }).click();
    const img = page.getByAltText('The unlocked image');
    await expectImageRendered(img, 20_000);

    const saved = await expectDownload(page, () => page.getByRole('link', { name: 'Save image' }).click());
    expect(saved.name).toBe('graphic.png');
    expect(saved.bytes.equals(await readFile(FIXTURE.png)), 'saved image is the original, byte for byte').toBe(true);
    expect(network, 'the locked file contacted nothing').toEqual([]);
  });

  test('changing the password after locking drops the result', async ({ page }) => {
    await openLock(page, FIXTURE.jpg);
    await typePasswords(page, PW);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('edit-again').click();
    await page.getByTestId('password').fill('another-one');
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await expect(page.getByTestId('action-hint')).toHaveText('The two passwords do not match');
  });

  test('HEIC is shown on the stage and locked as it is', async ({ page }) => {
    await openLock(page, FIXTURE.heic);
    await expect(page.getByTestId('stage-status')).toContainText('HEIC');
    await expect(page.getByTestId('heic-note')).toBeVisible();
    await typePasswords(page, PW);
    const { bytes } = await lockAndDownload(page);
    const locked = readLockedHtml(bytes.toString('utf8'));
    expect(locked.header.type).toBe('image/heic');
    expect((await decryptLocked(locked, PW)).equals(await readFile(FIXTURE.heic))).toBe(true);
  });

  test('a file that is not an image is not locked, and says why', async ({ page }) => {
    await page.goto('/lock-image');
    await uploadBuffer(page, { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('just some text, not an image at all') });
    await expect(page.getByTestId('workspace')).toBeVisible();
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('notes.png is not an image this tool can lock');
    await expect(page.getByTestId('step-prompt')).toContainText('cannot be locked');
  });
});
