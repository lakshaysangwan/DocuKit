import { type Page, expect } from '@playwright/test';
import { webcrypto } from 'node:crypto';
import { expectDownload, expectImageRendered, uploadFiles } from './harness';
import { openOptions } from './compress-image';

export { openOptions };

/**
 * Helpers for Lock Image's workspace. What they check is the file: the HTML
 * that downloads is read back with the tool's own format (a JSON header and the
 * base64 ciphertext in two script elements) and decrypted here, in Node, with
 * the parameters the header names.
 */

/** Open Lock Image with a file and wait until the image is drawn. */
export async function openLock(page: Page, file: string) {
  await page.goto('/lock-image');
  await uploadFiles(page, file);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expectImageRendered(page.getByTestId('compare-before'), 45_000);
}

/** Type the password in both fields, opening Options on a phone first. */
export async function typePasswords(page: Page, password: string, confirm = password) {
  await openOptions(page);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('confirm-password').fill(confirm);
}

/** Lock, wait for the download in the action's place, and download the file. */
export async function lockAndDownload(page: Page) {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
  return expectDownload(page, () => page.getByTestId('download-button').click());
}

export interface LockedFile {
  header: {
    v: number;
    kdf: string;
    hash: string;
    iterations: number;
    cipher: string;
    salt: string;
    iv: string;
    type: string;
    ext: string;
  };
  cipher: Buffer;
}

/** Read the header and ciphertext out of a locked HTML file. */
export function readLockedHtml(html: string): LockedFile {
  const head = /<script type="application\/json" id="docukit-lock">([\s\S]*?)<\/script>/.exec(html);
  const data = /<script type="text\/plain" id="docukit-data">([\s\S]*?)<\/script>/.exec(html);
  expect(head, 'the file has its header').toBeTruthy();
  expect(data, 'the file has its data').toBeTruthy();
  return { header: JSON.parse(head![1]), cipher: Buffer.from(data![1].replace(/\s+/g, ''), 'base64') };
}

/**
 * Decrypt a locked file in Node with WebCrypto, deriving the key from the
 * password exactly as the header says. Rejects on a wrong password.
 */
export async function decryptLocked(file: LockedFile, password: string): Promise<Buffer> {
  const { subtle } = webcrypto;
  const material = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    {
      name: file.header.kdf,
      salt: new Uint8Array(Buffer.from(file.header.salt, 'base64')),
      iterations: file.header.iterations,
      hash: file.header.hash,
    },
    material,
    { name: file.header.cipher, length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(Buffer.from(file.header.iv, 'base64')) }, key, new Uint8Array(file.cipher));
  return Buffer.from(plain);
}
