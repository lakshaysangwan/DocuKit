/**
 * Static server for `dist/`, applying the headers from dist/_headers the way
 * Cloudflare Pages does — including the CSP, so a policy that would break a tool
 * in production breaks it here first. Lets the e2e suite run against a
 * real production build (`E2E_BASE_URL=http://localhost:4322 npx playwright test`)
 * instead of the Vite dev server, which serves workers as transformed modules
 * rather than the static hashed files users actually get.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
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

/**
 * Parse Cloudflare's _headers format: an unindented URL pattern followed by
 * indented `Name: value` lines. Only the two pattern shapes the file uses are
 * supported — an exact path, or a prefix ending in `*`.
 */
function parseHeaderRules(text) {
  const rules = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      const idx = line.indexOf(':');
      if (current && idx > 0) current.headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    } else {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
    }
  }
  return rules;
}

const headerRules = parseHeaderRules(readFileSync(path.join(root, '_headers'), 'utf8'));

function headersFor(pathname) {
  const out = {};
  for (const { pattern, headers } of headerRules) {
    const matches = pattern.endsWith('*')
      ? pathname.startsWith(pattern.slice(0, -1))
      : pathname === pattern;
    if (matches) Object.assign(out, headers);
  }
  return out;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let file = path.join(root, decodeURIComponent(url.pathname));
  try {
    const s = await stat(file).catch(() => null);
    if (!s || s.isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      ...headersFor(url.pathname),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, () => console.log(`dist/ served on http://localhost:${port}`));
