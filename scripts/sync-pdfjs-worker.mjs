/**
 * Copies the pdf.js worker from the installed pdfjs-dist into /public so the
 * served worker (/pdfjs/pdf.worker.min.mjs) can never drift from the bundled
 * API version. Runs on `postinstall`. Keeping these in lockstep prevents the
 * "API version does not match the Worker version" class of bug.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';

const src = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'build', 'pdf.worker.min.mjs');
const destDir = path.join(root, 'public', 'pdfjs');
const dest = path.join(destDir, 'pdf.worker.min.mjs');

await mkdir(destDir, { recursive: true });
await copyFile(src, dest);

const { version } = require('pdfjs-dist/package.json');
console.log(`✓ synced pdf.js worker (v${version}) → public/pdfjs/pdf.worker.min.mjs`);
