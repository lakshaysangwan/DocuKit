import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { addSingleFileAndWait, uploadBuffer, expectDownload, assertPdf, extractPdfText } from '../helpers/harness';
import {
  PERMISSION_BIT,
  expectedRawFlags,
  readRawPermissionFlags,
  readGrantedBits,
  readCipher,
  openWithPdfJs,
  bitsToPdfJsList,
  passwordRole,
} from '../helpers/pdf-security';

/**
 * Protect PDF: what the permission checkboxes and the two passwords really put
 * in the file.
 *
 * The tool used to ignore every checkbox (each output allowed copying and
 * forbade printing, whatever was ticked) and used the open password as the
 * owner password too, so whoever opened the file held full rights. These tests
 * read the output with readers that are not the app's own code — a scan of the
 * /Encrypt dictionary, pdf.js, and MuPDF — and pin the whole truth table.
 */

const OPEN_PW = 'Open-Sesame-2026';
const OWNER_PW = 'Owner-Only-9731';

type PermissionKey = 'print' | 'copyContents' | 'modifyContents' | 'fillForms' | 'annotations' | 'assemble';
const KEYS: PermissionKey[] = ['print', 'copyContents', 'modifyContents', 'fillForms', 'annotations', 'assemble'];

/**
 * The bits each checkbox must grant. Printing grants both print bits (there is
 * no low-resolution-only choice), and commenting grants form filling as well,
 * because the PDF specification defines the annotation bit to include it.
 */
const GRANTS: Record<PermissionKey, number> = {
  print: PERMISSION_BIT.print | PERMISSION_BIT.printHighQuality,
  copyContents: PERMISSION_BIT.copy,
  modifyContents: PERMISSION_BIT.modify,
  fillForms: PERMISSION_BIT.fillForms,
  annotations: PERMISSION_BIT.annotate | PERMISSION_BIT.fillForms,
  assemble: PERMISSION_BIT.assemble,
};

/** Extraction for accessibility is never withheld — screen readers must keep working. */
const ALWAYS_GRANTED = PERMISSION_BIT.accessibility;

function expectedBits(allowed: PermissionKey[]): number {
  return allowed.reduce<number>((bits, key) => bits | GRANTS[key], ALWAYS_GRANTED);
}

function permissionBox(page: Page, key: PermissionKey) {
  return page.getByTestId(`perm-${key}`);
}

async function setPermissions(page: Page, allowed: PermissionKey[]) {
  // Commenting first: while it is on, "Fill in forms" is locked on with it.
  const order: PermissionKey[] = ['annotations', ...KEYS.filter((k) => k !== 'annotations')];
  for (const key of order) {
    if (key === 'fillForms' && allowed.includes('annotations')) continue;
    await permissionBox(page, key).setChecked(allowed.includes(key));
  }
}

async function openProtect(page: Page, fixture: string = FIXTURE.pdf3page) {
  await page.goto('/protect-pdf');
  await addSingleFileAndWait(page, fixture);
}

async function fillOpenPassword(page: Page, password: string) {
  await page.getByTestId('password').fill(password);
  await page.getByTestId('confirm-password').fill(password);
}

async function protectAndDownload(page: Page): Promise<Buffer> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
  const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
  assertPdf(bytes);
  return bytes;
}

/** Both independent readers must report exactly these granted bits. */
async function expectFlags(bytes: Buffer, granted: number, password: string | undefined, label: string) {
  expect(readRawPermissionFlags(bytes), `${label}: raw /P in the /Encrypt dictionary`).toBe(expectedRawFlags(granted));
  const opened = await openWithPdfJs(bytes, password);
  expect(opened.opened, `${label}: pdf.js should open the file`).toBe(true);
  if (opened.opened) {
    expect(opened.permissions, `${label}: pdf.js getPermissions()`).toEqual(bitsToPdfJsList(granted));
  }
}

const single = (key: PermissionKey): PermissionKey[] => [key];
/** Withholding form filling means withholding commenting too (see GRANTS). */
const allBut = (key: PermissionKey): PermissionKey[] =>
  KEYS.filter((k) => k !== key && !(key === 'fillForms' && k === 'annotations'));

const TRUTH_TABLE: { name: string; allowed: PermissionKey[] }[] = [
  { name: 'nothing allowed', allowed: [] },
  { name: 'everything allowed', allowed: [...KEYS] },
  ...KEYS.map((key) => ({ name: `only ${key} allowed`, allowed: single(key) })),
  ...KEYS.map((key) => ({ name: `everything but ${key} allowed`, allowed: allBut(key) })),
];

test.describe('Protect PDF — permission flags written to the file', () => {
  for (const { name, allowed } of TRUTH_TABLE) {
    test(`flags: ${name}`, async ({ page }) => {
      await openProtect(page);
      await fillOpenPassword(page, OPEN_PW);
      await setPermissions(page, allowed);
      const bytes = await protectAndDownload(page);
      await expectFlags(bytes, expectedBits(allowed), OPEN_PW, name);
    });
  }

  test('allowing comments locks form filling on, and the file grants both', async ({ page }) => {
    await openProtect(page);
    await fillOpenPassword(page, OPEN_PW);
    await setPermissions(page, []);
    await permissionBox(page, 'annotations').setChecked(true);
    await expect(permissionBox(page, 'fillForms')).toBeChecked();
    await expect(permissionBox(page, 'fillForms')).toBeDisabled();
    const bytes = await protectAndDownload(page);
    expect(readGrantedBits(bytes)).toBe(
      PERMISSION_BIT.annotate | PERMISSION_BIT.fillForms | PERMISSION_BIT.accessibility
    );
  });

  test('the output is AES-256 (revision 6) whatever is restricted', async ({ page }) => {
    await openProtect(page);
    await fillOpenPassword(page, OPEN_PW);
    await setPermissions(page, []);
    const bytes = await protectAndDownload(page);
    expect(readCipher(bytes)).toEqual({ cfm: 'AESV3', revision: 6, version: 5 });
    // Metadata is encrypted with everything else (no /EncryptMetadata false).
    expect(bytes.toString('latin1')).not.toMatch(/\/EncryptMetadata\s+false/);
  });
});

test.describe('Protect PDF — passwords', () => {
  test('open password only: opening with it gives a restricted session, not owner rights', async ({ page }) => {
    await openProtect(page);
    await fillOpenPassword(page, OPEN_PW);
    await setPermissions(page, ['print']);
    const bytes = await protectAndDownload(page);

    // The file cannot be opened without a password, or with a wrong one.
    const noPassword = await openWithPdfJs(bytes);
    expect(noPassword).toMatchObject({ opened: false, reason: 'needs-password' });
    const wrong = await openWithPdfJs(bytes, 'not-the-password');
    expect(wrong).toMatchObject({ opened: false, reason: 'wrong-password' });
    expect(await passwordRole(bytes, '')).toEqual({ needsPassword: true, role: 'rejected' });

    // The open password is the user password only — so the restrictions apply.
    expect(await passwordRole(bytes, OPEN_PW)).toEqual({ needsPassword: true, role: 'user' });
    const opened = await openWithPdfJs(bytes, OPEN_PW);
    expect(opened.opened).toBe(true);
    if (opened.opened) {
      expect(opened.permissions).toContain(PERMISSION_BIT.print);
      expect(opened.permissions).not.toContain(PERMISSION_BIT.copy);
      expect(opened.permissions).not.toContain(PERMISSION_BIT.modify);
    }

    // A separate permissions password was generated, shown, and is the owner password.
    const generated = await page.getByTestId('generated-owner-password').inputValue();
    expect(generated.length, 'generated permissions password length').toBeGreaterThanOrEqual(20);
    expect(generated).not.toBe(OPEN_PW);
    expect(await passwordRole(bytes, generated)).toEqual({ needsPassword: true, role: 'owner' });
  });

  test('a generated permissions password is different every time', async ({ page }) => {
    await openProtect(page);
    await fillOpenPassword(page, OPEN_PW);
    await protectAndDownload(page);
    const first = await page.getByTestId('generated-owner-password').inputValue();
    // In the workspace the download takes the action's place; Make changes brings it back.
    await page.getByTestId('edit-again').click();
    await page.getByTestId('tool-action').click();
    await expect
      .poll(async () => page.getByTestId('generated-owner-password').inputValue(), { timeout: 45_000 })
      .not.toBe(first);
  });

  test('open password plus my own permissions password: each plays its own role', async ({ page }) => {
    await openProtect(page);
    await fillOpenPassword(page, OPEN_PW);
    await page.getByTestId('owner-password').fill(OWNER_PW);
    await setPermissions(page, []);
    const bytes = await protectAndDownload(page);

    expect(await passwordRole(bytes, OPEN_PW)).toEqual({ needsPassword: true, role: 'user' });
    expect(await passwordRole(bytes, OWNER_PW)).toEqual({ needsPassword: true, role: 'owner' });
    await expectFlags(bytes, expectedBits([]), OPEN_PW, 'own permissions password');
    // Nothing was generated, so nothing is shown.
    await expect(page.getByTestId('generated-owner-password')).toHaveCount(0);
  });

  test('a permissions password equal to the open password is refused', async ({ page }) => {
    await openProtect(page);
    await fillOpenPassword(page, OPEN_PW);
    await page.getByTestId('owner-password').fill(OPEN_PW);
    // The action is not offered while the passwords clash, and says why.
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText(
      'The permissions password must be different from the password that opens the file.'
    );
    await expect(page.getByTestId('owner-password-error')).toBeVisible();
    await expect(page.getByTestId('download-button')).toHaveCount(0);
  });

  test('restrictions only: opens without a password, still restricted', async ({ page }) => {
    await openProtect(page);
    await page.getByTestId('mode-restrict').check();
    await expect(page.getByTestId('password')).toHaveCount(0);
    await expect(page.getByTestId('no-open-password-note')).toBeVisible();
    await page.getByTestId('owner-password').fill(OWNER_PW);
    await setPermissions(page, ['print', 'fillForms']);
    const bytes = await protectAndDownload(page);

    // Anyone can open and read it — that is what this mode means.
    expect(await passwordRole(bytes, '')).toEqual({ needsPassword: false, role: 'user' });
    expect(await extractPdfText(bytes)).toContain('Test Document');
    await expectFlags(bytes, expectedBits(['print', 'fillForms']), undefined, 'restrictions only');
    // Only the permissions password lifts the restrictions.
    expect(await passwordRole(bytes, OWNER_PW)).toEqual({ needsPassword: false, role: 'owner' });
  });

  test('restrictions only with no permissions password generates one', async ({ page }) => {
    await openProtect(page);
    await page.getByTestId('mode-restrict').check();
    await setPermissions(page, []);
    const bytes = await protectAndDownload(page);
    const generated = await page.getByTestId('generated-owner-password').inputValue();
    expect(await passwordRole(bytes, '')).toEqual({ needsPassword: false, role: 'user' });
    expect(await passwordRole(bytes, generated)).toEqual({ needsPassword: false, role: 'owner' });
  });

  // qpdf reads an argument starting with "@" as a file of arguments and one
  // starting with "--" as an option, so these passwords used to fail outright.
  for (const awkward of ['@t-the-start-1', '--print=full', 'pä55wörd 日本 ✓']) {
    test(`a password like ${JSON.stringify(awkward)} works as typed`, async ({ page }) => {
      await openProtect(page);
      await fillOpenPassword(page, awkward);
      const bytes = await protectAndDownload(page);
      expect(await passwordRole(bytes, awkward)).toEqual({ needsPassword: true, role: 'user' });
    });
  }
});

test.describe('Protect PDF — what the screen says about restrictions', () => {
  test('says plainly that restrictions depend on the reader', async ({ page }) => {
    await openProtect(page);
    const note = page.getByTestId('permissions-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('Adobe Acrobat');
    await expect(note).toContainText('Firefox');
    await expect(note).toContainText(/ignore/i);
    // No promise that copying or printing is prevented.
    await expect(page.locator('#main-content')).not.toContainText(/prevents? (copying|printing|editing)/i);
  });
});

test.describe('Unlock PDF — files made by Protect PDF', () => {
  /** `password` null: a file that opens without one, so no password field is offered. */
  async function unlock(page: Page, encrypted: Buffer, password: string | null): Promise<Buffer> {
    await page.goto('/unlock-pdf');
    await uploadBuffer(page, { name: 'protected.pdf', mimeType: 'application/pdf', buffer: encrypted });
    await expect(page.getByTestId('file-info')).toBeVisible({ timeout: 15_000 });
    if (password !== null) await page.getByTestId('unlock-password').fill(password);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    return bytes;
  }

  async function expectUnlocked(bytes: Buffer) {
    expect(bytes.toString('latin1')).not.toContain('/Encrypt');
    const opened = await openWithPdfJs(bytes);
    expect(opened).toMatchObject({ opened: true, permissions: null, pages: 3 });
    expect(await extractPdfText(bytes)).toContain('Test Document');
  }

  test('round-trips with the open password and with the permissions password', async ({ page }) => {
    await openProtect(page);
    await fillOpenPassword(page, OPEN_PW);
    await page.getByTestId('owner-password').fill(OWNER_PW);
    await setPermissions(page, []);
    const encrypted = await protectAndDownload(page);

    await expectUnlocked(await unlock(page, encrypted, OPEN_PW));
    await expectUnlocked(await unlock(page, encrypted, OWNER_PW));
  });

  // qpdf removes the encryption with any password that opens the file, and a
  // restrictions-only file opens with none, so none is asked for.
  test('a restrictions-only file unlocks with no password', async ({ page }) => {
    await openProtect(page);
    await page.getByTestId('mode-restrict').check();
    await page.getByTestId('owner-password').fill(OWNER_PW);
    await setPermissions(page, []);
    const encrypted = await protectAndDownload(page);

    await expectUnlocked(await unlock(page, encrypted, null));
  });
});
