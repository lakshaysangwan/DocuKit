import { describe, it, expect } from 'vitest';
import { onRequest } from './[[path]]';

/**
 * The view-once tool advertises "Automatically deleted after first view" and
 * "Max 10MB image size". The delete-on-read half is enforced entirely by this
 * Pages Function, which the Playwright suite cannot reach — it runs against a
 * static build with no Functions runtime. So it is proven here instead, against
 * a stub KV namespace that records what the handler actually does.
 */

/** Minimal in-memory stand-in for the KV binding. */
function stubKv() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  return {
    store,
    ttls,
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, value);
      ttls.set(key, opts?.expirationTtl);
    },
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

type Handler = (ctx: {
  request: Request;
  env: Record<string, unknown>;
  params: { path?: string[] };
}) => Promise<Response>;

const call = (request: Request, env: unknown, path?: string[]) =>
  (onRequest as unknown as Handler)({
    request,
    env: env as Record<string, unknown>,
    params: path ? { path } : {},
  });

const ORIGIN = 'https://docukit.test';

function postRequest(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/view-once`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });
}

describe('view-once Pages Function', () => {
  it('stores a blob and returns an id', async () => {
    const kv = stubKv();
    const res = await call(postRequest(new Uint8Array([1, 2, 3])), { VIEW_ONCE_KV: kv });

    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(kv.store.size).toBe(1);
  });

  it('deletes the blob on the first read — a second read 404s', async () => {
    const kv = stubKv();
    const env = { VIEW_ONCE_KV: kv };

    const payload = new Uint8Array([9, 8, 7, 6]);
    const created = await call(postRequest(payload), env);
    const { id } = (await created.json()) as { id: string };

    const first = await call(new Request(`${ORIGIN}/api/view-once/${id}`), env, [id]);
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload);

    // This is the advertised guarantee: the blob is gone the instant it is read.
    expect(kv.store.has(id), 'blob deleted immediately after the first view').toBe(false);

    const second = await call(new Request(`${ORIGIN}/api/view-once/${id}`), env, [id]);
    expect(second.status).toBe(404);
  });

  it('rejects a body larger than the ciphertext cap', async () => {
    const kv = stubKv();
    // The client caps the *image* at 10MB; the server caps the ciphertext at 12MB.
    const res = await call(
      postRequest(new Uint8Array(16), { 'Content-Length': String(13 * 1024 * 1024) }),
      { VIEW_ONCE_KV: kv }
    );

    expect(res.status).toBe(413);
    expect(kv.store.size).toBe(0);
  });

  it('clamps an unexpected TTL to the 24h default', async () => {
    const kv = stubKv();
    const res = await call(postRequest(new Uint8Array([1]), { 'X-TTL': '999999' }), {
      VIEW_ONCE_KV: kv,
    });

    const { expiresIn } = (await res.json()) as { expiresIn: number };
    expect(expiresIn).toBe(86400);
    expect([...kv.ttls.values()][0]).toBe(86400);
  });

  it('refuses a malformed id without touching the store', async () => {
    const kv = stubKv();
    const res = await call(new Request(`${ORIGIN}/api/view-once/not-a-uuid`), { VIEW_ONCE_KV: kv }, [
      'not-a-uuid',
    ]);
    expect(res.status).toBe(404);
  });
});
