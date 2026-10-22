import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { uploadBuffer } from './harness';

/**
 * Encrypted PDFs for the Unlock PDF tests, made here in Node by qpdf itself
 * rather than through Protect PDF in the browser: an Unlock test then fails
 * only when Unlock is wrong, and needs no round trip through another tool.
 */

const WASM = fileURLToPath(new URL('../../../node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm', import.meta.url));

interface Qpdf {
  callMain(args: string[]): number;
  FS: { writeFile(path: string, data: Uint8Array): void; readFile(path: string): Uint8Array; unlink(path: string): void };
}

let qpdf: Promise<Qpdf> | null = null;

function getQpdf(): Promise<Qpdf> {
  if (!qpdf) {
    qpdf = import('@neslinesli93/qpdf-wasm').then(async (mod) => {
      const create = (mod as unknown as { default: (opts: object) => Promise<Qpdf> }).default;
      return create({ locateFile: () => WASM });
    });
  }
  return qpdf;
}

export interface EncryptOptions {
  /** The open (user) password. Omit for a restrictions-only file, which opens without one. */
  user?: string;
  /** The permissions (owner) password. */
  owner: string;
  /** Withhold every permission (the default), or grant them all. */
  allow?: 'nothing' | 'everything';
}

/** `source` (a path or bytes) encrypted with AES-256. */
export async function encryptPdf(source: string | Buffer, { user, owner, allow = 'nothing' }: EncryptOptions): Promise<Buffer> {
  const bytes = typeof source === 'string' ? await readFile(source) : source;
  const q = await getQpdf();
  const yn = allow === 'everything' ? 'y' : 'n';
  q.FS.writeFile('/in.pdf', new Uint8Array(bytes));
  try {
    q.callMain([
      '--encrypt',
      ...(user ? [`--user-password=${user}`] : []),
      `--owner-password=${owner}`,
      '--bits=256',
      `--print=${allow === 'everything' ? 'full' : 'none'}`,
      `--extract=${yn}`,
      `--modify-other=${yn}`,
      `--annotate=${yn}`,
      `--form=${yn}`,
      `--assemble=${yn}`,
      '--',
      '/in.pdf',
      '/out.pdf',
    ]);
    return Buffer.from(q.FS.readFile('/out.pdf'));
  } finally {
    for (const path of ['/in.pdf', '/out.pdf']) {
      try {
        q.FS.unlink(path);
      } catch {
        /* not there */
      }
    }
  }
}

/** Go to `slug` and add `bytes` as `name`. */
export async function addPdfBuffer(page: Page, slug: string, bytes: Buffer, name = 'locked.pdf') {
  await page.goto(`/${slug}`);
  await uploadBuffer(page, { name, mimeType: 'application/pdf', buffer: bytes });
}
