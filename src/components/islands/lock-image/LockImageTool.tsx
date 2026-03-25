import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { cn } from '@/lib/utils';

type Status = 'idle' | 'encrypting' | 'done' | 'error';

/** Strength meter (0-4) */
function getStrength(pw: string) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const labels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = ['#DC2626', '#EAB308', '#F97316', '#16A34A', '#15803D'];
  return { score: Math.min(score, 4), label: labels[Math.min(score, 4)], color: colors[Math.min(score, 4)] };
}

/** Build a standalone HTML file that decrypts and shows the image on password entry */
function buildLockedHtml(cipherB64: string, ivB64: string, saltB64: string, mimeType: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Locked Image — Docukit</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;font-family:system-ui,sans-serif;color:#f1f5f9}
  .card{background:#1e293b;border-radius:16px;padding:2rem;max-width:400px;width:90%;box-shadow:0 25px 50px rgba(0,0,0,.5)}
  h1{font-size:1.25rem;font-weight:600;margin-bottom:.5rem}
  p{color:#94a3b8;font-size:.875rem;margin-bottom:1.5rem}
  input{width:100%;padding:.75rem 1rem;border:1.5px solid #334155;border-radius:10px;background:#0f172a;color:#f1f5f9;font-size:1rem;outline:none;margin-bottom:.75rem}
  input:focus{border-color:#1a56db}
  button{width:100%;padding:.75rem;border:none;border-radius:10px;background:#1a56db;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#1e40af}
  .err{color:#dc2626;font-size:.875rem;margin-top:.5rem;text-align:center}
  img{max-width:100%;border-radius:8px;display:block;margin:0 auto}
  .branding{margin-top:1rem;text-align:center;font-size:.75rem;color:#475569}
  .branding a{color:#1a56db;text-decoration:none}
</style>
</head>
<body>
<div class="card" id="lockCard">
  <h1>🔒 Locked Image</h1>
  <p>This image is password-protected. Enter the password to view it.</p>
  <input type="password" id="pw" placeholder="Enter password" autocomplete="current-password" />
  <button onclick="unlock()">Unlock Image</button>
  <p class="err" id="err"></p>
  <p class="branding">Protected by <a href="https://docukit.uk" target="_blank">Docukit</a></p>
</div>
<script>
const CIPHER='${cipherB64}';
const IV='${ivB64}';
const SALT='${saltB64}';
const MIME='${mimeType}';
async function unlock(){
  const pw=document.getElementById('pw').value;
  if(!pw){document.getElementById('err').textContent='Enter a password';return;}
  try{
    const enc=new TextEncoder();
    const keyMat=await crypto.subtle.importKey('raw',enc.encode(pw),{name:'PBKDF2'},false,['deriveKey']);
    const salt=Uint8Array.from(atob(SALT),c=>c.charCodeAt(0));
    const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},keyMat,{name:'AES-GCM',length:256},false,['decrypt']);
    const iv=Uint8Array.from(atob(IV),c=>c.charCodeAt(0));
    const cipher=Uint8Array.from(atob(CIPHER),c=>c.charCodeAt(0));
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,cipher);
    const blob=new Blob([plain],{type:MIME});
    const url=URL.createObjectURL(blob);
    document.getElementById('lockCard').innerHTML='<img src="'+url+'" alt="Decrypted image"/><p class="branding" style="margin-top:1rem">Decrypted by <a href="https://docukit.uk" target="_blank">Docukit</a></p>';
  }catch(e){document.getElementById('err').textContent='Incorrect password. Please try again.';}
}
document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')unlock();});
</script>
</body>
</html>`;
}

export default function LockImageTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [resultHtml, setResultHtml] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const strength = getStrength(password);

  const handleFiles = useCallback(async (files: File[]) => {
    const f = files[0]; if (!f) return;
    setFile(f); setStatus('idle'); setResultHtml(null);
    try { setBuffer(await fileToArrayBuffer(f)); } catch { toast.error('Failed to read image'); }
  }, []);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); setStatus('idle'); setResultHtml(null); setErrorMsg(null);
  }, []);

  const handleEncrypt = useCallback(async () => {
    if (!buffer || !file) { toast.error('Upload an image first'); return; }
    if (!password) { toast.error('Enter a password'); return; }
    if (password !== confirmPassword) { toast.error('Passwords do not match'); return; }

    setStatus('encrypting');
    setErrorMsg(null);

    try {
      const enc = new TextEncoder();

      // Generate random salt + IV
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));

      // Derive AES-256 key from password via PBKDF2
      const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
        keyMat,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
      );

      // Encrypt image data
      const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);

      // Encode to base64 — chunked to avoid exceeding max function arguments
      const toB64 = (buf: ArrayBuffer) => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        return btoa(binary);
      };
      const cipherB64 = toB64(cipherBuf);
      const ivB64 = toB64(iv.buffer as ArrayBuffer);
      const saltB64 = toB64(salt.buffer as ArrayBuffer);

      const html = buildLockedHtml(cipherB64, ivB64, saltB64, file.type || 'image/jpeg');
      setResultHtml(html);
      setStatus('done');
      toast.success('Image locked! Download the HTML file to share.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Encryption failed';
      setStatus('error'); setErrorMsg(msg); toast.error(msg);
    }
  }, [buffer, file, password, confirmPassword]);

  const handleDownload = useCallback(async () => {
    if (!resultHtml || !file) return;
    const name = file.name.replace(/\.[^.]+$/, '') + '-locked.html';
    const blob = new Blob([resultHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [resultHtml, file]);

  return (
    <div className="flex flex-col gap-6">
      {/* How it works note */}
      <div className="flex gap-3 rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/5 p-4">
        <svg className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div className="text-sm text-[var(--color-text-secondary)]">
          <p className="font-medium text-[var(--color-text-primary)]">AES-256-GCM encryption</p>
          <p className="mt-0.5">The image is encrypted in your browser and wrapped in a standalone HTML file. Share the HTML file — the recipient enters the password to view the image. No uploads needed.</p>
        </div>
      </div>

      <DropZone accept={['image/jpeg', 'image/png', 'image/webp', 'image/gif']}
        multiple={false} onFiles={handleFiles}
        hint="JPEG, PNG, WebP, GIF · Encrypted in browser" />

      {file && (
        <>
          <FileInfoCard file={file} onRemove={handleRemoveFile} />

          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <div className="flex flex-col gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
                {password && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-border)]">
                      <div className="h-full rounded-full transition-[width]"
                        style={{ width: `${(strength.score / 4) * 100}%`, backgroundColor: strength.color }} />
                    </div>
                    <span className="text-xs" style={{ color: strength.color }}>{strength.label}</span>
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">Confirm Password</label>
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  className={cn('w-full rounded-xl border px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]',
                    'bg-[var(--color-background)]',
                    confirmPassword && password !== confirmPassword ? 'border-[var(--color-error)]' : 'border-[var(--color-border)]'
                  )} />
              </div>
            </div>
          </div>
        </>
      )}

      {status === 'encrypting' && (
        <div className="flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
          <svg className="h-4 w-4 animate-spin text-[var(--color-primary)]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Encrypting with PBKDF2 + AES-256-GCM…
        </div>
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {status !== 'encrypting' && file && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleEncrypt} disabled={!password || !confirmPassword}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] disabled:opacity-50 sm:w-auto">
            🔒 Lock Image
          </button>
          {status === 'done' && resultHtml && (
            <DownloadButton onClick={handleDownload} label="Download Locked HTML" />
          )}
        </div>
      )}

      {status === 'done' && resultHtml && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Image locked!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Share the .html file with anyone who has the password. No server involved.
          </p>
        </div>
      )}
    </div>
  );
}
