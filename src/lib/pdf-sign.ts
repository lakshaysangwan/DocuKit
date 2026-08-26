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

/** Extract the private key + certificate from an uploaded PKCS#12 (.p12/.pfx). */
export async function loadP12(
  buffer: ArrayBuffer,
  password: string,
): Promise<{ privateKey: ForgeTypes.pki.rsa.PrivateKey; certificate: ForgeTypes.pki.Certificate }> {
  const forge = await getForge();
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(buffer));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const privateKey = (keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [])[0]?.key as
    | ForgeTypes.pki.rsa.PrivateKey
    | undefined;

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certificate = (certBags[forge.pki.oids.certBag] ?? [])[0]?.cert;

  if (!privateKey || !certificate) throw new Error('Could not extract key/cert from .p12 file');
  return { privateKey, certificate };
}

/**
 * Sign a PDF with a PKCS#7 detached signature. Adds a visible signature box on
 * page 1, a signature dictionary + AcroForm field, computes the ByteRange over
 * the saved bytes, signs the covered ranges, and embeds the DER blob.
 */
export async function signPdfWithPkcs7(
  pdfBuffer: ArrayBuffer,
  privateKey: ForgeTypes.pki.rsa.PrivateKey,
  certificate: ForgeTypes.pki.Certificate,
  signerName: string,
): Promise<ArrayBuffer> {
  const { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFHexString, PDFArray, PDFNumber } =
    await import('pdf-lib');
  const forge = await getForge();

  let doc;
  try {
    doc = await PDFDocument.load(new Uint8Array(pdfBuffer));
  } catch (err) {
    if (err instanceof Error && err.message.includes('encrypted')) {
      throw new Error('This PDF is encrypted. Please use the Unlock PDF tool first to remove the password.', { cause: err });
    }
    doc = await PDFDocument.load(new Uint8Array(pdfBuffer), { ignoreEncryption: true });
  }
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.getPage(0);
  const { width } = page.getSize();

  const sigText = [
    `Digitally signed by: ${signerName}`,
    `Date: ${new Date().toISOString().split('T')[0]}`,
    `Algorithm: RSA-SHA256 (PKCS#7)`,
  ];

  page.drawRectangle({
    x: width - 250 - 20,
    y: 20,
    width: 250,
    height: 60,
    color: rgb(0.95, 0.97, 1),
    borderColor: rgb(0.2, 0.4, 0.8),
    borderWidth: 1,
    opacity: 0.9,
  });
  sigText.forEach((line, i) => {
    page.drawText(line, { x: width - 250 - 14, y: 20 + 44 - i * 16, size: 7, font, color: rgb(0.1, 0.2, 0.5) });
  });

  const context = doc.context;

  const sigDict = context.obj({});
  (sigDict as any).set(PDFName.of('Type'), PDFName.of('Sig'));
  (sigDict as any).set(PDFName.of('Filter'), PDFName.of('Adobe.PPKLite'));
  (sigDict as any).set(PDFName.of('SubFilter'), PDFName.of('adbe.pkcs7.detached'));
  (sigDict as any).set(PDFName.of('M'), PDFString.of(formatPdfDate(new Date())));
  (sigDict as any).set(PDFName.of('Name'), PDFString.of(signerName));
  (sigDict as any).set(PDFName.of('Reason'), PDFString.of('Document digitally signed'));

  const byteRangeArray = PDFArray.withContext(context);
  byteRangeArray.push(PDFNumber.of(0));
  byteRangeArray.push(PDFNumber.of(9999999999));
  byteRangeArray.push(PDFNumber.of(9999999999));
  byteRangeArray.push(PDFNumber.of(9999999999));
  (sigDict as any).set(PDFName.of('ByteRange'), byteRangeArray);

  const contentsPlaceholder = '0'.repeat(CONTENTS_HEX_LENGTH);
  (sigDict as any).set(PDFName.of('Contents'), PDFHexString.of(contentsPlaceholder));

  const sigRef = context.register(sigDict);

  const acroForm = doc.catalog.getOrCreateAcroForm();
  const sigFieldDict = context.obj({});
  (sigFieldDict as any).set(PDFName.of('Type'), PDFName.of('Annot'));
  (sigFieldDict as any).set(PDFName.of('Subtype'), PDFName.of('Widget'));
  (sigFieldDict as any).set(PDFName.of('FT'), PDFName.of('Sig'));
  (sigFieldDict as any).set(PDFName.of('T'), PDFString.of('Signature1'));
  (sigFieldDict as any).set(PDFName.of('V'), sigRef);
  (sigFieldDict as any).set(PDFName.of('F'), PDFNumber.of(132));
  const rectArray = PDFArray.withContext(context);
  [0, 0, 0, 0].forEach((v) => rectArray.push(PDFNumber.of(v)));
  (sigFieldDict as any).set(PDFName.of('Rect'), rectArray);
  (sigFieldDict as any).set(PDFName.of('P'), page.ref);

  const sigFieldRef = context.register(sigFieldDict);

  const annots = page.node.get(PDFName.of('Annots'));
  if (annots instanceof PDFArray) {
    annots.push(sigFieldRef);
  } else {
    const annotsArray = PDFArray.withContext(context);
    annotsArray.push(sigFieldRef);
    page.node.set(PDFName.of('Annots'), annotsArray);
  }

  const acroDict = (acroForm as any).dict ?? acroForm;
  const fields = acroDict.get(PDFName.of('Fields'));
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
      { type: forge.pki.oids.signingTime, value: new Date() as unknown as string },
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
