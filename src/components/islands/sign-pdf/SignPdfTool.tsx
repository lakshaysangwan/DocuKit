import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import SignaturePad, { type SignaturePadHandle } from './SignaturePad';
import { useWorker } from '@/hooks/use-worker';
import { usePdfThumbnails } from '@/hooks/use-pdf-thumbnails';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { triggerDownload } from '@/lib/download';
import { formatBytes, generateId } from '@/lib/utils';
import { cn } from '@/lib/utils';
import type { WorkerResponse, VisualAnnotation } from '@/types/worker-messages';

type SignatureMode = 'draw' | 'type' | 'upload';
type Status = 'idle' | 'placing' | 'processing' | 'done' | 'error';
type Step = 'create' | 'place' | 'apply';

const SIGNATURE_FONTS = [
  { name: 'Dancing Script', css: "'Dancing Script', cursive", canvas: '"Dancing Script"' },
  { name: 'Caveat', css: "'Caveat', cursive", canvas: '"Caveat"' },
  { name: 'Pacifico', css: "'Pacifico', cursive", canvas: '"Pacifico"' },
  { name: 'Sacramento', css: "'Sacramento', cursive", canvas: '"Sacramento"' },
];

interface PlacedAnnotation {
  id: string;
  type: 'signature';
  pageIndex: number;
  x: number; y: number;
  width: number; height: number;
  rotation: number;
  opacity: number;
  imageDataUrl: string;
}

export default function SignPdfTool() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const [, setStep] = useState<Step>('create');
  const [signatureMode, setSignatureMode] = useState<SignatureMode>('draw');
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [typedText, setTypedText] = useState('');
  const [selectedFont, setSelectedFont] = useState(0);
  const [annotations, setAnnotations] = useState<PlacedAnnotation[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [_activePage] = useState(0);

  const padRef = useRef<SignaturePadHandle>(null);

  // Preload signature fonts so they render immediately in previews and canvas
  useEffect(() => {
    SIGNATURE_FONTS.forEach((f) => {
      const name = f.name;
      if (document.fonts) {
        document.fonts.load(`60px "${name}"`).catch(() => {});
      }
    });
  }, []);
  const { isRunning, progress, progressLabel, run, cancel } = useWorker();
  const { thumbnails, pageCount, loadThumbnails } = usePdfThumbnails();

  const handlePdfFiles = useCallback(async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setPdfFile(f);
    setAnnotations([]);
    setResult(null);
    setStatus('idle');
    try {
      const buf = await fileToArrayBuffer(f);
      setPdfBuffer(buf);
      await loadThumbnails(buf, 200);
    } catch {
      setPdfFile(null); setPdfBuffer(null); setStatus('idle'); setAnnotations([]); toast.error('Failed to load PDF. If it is encrypted, please unlock it first.');
    }
  }, [loadThumbnails]);

  const handleRemovePdf = useCallback(() => {
    setPdfFile(null); setPdfBuffer(null); setAnnotations([]); setResult(null); setStatus('idle'); setErrorMsg(null);
  }, []);

  // Render typed signature to canvas → dataURL
  const renderTypedSignature = useCallback(async (): Promise<string> => {
    // Ensure fonts are loaded before rendering to canvas
    const fontName = SIGNATURE_FONTS[selectedFont].name;
    await document.fonts.load(`60px "${fontName}"`);
    await document.fonts.ready;
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 120;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Canvas ctx.font requires the font name in double quotes, not CSS fallback chain
    ctx.font = `60px ${SIGNATURE_FONTS[selectedFont].canvas}`;
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'middle';
    ctx.fillText(typedText, 20, 60);
    return canvas.toDataURL('image/png');
  }, [typedText, selectedFont]);

  const handleCaptureSignature = useCallback(async () => {
    let dataUrl = '';
    if (signatureMode === 'draw') {
      if (padRef.current?.isEmpty()) { toast.error('Draw your signature first'); return; }
      dataUrl = padRef.current?.toDataURL('image/png') ?? '';
    } else if (signatureMode === 'type') {
      if (!typedText.trim()) { toast.error('Type your signature first'); return; }
      dataUrl = await renderTypedSignature();
    }
    if (dataUrl) {
      setSignatureDataUrl(dataUrl);
      // Save to sessionStorage for reuse
      try { sessionStorage.setItem('docukit-signature', dataUrl); } catch {}
      setStep('place');
    }
  }, [signatureMode, typedText, renderTypedSignature]);

  const handleUploadSignature = useCallback((files: File[]) => {
    const f = files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setSignatureDataUrl(dataUrl);
      try { sessionStorage.setItem('docukit-signature', dataUrl); } catch {}
      setStep('place');
    };
    reader.readAsDataURL(f);
  }, []);

  const handlePlaceOnPage = useCallback((pageIdx: number) => {
    if (!signatureDataUrl) return;
    const newAnn: PlacedAnnotation = {
      id: generateId(),
      type: 'signature',
      pageIndex: pageIdx,
      x: 100, y: 100,  // points from bottom-left in PDF coords — 100pt is ~35mm from bottom
      width: 200, height: 60,
      rotation: 0, opacity: 1,
      imageDataUrl: signatureDataUrl,
    };
    // Replace existing annotation on the same page instead of stacking duplicates
    setAnnotations((prev) => {
      const existing = prev.filter((a) => a.pageIndex !== pageIdx);
      return [...existing, newAnn];
    });
    toast.success(`Signature placed on page ${pageIdx + 1}`);
  }, [signatureDataUrl]);

  const handleApply = useCallback(async () => {
    if (!pdfBuffer || !pdfFile || annotations.length === 0) {
      toast.error('Place at least one signature first');
      return;
    }
    setStatus('processing');
    setErrorMsg(null);

    try {
      const { port1, port2 } = new MessageChannel();
      const bufCopy = pdfBuffer.slice(0);

      const visAnnotations: VisualAnnotation[] = annotations.map((a) => ({
        type: a.type,
        pageIndex: a.pageIndex,
        x: a.x, y: a.y,
        width: a.width, height: a.height,
        rotation: a.rotation, opacity: a.opacity,
        imageDataUrl: a.imageDataUrl,
      }));

      const response: WorkerResponse | null = await run(
        'pdf',
        { op: 'sign-visual', buffer: bufCopy, options: { annotations: visAnnotations }, progressPort: port2 },
        [bufCopy, port2]
      );

      port1.close();
      if (!response) { setStatus('idle'); return; }
      if (response.status === 'error') {
        setStatus('error'); setErrorMsg(response.message);
        toast.error(response.message); return;
      }
      if (response.status === 'success') {
        setResult(response.result);
        setStatus('done');
        toast.success('Signature applied!');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      setStatus('error'); setErrorMsg(msg); toast.error(msg);
    }
  }, [pdfBuffer, pdfFile, annotations, run]);

  const handleDownload = useCallback(async () => {
    if (!result || !pdfFile) return;
    const base = pdfFile.name.replace(/\.pdf$/i, '');
    triggerDownload(result, `${base}-signed.pdf`, 'application/pdf');
  }, [result, pdfFile]);

  return (
    <div className="flex flex-col gap-6">
      {/* Step 1: Create signature */}
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h3 className="mb-4 text-base font-semibold text-[var(--color-text-primary)]">
          Step 1: Create your signature
        </h3>

        {/* Mode tabs */}
        <div className="mb-4 flex gap-1 rounded-xl bg-[var(--color-background)] p-1">
          {(['draw', 'type', 'upload'] as SignatureMode[]).map((m) => (
            <button key={m} onClick={() => setSignatureMode(m)}
              className={cn('flex-1 rounded-lg py-2 text-sm font-medium capitalize transition-colors',
                signatureMode === m
                  ? 'bg-white text-[var(--color-primary)] shadow-sm dark:bg-[var(--color-surface)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}>
              {m}
            </button>
          ))}
        </div>

        {/* Draw */}
        {signatureMode === 'draw' && (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border-2 border-dashed border-[var(--color-border)] bg-white dark:bg-[var(--color-background)]">
              <SignaturePad ref={padRef} width={560} height={180}
                className="h-44 w-full rounded-xl" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => padRef.current?.undo()}
                className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-background)]">
                Undo
              </button>
              <button onClick={() => padRef.current?.clear()}
                className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-background)]">
                Clear
              </button>
            </div>
          </div>
        )}

        {/* Type */}
        {signatureMode === 'type' && (
          <div className="flex flex-col gap-3">
            <input type="text" value={typedText} onChange={(e) => setTypedText(e.target.value)}
              placeholder="Type your name"
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3 text-lg outline-none focus:border-[var(--color-primary)]" />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {SIGNATURE_FONTS.map((font, i) => (
                <button key={font.name} onClick={() => setSelectedFont(i)}
                  className={cn('rounded-xl border p-3 transition-colors',
                    selectedFont === i
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
                      : 'border-[var(--color-border)] hover:border-[var(--color-primary)]/50'
                  )}>
                  <span style={{ fontFamily: font.css, fontSize: '18px' }}>
                    {typedText || 'Your Name'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Upload */}
        {signatureMode === 'upload' && (
          <div className="flex flex-col gap-4">
            <DropZone accept={['image/png', 'image/jpeg', 'image/webp']} multiple={false}
              onFiles={handleUploadSignature}
              hint="PNG with transparent background works best" />
            {signatureDataUrl && (
              <div className="flex justify-center rounded-xl border border-[var(--color-border)] bg-white p-4">
                <img src={signatureDataUrl} alt="Signature preview" className="max-h-32 object-contain" />
              </div>
            )}
          </div>
        )}

        <button onClick={() => {
          handleCaptureSignature();
          setTimeout(() => document.getElementById('step-2')?.scrollIntoView({ behavior: 'smooth' }), 100);
        }}
          className="mt-4 w-full rounded-xl bg-[var(--color-primary)] py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] sm:w-auto sm:px-8">
          Use this signature →
        </button>
      </div>
      
      {/* Uploading Signature directly jumps to step 2 visually without clicking the button */}
      <span id="step-2"></span>

      {/* Step 2: Upload PDF */}
      {signatureDataUrl && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <h3 className="mb-4 text-base font-semibold text-[var(--color-text-primary)]">
            Step 2: Upload your PDF
          </h3>
          <div className="flex flex-col gap-4">
            <DropZone accept={['application/pdf']} multiple={false} onFiles={handlePdfFiles} />
            {pdfFile && <FileInfoCard file={pdfFile} onRemove={handleRemovePdf} />}
          </div>
        </div>
      )}

      {/* Step 3: Place & Apply */}
      {signatureDataUrl && pdfFile && pageCount > 0 && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <h3 className="mb-4 text-base font-semibold text-[var(--color-text-primary)]">
            Step 3: Place signature on page(s)
          </h3>

          {/* Signature preview */}
          <div className="mb-4 flex items-center gap-4">
            <img src={signatureDataUrl} alt="Your signature" className="h-12 max-w-[200px] object-contain" />
            <span className="text-sm text-[var(--color-text-muted)]">Your signature</span>
          </div>

          {/* Page thumbnails for placement */}
          <div className="flex flex-wrap gap-3">
            {thumbnails.map((thumb, i) => (
              <button key={i} onClick={() => handlePlaceOnPage(i)}
                className="group relative overflow-hidden rounded-lg border-2 border-[var(--color-border)] transition-colors hover:border-[var(--color-primary)]"
                title={`Place on page ${i + 1}`}>
                <img src={thumb.dataUrl} alt={`Page ${i + 1}`}
                  className="block h-24 w-16 object-cover" />
                <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-primary)]/0 transition-colors group-hover:bg-[var(--color-primary)]/20">
                  <span className="rounded-full bg-[var(--color-primary)] px-2 py-0.5 text-xs font-bold text-white opacity-0 group-hover:opacity-100">
                    + Sign
                  </span>
                </div>
                <span className="absolute bottom-1 left-0 right-0 text-center text-xs text-white drop-shadow">{i + 1}</span>
                {annotations.some((a) => a.pageIndex === i) && (
                  <div className="absolute right-1 top-1 h-3 w-3 rounded-full bg-[var(--color-success)]" />
                )}
              </button>
            ))}
          </div>

          {annotations.length > 0 && (
            <p className="mt-3 text-sm text-[var(--color-text-secondary)]">
              {annotations.length} signature{annotations.length !== 1 ? 's' : ''} placed
            </p>
          )}
        </div>
      )}

      {/* Processing */}
      {isRunning && (
        <ProcessingOverlay progress={progress}
          label={progressLabel || 'Applying signatures…'}
          onCancel={() => { cancel(); setStatus('idle'); }} />
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
          {errorMsg}
        </div>
      )}

      {/* Actions */}
      {!isRunning && annotations.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleApply}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] sm:w-auto">
            Apply & Download
          </button>
          {status === 'done' && result && (
            <DownloadButton onClick={handleDownload} label="Download Signed PDF" />
          )}
        </div>
      )}

      {status === 'done' && result && pdfFile && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Signature applied!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {formatBytes(result.byteLength)}
          </p>
        </div>
      )}
    </div>
  );
}
