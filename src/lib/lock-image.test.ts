import { describe, it, expect } from 'vitest';
import {
  LOCK_ITERATIONS,
  buildLockedHtml,
  lockImage,
  lockedFileName,
  parseLockedHtml,
  passwordStrength,
  unlockImage,
} from './lock-image';

const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 300 }, (_, i) => (i * 37) & 255)]);

describe('lockImage / unlockImage', () => {
  it('round-trips the exact bytes through the HTML file, and a wrong password fails', async () => {
    const locked = await lockImage(IMAGE, 'image/jpeg', 'Corr3ct-Horse!');
    expect(locked.header).toMatchObject({
      v: 2,
      kdf: 'PBKDF2',
      hash: 'SHA-256',
      iterations: LOCK_ITERATIONS,
      cipher: 'AES-GCM',
      type: 'image/jpeg',
      ext: 'jpg',
    });
    // AES-GCM: the image plus a 16-byte tag; none of the image in the clear.
    expect(locked.cipher.length).toBe(IMAGE.length + 16);

    const html = buildLockedHtml(locked);
    expect(html).not.toContain('Corr3ct-Horse!');
    const back = parseLockedHtml(html);
    expect(back.header).toEqual(locked.header);
    expect(await unlockImage(back, 'Corr3ct-Horse!')).toEqual(IMAGE);
    await expect(unlockImage(back, 'corr3ct-horse!')).rejects.toThrow();
  });

  it('uses a new salt and IV every time', async () => {
    const a = await lockImage(IMAGE, 'image/jpeg', 'pw', 1000);
    const b = await lockImage(IMAGE, 'image/jpeg', 'pw', 1000);
    expect(a.header.salt).not.toBe(b.header.salt);
    expect(a.header.iv).not.toBe(b.header.iv);
    expect(Buffer.from(a.cipher).equals(Buffer.from(b.cipher))).toBe(false);
  });

  it('refuses a type it does not know and an empty password', async () => {
    await expect(lockImage(IMAGE, 'text/html', 'pw', 1000)).rejects.toThrow(/not an image/);
    await expect(lockImage(IMAGE, 'image/jpeg', '', 1000)).rejects.toThrow(/password/);
  });

  it('keeps the header JSON from closing its script element', async () => {
    const locked = await lockImage(IMAGE, 'image/png', 'pw', 1000);
    const html = buildLockedHtml({ ...locked, header: { ...locked.header, type: '</script><script>alert(1)</script>' } });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(parseLockedHtml(html).header.type).toBe('</script><script>alert(1)</script>');
  });
});

describe('lockedFileName', () => {
  it('replaces the extension', () => {
    expect(lockedFileName('holiday.jpg')).toBe('holiday-locked.html');
    expect(lockedFileName('a.b.png')).toBe('a.b-locked.html');
    expect(lockedFileName('noext')).toBe('noext-locked.html');
  });
});

describe('passwordStrength', () => {
  it('grades by length and character kinds; short stays weak', () => {
    expect(passwordStrength('').label).toBe('Very weak');
    expect(passwordStrength('Ab1!').label).toBe('Weak');
    expect(passwordStrength('abcdefgh').label).toBe('Weak');
    expect(passwordStrength('abcdefgh12').label).toBe('Fair');
    expect(passwordStrength('Corr3ct-Horse!').label).toBe('Strong');
  });
});
