import { useState, useEffect } from 'react';

type Status = 'loading' | 'decrypting' | 'done' | 'error';

async function fetchAndDecrypt(id: string, keyB64: string, ivB64: string): Promise<{ url: string; mimeType: string }> {
  const res = await fetch(`/api/view-once/${id}`);
  if (!res.ok) {
    if (res.status === 404 || res.status === 410) {
      throw new Error('This image has expired or has already been viewed.');
    }
    throw new Error(`Failed to fetch image (${res.status}).`);
  }

  const encrypted = await res.arrayBuffer();

  // Import key from base64
  const keyBytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);

  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  } catch {
    throw new Error('Decryption failed — the link may be corrupted or the key is invalid.');
  }

  // Parse prepended mime type (uint16 length + mime bytes + image data)
  const view = new DataView(decrypted);
  const mimeLen = view.getUint16(0, false);
  const mimeType = new TextDecoder().decode(new Uint8Array(decrypted, 2, mimeLen));
  const imageData = decrypted.slice(2 + mimeLen);

  const blob = new Blob([imageData], { type: mimeType });
  const url = URL.createObjectURL(blob);
  return { url, mimeType };
}

export default function ViewOnceRecipient() {
  const [status, setStatus] = useState<Status>('loading');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.slice(1); // remove #
    if (!hash) {
      setStatus('error');
      setErrorMsg('Invalid link — missing decryption key.');
      return;
    }

    const dotIdx = hash.lastIndexOf('.');
    if (dotIdx === -1) {
      setStatus('error');
      setErrorMsg('Invalid link format.');
      return;
    }

    const keyB64 = hash.slice(0, dotIdx);
    const ivB64 = hash.slice(dotIdx + 1);

    // Extract ID from pathname: /view/[id]
    const pathParts = window.location.pathname.split('/');
    const id = pathParts[pathParts.length - 1];

    if (!id || !keyB64 || !ivB64) {
      setStatus('error');
      setErrorMsg('Invalid link — missing required parameters.');
      return;
    }

    setStatus('loading');
    fetchAndDecrypt(id, keyB64, ivB64)
      .then(({ url }) => {
        setImageUrl(url);
        setStatus('done');
      })
      .catch((err: Error) => {
        setStatus('error');
        setErrorMsg(err.message);
      });
  }, []);

  if (status === 'loading' || status === 'decrypting') {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <svg className="h-10 w-10 animate-spin text-[var(--color-primary)]" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {status === 'loading' ? 'Fetching encrypted image…' : 'Decrypting…'}
        </p>
      </div>
    );
  }

  if (status === 'error' || !imageUrl) {
    return (
      <div className="flex flex-col items-center gap-6 py-16 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-error)]/10 text-3xl">
          🔒
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Image Unavailable</h2>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            {errorMsg ?? 'This image has expired or has already been viewed.'}
          </p>
        </div>
        <a
          href="/"
          className="rounded-xl bg-[var(--color-primary)] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-dark)]"
        >
          Go to Docukit
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6 py-8">
      <div className="flex items-center gap-2 rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 px-4 py-2 text-sm text-[var(--color-success)]">
        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        Decrypted successfully · Image deleted from server
      </div>

      <img
        src={imageUrl}
        alt="Decrypted view-once image"
        className="max-h-[70vh] max-w-full rounded-xl object-contain shadow-lg"
      />

      <div className="flex gap-3">
        <a
          href={imageUrl}
          download="image"
          className="rounded-xl border border-[var(--color-border)] px-5 py-2.5 text-sm font-medium text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
        >
          Save Image
        </a>
        <a
          href="/"
          className="rounded-xl bg-[var(--color-primary)] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-dark)]"
        >
          Go to Docukit
        </a>
      </div>

      <p className="text-xs text-[var(--color-text-muted)]">
        This image was encrypted end-to-end and has been permanently deleted from our servers.
      </p>
    </div>
  );
}
