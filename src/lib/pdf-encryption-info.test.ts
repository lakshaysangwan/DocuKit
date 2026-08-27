import { describe, it, expect } from 'vitest';
import { readEncryptionInfo } from './pdf-encryption-info';

/**
 * The unlock tool advertises "Shows original encryption details". Those details
 * come from parsing the /Encrypt dictionary out of the raw bytes, so the parser
 * is worth pinning down directly — building genuinely encrypted PDFs for every
 * handler revision would be far more machinery than the claim needs.
 */

const bytes = (s: string) => new TextEncoder().encode(s);

/** A trailer + /Encrypt dictionary shaped like the real thing. */
const encryptedPdf = (dict: string) =>
  bytes(`%PDF-1.7\n1 0 obj\n<< /Filter /Standard ${dict} >>\nendobj\ntrailer\n<< /Encrypt 1 0 R /Root 2 0 R >>\n%%EOF`);

describe('readEncryptionInfo', () => {
  it('reports an unencrypted PDF as unencrypted', () => {
    const info = readEncryptionInfo(bytes('%PDF-1.7\ntrailer\n<< /Root 1 0 R >>\n%%EOF'));
    expect(info.encrypted).toBe(false);
    expect(info.algorithm).toBe('None');
  });

  it('decodes AES-256 (V5 R6)', () => {
    const info = readEncryptionInfo(encryptedPdf('/V 5 /R 6 /Length 256 /P -3904 /CF << /StdCF << /CFM /AESV3 >> >>'));
    expect(info.encrypted).toBe(true);
    expect(info.algorithm).toBe('AES-256');
    expect(info.version).toBe(5);
    expect(info.revision).toBe(6);
    expect(info.keyLength).toBe(256);
  });

  it('decodes AES-128 (V4 R4) from its crypt filter', () => {
    const info = readEncryptionInfo(encryptedPdf('/V 4 /R 4 /Length 128 /P -44 /CF << /StdCF << /CFM /AESV2 >> >>'));
    expect(info.algorithm).toBe('AES-128');
    expect(info.keyLength).toBe(128);
  });

  it('decodes legacy RC4 and defaults /Length to 40 bits', () => {
    const info = readEncryptionInfo(encryptedPdf('/V 1 /R 2 /P -44'));
    expect(info.algorithm).toBe('RC4 40-bit');
    expect(info.keyLength).toBe(40);
  });

  it('decodes the /P bit-field into named permissions', () => {
    // -44 (0x…FFD4) sets bits 3 and 5: printing and copying allowed, editing not.
    const info = readEncryptionInfo(encryptedPdf('/V 5 /R 6 /Length 256 /P -44'));
    expect(info.permissions).toMatchObject({
      print: true,
      copy: true,
      modify: false,
      annotate: false,
    });

    // -3904 (0x…F0C0) clears bits 1-6 — a fully locked-down document.
    const locked = readEncryptionInfo(encryptedPdf('/V 5 /R 6 /Length 256 /P -3904'));
    expect(locked.permissions).toMatchObject({
      print: false,
      copy: false,
      modify: false,
      annotate: false,
    });

    // -1 grants everything.
    const all = readEncryptionInfo(encryptedPdf('/V 5 /R 6 /Length 256 /P -1'));
    expect(all.permissions).toMatchObject({
      print: true,
      copy: true,
      modify: true,
      annotate: true,
    });
  });

  it('does not claim to understand a non-standard security handler', () => {
    const info = readEncryptionInfo(
      bytes('%PDF-1.7\n1 0 obj\n<< /Filter /Custom /V 4 >>\nendobj\ntrailer\n<< /Encrypt 1 0 R >>\n%%EOF')
    );
    expect(info.encrypted).toBe(true);
    expect(info.algorithm).toMatch(/Unknown/);
  });
});
