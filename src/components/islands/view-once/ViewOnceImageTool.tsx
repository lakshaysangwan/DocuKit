import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import { fileToArrayBuffer, validateFileSize, VIEW_ONCE_MAX_SIZE } from '@/lib/file-utils';
import { formatBytes } from '@/lib/utils';

type Status = 'idle' | 'encrypting' | 'uploading' | 'done' | 'error';

const TTL_OPTIONS = [
  { label: '1 hour', value: 3600 },
  { label: '6 hours', value: 21600 },
  { label: '24 hours', value: 86400 },
  { label: '7 days', value: 604800 },
];

async function encryptBuffer(buffer: ArrayBuffer): Promise<{ encrypted: ArrayBuffer; key: CryptoKey; iv: Uint8Array }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  return { encrypted, key, iv };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

async function exportKeyBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bytesToBase64(new Uint8Array(raw));
}

function ivToBase64(iv: Uint8Array): string {
  return bytesToBase64(iv);
}

export default function ViewOnceImageTool() {
  const [file, setFile] = useState<File | null>(null);
  const [ttl, setTtl] = useState(86400);
  const [status, setStatus] = useState<Status>('idle');
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFiles = useCallback((files: File[]) => {
    const f = files[0];
    if (!f) return;
    const err = validateFileSize(f, VIEW_ONCE_MAX_SIZE);
    if (err) { toast.error(err); return; }
    setFile(f);
    setStatus('idle');
    setShareUrl(null);
    setCopied(false);
  }, []);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setStatus('idle'); setShareUrl(null); setCopied(false); setErrorMsg(null);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!file) { toast.error('Upload an image first'); return; }

    setStatus('encrypting');
    setErrorMsg(null);

    try {
      const buffer = await fileToArrayBuffer(file);

      // Combine mime type length + mime type + image data so recipient knows the type
      const mimeBytes = new TextEncoder().encode(file.type);
      const combined = new ArrayBuffer(2 + mimeBytes.length + buffer.byteLength);
      const view = new DataView(combined);
      view.setUint16(0, mimeBytes.length, false);
      new Uint8Array(combined, 2, mimeBytes.length).set(mimeBytes);
      new Uint8Array(combined, 2 + mimeBytes.length).set(new Uint8Array(buffer));

      const { encrypted, key, iv } = await encryptBuffer(combined);
      const keyB64 = await exportKeyBase64(key);
      const ivB64 = ivToBase64(iv);

      setStatus('uploading');

      const res = await fetch('/api/view-once', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-TTL': String(ttl) },
        body: encrypted,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'Unknown error');
        throw new Error(`Upload failed: ${text}`);
      }

      const { id } = (await res.json()) as { id: string };

      // Key and IV are in the fragment — never sent to server
      const url = `${window.location.origin}/view/${id}#${keyB64}.${ivB64}`;
      setShareUrl(url);
      setStatus('done');
      toast.success('View-once link created!');
    } catch (err) {
      let msg = err instanceof Error ? err.message : 'Failed to create link';
      if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('network'))) {
        msg = 'View-once requires the Cloudflare Worker backend. This feature is unavailable in local development.';
      }
      setStatus('error');
      setErrorMsg(msg);
      toast.error(msg);
    }
  }, [file, ttl]);

  const handleCopy = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success('Link copied to clipboard!');
      setTimeout(() => setCopied(false), 3000);
    } catch {
      toast.error('Failed to copy — select and copy manually');
    }
  }, [shareUrl]);

  const handleReset = useCallback(() => {
    setFile(null);
    setStatus('idle');
    setShareUrl(null);
    setCopied(false);
    setErrorMsg(null);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {/* How it works */}
      <div className="flex gap-3 rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/5 p-4">
        <svg className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div className="text-sm text-[var(--color-text-secondary)]">
          <p className="font-medium text-[var(--color-text-primary)]">End-to-end encrypted · View once · Auto-delete</p>
          <p className="mt-0.5">Your image is encrypted in the browser before upload. The decryption key is only in the share URL — never sent to the server. The image is permanently deleted after the first view.</p>
        </div>
      </div>

      {!shareUrl && (
        <>
          <DropZone
            accept={['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']}
            multiple={false}
            onFiles={handleFiles}
            hint="JPEG, PNG, WebP, GIF · Max 10MB"
          />

          {file && (
            <div className="flex flex-col gap-2">
              <FileInfoCard file={file} onRemove={handleRemoveFile} />
              <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
                <img src={URL.createObjectURL(file)} alt={file.name} className="mx-auto max-h-48 object-contain" />
              </div>
            </div>
          )}

          {file && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <label className="mb-3 block text-sm font-medium text-[var(--color-text-primary)]">Link expires after</label>
              <div className="flex flex-wrap gap-2">
                {TTL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setTtl(opt.value)}
                    className={[
                      'rounded-xl border px-4 py-2 text-sm transition-colors',
                      ttl === opt.value
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)] font-medium'
                        : 'border-[var(--color-border)] text-[var(--color-text-secondary)]',
                    ].join(' ')}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {status === 'error' && errorMsg && (
            <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
              {errorMsg}
            </div>
          )}

          {(status === 'encrypting' || status === 'uploading') && (
            <div className="flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
              <svg className="h-4 w-4 animate-spin text-[var(--color-primary)]" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {status === 'encrypting' ? 'Encrypting image…' : 'Uploading encrypted data…'}
            </div>
          )}

          {file && status !== 'encrypting' && status !== 'uploading' && (
            <button
              onClick={handleCreate}
              className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] sm:w-auto"
            >
              🔗 Create View-Once Link
            </button>
          )}
        </>
      )}

      {/* Success state */}
      {status === 'done' && shareUrl && (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
            <p className="text-sm font-medium text-[var(--color-success)]">View-once link created!</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Share the link below. The image will be permanently deleted after the first view.
            </p>
          </div>

          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <label className="mb-2 block text-xs font-medium text-[var(--color-text-secondary)]">Share link</label>
            <div className="flex gap-2">
              <input
                readOnly
                value={shareUrl}
                className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2.5 text-sm font-mono outline-none"
                onFocus={(e) => e.target.select()}
              />
              <button
                onClick={handleCopy}
                className={[
                  'shrink-0 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors',
                  copied
                    ? 'border-[var(--color-success)] bg-[var(--color-success)]/10 text-[var(--color-success)]'
                    : 'border-[var(--color-border)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]',
                ].join(' ')}
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 p-3 text-xs text-[var(--color-text-secondary)]">
            ⚠️ <strong>Important:</strong> This is the only time you can see this link. Once you leave the page, the link cannot be recovered. The recipient's browser will automatically delete the image from our servers.
          </div>

          <button
            onClick={handleReset}
            className="w-full rounded-xl border border-[var(--color-border)] px-6 py-2.5 text-sm font-medium text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] sm:w-auto"
          >
            Create another link
          </button>
        </div>
      )}
    </div>
  );
}
