/**
 * Read back the signature of a signed PDF and check what can be checked
 * without trusting anyone: that the signed byte ranges cover the whole file
 * except the signature itself, that the SHA-256 digest inside the signature
 * matches those bytes, and that the RSA signature over the signed attributes
 * verifies with the certificate the signature carries.
 *
 * It does NOT check whether the certificate is trusted (no chain or revocation
 * check): that is for the reader's PDF software. Environment-agnostic: runs in
 * the page and in Node.
 */
import type * as ForgeTypes from 'node-forge';

async function getForge(): Promise<typeof ForgeTypes> {
  const mod = (await import('node-forge')) as any;
  return (mod.default ?? mod) as typeof ForgeTypes;
}

export interface SignatureCheck {
  /** `/ByteRange` as written. */
  byteRange: [number, number, number, number];
  fileSize: number;
  /** Size of the `/Contents` hex string, delimiters included: the only bytes not signed. */
  unsignedBytes: number;
  /** The ranges start at 0, end at the end of the file, and leave out exactly the `/Contents` string. */
  coversWholeFile: boolean;
  /** The messageDigest attribute equals SHA-256 of the covered bytes. */
  digestMatches: boolean;
  /** The RSA signature over the signed attributes verifies with the embedded certificate. */
  signatureValid: boolean;
  signerName: string | null;
  issuerName: string | null;
  selfSigned: boolean;
  /** The signingTime attribute. */
  signingTime: Date | null;
  certificateExpires: Date | null;
}

const BYTE_RANGE = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;

/** Check the last signature in `bytes`. Throws if the file has none. */
export async function checkSignedPdf(bytes: Uint8Array): Promise<SignatureCheck> {
  const forge = await getForge();
  const text = new TextDecoder('latin1').decode(bytes);
  const matches = [...text.matchAll(BYTE_RANGE)];
  const last = matches[matches.length - 1];
  if (!last) throw new Error('This file has no signature.');
  const [a, b, c, d] = last.slice(1, 5).map(Number) as [number, number, number, number];

  const between = text.slice(a + b, c);
  const coversWholeFile =
    a === 0 && b > 0 && c > b && c + d === bytes.length && /^<[0-9a-fA-F]*>$/.test(between);

  const hex = between.replace(/[^0-9a-fA-F]/g, '');
  let der = '';
  for (let i = 0; i + 1 < hex.length; i += 2) der += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  // The blob is zero-padded to a fixed length: parse leniently and ignore the padding.
  const p7 = forge.pkcs7.messageFromAsn1((forge.asn1.fromDer as (b: string, o: unknown) => ForgeTypes.asn1.Asn1)(der, { strict: false, parseAllBytes: false })) as any;
  const attrs: any[] = p7.rawCapture?.authenticatedAttributes ?? [];
  const attr = (oid: string): any => {
    for (const at of attrs) {
      if (forge.asn1.derToOid(at.value[0].value) === oid) return at.value[1].value[0];
    }
    return null;
  };

  const covered = new Uint8Array(b + d);
  covered.set(bytes.subarray(a, a + b), 0);
  covered.set(bytes.subarray(c, c + d), b);
  const md = forge.md.sha256.create();
  // Feed the bytes in chunks as a binary string.
  for (let i = 0; i < covered.length; i += 0x2000) {
    md.update(String.fromCharCode(...covered.subarray(i, i + 0x2000)));
  }
  const digest = attr(forge.pki.oids.messageDigest);
  const digestMatches = !!digest && digest.value === md.digest().bytes();

  const cert: ForgeTypes.pki.Certificate | undefined = p7.certificates?.[0];
  let signatureValid = false;
  if (cert && attrs.length) {
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
    const sigMd = forge.md.sha256.create();
    sigMd.update(forge.asn1.toDer(set).getBytes());
    try {
      signatureValid = (cert.publicKey as ForgeTypes.pki.rsa.PublicKey).verify(sigMd.digest().bytes(), p7.rawCapture.signature);
    } catch {
      signatureValid = false;
    }
  }

  const time = attr(forge.pki.oids.signingTime);
  let signingTime: Date | null = null;
  if (time) {
    try {
      signingTime =
        time.type === forge.asn1.Type.UTCTIME ? forge.asn1.utcTimeToDate(time.value) : forge.asn1.generalizedTimeToDate(time.value);
    } catch {
      signingTime = null;
    }
  }

  const name = (field: ForgeTypes.pki.Certificate['subject']) => {
    const cn = field.getField('CN')?.value;
    return typeof cn === 'string' ? cn : null;
  };

  return {
    byteRange: [a, b, c, d],
    fileSize: bytes.length,
    unsignedBytes: c - b,
    coversWholeFile,
    digestMatches,
    signatureValid,
    signerName: cert ? name(cert.subject) : null,
    issuerName: cert ? name(cert.issuer) : null,
    selfSigned: cert ? cert.isIssuer(cert) : false,
    signingTime,
    certificateExpires: cert ? cert.validity.notAfter : null,
  };
}
