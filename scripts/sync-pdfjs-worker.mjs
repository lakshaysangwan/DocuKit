/**
 * Copies pdf.js runtime assets from the installed pdfjs-dist into /public so the
 * served copies can never drift from the bundled API version. Runs on
 * `postinstall`. Keeping these in lockstep prevents the "API version does not
 * match the Worker version" class of bug.
 *
 * Beyond the worker, pdf.js fetches several asset bundles *at render time*:
 *
 *   standard_fonts/  the Foxit substitutes for the 14 PDF base fonts. Only
 *                    requested when the host has no matching system font — so
 *                    Chrome/Firefox on a normal desktop never ask for them and
 *                    the omission stays invisible, while WebKit (and any machine
 *                    without Helvetica) fails to render text at all.
 *   cmaps/           character maps for CJK encodings.
 *   wasm/            jbig2 / openjpeg / qcms decoders for scanned + JPEG2000 PDFs.
 *   iccs/            ICC profile used for CMYK colour conversion.
 *
 * All four are copied wholesale; they're only fetched on demand, so serving them
 * costs nothing until a document actually needs one.
 */
import { copyFile, mkdir, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';

const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
const destDir = path.join(root, 'public', 'pdfjs');

await mkdir(destDir, { recursive: true });
await copyFile(
  path.join(pkgDir, 'build', 'pdf.worker.min.mjs'),
  path.join(destDir, 'pdf.worker.min.mjs')
);

// Asset bundles pdf.js fetches lazily at render time.
for (const dir of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) {
  await cp(path.join(pkgDir, dir), path.join(destDir, dir), { recursive: true });
}

const { version } = require('pdfjs-dist/package.json');
console.log(`✓ synced pdf.js v${version} (worker + standard_fonts, cmaps, wasm, iccs) → public/pdfjs/`);
