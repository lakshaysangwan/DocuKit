/**
 * Static server for `dist/`, applying the same cross-origin headers that
 * public/_headers gives us on Cloudflare Pages. Lets the e2e suite run against a
 * real production build (`E2E_BASE_URL=http://localhost:4322 npx playwright test`)
 * instead of the Vite dev server, which serves workers as transformed modules
 * rather than the static hashed files users actually get.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT ?? 4322);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream', '.icc': 'application/vnd.iccprofile',
  '.txt': 'text/plain', '.xml': 'application/xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let file = path.join(root, decodeURIComponent(url.pathname));
  try {
    const s = await stat(file).catch(() => null);
    if (!s || s.isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      // Mirrors public/_headers.
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, () => console.log(`dist/ served on http://localhost:${port}`));
