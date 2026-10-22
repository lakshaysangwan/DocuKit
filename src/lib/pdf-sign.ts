/**
 * PKCS#7 detached PDF signing — environment-agnostic (no DOM), so it runs both
 * in the browser island and in Node (tests). Produces an `adbe.pkcs7.detached`
 * signature with a correct ByteRange over the whole file minus the /Contents
 * placeholder, matching the PDF signature spec.
 *
 * We deliberately keep node-forge here rather than @signpdf: @signpdf v3 depends
 * on Node's global `Buffer`, which would force a bundle-wide Buffer polyfill into
 * this fully client-side app. The signature this module emits is cryptographically
 * verifiable (see `verifyPdfSignature` in the test harness), so the swap would add
 * dependencies and polyfill risk for no correctness gain.
 */
import type * as ForgeTypes from 'node-forge';
import type { PageGeometry, RectNorm } from './pdf/page-geometry';
import {
  BOX_BORDER,
  BOX_FILL,
  BOX_OPACITY,
  BOX_TEXT,
  signatureBoxLines,
  signatureTextLayout,
  signatureWidgetPlacement,
} from './pdf/signature-box';

/** node-forge is CJS; normalize the default/namespace shape across Vite and Node. */
async function getForge(): Promise<typeof ForgeTypes> {
  const mod = (await import('node-forge')) as any;
  return (mod.default ?? mod) as typeof ForgeTypes;
}

// 8 KB hex placeholder reserved for the PKCS#7 DER blob.
const CONTENTS_LENGTH = 8192;
const CONTENTS_HEX_LENGTH = CONTENTS_LENGTH * 2;

export interface CertSubject {
  cn: string;
  org?: string;
  email?: string;
}

export interface GeneratedCert {
  privateKey: ForgeTypes.pki.rsa.PrivateKey;
  certificate: ForgeTypes.pki.Certificate;
  /** The key pair + cert exported as an unencrypted PKCS#12 (for download). */
  p12Buffer: ArrayBuffer;
}

function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function formatPdfDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}Z`;
}

/** Generate a self-signed RSA-2048 certificate valid for one year. */
export async function generateSelfSignedCert(subject: CertSubject): Promise<GeneratedCert> {
  const forge = await getForge();

  const { privateKey, publicKey } = await new Promise<ForgeTypes.pki.rsa.KeyPair>((resolve, reject) =>
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, pair) => {
      if (err) reject(err);
      else resolve(pair);
    }),
  );

  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date();
  certificate.validity.notAfter = new Date();
  certificate.validity.notAfter.setFullYear(certificate.validity.notAfter.getFullYear() + 1);

  const attrs: ForgeTypes.pki.CertificateField[] = [{ name: 'commonName', value: subject.cn }];
  if (subject.org) attrs.push({ name: 'organizationName', value: subject.org });
  if (subject.email) attrs.push({ name: 'emailAddress', value: subject.email });

  certificate.setSubject(attrs);
  certificate.setIssuer(attrs);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, nonRepudiation: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  certificate.sign(privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, certificate, '', { algorithm: '3des' });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  const p12Buffer = Uint8Array.from(p12Der, (c) => c.charCodeAt(0)).buffer as ArrayBuffer;

  return { privateKey, certificate, p12Buffer };
}

/** Shown when the password does not open the .p12/.pfx file. */
export const WRONG_CERT_PASSWORD_MESSAGE = 'That password does not open this certificate file. Check it and try again.';
/** Shown when the file is not a PKCS#12 certificate file at all. */
export const NOT_A_CERTIFICATE_MESSAGE = 'This file could not be read as a .p12 or .pfx certificate file.';
/** Shown when the file opens but holds no private key or no certificate. */
export const NO_KEY_MESSAGE = 'This certificate file has no private key and certificate pair to sign with.';

/** Extract the private key + certificate from an uploaded PKCS#12 (.p12/.pfx). */
export async function loadP12(
  buffer: ArrayBuffer,
  password: string,
): Promise<{ privateKey: ForgeTypes.pki.rsa.PrivateKey; certificate: ForgeTypes.pki.Certificate }> {
  const forge = await getForge();
  let p12Asn1;
  try {
    p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(buffer));
  } catch (err) {
    throw new Error(NOT_A_CERTIFICATE_MESSAGE, { cause: err });
  }
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
  } catch (err) {
    throw new Error(WRONG_CERT_PASSWORD_MESSAGE, { cause: err });
  }

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const privateKey = (keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [])[0]?.key as
    | ForgeTypes.pki.rsa.PrivateKey
    | undefined;

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certificate = (certBags[forge.pki.oids.certBag] ?? [])[0]?.cert;

  if (!privateKey || !certificate) throw new Error(NO_KEY_MESSAGE);
  return { privateKey, certificate };
}

/** "Signature1", or the first "SignatureN" no field of the form already has. */
export function uniqueFieldName(taken: string[]): string {
  const names = new Set(taken);
  let i = 1;
  while (names.has(`Signature${i}`)) i++;
  return `Signature${i}`;
}

/** The certificate's Common Name, or "Signer" when it has none. */
export function certificateName(certificate: ForgeTypes.pki.Certificate): string {
  const cn = certificate.subject.getField('CN')?.value;
  return typeof cn === 'string' && cn.trim() ? cn : 'Signer';
}

/** Where the visible box goes: a page, that page's geometry, and the box on the displayed page. */
export interface VisibleSignature {
  pageIndex: number;
  geometry: PageGeometry;
  rect: RectNorm;
}

export interface SignOptions {
  /** The visible box, or null for an invisible signature (no box on any page). */
  visible: VisibleSignature | null;
  /** When the document is signed: the signature's time, and the date in the box. Defaults to now. */
  date?: Date;
}

/**
 * Sign a PDF with a PKCS#7 detached signature. Adds a signature dictionary and
 * its AcroForm field — with a visible box as the field's appearance when
 * `visible` is set, or a zero-size widget when it is not — computes the
 * ByteRange over the saved bytes, signs the covered ranges, and embeds the DER
 * blob. The signer's name is the certificate's Common Name.
 */
export async function signPdfWithPkcs7(
  pdfBuffer: ArrayBuffer,
  privateKey: ForgeTypes.pki.rsa.PrivateKey,
  certificate: ForgeTypes.pki.Certificate,
  options: SignOptions = { visible: null },
): Promise<ArrayBuffer> {
  const { PDFDocument, StandardFonts, PDFName, PDFString, PDFHexString, PDFArray, PDFNumber } =
    await import('pdf-lib');
  const forge = await getForge();
  const signerName = certificateName(certificate);
  const date = options.date ?? new Date();
  const text = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? PDFString.of(s) : PDFHexString.fromText(s));

  let doc;
  try {
    doc = await PDFDocument.load(new Uint8Array(pdfBuffer));
  } catch (err) {
    if (err instanceof Error && err.message.includes('encrypted')) {
      throw new Error('This PDF is encrypted. Please use the Unlock PDF tool first to remove the password.', { cause: err });
    }
    doc = await PDFDocument.load(new Uint8Array(pdfBuffer), { ignoreEncryption: true });
  }
  const context = doc.context;
  const visible = options.visible;
  const pageIndex = visible ? visible.pageIndex : 0;
  if (pageIndex < 0 || pageIndex >= doc.getPageCount()) throw new Error('The page chosen for the signature box is not in this PDF.');
  const page = doc.getPage(pageIndex);

  const sigDict = context.obj({});
  sigDict.set(PDFName.of('Type'), PDFName.of('Sig'));
  sigDict.set(PDFName.of('Filter'), PDFName.of('Adobe.PPKLite'));
  sigDict.set(PDFName.of('SubFilter'), PDFName.of('adbe.pkcs7.detached'));
  sigDict.set(PDFName.of('M'), PDFString.of(formatPdfDate(date)));
  sigDict.set(PDFName.of('Name'), text(signerName));
  sigDict.set(PDFName.of('Reason'), PDFString.of('Document digitally signed'));

  const byteRangeArray = PDFArray.withContext(context);
  byteRangeArray.push(PDFNumber.of(0));
  byteRangeArray.push(PDFNumber.of(9999999999));
  byteRangeArray.push(PDFNumber.of(9999999999));
  byteRangeArray.push(PDFNumber.of(9999999999));
  sigDict.set(PDFName.of('ByteRange'), byteRangeArray);

  const contentsPlaceholder = '0'.repeat(CONTENTS_HEX_LENGTH);
  sigDict.set(PDFName.of('Contents'), PDFHexString.of(contentsPlaceholder));

  const sigRef = context.register(sigDict);

  const acroForm = doc.catalog.getOrCreateAcroForm();
  const sigFieldDict = context.obj({});
  sigFieldDict.set(PDFName.of('Type'), PDFName.of('Annot'));
  sigFieldDict.set(PDFName.of('Subtype'), PDFName.of('Widget'));
  sigFieldDict.set(PDFName.of('FT'), PDFName.of('Sig'));
  sigFieldDict.set(PDFName.of('T'), PDFString.of(uniqueFieldName(acroForm.getAllFields().map(([f]) => f.getFullyQualifiedName() ?? ''))));
  sigFieldDict.set(PDFName.of('V'), sigRef);
  // Print + Locked.
  sigFieldDict.set(PDFName.of('F'), PDFNumber.of(132));
  sigFieldDict.set(PDFName.of('P'), page.ref);

  let rect: [number, number, number, number] = [0, 0, 0, 0];
  if (visible) {
    // The box is the field's appearance, drawn where the visitor placed it and
    // turned with the page so it reads upright.
    const placement = signatureWidgetPlacement(visible.geometry, visible.rect);
    rect = [placement.rect.x, placement.rect.y, placement.rect.x + placement.rect.width, placement.rect.y + placement.rect.height];
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const lines = signatureBoxLines(signerName, date);
    const longest = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, 1)));
    const { width: w, height: h } = placement;
    const layout = signatureTextLayout(w, h, longest, lines.length);
    const n = (v: number) => Number(v.toFixed(4)).toString();
    const rgbOp = (c: readonly number[], op: string) => `${c.map(n).join(' ')} ${op}`;
    const ops = [
      'q',
      '/GS0 gs',
      rgbOp(BOX_FILL, 'rg'),
      rgbOp(BOX_BORDER, 'RG'),
      '1 w',
      `0.5 0.5 ${n(Math.max(0, w - 1))} ${n(Math.max(0, h - 1))} re B`,
      rgbOp(BOX_TEXT, 'rg'),
      'BT',
      `/F0 ${n(layout.fontSize)} Tf`,
      ...lines.map((line, i) => `1 0 0 1 ${n(layout.x)} ${n(h - layout.baselines[i])} Tm ${font.encodeText(line).toString()} Tj`),
      'ET',
      'Q',
    ];
    const gs = context.obj({ Type: 'ExtGState', ca: BOX_OPACITY, CA: BOX_OPACITY });
    const appearance = context.stream(ops.join('\n'), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, w, h],
      Matrix: placement.matrix,
      Resources: { Font: { F0: font.ref }, ExtGState: { GS0: gs } },
    });
    sigFieldDict.set(PDFName.of('AP'), context.obj({ N: context.register(appearance) }));
  }
  const rectArray = PDFArray.withContext(context);
  rect.forEach((v) => rectArray.push(PDFNumber.of(v)));
  sigFieldDict.set(PDFName.of('Rect'), rectArray);

  const sigFieldRef = context.register(sigFieldDict);

  // Existing arrays may be indirect objects: look them up rather than replace them.
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots instanceof PDFArray) {
    annots.push(sigFieldRef);
  } else {
    const annotsArray = PDFArray.withContext(context);
    annotsArray.push(sigFieldRef);
    page.node.set(PDFName.of('Annots'), annotsArray);
  }

  const acroDict = acroForm.dict;
  const fields = acroDict.lookup(PDFName.of('Fields'));
  if (fields instanceof PDFArray) {
    fields.push(sigFieldRef);
  } else {
    const fieldsArray = PDFArray.withContext(context);
    fieldsArray.push(sigFieldRef);
    acroDict.set(PDFName.of('Fields'), fieldsArray);
  }
  acroDict.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  const savedBytes = await doc.save({ useObjectStreams: false });
  const pdfBytes = new Uint8Array(savedBytes);

  const pdfStr = new TextDecoder('latin1').decode(pdfBytes);

  const contentsMarker = '<' + contentsPlaceholder + '>';
  const contentsStart = pdfStr.indexOf(contentsMarker);
  if (contentsStart === -1) throw new Error('Could not find signature placeholder in PDF');
  const contentsEnd = contentsStart + contentsMarker.length;

  const byteRange = [0, contentsStart, contentsEnd, pdfBytes.length - contentsEnd];

  const byteRangeStr = `/ByteRange [${byteRange[0]} ${byteRange[1]} ${byteRange[2]} ${byteRange[3]}]`;
  const byteRangePattern = /\/ByteRange\s*\[\s*0\s+9999999999\s+9999999999\s+9999999999\s*\]/;
  const brMatch = pdfStr.match(byteRangePattern);
  if (!brMatch || brMatch.index === undefined) throw new Error('Could not find ByteRange placeholder');

  const originalBrLen = brMatch[0].length;
  const paddedBr = byteRangeStr.padEnd(originalBrLen, ' ');
  if (paddedBr.length > originalBrLen) throw new Error('ByteRange replacement too long');
  for (let i = 0; i < paddedBr.length; i++) pdfBytes[brMatch.index + i] = paddedBr.charCodeAt(i);

  const part1 = pdfBytes.subarray(byteRange[0], byteRange[0] + byteRange[1]);
  const part2 = pdfBytes.subarray(byteRange[2], byteRange[2] + byteRange[3]);
  const signedData = concatUint8Arrays(part1, part2);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(new Uint8Array(signedData));
  p7.addCertificate(certificate);
  p7.addSigner({
    key: privateKey,
    certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.signingTime, value: date as unknown as string },
      { type: forge.pki.oids.messageDigest },
    ],
  });
  p7.sign({ detached: true });

  const derBytes = forge.asn1.toDer(p7.toAsn1()).getBytes();
  if (derBytes.length > CONTENTS_LENGTH) {
    throw new Error(`Signature too large (${derBytes.length} bytes, max ${CONTENTS_LENGTH})`);
  }

  let hexSig = '';
  for (let i = 0; i < derBytes.length; i++) hexSig += derBytes.charCodeAt(i).toString(16).padStart(2, '0');
  hexSig = hexSig.padEnd(CONTENTS_HEX_LENGTH, '0');
  for (let i = 0; i < CONTENTS_HEX_LENGTH; i++) pdfBytes[contentsStart + 1 + i] = hexSig.charCodeAt(i);

  return pdfBytes.buffer as ArrayBuffer;
}
