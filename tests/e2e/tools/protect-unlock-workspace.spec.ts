import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { addSingleFileAndWait, expectDownload, assertPdf, extractPdfText } from '../helpers/harness';
import { openWithPdfJs, passwordRole, readRawPermissionFlags } from '../helpers/pdf-security';
import { encryptPdf, addPdfBuffer } from '../helpers/encrypted-pdf';

/**
 * Protect PDF and Unlock PDF in the shared workspace: what the visitor sees of
 * the document before and after, and what the downloaded file really is.
 *
 * Encrypted inputs are made in Node by qpdf (helpers/encrypted-pdf.ts), and
 * every download is read back by pdf.js and MuPDF, not by the app's own code.
 */

const OPEN_PW = 'Open-Sesame-2026';
const OWNER_PW = 'Owner-Only-9731';
const WRONG_PASSWORD = 'That password does not open this file.';
const NOT_A_PDF = 'This file could not be read as a PDF.';

const rendered = (page: Page) => page.locator('[data-testid="page-canvas"][data-rendered="true"]');

async function openOptions(page: Page) {
  const toggle = page.getByTestId('options-toggle');
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

async function downloadResult(page: Page): Promise<{ bytes: Buffer; name: string }> {
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
  const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
  assertPdf(bytes);
  return { bytes, name };
}

/** No encryption left, three readable pages, no restrictions. */
async function expectUnlocked(bytes: Buffer) {
  expect(bytes.toString('latin1')).not.toContain('/Encrypt');
  expect(await openWithPdfJs(bytes)).toMatchObject({ opened: true, permissions: null, pages: 3 });
  expect(await extractPdfText(bytes)).toContain('Test Document');
}

test.describe('Protect PDF in the workspace', () => {
  test('shows the document before protecting it', async ({ page }) => {
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(page.getByTestId('workspace')).toBeVisible();
    await expect(rendered(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('page-indicator')).toHaveText('Page 1 of 3');
    await expect(page.getByTestId('action-hint')).toHaveText('Enter a password that will open the file.');
    await expect(page.getByTestId('tool-action')).toBeDisabled();
  });

  test('a PDF that already has a password is recognised on upload and sent to Unlock PDF', async ({ page }) => {
    await addPdfBuffer(page, 'protect-pdf', await encryptPdf(FIXTURE.pdf3page, { user: OPEN_PW, owner: OWNER_PW }));
    await openOptions(page);
    const warning = page.getByTestId('already-encrypted');
    await expect(warning).toBeVisible({ timeout: 30_000 });
    await expect(warning).toContainText('This PDF already has a password.');
    await expect(page.getByTestId('unlock-link')).toHaveAttribute('href', '/unlock-pdf/');
    await expect(page.getByTestId('already-protected-stage')).toBeVisible();
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('This PDF already has a password. Remove it with Unlock PDF first.');
    // The protect form is not offered for it.
    await expect(page.getByTestId('password')).toHaveCount(0);
  });

  test('a PDF that already has restrictions is recognised too, and its pages are shown', async ({ page }) => {
    await addPdfBuffer(page, 'protect-pdf', await encryptPdf(FIXTURE.pdf3page, { owner: OWNER_PW }));
    await openOptions(page);
    await expect(page.getByTestId('already-encrypted')).toContainText('This PDF already has restrictions.', { timeout: 30_000 });
    await expect(rendered(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('This PDF already has restrictions. Remove them with Unlock PDF first.');
  });

  test('after protecting, the file is locked and "Check it opens" tries a password on it', async ({ page }) => {
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await openOptions(page);
    await page.getByTestId('password').fill(OPEN_PW);
    await page.getByTestId('confirm-password').fill(OPEN_PW);
    await page.getByTestId('tool-action').click();
    const { bytes, name } = await downloadResult(page);
    expect(name).toMatch(/-protected\.pdf$/);
    expect(readRawPermissionFlags(bytes)).not.toBeNull();
    expect(await passwordRole(bytes, OPEN_PW)).toEqual({ needsPassword: true, role: 'user' });

    const stage = page.getByTestId('protected-stage');
    await expect(stage).toBeVisible();
    await expect(page.getByTestId('protected-stage-title')).toHaveText('This file now asks for its password');
    await expect(page.getByTestId('page-canvas')).toHaveCount(0);

    // A wrong password is said so in place.
    await page.getByTestId('check-password').fill('not-it');
    await page.getByTestId('check-password').press('Enter');
    await expect(page.getByTestId('check-error')).toHaveText(WRONG_PASSWORD);

    // The right one opens the real output, and page 1 is drawn from it.
    await page.getByTestId('check-password').fill(OPEN_PW);
    await page.getByTestId('check-open').click();
    await expect(rendered(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('page-indicator')).toHaveText('Page 1 of 3');
    await expect(page.getByTestId('output-caption')).toHaveText('It opens with that password — this is your protected file.');
    // Still downloadable.
    await expect(page.getByTestId('download-button')).toBeVisible();
  });

  test('restrictions only: the protected file is shown at once, with no lock', async ({ page }) => {
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await openOptions(page);
    await page.getByTestId('mode-restrict').check();
    await page.getByTestId('owner-password').fill(OWNER_PW);
    await page.getByTestId('tool-action').click();
    const { bytes } = await downloadResult(page);
    expect(await passwordRole(bytes, '')).toEqual({ needsPassword: false, role: 'user' });
    await expect(page.getByTestId('protected-stage')).toHaveCount(0);
    await expect(rendered(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('output-caption')).toContainText('opens without a password');
  });
});

test.describe('Unlock PDF in the workspace', () => {
  test('a locked file shows a placeholder until its open password opens it; then its pages, then the unlocked file', async ({ page }) => {
    await addPdfBuffer(page, 'unlock-pdf', await encryptPdf(FIXTURE.pdf3page, { user: OPEN_PW, owner: OWNER_PW }));
    await expect(page.getByTestId('locked-stage')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('locked-stage-title')).toHaveText('This PDF is locked');
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('Enter the password that opens this file.');
    await expect(page.getByTestId('encryption-algorithm')).toHaveText('AES-256');

    await openOptions(page);
    await page.getByTestId('unlock-password').fill(OPEN_PW);
    await page.getByTestId('unlock-password').press('Enter');
    await expect(page.getByTestId('locked-stage')).toHaveCount(0);
    await expect(rendered(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('page-indicator')).toHaveText('Page 1 of 3');
    await expect(page.getByTestId('unlock-caption')).toHaveText('Opened with your password. Check this is the right file.');

    await page.getByTestId('tool-action').click();
    const { bytes, name } = await downloadResult(page);
    expect(name).toBe('locked-unlocked.pdf');
    await expectUnlocked(bytes);

    // The stage now shows the output, with no lock.
    await expect(page.getByTestId('output-caption')).toHaveText('Unlocked — this is your file. It opens with no password.');
    await expect(page.getByTestId('page-image')).toHaveAttribute('alt', /^Unlocked page/, { timeout: 30_000 });
    await expect(rendered(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('locked-stage')).toHaveCount(0);
  });

  test('the permissions password unlocks it too', async ({ page }) => {
    await addPdfBuffer(page, 'unlock-pdf', await encryptPdf(FIXTURE.pdf3page, { user: OPEN_PW, owner: OWNER_PW }));
    await openOptions(page);
    await page.getByTestId('unlock-password').fill(OWNER_PW);
    await page.getByTestId('unlock-open').click();
    await expect(rendered(page)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tool-action').click();
    await expectUnlocked((await downloadResult(page)).bytes);
  });

  test('a restrictions-only file opens with no password, shows its restrictions, and unlocks with none', async ({ page }) => {
    await addPdfBuffer(page, 'unlock-pdf', await encryptPdf(FIXTURE.pdf3page, { owner: OWNER_PW }));
    await expect(rendered(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('locked-stage')).toHaveCount(0);
    await openOptions(page);
    await expect(page.getByTestId('restrictions-only')).toContainText('No password is needed to remove them');
    await expect(page.getByTestId('encryption-allowed')).toHaveText('Allowed: nothing beyond opening the file');
    await expect(page.getByTestId('unlock-password')).toHaveCount(0);
    await expect(page.getByTestId('action-hint')).toHaveText('Saves a copy without the restrictions. No password is needed.');
    await page.getByTestId('tool-action').click();
    await expectUnlocked((await downloadResult(page)).bytes);
  });

  test('a wrong password is named as such, on opening and on unlocking', async ({ page }) => {
    await addPdfBuffer(page, 'unlock-pdf', await encryptPdf(FIXTURE.pdf3page, { user: OPEN_PW, owner: OWNER_PW }));
    await openOptions(page);
    await page.getByTestId('unlock-password').fill('wrong-password');
    await page.getByTestId('unlock-password').press('Enter');
    await expect(page.getByTestId('unlock-password-error')).toHaveText(WRONG_PASSWORD);
    await expect(page.getByTestId('locked-stage')).toBeVisible();

    // Pressing Unlock PDF with it goes to qpdf, which refuses it the same way.
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('action-error')).toHaveText(WRONG_PASSWORD, { timeout: 30_000 });
    await expect(page.getByTestId('download-button')).toHaveCount(0);
  });

  test('a file that is not a PDF is said to be unreadable, not locked', async ({ page }) => {
    await addPdfBuffer(page, 'unlock-pdf', Buffer.from('This is plain text, not a PDF at all.\n'.repeat(20)), 'notes.pdf');
    await expect(page.getByTestId('unreadable-stage-title')).toHaveText(NOT_A_PDF, { timeout: 30_000 });
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText(NOT_A_PDF);
    await expect(page.getByTestId('locked-stage')).toHaveCount(0);
  });

  test('a PDF with no encryption has nothing to unlock', async ({ page }) => {
    await page.goto('/unlock-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(rendered(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('This PDF has no password or restrictions, so there is nothing to unlock.');
  });
});
