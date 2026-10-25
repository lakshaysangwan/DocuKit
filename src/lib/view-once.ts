/**
 * View-Once Image: what is encrypted, what is uploaded, and what the link holds.
 *
 *   plaintext  = uint16 (big-endian) length of the type · the type (UTF-8) · the image bytes
 *   ciphertext = AES-256-GCM(plaintext) under a new random key and 12-byte IV
 *
 * Only the ciphertext is uploaded (POST /api/view-once, with the expiry in an
 * `X-TTL` header). The server answers with an id. The link is
 *
 *   https://docukit.uk/view/<id>#<key>.<iv>
 *
 * with the key and IV in base64url after the `#`. Browsers do not send the part
 * after `#` to the server, so the server holds bytes it cannot decrypt, and the
 * link alone opens the image. The first GET of the id returns the ciphertext and
 * deletes it (functions/api/view-once).
 *
 * Links made before base64url (standard base64 with + / =) still open.
 */

import { bytesToBase64, base64ToBytes } from './lock-image';

export const VIEW_ONCE_API = '/api/view-once';

/** Expiry choices; the server accepts exactly these and falls back to 24 hours. */
export const VIEW_ONCE_TTLS = [
  { label: '1 hour', seconds: 3600 },
  { label: '6 hours', seconds: 21600 },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
] as const;

export const DEFAULT_TTL = 86400;

/**
 * Types the recipient's page will hand to the browser as an image. Anything
 * else in a decrypted payload (a link can be made by anyone, with any bytes in
 * it) is treated as plain data, so it can never be opened as a page or script
 * on this site.
 */
export const VIEW_ONCE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function safeImageType(type: string): string | null {
  return Object.prototype.hasOwnProperty.call(VIEW_ONCE_TYPES, type) ? type : null;
}

/* ── base64url ──────────────────────────────────────────────────────────── */

export function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Accepts base64url and standard base64. */
export function fromBase64Any(s: string): Uint8Array {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return base64ToBytes(b64);
}

/* ── payload ────────────────────────────────────────────────────────────── */

export function packPayload(type: string, image: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(2 + typeBytes.length + image.length);
  new DataView(out.buffer).setUint16(0, typeBytes.length, false);
  out.set(typeBytes, 2);
  out.set(image, 2 + typeBytes.length);
  return out;
}

export function unpackPayload(plain: Uint8Array): { type: string; image: Uint8Array } {
  if (plain.length < 2) throw new Error('The image data is incomplete.');
  const len = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint16(0, false);
  if (2 + len > plain.length) throw new Error('The image data is incomplete.');
  const type = new TextDecoder().decode(plain.subarray(2, 2 + len));
  return { type, image: plain.slice(2 + len) };
}

/* ── seal / open ────────────────────────────────────────────────────────── */

export interface Sealed {
  /** What is uploaded. */
  cipher: Uint8Array;
  /** What goes in the link, after the `#`: `<key>.<iv>`. */
  fragment: string;
}

/** Encrypt an image under a new random key. */
export async function sealImage(image: Uint8Array, type: string): Promise<Sealed> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, packPayload(type, image) as BufferSource),
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return { cipher, fragment: `${toBase64Url(raw)}.${toBase64Url(iv)}` };
}

export function shareLink(origin: string, id: string, fragment: string): string {
  return `${origin}/view/${id}#${fragment}`;
}

export interface ParsedLink {
  id: string;
  key: Uint8Array;
  iv: Uint8Array;
}

/** Read `/view/<id>` and `#<key>.<iv>`. Returns a reason when the link is not whole. */
export function parseLink(pathname: string, hash: string): ParsedLink | { error: string } {
  const id = pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  const fragment = hash.replace(/^#/, '');
  if (!UUID.test(id)) return { error: 'This link is not complete: the part after /view/ is missing or changed.' };
  const dot = fragment.lastIndexOf('.');
  if (!fragment || dot < 1) return { error: 'This link is not complete: the key after the # is missing. Ask for the whole link.' };
  try {
    const key = fromBase64Any(fragment.slice(0, dot));
    const iv = fromBase64Any(fragment.slice(dot + 1));
    if (key.length !== 32 || iv.length !== 12) throw new Error('size');
    return { id, key, iv };
  } catch {
    return { error: 'This link is not complete: the key after the # is damaged. Ask for the whole link.' };
  }
}

/** Decrypt what the server returned. Throws when the key does not fit. */
export async function openSealed(cipher: Uint8Array, link: ParsedLink): Promise<{ type: string; image: Uint8Array }> {
  const key = await crypto.subtle.importKey('raw', link.key as BufferSource, { name: 'AES-GCM', length: 256 }, false, [
    'decrypt',
  ]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: link.iv as BufferSource }, key, cipher as BufferSource),
  );
  return unpackPayload(plain);
}

/** "24 hours" for 86400. */
export function ttlLabel(seconds: number): string {
  return VIEW_ONCE_TTLS.find((t) => t.seconds === seconds)?.label ?? `${Math.round(seconds / 3600)} hours`;
}
