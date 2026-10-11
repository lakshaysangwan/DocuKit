/**
 * Independent readers for a PDF's security settings.
 *
 * Nothing here goes through the app's own code: the permission flags are read
 * by scanning the /Encrypt dictionary and, separately, by pdf.js; which password
 * a string turns out to be is decided by MuPDF. A test that asked the encryptor
 * what it wrote would only prove the encryptor agrees with itself.
 */

/** Bit values of the /P permission field (ISO 32000-1, table 22). Set = granted. */
export const PERMISSION_BIT = {
  print: 4, // bit 3
  modify: 8, // bit 4
  copy: 16, // bit 5
  annotate: 32, // bit 6
  fillForms: 256, // bit 9
  accessibility: 512, // bit 10
  assemble: 1024, // bit 11
  printHighQuality: 2048, // bit 12
} as const;

const ALL_PERMISSION_BITS = Object.values(PERMISSION_BIT).reduce((a, b) => a | b, 0);

/**
 * The /P value a file should carry for a set of granted bits: the two reserved
 * bits 7-8 and everything from bit 13 up must be 1, so the stored integer is
 * negative. Returned signed, exactly as it is written in the file.
 */
export function expectedRawFlags(granted: number): number {
  return (0xfffff0c0 | granted) | 0;
}

/**
 * The raw /P integer, found by following the trailer's /Encrypt reference to
 * its dictionary. The encryption dictionary is never itself encrypted and may
 * not sit in an object stream, so a byte scan is sound.
 */
export function readRawPermissionFlags(bytes: Buffer): number | null {
  const text = bytes.toString('latin1');
  const ref = /\/Encrypt\s+(\d+)\s+(\d+)\s+R/.exec(text);
  if (!ref) return null;
  const start = text.search(new RegExp(`(^|[\\r\\n])${ref[1]}\\s+${ref[2]}\\s+obj\\b`));
  if (start === -1) return null;
  const dict = text.slice(start, text.indexOf('endobj', start));
  const p = /\/P\s+(-?\d+)/.exec(dict);
  return p ? Number(p[1]) : null;
}

/** The granted permission bits only (reserved bits masked off). */
export function readGrantedBits(bytes: Buffer): number | null {
  const raw = readRawPermissionFlags(bytes);
  return raw === null ? null : raw & ALL_PERMISSION_BITS;
}

/** The cipher and handler revision named in the /Encrypt dictionary. */
export function readCipher(bytes: Buffer): { cfm: string | null; revision: number | null; version: number | null } {
  const text = bytes.toString('latin1');
  const at = text.search(/\/Filter\s*\/Standard\b/);
  const dict = at === -1 ? '' : text.slice(Math.max(0, at - 200), at + 1200);
  const num = (key: string) => {
    const m = new RegExp(`/${key}\\s+(\\d+)`).exec(dict);
    return m ? Number(m[1]) : null;
  };
  return { cfm: /\/CFM\s*\/(\w+)/.exec(dict)?.[1] ?? null, revision: num('R'), version: num('V') };
}

export type PdfJsOpenResult =
  | { opened: true; permissions: number[] | null; pages: number }
  | { opened: false; reason: 'needs-password' | 'wrong-password' | 'other'; message: string };

/**
 * Open a PDF with pdf.js, optionally with a password, and report the
 * permissions it sees. `permissions` is null for an unencrypted file, otherwise
 * the list of granted PermissionFlag values (the same numbers as PERMISSION_BIT).
 */
export async function openWithPdfJs(bytes: Buffer, password?: string): Promise<PdfJsOpenResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  try {
    const doc = await task.promise;
    const permissions = await doc.getPermissions();
    const pages = doc.numPages;
    await doc.destroy();
    return { opened: true, permissions: permissions ? [...permissions].sort((a, b) => a - b) : null, pages };
  } catch (err) {
    const e = err as { name?: string; code?: number; message?: string };
    await task.destroy().catch(() => {});
    if (e.name === 'PasswordException') {
      // pdf.js: code 1 = a password is needed, code 2 = the one given is wrong.
      return { opened: false, reason: e.code === 2 ? 'wrong-password' : 'needs-password', message: e.message ?? '' };
    }
    return { opened: false, reason: 'other', message: e.message ?? String(err) };
  }
}

/** The list pdf.js should report for a set of granted bits. */
export function bitsToPdfJsList(granted: number): number[] {
  return Object.values(PERMISSION_BIT)
    .filter((bit) => (granted & bit) !== 0)
    .sort((a, b) => a - b);
}

export type PasswordRole = 'rejected' | 'user' | 'owner' | 'user-and-owner';

/**
 * Ask MuPDF which password a string is for this file.
 *
 * This is what decides whether restrictions apply at all: a reader that is
 * handed the *owner* password must lift every restriction, so a file whose open
 * password also authenticates as owner restricts nobody.
 */
export async function passwordRole(
  bytes: Buffer,
  password: string
): Promise<{ needsPassword: boolean; role: PasswordRole }> {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  try {
    const needsPassword = doc.needsPassword();
    // MuPDF: 0 = rejected, bit 2 = user password, bit 4 = owner password.
    const code = doc.authenticatePassword(password);
    const user = (code & 2) !== 0;
    const owner = (code & 4) !== 0;
    const role: PasswordRole = user && owner ? 'user-and-owner' : owner ? 'owner' : user ? 'user' : 'rejected';
    return { needsPassword, role };
  } finally {
    doc.destroy();
  }
}
