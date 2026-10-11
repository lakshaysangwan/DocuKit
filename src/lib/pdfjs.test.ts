import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('pdf.js call sites', () => {
  /**
   * PDFJS_DOC_ASSETS carries the font/cMap/WASM URLs and the shared worker.
   * A getDocument() without it renders with missing fonts on some machines and
   * goes back to owning the worker, which reopens the "worker is being
   * destroyed" race that Crop PDF's Flatten mode used to hit.
   */
  it('every getDocument() call spreads PDFJS_DOC_ASSETS', () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/\bgetDocument\(/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
        calls++;
        // The options object may be spread over the next few lines.
        const call = lines.slice(i, i + 4).join(' ');
        if (!call.includes('...PDFJS_DOC_ASSETS')) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(calls).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});
