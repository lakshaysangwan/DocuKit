import { describe, it, expect } from 'vitest';
import {
  fromBase64Any,
  openSealed,
  packPayload,
  parseLink,
  safeImageType,
  sealImage,
  shareLink,
  toBase64Url,
  unpackPayload,
} from './view-once';

const IMAGE = new Uint8Array(Array.from({ length: 500 }, (_, i) => (i * 13) & 255));
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('view-once sealing', () => {
  it('uploads only ciphertext and the link opens it', async () => {
    const sealed = await sealImage(IMAGE, 'image/png');
    // The ciphertext is the payload plus a 16-byte tag, and does not contain the image.
    expect(sealed.cipher.length).toBe(2 + 'image/png'.length + IMAGE.length + 16);
    expect(Buffer.from(sealed.cipher).includes(Buffer.from(IMAGE.subarray(0, 32)))).toBe(false);

    const url = new URL(shareLink('https://docukit.test', ID, sealed.fragment));
    expect(url.pathname).toBe(`/view/${ID}`);
    // Key and IV only after the '#', in base64url.
    expect(url.hash).toMatch(/^#[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}$/);

    const link = parseLink(url.pathname, url.hash);
    if ('error' in link) throw new Error(link.error);
    const opened = await openSealed(sealed.cipher, link);
    expect(opened.type).toBe('image/png');
    expect(opened.image).toEqual(IMAGE);
  });

  it('a different key does not open it', async () => {
    const a = await sealImage(IMAGE, 'image/png');
    const b = await sealImage(IMAGE, 'image/png');
    const link = parseLink(`/view/${ID}`, `#${b.fragment}`);
    if ('error' in link) throw new Error(link.error);
    await expect(openSealed(a.cipher, link)).rejects.toThrow();
  });
});

describe('parseLink', () => {
  it('reads links made before base64url', () => {
    const key = new Uint8Array(32).fill(251);
    const iv = new Uint8Array(12).fill(255);
    const std = `${Buffer.from(key).toString('base64')}.${Buffer.from(iv).toString('base64')}`;
    const link = parseLink(`/view/${ID}`, `#${std}`);
    expect('error' in link).toBe(false);
    if (!('error' in link)) {
      expect(link.key).toEqual(key);
      expect(link.iv).toEqual(iv);
    }
  });

  it('says what is wrong with an incomplete link', () => {
    expect(parseLink('/view/', '#abc.def')).toHaveProperty('error');
    expect(parseLink(`/view/${ID}`, '')).toHaveProperty('error');
    expect(parseLink(`/view/${ID}`, '#short.iv')).toHaveProperty('error');
    expect('error' in parseLink(`/view/${ID}/`, `#${toBase64Url(new Uint8Array(32))}.${toBase64Url(new Uint8Array(12))}`)).toBe(false);
  });
});

describe('payload', () => {
  it('packs and unpacks the type with the bytes', () => {
    const p = unpackPayload(packPayload('image/webp', IMAGE));
    expect(p.type).toBe('image/webp');
    expect(p.image).toEqual(IMAGE);
    expect(() => unpackPayload(new Uint8Array([0, 50, 1]))).toThrow();
  });

  it('only image types are treated as images', () => {
    expect(safeImageType('image/jpeg')).toBe('image/jpeg');
    expect(safeImageType('text/html')).toBeNull();
    expect(safeImageType('image/svg+xml')).toBeNull();
    expect(safeImageType('constructor')).toBeNull();
  });

  it('base64url round-trips', () => {
    const bytes = new Uint8Array([251, 255, 254, 0, 1]);
    expect(fromBase64Any(toBase64Url(bytes))).toEqual(bytes);
  });
});
