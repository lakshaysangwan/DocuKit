/**
 * Cloudflare Worker — View-Once Image
 *
 * POST /api/view-once   — Store encrypted blob in KV with TTL
 * GET  /api/view-once/:id — Read (and immediately delete) encrypted blob from KV
 *
 * The encryption key is stored in the URL fragment (#key) on the client side —
 * it is never sent to this server per HTTP spec.
 */

export interface Env {
  VIEW_ONCE_KV: KVNamespace;
  ALLOWED_ORIGIN: string;
}

const MAX_BODY_BYTES = 12 * 1024 * 1024; // 10MB image + ~20% base64 overhead
const RATE_LIMIT_CREATE = 10;
const RATE_LIMIT_READ = 60;

// Simple CORS headers
function corsHeaders(origin: string | null, allowedOrigin: string): HeadersInit {
  if (origin !== allowedOrigin && origin !== null) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-TTL',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

  // Check Content-Length to guard against huge uploads before reading body
  const contentLength = parseInt(request.headers.get('Content-Length') ?? '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'Payload too large' }, 413, cors);
  }

  // Accept binary body (application/octet-stream) with TTL in X-TTL header
  const body = await request.arrayBuffer();
  if (!body || body.byteLength === 0) {
    return jsonResponse({ error: 'Missing body' }, 400, cors);
  }

  // Validate TTL from header: 1h, 6h, 24h, or 7d
  const ttlHeader = parseInt(request.headers.get('X-TTL') ?? '86400', 10);
  const allowedTtls = [3600, 21600, 86400, 604800];
  const ttl = allowedTtls.includes(ttlHeader) ? ttlHeader : 86400;

  // Generate a cryptographically random UUID
  const id = crypto.randomUUID();

  // Store as base64 since KV values are strings
  const bytes = new Uint8Array(body);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const b64 = btoa(binary);

  await env.VIEW_ONCE_KV.put(id, b64, { expirationTtl: ttl });

  return jsonResponse({ id, expiresIn: ttl }, 201, cors);
}

async function handleRead(id: string, request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    return jsonResponse({ error: 'Invalid ID' }, 400, cors);
  }

  const b64 = await env.VIEW_ONCE_KV.get(id);

  if (!b64) {
    return jsonResponse({ error: 'Not found or already viewed' }, 404, cors);
  }

  // Delete immediately — view-once semantics
  await env.VIEW_ONCE_KV.delete(id);

  // Decode base64 back to binary
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', ...cors },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/api/view-once' && request.method === 'POST') {
      return handleCreate(request, env);
    }

    const readMatch = url.pathname.match(/^\/api\/view-once\/([0-9a-f-]{36})$/);
    if (readMatch && request.method === 'GET') {
      return handleRead(readMatch[1], request, env);
    }

    return jsonResponse({ error: 'Not found' }, 404, cors);
  },
};
