import { type BrowserContext, type Page, expect } from '@playwright/test';
import { randomUUID, webcrypto } from 'node:crypto';
import { expectImageRendered, uploadFiles } from './harness';
import { openOptions } from './compress-image';

export { openOptions };

/**
 * Helpers for View-Once Image. The e2e suite runs against a static build with
 * no Pages Functions, and must never touch the production API, so the API is
 * stubbed in the browser context: an in-memory store that, like
 * functions/api/view-once, answers a POST with an id and hands a blob over once
 * on GET, deleting it. Every request it sees is recorded, so a test can read
 * exactly what would have reached the server.
 */

export interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

export interface StubApi {
  /** Every request to /api/view-once, in order. */
  seen: SeenRequest[];
  store: Map<string, Buffer>;
  /** Answer the next POST with this status instead of storing it. */
  failNextPost: (status: number) => void;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export async function stubViewOnceApi(context: BrowserContext): Promise<StubApi> {
  const api: StubApi = { seen: [], store: new Map(), failNextPost: () => {} };
  let fail: number | null = null;
  api.failNextPost = (status) => (fail = status);
  await context.route(/\/api\/view-once(\/.*)?$/, async (route) => {
    const req = route.request();
    const body = req.postDataBuffer();
    api.seen.push({ method: req.method(), url: req.url(), headers: await req.allHeaders(), body });
    const json = (status: number, data: unknown) =>
      route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(data) });
    if (req.method() === 'POST' && /\/api\/view-once$/.test(new URL(req.url()).pathname)) {
      if (fail !== null) {
        const status = fail;
        fail = null;
        return json(status, { error: 'stubbed failure' });
      }
      if (!body || body.length === 0) return json(400, { error: 'Missing body' });
      const id = randomUUID();
      api.store.set(id, body);
      const ttl = Number(req.headers()['x-ttl']);
      return json(201, { id, expiresIn: [3600, 21600, 86400, 604800].includes(ttl) ? ttl : 86400 });
    }
    const id = UUID.exec(new URL(req.url()).pathname)?.[0];
    if (req.method() === 'GET' && id) {
      const blob = api.store.get(id);
      if (!blob) return json(404, { error: 'Not found or already viewed' });
      api.store.delete(id);
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'Cache-Control': 'no-store' }, body: blob });
    }
    return json(404, { error: 'Not found' });
  });
  return api;
}

/**
 * Cloudflare serves /view/<id> from the static /view/ page (functions/view);
 * the static test server has no such rewrite, so the context does it.
 */
export async function routeViewPages(context: BrowserContext, baseURL: string) {
  await context.route(/\/view\/[0-9a-f-]{36}\/?$/, async (route) => {
    const response = await route.fetch({ url: new URL('/view/', baseURL).toString() });
    await route.fulfill({ response });
  });
}

/** Open View-Once with a file (API stubbed) and wait until the image is drawn. */
export async function openViewOnce(page: Page, file: string): Promise<StubApi> {
  const api = await stubViewOnceApi(page.context());
  await page.goto('/view-once-image');
  await uploadFiles(page, file);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expectImageRendered(page.getByTestId('compare-before'), 45_000);
  return api;
}

/** Press the action and wait for the link. */
export async function createLink(page: Page): Promise<string> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
  return page.getByTestId('share-link').inputValue();
}

function fromBase64Url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** The key and IV from a link's fragment. */
export function linkSecrets(link: string): { id: string; key: Buffer; iv: Buffer; fragment: string } {
  const url = new URL(link);
  const fragment = url.hash.slice(1);
  const [key, iv] = fragment.split('.');
  return { id: url.pathname.split('/').pop()!, key: fromBase64Url(key), iv: fromBase64Url(iv), fragment };
}

/** Decrypt an uploaded body with a link's key: the type and the image bytes. */
export async function decryptUpload(body: Buffer, link: string): Promise<{ type: string; image: Buffer }> {
  const { key, iv } = linkSecrets(link);
  const k = await webcrypto.subtle.importKey('raw', new Uint8Array(key), { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, k, new Uint8Array(body)));
  const len = plain.readUInt16BE(0);
  return { type: plain.subarray(2, 2 + len).toString('utf8'), image: plain.subarray(2 + len) };
}

/**
 * Make a link the way an attacker could: any type, any bytes, sealed with a
 * fresh key and put straight into the stub's store.
 */
export async function plantLink(api: StubApi, origin: string, type: string, bytes: Buffer): Promise<string> {
  const raw = webcrypto.getRandomValues(new Uint8Array(32));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await webcrypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const typeBytes = Buffer.from(type, 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(typeBytes.length);
  const cipher = Buffer.from(
    await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(Buffer.concat([head, typeBytes, bytes]))),
  );
  const id = randomUUID();
  api.store.set(id, cipher);
  const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
  return `${origin}/view/${id}#${b64u(raw)}.${b64u(iv)}`;
}
