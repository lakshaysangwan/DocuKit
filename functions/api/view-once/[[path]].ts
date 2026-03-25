/**
 * Cloudflare Pages Function — View-Once Image
 *
 * POST /api/view-once      — Store encrypted blob in KV with TTL
 * GET  /api/view-once/:id  — Read (and immediately delete) encrypted blob from KV
 *
 * The encryption key lives in the URL fragment (#key) — never sent to the server.
 *
 * KV binding "VIEW_ONCE_KV" must be configured in Cloudflare Pages Settings → Bindings.
 */

interface Env {
  VIEW_ONCE_KV: KVNamespace;
  ALLOWED_ORIGIN?: string;
}

const MAX_BODY_BYTES = 12 * 1024 * 1024;

function corsHeaders(origin: string | null, allowedOrigin: string): Record<string, string> {
  if (origin && origin !== allowedOrigin) return {};
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-TTL',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowedOrigin = env.ALLOWED_ORIGIN || url.origin;
  const cors = corsHeaders(origin, allowedOrigin);

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // Extract the sub-path after /api/view-once/
  // [[path]] catches: "" (POST to /api/view-once) and ":id" (GET to /api/view-once/:id)
  const subpath = (context.params.path as string[] || []).join('/');

  // POST /api/view-once — create
  if (request.method === 'POST' && !subpath) {
    const contentLength = parseInt(request.headers.get('Content-Length') ?? '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: 'Payload too large' }, 413, cors);
    }

    const body = await request.arrayBuffer();
    if (!body || body.byteLength === 0) {
      return json({ error: 'Missing body' }, 400, cors);
    }

    const ttlHeader = parseInt(request.headers.get('X-TTL') ?? '86400', 10);
    const allowedTtls = [3600, 21600, 86400, 604800];
    const ttl = allowedTtls.includes(ttlHeader) ? ttlHeader : 86400;

    const id = crypto.randomUUID();

    // Store as base64 (KV values are strings)
    const bytes = new Uint8Array(body);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    const b64 = btoa(binary);

    await env.VIEW_ONCE_KV.put(id, b64, { expirationTtl: ttl });

    return json({ id, expiresIn: ttl }, 201, cors);
  }

  // GET /api/view-once/:id — read and delete
  if (request.method === 'GET' && subpath && /^[0-9a-f-]{36}$/.test(subpath)) {
    const b64 = await env.VIEW_ONCE_KV.get(subpath);

    if (!b64) {
      return json({ error: 'Not found or already viewed' }, 404, cors);
    }

    // Delete immediately — view-once semantics
    await env.VIEW_ONCE_KV.delete(subpath);

    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream', ...cors },
    });
  }

  return json({ error: 'Not found' }, 404, cors);
};
