/**
 * qpdf-wasm helper — wraps Emscripten FS dance for PDF encrypt/decrypt.
 * Uses @neslinesli93/qpdf-wasm (qpdf CLI compiled to WASM).
 */
import createModule from '@neslinesli93/qpdf-wasm';
import type { QpdfInstance } from '@neslinesli93/qpdf-wasm';

// Emscripten FS has more methods than the package types declare
interface EmscriptenFSExt {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
}

type QpdfExt = QpdfInstance & { FS: QpdfInstance['FS'] & EmscriptenFSExt };

let modulePromise: Promise<QpdfExt> | null = null;

function getModule(): Promise<QpdfExt> {
  if (!modulePromise) {
    modulePromise = createModule({
      locateFile: () => '/wasm/qpdf.wasm',
    }) as Promise<QpdfExt>;
  }
  return modulePromise;
}

export async function qpdfEncrypt(
  pdfBytes: Uint8Array,
  userPassword: string,
  ownerPassword: string,
  keyLength: '128' | '256' = '256',
): Promise<Uint8Array> {
  const qpdf = await getModule();
  qpdf.FS.writeFile('/input.pdf', pdfBytes);
  try {
    qpdf.callMain([
      '--encrypt', userPassword, ownerPassword, keyLength,
      '--print=none', '--modify=none', '--',
      '/input.pdf', '/output.pdf',
    ]);
    const result = qpdf.FS.readFile('/output.pdf');
    return result;
  } finally {
    try { qpdf.FS.unlink('/input.pdf'); } catch { /* ignore */ }
    try { qpdf.FS.unlink('/output.pdf'); } catch { /* ignore */ }
  }
}

export async function qpdfDecrypt(
  pdfBytes: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const qpdf = await getModule();
  qpdf.FS.writeFile('/input.pdf', pdfBytes);
  try {
    qpdf.callMain([
      '--password=' + password, '--decrypt',
      '/input.pdf', '/output.pdf',
    ]);
    const result = qpdf.FS.readFile('/output.pdf');
    return result;
  } finally {
    try { qpdf.FS.unlink('/input.pdf'); } catch { /* ignore */ }
    try { qpdf.FS.unlink('/output.pdf'); } catch { /* ignore */ }
  }
}
