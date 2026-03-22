import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import type * as ForgeTypes from 'node-forge';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { triggerDownload } from '@/lib/download';
import { formatBytes } from '@/lib/utils';
import { cn } from '@/lib/utils';

type CertSource = 'generate' | 'upload';
type Status = 'idle' | 'generating' | 'signing' | 'done' | 'error';

interface CertInfo {
  cn: string;
  org?: string;
  email?: string;
}

interface ParsedCert {
  cn: string;
  issuer: string;
  expiry: string;
  keyAlgorithm: string;
}

// Placeholder markers for ByteRange — must be fixed length
const BYTERANGE_PLACEHOLDER = '/ByteRange [0 /********** /********** /**********]';
const CONTENTS_LENGTH = 8192; // 8KB hex placeholder for PKCS#7 DER
const CONTENTS_HEX_LENGTH = CONTENTS_LENGTH * 2; // hex-encoded length

/**
 * Create a PKCS#7 detached signature for a PDF using node-forge.
 *
 * Steps:
 * 1. Add signature placeholder dict via pdf-lib
 * 2. Find ByteRange offsets in saved PDF
 * 3. Hash signed ranges with SHA-256
 * 4. Build CMS SignedData with node-forge
 * 5. Embed signature into the Contents placeholder
 */
async function signPdfWithPkcs7(
  pdfBuffer: ArrayBuffer,
  privateKey: ForgeTypes.pki.rsa.PrivateKey,
  certificate: ForgeTypes.pki.Certificate,
  signerName: string,
): Promise<ArrayBuffer> {
  const { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFHexString, PDFArray, PDFNumber } = await import('pdf-lib');
  const forge = await import('node-forge');

  // 1. Load PDF and add visual signature + signature dictionary
  let doc;
  try {
    // Attempt to load without ignoring encryption to detect if it's encrypted
    doc = await PDFDocument.load(new Uint8Array(pdfBuffer));
  } catch (err) {
    if (err instanceof Error && err.message.includes('encrypted')) {
      throw new Error('This PDF is encrypted. Please use the Unlock PDF tool first to remove the password.');
    }
    // Fallback if some other error occurred but maybe ignoreEncryption lets it load
    doc = await PDFDocument.load(new Uint8Array(pdfBuffer), { ignoreEncryption: true });
  }
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.getPage(0);
  const { width } = page.getSize();

  // Draw visual signature box
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
    page.drawText(line, {
      x: width - 250 - 14,
      y: 20 + 44 - i * 16,
      size: 7,
      font,
      color: rgb(0.1, 0.2, 0.5),
    });
  });

  // Create signature dictionary with placeholders
  const context = doc.context;

  // Build the Sig dictionary
  const sigDict = context.obj({});
  (sigDict as any).set(PDFName.of('Type'), PDFName.of('Sig'));
  (sigDict as any).set(PDFName.of('Filter'), PDFName.of('Adobe.PPKLite'));
  (sigDict as any).set(PDFName.of('SubFilter'), PDFName.of('adbe.pkcs7.detached'));
  (sigDict as any).set(PDFName.of('M'), PDFString.of(formatPdfDate(new Date())));
  (sigDict as any).set(PDFName.of('Name'), PDFString.of(signerName));
  (sigDict as any).set(PDFName.of('Reason'), PDFString.of('Document digitally signed'));

  // ByteRange placeholder — will be replaced post-save
  // Use large placeholder numbers to reserve enough space for real offset values
  const byteRangeArray = PDFArray.withContext(context);
  byteRangeArray.push(PDFNumber.of(0));
  byteRangeArray.push(PDFNumber.of(9999999999));
  byteRangeArray.push(PDFNumber.of(9999999999));
  byteRangeArray.push(PDFNumber.of(9999999999));
  (sigDict as any).set(PDFName.of('ByteRange'), byteRangeArray);

  // Contents placeholder — filled with zeros, will hold PKCS#7 DER
  const contentsPlaceholder = '0'.repeat(CONTENTS_HEX_LENGTH);
  (sigDict as any).set(PDFName.of('Contents'), PDFHexString.of(contentsPlaceholder));

  const sigRef = context.register(sigDict);

  // Add signature field to AcroForm
  const acroForm = doc.catalog.getOrCreateAcroForm();
  const sigFieldDict = context.obj({});
  (sigFieldDict as any).set(PDFName.of('Type'), PDFName.of('Annot'));
  (sigFieldDict as any).set(PDFName.of('Subtype'), PDFName.of('Widget'));
  (sigFieldDict as any).set(PDFName.of('FT'), PDFName.of('Sig'));
  (sigFieldDict as any).set(PDFName.of('T'), PDFString.of('Signature1'));
  (sigFieldDict as any).set(PDFName.of('V'), sigRef);
  (sigFieldDict as any).set(PDFName.of('F'), PDFNumber.of(132)); // Print + Locked
  const rectArray = PDFArray.withContext(context);
  [0, 0, 0, 0].forEach(v => rectArray.push(PDFNumber.of(v)));
  (sigFieldDict as any).set(PDFName.of('Rect'), rectArray);
  (sigFieldDict as any).set(PDFName.of('P'), page.ref);

  const sigFieldRef = context.register(sigFieldDict);

  // Add to page annotations
  const annots = page.node.get(PDFName.of('Annots'));
  if (annots instanceof PDFArray) {
    annots.push(sigFieldRef);
  } else {
    const annotsArray = PDFArray.withContext(context);
    annotsArray.push(sigFieldRef);
    page.node.set(PDFName.of('Annots'), annotsArray);
  }

  // Add to AcroForm fields — acroForm is PDFAcroForm, use .dict to access underlying PDFDict
  const acroDict = (acroForm as any).dict ?? acroForm;
  const fields = acroDict.get(PDFName.of('Fields'));
  if (fields instanceof PDFArray) {
    fields.push(sigFieldRef);
  } else {
    const fieldsArray = PDFArray.withContext(context);
    fieldsArray.push(sigFieldRef);
    acroDict.set(PDFName.of('Fields'), fieldsArray);
  }

  // Set SigFlags: SignaturesExist (1) | AppendOnly (2) = 3
  acroDict.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  // 2. Save PDF
  const savedBytes = await doc.save({ useObjectStreams: false });
  const pdfBytes = new Uint8Array(savedBytes);

  // 3. Find the Contents hex string in the saved PDF
  // Look for the hex string marker: the Contents value is `<0000...0000>`
  const pdfStr = new TextDecoder('latin1').decode(pdfBytes);

  // Find the Contents hex string — it's a long sequence of zeros enclosed in < >
  const contentsMarker = '<' + contentsPlaceholder + '>';
  const contentsStart = pdfStr.indexOf(contentsMarker);
  if (contentsStart === -1) throw new Error('Could not find signature placeholder in PDF');

  const contentsEnd = contentsStart + contentsMarker.length;

  // 4. Compute ByteRange
  const byteRange = [
    0,
    contentsStart,
    contentsEnd,
    pdfBytes.length - contentsEnd,
  ];

  // Replace ByteRange in the PDF — find the [0 0 0 0] array near our sig dict
  // We need to find and replace the ByteRange values
  const byteRangeStr = `/ByteRange [${byteRange[0]} ${byteRange[1]} ${byteRange[2]} ${byteRange[3]}]`;
  // Find the original ByteRange pattern: /ByteRange [ 0 0 0 0 ]
  // pdf-lib serializes arrays with spaces
  const byteRangePattern = /\/ByteRange\s*\[\s*0\s+9999999999\s+9999999999\s+9999999999\s*\]/;
  const brMatch = pdfStr.match(byteRangePattern);
  if (!brMatch || brMatch.index === undefined) throw new Error('Could not find ByteRange placeholder');

  // Pad the new ByteRange string to exactly match original length
  const originalBrLen = brMatch[0].length;
  const paddedBr = byteRangeStr.padEnd(originalBrLen, ' ');
  if (paddedBr.length > originalBrLen) throw new Error('ByteRange replacement too long');

  // Write the ByteRange values
  for (let i = 0; i < paddedBr.length; i++) {
    pdfBytes[brMatch.index + i] = paddedBr.charCodeAt(i);
  }

  // 5. Extract the signed portions (everything except the Contents hex value)
  const part1 = pdfBytes.subarray(byteRange[0], byteRange[0] + byteRange[1]);
  const part2 = pdfBytes.subarray(byteRange[2], byteRange[2] + byteRange[3]);

  // Pass raw signed bytes to forge — forge will handle SHA-256 hashing internally
  const signedData = concatUint8Arrays(part1, part2);

  // 6. Build PKCS#7 SignedData using node-forge
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(new Uint8Array(signedData));
  p7.addCertificate(certificate);
  p7.addSigner({
    key: privateKey,
    certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      {
        type: forge.pki.oids.contentType,
        value: forge.pki.oids.data,
      },
      {
        type: forge.pki.oids.signingTime,
        value: new Date() as unknown as string,
      },
      {
        type: forge.pki.oids.messageDigest,
        // Will be auto-computed by forge
      },
    ],
  });
  p7.sign({ detached: true });

  // Convert to DER
  const derBytes = forge.asn1.toDer(p7.toAsn1()).getBytes();

  // 7. Embed signature into Contents
  if (derBytes.length > CONTENTS_LENGTH) {
    throw new Error(`Signature too large (${derBytes.length} bytes, max ${CONTENTS_LENGTH})`);
  }

  // Hex-encode the DER signature
  let hexSig = '';
  for (let i = 0; i < derBytes.length; i++) {
    hexSig += derBytes.charCodeAt(i).toString(16).padStart(2, '0');
  }
  // Pad with zeros to fill the placeholder
  hexSig = hexSig.padEnd(CONTENTS_HEX_LENGTH, '0');

  // Write hex signature into the PDF (inside the < > markers)
  for (let i = 0; i < CONTENTS_HEX_LENGTH; i++) {
    pdfBytes[contentsStart + 1 + i] = hexSig.charCodeAt(i);
  }

  return pdfBytes.buffer as ArrayBuffer;
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

export default function DigitalSignatureTool() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const [certSource, setCertSource] = useState<CertSource>('generate');
  const [certInfo, setCertInfo] = useState<CertInfo>({ cn: '', org: '', email: '' });
  const [pfxFile, setPfxFile] = useState<File | null>(null);
  const [pfxPassword, setPfxPassword] = useState('');
  const [parsedCert, setParsedCert] = useState<ParsedCert | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [generatedP12, setGeneratedP12] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handlePdfFiles = useCallback(async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setPdfFile(f);
    try {
      setPdfBuffer(await fileToArrayBuffer(f));
    } catch {
      setPdfFile(null); setPdfBuffer(null); toast.error('Failed to load PDF. If it is encrypted, please unlock it first.');
    }
  }, []);

  const handleRemovePdf = useCallback(() => {
    setPdfFile(null); setPdfBuffer(null); setStatus('idle'); setResult(null); setErrorMsg(null);
  }, []);

  const handlePfxFiles = useCallback(async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setPfxFile(f);
    setParsedCert(null);
  }, []);

  const parsePfx = useCallback(async () => {
    if (!pfxFile || !pfxPassword) {
      toast.error('Upload a .p12/.pfx file and enter the password');
      return;
    }
    try {
      const buf = await fileToArrayBuffer(pfxFile);
      const forge = await import('node-forge');
      const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(buf));
      const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, pfxPassword);
      const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
      const bags = certBags[forge.pki.oids.certBag] ?? [];
      if (bags.length === 0) throw new Error('No certificates found in file');

      const cert = bags[0].cert!;
      const cn = cert.subject.getField('CN')?.value ?? 'Unknown';
      const issuerCn = cert.issuer.getField('CN')?.value ?? 'Unknown';
      const expiry = cert.validity.notAfter.toISOString().split('T')[0];

      setParsedCert({ cn, issuer: issuerCn, expiry, keyAlgorithm: 'RSA-2048' });
      toast.success('Certificate loaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to parse certificate');
    }
  }, [pfxFile, pfxPassword]);

  const handleSign = useCallback(async () => {
    if (!pdfBuffer || !pdfFile) {
      toast.error('Upload a PDF first');
      return;
    }

    if (certSource === 'generate' && !certInfo.cn.trim()) {
      toast.error('Enter your name (CN) for the certificate');
      return;
    }

    if (certSource === 'upload' && (!pfxFile || !pfxPassword)) {
      toast.error('Upload certificate and enter password');
      return;
    }

    setStatus('signing');
    setErrorMsg(null);

    try {
      const forge = await import('node-forge');

      let privateKey: ForgeTypes.pki.rsa.PrivateKey;
      let certificate: ForgeTypes.pki.Certificate;

      if (certSource === 'generate') {
        setStatus('generating');
        // Generate RSA-2048 key pair
        const { privateKey: pk, publicKey } = await new Promise<ForgeTypes.pki.rsa.KeyPair>(
          (resolve, reject) =>
            forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, pair) => {
              if (err) reject(err);
              else resolve(pair);
            })
        );
        privateKey = pk;

        // Create self-signed X.509 certificate
        certificate = forge.pki.createCertificate();
        certificate.publicKey = publicKey;
        certificate.serialNumber = '01';
        certificate.validity.notBefore = new Date();
        certificate.validity.notAfter = new Date();
        certificate.validity.notAfter.setFullYear(certificate.validity.notAfter.getFullYear() + 1);

        const attrs = [{ name: 'commonName', value: certInfo.cn }];
        if (certInfo.org) attrs.push({ name: 'organizationName', value: certInfo.org });
        if (certInfo.email) attrs.push({ name: 'emailAddress', value: certInfo.email });

        certificate.setSubject(attrs);
        certificate.setIssuer(attrs);
        certificate.setExtensions([
          { name: 'basicConstraints', cA: true },
          { name: 'keyUsage', keyCertSign: true, digitalSignature: true, nonRepudiation: true },
          { name: 'subjectKeyIdentifier' },
        ]);
        certificate.sign(pk, forge.md.sha256.create());

        // Export as PKCS#12
        const p12Asn1 = forge.pkcs12.toPkcs12Asn1(pk, certificate, '', { algorithm: '3des' });
        const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
        const p12Buffer = Uint8Array.from(p12Der, (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
        setGeneratedP12(p12Buffer);
        setStatus('signing');
      } else {
        // Load uploaded .p12
        const pfxBuf = await fileToArrayBuffer(pfxFile!);
        const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuf));
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, pfxPassword);

        const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
        const keys = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
        privateKey = keys[0]?.key as ForgeTypes.pki.rsa.PrivateKey;

        const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
        certificate = certBags[forge.pki.oids.certBag]?.[0]?.cert!;

        if (!privateKey || !certificate) throw new Error('Could not extract key/cert from .p12 file');
      }

      // Sign the PDF with true PKCS#7
      const signerName = certInfo.cn || parsedCert?.cn || 'Signer';
      const signedPdf = await signPdfWithPkcs7(pdfBuffer, privateKey, certificate, signerName);

      setResult(signedPdf);
      setStatus('done');
      toast.success('PDF digitally signed with PKCS#7!');

      // Clear private key from memory
      (privateKey as unknown as Record<string, null>).d = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Signing failed';
      setStatus('error');
      setErrorMsg(msg);
      toast.error(msg);
    }
  }, [pdfBuffer, pdfFile, certSource, certInfo, pfxFile, pfxPassword, parsedCert]);

  const handleDownload = useCallback(async () => {
    if (!result || !pdfFile) return;
    const base = pdfFile.name.replace(/\.pdf$/i, '');
    triggerDownload(result, `${base}-signed.pdf`, 'application/pdf');
  }, [result, pdfFile]);

  const handleDownloadP12 = useCallback(() => {
    if (!generatedP12) return;
    const name = certInfo.cn.replace(/\s+/g, '-').toLowerCase() || 'docukit';
    triggerDownload(generatedP12, `${name}-cert.p12`, 'application/x-pkcs12');
  }, [generatedP12, certInfo.cn]);

  return (
    <div className="flex flex-col gap-6">
      {/* PDF upload */}
      <DropZone accept={['application/pdf']} multiple={false} onFiles={handlePdfFiles}
        hint="The PDF you want to sign" />

      {pdfFile && <FileInfoCard file={pdfFile} onRemove={handleRemovePdf} />}

      {/* Certificate source */}
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h3 className="mb-4 text-base font-semibold text-[var(--color-text-primary)]">Certificate</h3>

        <div className="mb-4 flex gap-1 rounded-xl bg-[var(--color-background)] p-1">
          {([['generate', 'Generate New'], ['upload', 'Upload Existing']] as const).map(([val, label]) => (
            <button key={val} onClick={() => setCertSource(val)}
              className={cn('flex-1 rounded-lg py-2 text-sm font-medium transition-colors',
                certSource === val
                  ? 'bg-white text-[var(--color-primary)] shadow-sm dark:bg-[var(--color-surface)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}>
              {label}
            </button>
          ))}
        </div>

        {certSource === 'generate' && (
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                Common Name (Your Name) *
              </label>
              <input type="text" value={certInfo.cn} onChange={(e) => setCertInfo((p) => ({ ...p, cn: e.target.value }))}
                placeholder="John Doe"
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                Organization (optional)
              </label>
              <input type="text" value={certInfo.org} onChange={(e) => setCertInfo((p) => ({ ...p, org: e.target.value }))}
                placeholder="Acme Corp"
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              A self-signed RSA-2048 certificate valid for 1 year will be generated. The PDF will contain a cryptographically valid PKCS#7 signature. You can also download the certificate as a .p12 file.
            </p>
          </div>
        )}

        {certSource === 'upload' && (
          <div className="flex flex-col gap-3">
            <DropZone accept={['.p12', '.pfx', 'application/x-pkcs12']} multiple={false}
              onFiles={handlePfxFiles} hint=".p12 or .pfx certificate file" />
            {pfxFile && (
              <div className="flex gap-2">
                <input type="password" value={pfxPassword} onChange={(e) => setPfxPassword(e.target.value)}
                  placeholder="Certificate password"
                  className="flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
                <button onClick={parsePfx}
                  className="rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-sm hover:bg-[var(--color-background)]">
                  Load
                </button>
              </div>
            )}
            {parsedCert && (
              <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-3 text-xs text-[var(--color-text-secondary)]">
                <p><span className="font-medium">CN:</span> {parsedCert.cn}</p>
                <p><span className="font-medium">Issued by:</span> {parsedCert.issuer}</p>
                <p><span className="font-medium">Expires:</span> {parsedCert.expiry}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Processing */}
      {(status === 'generating' || status === 'signing') && (
        <ProcessingOverlay progress={status === 'generating' ? 40 : 70}
          label={status === 'generating' ? 'Generating RSA-2048 key…' : 'Signing PDF with PKCS#7…'} />
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
          {errorMsg}
        </div>
      )}

      {/* Actions */}
      {status !== 'generating' && status !== 'signing' && pdfFile && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleSign}
            disabled={!pdfFile || (certSource === 'generate' && !certInfo.cn)}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] disabled:opacity-50 sm:w-auto">
            Sign PDF
          </button>
          {status === 'done' && result && (
            <DownloadButton onClick={handleDownload} label="Download Signed PDF" />
          )}
        </div>
      )}

      {/* Success */}
      {status === 'done' && result && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">PDF signed with PKCS#7!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {formatBytes(result.byteLength)} · Signature visible in Adobe Reader's signature panel
          </p>
          {generatedP12 && (
            <button onClick={handleDownloadP12}
              className="mt-2 text-xs text-[var(--color-primary)] hover:underline">
              Download your .p12 certificate →
            </button>
          )}
          <p className="mt-2 text-xs text-[var(--color-text-muted)] italic">
            Note: Self-signed certificates will show as "unverified" in Adobe Reader. Use a CA-signed certificate for trusted signatures.
          </p>
        </div>
      )}
    </div>
  );
}
