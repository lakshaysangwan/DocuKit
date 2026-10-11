import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { useWorker } from '@/hooks/use-worker';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { notifyPdfLoadError } from '@/lib/notify';
import { triggerDownload } from '@/lib/download';
import { formatBytes } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { readEncryptionInfo, type EncryptionInfo } from '@/lib/pdf-encryption-info';
import {
  GENERATED_OWNER_PASSWORD_LENGTH,
  generatePassword,
  passwordProblem,
  resolvePermissions,
  type ProtectPermissionKey,
  type ProtectPermissions,
} from '@/lib/pdf-protect';
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
/** Whether the protected file asks for a password before it opens. */
type OpenMode = 'password' | 'none';

const PERMISSION_OPTIONS: { key: ProtectPermissionKey; label: string }[] = [
  { key: 'print', label: 'Print' },
  { key: 'copyContents', label: 'Copy text and images' },
  { key: 'modifyContents', label: 'Edit the content' },
  { key: 'fillForms', label: 'Fill in forms' },
  { key: 'annotations', label: 'Comment and annotate' },
  { key: 'assemble', label: 'Insert, delete and rotate pages' },
];

const INPUT_CLASS =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 pr-10 text-sm outline-none focus:border-[var(--color-primary)]';

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
  const [openMode, setOpenMode] = useState<OpenMode>('password');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [showOwnerPw, setShowOwnerPw] = useState(false);
  // The permissions password made for the visitor when they did not choose one.
  const [generatedOwnerPw, setGeneratedOwnerPw] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<ProtectPermissions>({
    print: true, copyContents: true, modifyContents: false, fillForms: true, annotations: true, assemble: false,
  });
  const [unlockPassword, setUnlockPassword] = useState('');
  const [showUserPw, setShowUserPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [showUnlockPw, setShowUnlockPw] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [encryption, setEncryption] = useState<EncryptionInfo | null>(null);

  const { isRunning, progress, progressLabel, run } = useWorker();
  const strength = getPasswordStrength(userPassword);
  // What the file will actually record: allowing comments allows form filling.
  const effective = resolvePermissions(permissions);
  const openPassword = openMode === 'password' ? userPassword : '';
  const ownerClash = ownerPassword !== '' ? passwordProblem(openPassword, ownerPassword) : null;

  /**
   * A finished file belongs to the settings it was made with. Once any of them
   * changes, drop it rather than leave a download on screen that no longer
   * matches the form.
   */
  const clearResult = useCallback(() => {
    setStatus('idle'); setResult(null); setErrorMsg(null); setGeneratedOwnerPw(null);
  }, []);

  const handleFiles = useCallback(async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setFile(f); clearResult(); setEncryption(null);
    try {
      const buf = await fileToArrayBuffer(f);
      setBuffer(buf);
      setEncryption(readEncryptionInfo(new Uint8Array(buf)));
    } catch { setFile(null); setBuffer(null); notifyPdfLoadError(); }
  }, [clearResult]);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); clearResult(); setEncryption(null);
  }, [clearResult]);

  const handleProtect = useCallback(async () => {
    if (!buffer || !file) { toast.error('Upload a PDF first'); return; }
    if (openMode === 'password') {
      if (!userPassword) { toast.error('Enter a password'); return; }
      if (userPassword !== confirmPassword) { toast.error('Passwords do not match'); return; }
    }

    // The two passwords must differ, or whoever opens the file is treated as
    // its owner and none of the permissions apply to them. So when the visitor
    // names no permissions password, one is made for them — never the open
    // password again.
    const generated = ownerPassword === '';
    const owner = generated ? generatePassword(GENERATED_OWNER_PASSWORD_LENGTH) : ownerPassword;
    const problem = passwordProblem(openPassword, owner);
    if (problem) { toast.error(problem); return; }

    setStatus('processing'); setGeneratedOwnerPw(null);
    const { port1, port2 } = new MessageChannel();
    const bufCopy = buffer.slice(0);
    const opts: EncryptOptions = {
      userPassword: openPassword,
      ownerPassword: owner,
      permissions: effective,
    };
    const response: WorkerResponse | null = await run(
      'pdf', { op: 'encrypt', buffer: bufCopy, options: opts, progressPort: port2 }, [bufCopy, port2]
    );
    port1.close();
    if (!response) { setStatus('idle'); return; }
    if (response.status === 'error') { setStatus('error'); setErrorMsg(response.message); toast.error(response.message); return; }
    if (response.status === 'success') {
      setResult(response.result); setStatus('done');
      setGeneratedOwnerPw(generated ? owner : null);
      toast.success(openMode === 'password' ? 'PDF password protected!' : 'Restrictions added to the PDF');
    }
  }, [buffer, file, openMode, userPassword, confirmPassword, openPassword, ownerPassword, effective, run]);

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
    if (response.status === 'success') { setResult(response.result); setStatus('done'); toast.success('Password removed — ready to download'); }
  }, [buffer, file, unlockPassword, run]);

  const handleDownload = useCallback(async () => {
    if (!result || !file) return;
    const base = file.name.replace(/\.pdf$/i, '');
    const suffix = mode === 'protect' ? '-protected' : '-unlocked';
    triggerDownload(result, `${base}${suffix}.pdf`, 'application/pdf');
  }, [result, file, mode]);

  const fillRandomPassword = useCallback(() => {
    const pw = generatePassword(16);
    setUserPassword(pw); setConfirmPassword(pw); clearResult();
    setShowUserPw(true); // Show generated password so user can see it
    navigator.clipboard.writeText(pw).then(() => toast.success('Password copied to clipboard')).catch(() => {});
  }, [clearResult]);

  const copyGeneratedOwnerPw = useCallback(() => {
    if (!generatedOwnerPw) return;
    navigator.clipboard.writeText(generatedOwnerPw)
      .then(() => toast.success('Permissions password copied to clipboard'))
      .catch(() => toast.error('Could not copy — select the password and copy it yourself'));
  }, [generatedOwnerPw]);

  return (
    <div className="flex flex-col gap-6">
      {/* Mode tabs */}
      <div className="flex gap-1 rounded-lg bg-[var(--color-background)] p-1">
        {(['protect', 'unlock'] as Mode[]).map((m) => (
          <button key={m} onClick={() => { setMode(m); clearResult(); }}
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
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-[var(--color-text-primary)]">Opening the file</legend>
            <div className="flex flex-col gap-2 text-sm text-[var(--color-text-secondary)]">
              <label className="flex cursor-pointer items-start gap-2">
                <input type="radio" name="protect-open-mode" checked={openMode === 'password'}
                  onChange={() => { setOpenMode('password'); clearResult(); }}
                  data-testid="mode-password" className="mt-0.5 accent-[var(--color-primary)]" />
                <span>Ask for a password <span className="text-[var(--color-text-muted)]">— the file cannot be read without it</span></span>
              </label>
              <label className="flex cursor-pointer items-start gap-2">
                <input type="radio" name="protect-open-mode" checked={openMode === 'none'}
                  onChange={() => { setOpenMode('none'); clearResult(); }}
                  data-testid="mode-restrict" className="mt-0.5 accent-[var(--color-primary)]" />
                <span>No password, restrictions only <span className="text-[var(--color-text-muted)]">— anyone can open and read it</span></span>
              </label>
            </div>
          </fieldset>

          {openMode === 'none' && (
            <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3 text-xs text-[var(--color-text-secondary)]" data-testid="no-open-password-note">
              This file will open for anyone, with no password. It only records the permissions below, which a PDF reader may or may not follow.
            </p>
          )}

          {openMode === 'password' && (
          <>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="protect-password" className="text-sm font-medium text-[var(--color-text-primary)]">Password</label>
              <button type="button" onClick={fillRandomPassword} className="text-xs text-[var(--color-primary)] hover:underline">Generate random</button>
            </div>
            <div className="relative">
              <input id="protect-password" type={showUserPw ? 'text' : 'password'} value={userPassword} onChange={(e) => { setUserPassword(e.target.value); clearResult(); }}
                data-testid="password"
                className={INPUT_CLASS} />
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
            <label htmlFor="protect-confirm-password" className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">Confirm Password</label>
            <div className="relative">
              <input id="protect-confirm-password" type={showConfirmPw ? 'text' : 'password'} value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); clearResult(); }}
                data-testid="confirm-password"
                className={cn('w-full rounded-lg border px-4 py-2.5 pr-10 text-sm outline-none focus:border-[var(--color-primary)]',
                  'bg-[var(--color-background)]',
                  confirmPassword && userPassword !== confirmPassword ? 'border-[var(--color-error)]' : 'border-[var(--color-border)]'
                )} />
              <EyeToggle show={showConfirmPw} onToggle={() => setShowConfirmPw((v) => !v)} />
            </div>
          </div>
          </>
          )}

          <fieldset>
            <legend className="mb-1 text-sm font-medium text-[var(--color-text-primary)]">Permissions</legend>
            <p className="mb-2 text-xs text-[var(--color-text-muted)]">
              {openMode === 'password'
                ? 'What someone who opens the file with the password above may do. Ticked means allowed.'
                : 'What someone who opens the file may do. Ticked means allowed.'}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {PERMISSION_OPTIONS.map(({ key, label }) => {
                // Commenting includes form filling in the PDF format, so the
                // form box cannot be cleared on its own while commenting is on.
                const implied = key === 'fillForms' && permissions.annotations;
                return (
                  <label key={key} className={cn('flex items-center gap-2 text-sm text-[var(--color-text-secondary)]', implied ? 'cursor-default' : 'cursor-pointer')}>
                    <input type="checkbox" checked={effective[key]} disabled={implied}
                      onChange={(e) => { setPermissions((p) => ({ ...p, [key]: e.target.checked })); clearResult(); }}
                      data-testid={`perm-${key}`}
                      className="accent-[var(--color-primary)]" />
                    <span>{label}{implied && <span className="text-[var(--color-text-muted)]"> (comes with commenting)</span>}</span>
                  </label>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-[var(--color-text-secondary)]" data-testid="permissions-note">
              These permissions are written into the file, and PDF readers that respect them, such as Adobe Acrobat, hold to them.
              Some readers ignore them (Firefox&apos;s built-in viewer does unless it is set otherwise), and anyone who can open the file can remove them.
              {openMode === 'password'
                ? ' What keeps the content private is the password that opens it.'
                : ' Add a password to open the file if its content has to stay private.'}
            </p>
          </fieldset>

          <div>
            <label htmlFor="protect-owner-password" className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">Permissions password (optional)</label>
            <div className="relative">
              <input id="protect-owner-password" type={showOwnerPw ? 'text' : 'password'} value={ownerPassword} onChange={(e) => { setOwnerPassword(e.target.value); clearResult(); }}
                data-testid="owner-password" autoComplete="new-password"
                aria-describedby="protect-owner-password-help"
                aria-invalid={ownerClash ? true : undefined}
                className={cn(INPUT_CLASS, ownerClash && 'border-[var(--color-error)]')} />
              <EyeToggle show={showOwnerPw} onToggle={() => setShowOwnerPw((v) => !v)} />
            </div>
            {ownerClash && (
              <p className="mt-1.5 text-xs text-[var(--color-error)]" role="alert" data-testid="owner-password-error">{ownerClash}</p>
            )}
            <p id="protect-owner-password-help" className="mt-1.5 text-xs text-[var(--color-text-muted)]">
              Opens the file with every permission, whatever is ticked above.
              {openMode === 'password' ? ' It has to be different from the password that opens the file.' : ''}
              {' '}Leave it empty and a random one is made for you and shown once the file is ready.
            </p>
          </div>
        </div>
      )}

      {/* Unlock form */}
      {mode === 'unlock' && file && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <label htmlFor="unlock-password" className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">PDF Password</label>
          <div className="relative">
            <input id="unlock-password" type={showUnlockPw ? 'text' : 'password'} value={unlockPassword} onChange={(e) => setUnlockPassword(e.target.value)}
              data-testid="unlock-password"
              placeholder="Enter password to unlock"
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 pr-10 text-sm outline-none focus:border-[var(--color-primary)]" />
            <EyeToggle show={showUnlockPw} onToggle={() => setShowUnlockPw((v) => !v)} />
          </div>

          {/* Encryption details, read from the file's own /Encrypt dictionary */}
          {encryption && (
            <div className="mt-5 border-t border-[var(--color-border)] pt-4" data-testid="encryption-details">
              <p className="mb-2 text-xs font-medium text-[var(--color-text-primary)]">
                Original encryption
              </p>
              {encryption.encrypted ? (
                <>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-[var(--color-text-secondary)]">
                    <dt className="text-[var(--color-text-muted)]">Algorithm</dt>
                    <dd data-testid="encryption-algorithm">{encryption.algorithm}</dd>
                    {encryption.keyLength !== undefined && (
                      <>
                        <dt className="text-[var(--color-text-muted)]">Key length</dt>
                        <dd>{encryption.keyLength}-bit</dd>
                      </>
                    )}
                    {encryption.revision !== undefined && (
                      <>
                        <dt className="text-[var(--color-text-muted)]">Handler</dt>
                        <dd>
                          Standard
                          {encryption.version !== undefined ? ` V${encryption.version}` : ''}
                          {` R${encryption.revision}`}
                        </dd>
                      </>
                    )}
                  </dl>
                  {encryption.permissions && (
                    <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                      Allowed: {Object.entries(encryption.permissions)
                        .filter(([, allowed]) => allowed)
                        .map(([name]) => name.replace(/([A-Z])/g, ' $1').toLowerCase())
                        .join(', ') || 'nothing beyond opening the file'}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-[var(--color-text-muted)]" data-testid="encryption-algorithm">
                  This PDF is not encrypted — there is nothing to unlock.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {isRunning && <ProcessingOverlay progress={progress} label={progressLabel || (mode === 'protect' ? 'Encrypting…' : 'Decrypting…')} />}

      {status === 'error' && errorMsg && (
        <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {!isRunning && file && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={mode === 'protect' ? handleProtect : handleUnlock} data-testid="tool-action"
            className="w-full rounded-lg bg-[var(--color-text-primary)] px-6 py-2.5 text-sm font-medium text-[var(--color-background)] hover:opacity-80 sm:w-auto">
            {mode === 'protect' ? 'Protect PDF' : 'Unlock PDF'}
          </button>
          {status === 'done' && result && (
            <DownloadButton onClick={handleDownload} label={mode === 'protect' ? 'Download Protected PDF' : 'Download Unlocked PDF'} />
          )}
        </div>
      )}

      {status === 'done' && result && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">
            {mode === 'unlock' ? 'PDF unlocked!' : openMode === 'password' ? 'Password set!' : 'Restrictions added!'}
          </p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{formatBytes(result.byteLength)}</p>
          {mode === 'protect' && generatedOwnerPw && (
            <div className="mt-4 border-t border-[var(--color-border)] pt-4">
              <label htmlFor="generated-owner-password" className="mb-1.5 block text-xs font-medium text-[var(--color-text-primary)]">
                Permissions password made for this file
              </label>
              <div className="flex gap-2">
                <input id="generated-owner-password" type="text" readOnly value={generatedOwnerPw}
                  data-testid="generated-owner-password"
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-primary)]" />
                <button type="button" onClick={copyGeneratedOwnerPw}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)]">
                  Copy
                </button>
              </div>
              <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                It opens the file with every permission. Save it now if you might need that — it is not kept anywhere and will not be shown again.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
