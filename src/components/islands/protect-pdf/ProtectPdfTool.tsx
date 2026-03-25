import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { useWorker } from '@/hooks/use-worker';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { triggerDownload } from '@/lib/download';
import { formatBytes } from '@/lib/utils';
import { cn } from '@/lib/utils';
import type { WorkerResponse, EncryptOptions } from '@/types/worker-messages';

function EyeToggle({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} tabIndex={-1}
      className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      aria-label={show ? 'Hide password' : 'Show password'}>
      {show ? (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-5 0-9.27-3.11-11-7.5a11.72 11.72 0 013.168-4.477M6.343 6.343A9.97 9.97 0 0112 5c5 0 9.27 3.11 11 7.5a11.7 11.7 0 01-4.373 5.157M6.343 6.343L3 3m3.343 3.343l2.829 2.829M17.657 17.657L21 21m-3.343-3.343l-2.829-2.829M9.172 9.172a3 3 0 004.243 4.243" />
        </svg>
      ) : (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      )}
    </button>
  );
}

type Mode = 'protect' | 'unlock';
type Status = 'idle' | 'processing' | 'done' | 'error';

/** Simple zxcvbn-style strength (0-4 → weak/fair/good/strong/very strong) */
function getPasswordStrength(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const labels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = ['#DC2626', '#EAB308', '#F97316', '#16A34A', '#15803D'];
  const idx = Math.min(score, 4);
  return { score: idx, label: labels[idx], color: colors[idx] };
}

export default function ProtectPdfTool({ defaultMode = 'protect' }: { defaultMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [userPassword, setUserPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [ownerPassword] = useState('');
  const [useOwnerPw] = useState(false);
  const [permissions, setPermissions] = useState({
    print: true, copyContents: true, modifyContents: false, fillForms: true, annotations: true, assemble: false,
  });
  const [unlockPassword, setUnlockPassword] = useState('');
  const [showUserPw, setShowUserPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [showUnlockPw, setShowUnlockPw] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { isRunning, progress, progressLabel, run } = useWorker();
  const strength = getPasswordStrength(userPassword);

  const handleFiles = useCallback(async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setFile(f); setStatus('idle'); setResult(null); setErrorMsg(null);
    try { setBuffer(await fileToArrayBuffer(f)); } catch { setFile(null); setBuffer(null); toast.error('Failed to load PDF. If it is encrypted, please unlock it first.'); }
  }, []);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); setStatus('idle'); setResult(null); setErrorMsg(null);
  }, []);

  const handleProtect = useCallback(async () => {
    if (!buffer || !file) { toast.error('Upload a PDF first'); return; }
    if (!userPassword) { toast.error('Enter a password'); return; }
    if (userPassword !== confirmPassword) { toast.error('Passwords do not match'); return; }

    setStatus('processing');
    const { port1, port2 } = new MessageChannel();
    const bufCopy = buffer.slice(0);
    const opts: EncryptOptions = {
      userPassword,
      ownerPassword: useOwnerPw ? ownerPassword || userPassword : userPassword,
      permissions,
    };
    const response: WorkerResponse | null = await run(
      'pdf', { op: 'encrypt', buffer: bufCopy, options: opts, progressPort: port2 }, [bufCopy, port2]
    );
    port1.close();
    if (!response) { setStatus('idle'); return; }
    if (response.status === 'error') { setStatus('error'); setErrorMsg(response.message); toast.error(response.message); return; }
    if (response.status === 'success') { setResult(response.result); setStatus('done'); toast.success('PDF password protected!'); }
  }, [buffer, file, userPassword, confirmPassword, ownerPassword, useOwnerPw, permissions, run]);

  const handleUnlock = useCallback(async () => {
    if (!buffer || !file) { toast.error('Upload a PDF first'); return; }
    if (!unlockPassword) { toast.error('Enter the password'); return; }

    setStatus('processing');
    const { port1, port2 } = new MessageChannel();
    const bufCopy = buffer.slice(0);
    const response: WorkerResponse | null = await run(
      'pdf', { op: 'decrypt', buffer: bufCopy, password: unlockPassword, progressPort: port2 }, [bufCopy, port2]
    );
    port1.close();
    if (!response) { setStatus('idle'); return; }
    if (response.status === 'error') { setStatus('error'); setErrorMsg('Incorrect password or decryption failed'); toast.error('Incorrect password'); return; }
    if (response.status === 'success') { setResult(response.result); setStatus('done'); toast.success('PDF unlocked!'); }
  }, [buffer, file, unlockPassword, run]);

  const handleDownload = useCallback(async () => {
    if (!result || !file) return;
    const base = file.name.replace(/\.pdf$/i, '');
    const suffix = mode === 'protect' ? '-protected' : '-unlocked';
    triggerDownload(result, `${base}${suffix}.pdf`, 'application/pdf');
  }, [result, file, mode]);

  const generatePassword = useCallback(() => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    const pw = Array.from(arr).map((n) => chars[n % chars.length]).join('');
    setUserPassword(pw); setConfirmPassword(pw);
    setShowUserPw(true); // Show generated password so user can see it
    navigator.clipboard.writeText(pw).then(() => toast.success('Password copied to clipboard')).catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {/* Mode tabs */}
      <div className="flex gap-1 rounded-xl bg-[var(--color-background)] p-1">
        {(['protect', 'unlock'] as Mode[]).map((m) => (
          <button key={m} onClick={() => { setMode(m); setStatus('idle'); setResult(null); }}
            className={cn('flex-1 rounded-lg py-2.5 text-sm font-medium capitalize transition-colors',
              mode === m
                ? 'bg-white text-[var(--color-primary)] shadow-sm dark:bg-[var(--color-surface)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
            )}>
            {m === 'protect' ? '🔒 Add Password' : '🔓 Remove Password'}
          </button>
        ))}
      </div>

      <DropZone accept={['application/pdf']} multiple={false} onFiles={handleFiles}
        hint={mode === 'protect' ? 'PDF to password-protect' : 'Password-protected PDF'} />

      {file && <FileInfoCard file={file} onRemove={handleRemoveFile} />}

      {/* Protect form */}
      {mode === 'protect' && file && (
        <div className="flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-sm font-medium text-[var(--color-text-primary)]">Password</label>
              <button onClick={generatePassword} className="text-xs text-[var(--color-primary)] hover:underline">Generate random</button>
            </div>
            <div className="relative">
              <input type={showUserPw ? 'text' : 'password'} value={userPassword} onChange={(e) => setUserPassword(e.target.value)}
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 pr-10 text-sm outline-none focus:border-[var(--color-primary)]" />
              <EyeToggle show={showUserPw} onToggle={() => setShowUserPw((v) => !v)} />
            </div>
            {userPassword && (
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-border)]">
                  <div className="h-full rounded-full transition-[width]" style={{ width: `${(strength.score / 4) * 100}%`, backgroundColor: strength.color }} />
                </div>
                <span className="text-xs" style={{ color: strength.color }}>{strength.label}</span>
              </div>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">Confirm Password</label>
            <div className="relative">
              <input type={showConfirmPw ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                className={cn('w-full rounded-xl border px-4 py-2.5 pr-10 text-sm outline-none focus:border-[var(--color-primary)]',
                  'bg-[var(--color-background)]',
                  confirmPassword && userPassword !== confirmPassword ? 'border-[var(--color-error)]' : 'border-[var(--color-border)]'
                )} />
              <EyeToggle show={showConfirmPw} onToggle={() => setShowConfirmPw((v) => !v)} />
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-[var(--color-text-primary)]">Permissions</p>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(permissions).map(([key, val]) => (
                <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                  <input type="checkbox" checked={val}
                    onChange={(e) => setPermissions((p) => ({ ...p, [key]: e.target.checked }))}
                    className="accent-[var(--color-primary)]" />
                  {key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Unlock form */}
      {mode === 'unlock' && file && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">PDF Password</label>
          <div className="relative">
            <input type={showUnlockPw ? 'text' : 'password'} value={unlockPassword} onChange={(e) => setUnlockPassword(e.target.value)}
              placeholder="Enter password to unlock"
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 pr-10 text-sm outline-none focus:border-[var(--color-primary)]" />
            <EyeToggle show={showUnlockPw} onToggle={() => setShowUnlockPw((v) => !v)} />
          </div>
        </div>
      )}

      {isRunning && <ProcessingOverlay progress={progress} label={progressLabel || (mode === 'protect' ? 'Encrypting…' : 'Decrypting…')} />}

      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {!isRunning && file && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={mode === 'protect' ? handleProtect : handleUnlock}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] sm:w-auto">
            {mode === 'protect' ? 'Protect PDF' : 'Unlock PDF'}
          </button>
          {status === 'done' && result && (
            <DownloadButton onClick={handleDownload} label={mode === 'protect' ? 'Download Protected PDF' : 'Download Unlocked PDF'} />
          )}
        </div>
      )}

      {status === 'done' && result && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">{mode === 'protect' ? 'Password set!' : 'PDF unlocked!'}</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{formatBytes(result.byteLength)}</p>
        </div>
      )}
    </div>
  );
}
