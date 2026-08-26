import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { generateSelfSignedCert, loadP12, signPdfWithPkcs7 } from '@/lib/pdf-sign';
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
      let privateKey;
      let certificate;

      if (certSource === 'generate') {
        setStatus('generating');
        const generated = await generateSelfSignedCert({
          cn: certInfo.cn,
          org: certInfo.org,
          email: certInfo.email,
        });
        privateKey = generated.privateKey;
        certificate = generated.certificate;
        setGeneratedP12(generated.p12Buffer);
        setStatus('signing');
      } else {
        const pfxBuf = await fileToArrayBuffer(pfxFile!);
        ({ privateKey, certificate } = await loadP12(pfxBuf, pfxPassword));
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

        <div className="mb-4 flex gap-1 rounded-lg bg-[var(--color-background)] p-1">
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
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                Organization (optional)
              </label>
              <input type="text" value={certInfo.org} onChange={(e) => setCertInfo((p) => ({ ...p, org: e.target.value }))}
                placeholder="Acme Corp"
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
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
                  className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
                <button onClick={parsePfx}
                  className="rounded-lg border border-[var(--color-border)] px-4 py-2.5 text-sm hover:bg-[var(--color-background)]">
                  Load
                </button>
              </div>
            )}
            {parsedCert && (
              <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-3 text-xs text-[var(--color-text-secondary)]">
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
        <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
          {errorMsg}
        </div>
      )}

      {/* Actions */}
      {status !== 'generating' && status !== 'signing' && pdfFile && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleSign}
            disabled={!pdfFile || (certSource === 'generate' && !certInfo.cn)}
            data-testid="tool-action"
            className="w-full rounded-lg bg-[var(--color-text-primary)] px-6 py-2.5 text-sm font-medium text-[var(--color-background)] hover:opacity-80 disabled:opacity-50 sm:w-auto">
            Sign PDF
          </button>
          {status === 'done' && result && (
            <DownloadButton onClick={handleDownload} label="Download Signed PDF" />
          )}
        </div>
      )}

      {/* Success */}
      {status === 'done' && result && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
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
