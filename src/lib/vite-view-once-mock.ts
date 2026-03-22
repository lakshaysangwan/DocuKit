/**
 * Vite dev server middleware that mocks the /api/view-once endpoint.
 * Uses an in-memory Map (like KV) so view-once works locally without Cloudflare.
 */
import type { Plugin } from 'vite';

export function viewOnceMockPlugin(): Plugin {
  const store = new Map<string, { data: Buffer; expires: number }>();

  return {
    name: 'view-once-mock',
    configureServer(server) {
      // Rewrite /view/:uuid → /view/ so Astro dev server serves view/index.astro
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/view\/[0-9a-f-]{36}/.test(req.url)) {
          req.url = '/view/';
        }
        next();
      });

      server.middlewares.use('/api/view-once', async (req, res) => {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TTL');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url ?? '/', 'http://localhost');

        // POST /api/view-once — store
        if (req.method === 'POST' && url.pathname === '/') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks);

          const ttl = parseInt(req.headers['x-ttl'] as string ?? '86400', 10);
          const id = crypto.randomUUID();
          store.set(id, { data: body, expires: Date.now() + ttl * 1000 });

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, expiresIn: ttl }));
          return;
        }

        // GET /api/view-once/:id — read and delete
        const idMatch = url.pathname.match(/^\/([0-9a-f-]{36})$/);
        if (req.method === 'GET' && idMatch) {
          const id = idMatch[1];
          const entry = store.get(id);

          if (!entry || entry.expires < Date.now()) {
            store.delete(id);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found or already viewed' }));
            return;
          }

          // View-once: delete immediately
          store.delete(id);

          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(entry.data);
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });
    },
  };
}
