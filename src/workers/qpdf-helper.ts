/**
 * qpdf-wasm helper — wraps Emscripten FS dance for PDF encrypt/decrypt.
 * Uses @neslinesli93/qpdf-wasm (qpdf CLI compiled to WASM).
 */
import createModule from '@neslinesli93/qpdf-wasm';
import type { QpdfInstance } from '@neslinesli93/qpdf-wasm';
import { readEncryptionInfo } from '../lib/pdf-encryption-info';
import {
  decryptFailureMessage,
  passwordProblem,
  permissionsToFlags,
  permissionsToQpdfArgs,
  type ProtectPermissions,
} from '../lib/pdf-protect';

// Emscripten FS has more methods than the package types declare
interface EmscriptenFSExt {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
}

type QpdfExt = QpdfInstance & { FS: QpdfInstance['FS'] & EmscriptenFSExt };

let modulePromise: Promise<QpdfExt> | null = null;

/**
 * What qpdf printed on stderr since it was last read. qpdf says why it wrote
 * nothing only there ("invalid password", "can't find PDF header"), and that is
 * how a wrong password is told apart from an unreadable file. qpdf never
 * prints a password.
 */
let stderrLines: string[] = [];
function takeStderr(): string {
  const text = stderrLines.join('\n');
  stderrLines = [];
  return text;
}

function getModule(): Promise<QpdfExt> {
  if (!modulePromise) {
    // This build of qpdf ignores a `printErr` option: it binds `console.error`
    // for its stderr as the module is created (synchronously, inside the call
    // below). So for that moment `console.error` is a function that keeps the
    // lines instead, and qpdf holds on to it from then on.
    const original = console.error;
    console.error = (...parts: unknown[]) => {
      stderrLines.push(parts.join(' '));
      if (stderrLines.length > 50) stderrLines.shift();
    };
    try {
      modulePromise = createModule({
        // Absolute, not root-relative: this may run inside a blob: worker (see
        // worker-pool.createWorker), where a leading-slash path has no valid base
        // to resolve against and the fetch fails outright.
        locateFile: () => new URL('/wasm/qpdf.wasm', self.location.origin).href,
      }) as Promise<QpdfExt>;
    } finally {
      console.error = original;
    }
  }
  return modulePromise;
}

/**
 * Lossless structural compression: bundle objects into object streams and
 * (re)compress all stream data at max flate level. No image/quality loss — this
 * is the "Low" tier and a final pass for every tier. Returns the original bytes
 * unchanged if qpdf fails or doesn't actually shrink the file.
 */
export async function qpdfCompress(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const qpdf = await getModule();
  qpdf.FS.writeFile('/input.pdf', pdfBytes);
  try {
    qpdf.callMain([
      '--object-streams=generate',
      '--compress-streams=y',
      '--recompress-flate',
      '--compression-level=9',
      '--',
      '/input.pdf', '/output.pdf',
    ]);
    const result = qpdf.FS.readFile('/output.pdf');
    return result.byteLength > 0 && result.byteLength < pdfBytes.byteLength ? result : pdfBytes;
  } catch {
    return pdfBytes;
  } finally {
    try { qpdf.FS.unlink('/input.pdf'); } catch { /* ignore */ }
    try { qpdf.FS.unlink('/output.pdf'); } catch { /* ignore */ }
  }
}

export interface QpdfEncryptOptions {
  /** Opens the file with the restrictions in force. Empty = opens without a prompt. */
  userPassword: string;
  /** Opens the file with no restrictions. Must be set and differ from the user password. */
  ownerPassword: string;
  /** What someone holding only the user password may do. Anything left out is withheld. */
  permissions?: Partial<ProtectPermissions>;
}

/**
 * Encrypt with AES-256 (PDF 2.0, handler revision 6).
 *
 * Passwords go in as `--user-password=…` / `--owner-password=…`, never as bare
 * arguments: qpdf reads a bare argument starting with "@" as a file of
 * arguments and one starting with "--" as an option, so a password of either
 * shape used to fail (and the generator can produce a leading "@").
 */
export async function qpdfEncrypt(
  pdfBytes: Uint8Array,
  { userPassword, ownerPassword, permissions }: QpdfEncryptOptions,
): Promise<Uint8Array> {
  const problem = passwordProblem(userPassword, ownerPassword);
  if (problem) throw new Error(problem);

  const qpdf = await getModule();
  qpdf.FS.writeFile('/input.pdf', pdfBytes);
  try {
    qpdf.callMain([
      '--encrypt',
      ...(userPassword ? [`--user-password=${userPassword}`] : []),
      `--owner-password=${ownerPassword}`,
      '--bits=256',
      ...permissionsToQpdfArgs(permissions),
      '--',
      '/input.pdf', '/output.pdf',
    ]);
    let result: Uint8Array;
    try {
      result = qpdf.FS.readFile('/output.pdf');
    } catch {
      // qpdf wrote nothing: most often the input is itself password-protected.
      throw new Error('This PDF could not be encrypted. If it already has a password, unlock it first.');
    }
    // Hand back only a file that says what was asked for. The checkboxes were
    // once ignored without anyone noticing; this makes that impossible to repeat.
    const written = readEncryptionInfo(result);
    if (!written.encrypted || written.permissionFlags !== permissionsToFlags(permissions)) {
      throw new Error('The encrypted file did not carry the chosen permissions, so it was not saved.');
    }
    return result;
  } finally {
    try { qpdf.FS.unlink('/input.pdf'); } catch { /* ignore */ }
    try { qpdf.FS.unlink('/output.pdf'); } catch { /* ignore */ }
  }
}

/**
 * Remove a file's encryption. `password` may be the open (user) password, the
 * permissions (owner) password, or empty for a file that opens without one:
 * qpdf removes the encryption with any password that opens the file, so a
 * restrictions-only file needs none.
 *
 * Throws with a message for the visitor: the password was wrong, the file is
 * not a readable PDF, or (anything else) it could not be unlocked.
 */
export async function qpdfDecrypt(
  pdfBytes: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const qpdf = await getModule();
  qpdf.FS.writeFile('/input.pdf', pdfBytes);
  takeStderr();
  try {
    try {
      qpdf.callMain([
        '--password=' + password, '--decrypt',
        '/input.pdf', '/output.pdf',
      ]);
    } catch {
      /* qpdf's failure is reported through what it wrote (or did not), below */
    }
    let result: Uint8Array;
    try {
      result = qpdf.FS.readFile('/output.pdf');
    } catch {
      throw new Error(decryptFailureMessage(takeStderr()));
    }
    // Hand back only a file that really has no encryption left.
    if (readEncryptionInfo(result).encrypted) throw new Error(decryptFailureMessage(''));
    return result;
  } finally {
    try { qpdf.FS.unlink('/input.pdf'); } catch { /* ignore */ }
    try { qpdf.FS.unlink('/output.pdf'); } catch { /* ignore */ }
  }
}
