import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageViewer from '@/components/islands/workspace/PageViewer';
import PageRail from '@/components/islands/workspace/PageRail';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import {
  EyeToggle,
  LockedStage,
  PASSWORD_INPUT_CLASS,
  SECONDARY_BUTTON_CLASS,
  StageCaption,
} from './security-ui';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import { useMediaQuery } from '@/hooks/use-media-query';
import { PdfPasswordError } from '@/lib/pdf/doc-handle';
import { notifyPdfLoadError } from '@/lib/notify';
import { downloadBlob } from '@/lib/download';
import { formatBytes, cn } from '@/lib/utils';
import { readEncryptionInfo, type EncryptionInfo } from '@/lib/pdf-encryption-info';
import {
  GENERATED_OWNER_PASSWORD_LENGTH,
  WRONG_PASSWORD_MESSAGE,
  generatePassword,
  passwordProblem,
  resolvePermissions,
  type ProtectPermissionKey,
  type ProtectPermissions,
} from '@/lib/pdf-protect';
import type { EncryptOptions } from '@/types/worker-messages';

/**
 * Protect PDF, in the shared workspace.
 *
 * The document is shown (page large, rail) so the visitor can confirm it is
 * the right file; the passwords and permissions are in the controls pane,
 * exactly as before. A file that is already encrypted is recognised on upload
 * and sent to Unlock PDF first. After a run, a file that asks for a password is
 * shown as a locked placeholder — it cannot be drawn without the password —
 * with "Check it opens", which tries a password on the real output in the
 * page and shows page 1 if it opens.
 */

/** Whether the protected file asks for a password before it opens. */
type OpenMode = 'password' | 'none';

interface Protected {
  file: File;
  /** How the file opens, as it was made. */
  openMode: OpenMode;
  /** The permissions password made for the visitor, when they did not choose one. */
  generatedOwnerPassword: string | null;
}

const ACCEPT = ['application/pdf'];

const PERMISSION_OPTIONS: { key: ProtectPermissionKey; label: string }[] = [
  { key: 'print', label: 'Print' },
  { key: 'copyContents', label: 'Copy text and images' },
  { key: 'modifyContents', label: 'Edit the content' },
  { key: 'fillForms', label: 'Fill in forms' },
  { key: 'annotations', label: 'Comment and annotate' },
  { key: 'assemble', label: 'Insert, delete and rotate pages' },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
const note = 'text-sm text-[var(--color-text-secondary)]';

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

export default function ProtectPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const { status, doc, pageCount } = usePdfDocument(file);
  const [encryption, setEncryption] = useState<{ file: File; info: EncryptionInfo } | null>(null);
  const [pageIndex, setPageIndex] = useState(0);

  const [userPassword, setUserPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [openMode, setOpenMode] = useState<OpenMode>('password');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [showOwnerPw, setShowOwnerPw] = useState(false);
  const [permissions, setPermissions] = useState<ProtectPermissions>({
    print: true, copyContents: true, modifyContents: false, fillForms: true, annotations: true, assemble: false,
  });
  const [showUserPw, setShowUserPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);

  const run = useToolRun<Protected>();
  const done = run.phase === 'done' && !!run.result;
  const made = done ? run.result : null;

  // "Check it opens": a password tried on the protected file, in the page.
  const [checkTyped, setCheckTyped] = useState('');
  const [checkTried, setCheckTried] = useState<string | undefined>(undefined);
  const [showCheckPw, setShowCheckPw] = useState(false);
  const output = usePdfDocument(made?.file ?? null, { password: checkTried });

  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const [optionsOpen, setOptionsOpen] = useState(false);

  const strength = getPasswordStrength(userPassword);
  // What the file will actually record: allowing comments allows form filling.
  const effective = resolvePermissions(permissions);
  const openPassword = openMode === 'password' ? userPassword : '';
  const ownerClash = ownerPassword !== '' ? passwordProblem(openPassword, ownerPassword) : null;

  const { invalidate } = run;
  /** Every change makes a result stale. */
  const change = useCallback(
    <T,>(set: (value: T) => void) =>
      (value: T) => {
        set(value);
        invalidate();
      },
    [invalidate],
  );

  // A new result starts with nothing tried on it.
  useEffect(() => {
    setCheckTyped('');
    setCheckTried(undefined);
  }, [run.result]);

  // The /Encrypt dictionary, read from the bytes: a file that opens without a
  // password can still be encrypted (restrictions only).
  useEffect(() => {
    if (!file) return;
    let live = true;
    file.arrayBuffer().then(
      (buffer) => {
        if (live) setEncryption({ file, info: readEncryptionInfo(new Uint8Array(buffer)) });
      },
      () => {
        if (live) setEncryption({ file, info: { encrypted: false, algorithm: 'None' } });
      },
    );
    return () => {
      live = false;
    };
  }, [file]);
  const info = encryption?.file === file ? encryption.info : null;

  useEffect(() => {
    if (status === 'error') {
      notifyPdfLoadError();
      setFile(null);
    }
  }, [status]);

  const hasPassword = status === 'locked';
  const hasRestrictions = status === 'ready' && !!info?.encrypted;
  const alreadyProtected = hasPassword || hasRestrictions;

  const acceptFile = useCallback(
    (files: File[]) => {
      const next = files[0];
      if (!next) return;
      invalidate();
      setFile(next);
      setPageIndex(0);
    },
    [invalidate],
  );

  const removeFile = useCallback(() => {
    invalidate();
    setFile(null);
  }, [invalidate]);

  /* ── The run ──────────────────────────────────────────────────────────── */

  const outputName = `${(file?.name ?? 'document').replace(/\.pdf$/i, '')}-protected.pdf`;

  let disabledReason: string | null = null;
  if (hasPassword) disabledReason = 'This PDF already has a password. Remove it with Unlock PDF first.';
  else if (status !== 'ready' || !info) disabledReason = 'Opening your PDF…';
  else if (hasRestrictions) disabledReason = 'This PDF already has restrictions. Remove them with Unlock PDF first.';
  else if (openMode === 'password' && !userPassword) disabledReason = 'Enter a password that will open the file.';
  else if (openMode === 'password' && !confirmPassword) disabledReason = 'Type the password again in Confirm Password.';
  else if (openMode === 'password' && userPassword !== confirmPassword) disabledReason = 'The two passwords do not match.';
  else if (ownerClash) disabledReason = ownerClash;

  const apply = useCallback(() => {
    if (!file || disabledReason) return;
    // The two passwords must differ, or whoever opens the file is treated as
    // its owner and none of the permissions apply to them. So when the visitor
    // names no permissions password, one is made for them — never the open
    // password again.
    const generated = ownerPassword === '';
    const owner = generated ? generatePassword(GENERATED_OWNER_PASSWORD_LENGTH) : ownerPassword;
    if (passwordProblem(openPassword, owner)) return;
    const mode = openMode;
    const options: EncryptOptions = { userPassword: openPassword, ownerPassword: owner, permissions: effective };
    void run.start(async (work) => {
      const buffer = await file.arrayBuffer();
      const { port1, port2 } = new MessageChannel();
      try {
        const response = await work('pdf', { op: 'encrypt', buffer, options, progressPort: port2 }, [buffer, port2]);
        // No response without a cancel (a cancel makes the run ignore this)
        // means the worker itself failed: say so rather than going back to idle.
        if (!response) throw new Error('The PDF could not be protected: the PDF worker stopped. Try again.');
        if (response.status === 'error') throw new Error(response.message || 'The PDF could not be protected.');
        if (response.status !== 'success') throw new Error('The PDF could not be protected.');
        setPageIndex(0);
        return {
          file: new File([response.result], outputName, { type: 'application/pdf' }),
          openMode: mode,
          generatedOwnerPassword: generated ? owner : null,
        };
      } finally {
        port1.close();
      }
    });
  }, [file, disabledReason, ownerPassword, openPassword, openMode, effective, run, outputName]);

  const download = useCallback(() => {
    if (run.result) downloadBlob(run.result.file, run.result.file.name);
  }, [run.result]);

  const fillRandomPassword = useCallback(() => {
    const pw = generatePassword(16);
    setUserPassword(pw); setConfirmPassword(pw); invalidate();
    setShowUserPw(true); // Show generated password so user can see it
    navigator.clipboard.writeText(pw).then(() => toast.success('Password copied to clipboard')).catch(() => {});
  }, [invalidate]);

  const generatedOwnerPw = made?.generatedOwnerPassword ?? null;
  const copyGeneratedOwnerPw = useCallback(() => {
    if (!generatedOwnerPw) return;
    navigator.clipboard.writeText(generatedOwnerPw)
      .then(() => toast.success('Permissions password copied to clipboard'))
      .catch(() => toast.error('Could not copy — select the password and copy it yourself'));
  }, [generatedOwnerPw]);

  /* ── The stage ────────────────────────────────────────────────────────── */

  // After a run, the output — once it opens (always, for restrictions only;
  // with the right password tried, for a file that asks for one).
  const outputOpen = done && output.status === 'ready' && !!output.doc;
  const viewerDoc = done ? (outputOpen ? output.doc : null) : doc;
  const shownCount = viewerDoc ? viewerDoc.pageCount : 0;
  const index = Math.min(pageIndex, Math.max(shownCount - 1, 0));
  const goToPage = useCallback(
    (next: number) => {
      if (next < 0 || next >= shownCount) return;
      setPageIndex(next);
    },
    [shownCount],
  );

  const checkWrong =
    done && output.status === 'locked' && output.error instanceof PdfPasswordError && output.error.reason === 'incorrect';

  let stage;
  if (!done && hasPassword) {
    stage = (
      <LockedStage title="This PDF already has a password" testId="already-protected-stage">
        <p className={cn(note, 'max-w-sm')}>
          It cannot be shown or protected again until the password is removed.{' '}
          <a href="/unlock-pdf/" className="font-medium text-[var(--color-primary)] underline">Open Unlock PDF</a>
        </p>
      </LockedStage>
    );
  } else if (done && made?.openMode === 'password' && !outputOpen) {
    stage = (
      <LockedStage title="This file now asks for its password" testId="protected-stage">
        <p className={cn(note, 'max-w-sm')}>It cannot be shown here without it. You can check it opens with the password you set:</p>
        <form
          className="flex w-full max-w-sm flex-col gap-1.5 text-left"
          onSubmit={(e) => {
            e.preventDefault();
            if (checkTyped) setCheckTried(checkTyped);
          }}
        >
          <label htmlFor="check-password" className="text-xs font-medium text-[var(--color-text-primary)]">
            Check it opens
          </label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                id="check-password"
                type={showCheckPw ? 'text' : 'password'}
                value={checkTyped}
                onChange={(e) => setCheckTyped(e.target.value)}
                data-testid="check-password"
                autoComplete="off"
                enterKeyHint="go"
                aria-invalid={checkWrong ? true : undefined}
                className={cn(PASSWORD_INPUT_CLASS, 'bg-[var(--color-surface)]', checkWrong && 'border-[var(--color-error)]')}
              />
              <EyeToggle show={showCheckPw} onToggle={() => setShowCheckPw((v) => !v)} />
            </div>
            <button type="submit" disabled={!checkTyped} data-testid="check-open" className={SECONDARY_BUTTON_CLASS}>
              Check
            </button>
          </div>
          {checkWrong && (
            <p role="alert" data-testid="check-error" className="text-xs font-medium text-[var(--color-error)]">
              {WRONG_PASSWORD_MESSAGE}
            </p>
          )}
          <p className="text-xs text-[var(--color-text-muted)]">Tried on your protected file, in this page. Nothing is sent anywhere.</p>
        </form>
      </LockedStage>
    );
  } else {
    let caption = 'Check this is the file you want to protect.';
    if (done && made?.openMode === 'password') caption = 'It opens with that password — this is your protected file.';
    else if (done) caption = 'This is your file: it opens without a password and records the permissions you chose.';
    stage = (
      <PageViewer
        doc={viewerDoc}
        pageIndex={index}
        onPageChange={goToPage}
        footer={<StageCaption testId={done ? 'output-caption' : 'protect-caption'}>{caption}</StageCaption>}
        pageLabel={done ? 'Protected page' : 'Page'}
      />
    );
  }

  const rail = (
    <PageRail doc={viewerDoc} current={index} onSelect={goToPage} label={done ? 'Protected pages' : 'Pages'} />
  );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const alreadyNote = alreadyProtected ? (
    <div
      role="alert"
      data-testid="already-encrypted"
      className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-3 text-sm text-[var(--color-text-primary)]"
    >
      <p className="font-medium">
        {hasPassword ? 'This PDF already has a password.' : 'This PDF already has restrictions.'}
      </p>
      <p className="mt-1 text-[var(--color-text-secondary)]">
        Protect PDF cannot add protection on top of it. Remove {hasPassword ? 'the password' : 'the restrictions'} with{' '}
        <a href="/unlock-pdf/" data-testid="unlock-link" className="font-medium text-[var(--color-primary)] underline">Unlock PDF</a>
        {' '}first, then protect the unlocked copy here.
      </p>
    </div>
  ) : null;

  const form = (
    <>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[var(--color-text-primary)]">Opening the file</legend>
        <div className="flex flex-col gap-2 text-sm text-[var(--color-text-secondary)]">
          <label className="flex cursor-pointer items-start gap-2">
            <input type="radio" name="protect-open-mode" checked={openMode === 'password'}
              onChange={() => change(setOpenMode)('password')}
              data-testid="mode-password" className="mt-0.5 accent-[var(--color-primary)]" />
            <span>Ask for a password <span className="text-[var(--color-text-muted)]">— the file cannot be read without it</span></span>
          </label>
          <label className="flex cursor-pointer items-start gap-2">
            <input type="radio" name="protect-open-mode" checked={openMode === 'none'}
              onChange={() => change(setOpenMode)('none')}
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
              <input id="protect-password" type={showUserPw ? 'text' : 'password'} value={userPassword} onChange={(e) => change(setUserPassword)(e.target.value)}
                data-testid="password" autoComplete="new-password"
                className={PASSWORD_INPUT_CLASS} />
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
              <input id="protect-confirm-password" type={showConfirmPw ? 'text' : 'password'} value={confirmPassword} onChange={(e) => change(setConfirmPassword)(e.target.value)}
                data-testid="confirm-password" autoComplete="new-password"
                aria-invalid={confirmPassword && userPassword !== confirmPassword ? true : undefined}
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
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {PERMISSION_OPTIONS.map(({ key, label }) => {
            // Commenting includes form filling in the PDF format, so the
            // form box cannot be cleared on its own while commenting is on.
            const implied = key === 'fillForms' && permissions.annotations;
            return (
              <label key={key} className={cn('flex items-center gap-2 text-sm text-[var(--color-text-secondary)]', implied ? 'cursor-default' : 'cursor-pointer')}>
                <input type="checkbox" checked={effective[key]} disabled={implied}
                  onChange={(e) => { setPermissions((p) => ({ ...p, [key]: e.target.checked })); invalidate(); }}
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
          <input id="protect-owner-password" type={showOwnerPw ? 'text' : 'password'} value={ownerPassword} onChange={(e) => change(setOwnerPassword)(e.target.value)}
            data-testid="owner-password" autoComplete="new-password"
            aria-describedby="protect-owner-password-help"
            aria-invalid={ownerClash ? true : undefined}
            className={cn(PASSWORD_INPUT_CLASS, ownerClash && 'border-[var(--color-error)]')} />
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
    </>
  );

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={run.phase === 'running'}>
      {alreadyNote ?? form}
    </div>
  );

  const result = made ? (
    <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="protect-result">
      <section className="flex flex-col gap-1.5" aria-labelledby="protect-result-heading">
        <h3 id="protect-result-heading" className={heading}>
          {made.openMode === 'password' ? 'Password set' : 'Restrictions added'}
        </h3>
        <p className={note}>
          {made.openMode === 'password'
            ? 'Encrypted with AES-256. The file asks for the password you set before it opens.'
            : 'Encrypted with AES-256. The file opens without a password and records the permissions you chose.'}
        </p>
        <p className={note}>Press Make changes to change the password or permissions.</p>
      </section>
      {generatedOwnerPw && (
        <div className="border-t border-[var(--color-border)] pt-4">
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
  ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const beside = wide ? 'on the right' : 'below';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (hasPassword) {
    prompt = 'This PDF already has a password. Remove it with Unlock PDF first.';
    promptTone = 'error';
  } else if (status !== 'ready' || !info) prompt = 'Opening your PDF…';
  else if (hasRestrictions) {
    prompt = 'This PDF already has restrictions. Remove them with Unlock PDF first.';
    promptTone = 'error';
  } else if (run.phase === 'running') prompt = 'Encrypting your PDF…';
  else if (run.phase === 'error') {
    prompt = 'The PDF could not be protected. Try again.';
    promptTone = 'error';
  } else if (made) {
    prompt =
      made.openMode === 'password'
        ? 'Download your protected PDF, and keep its password somewhere safe.'
        : 'Download your PDF with its restrictions recorded.';
    // On a phone the permissions password made for the file is in the closed Options panel.
    if (made.generatedOwnerPassword && phone && !optionsOpen) prompt += ' Its permissions password is in Options.';
    promptTone = 'success';
  } else if (phone && !optionsOpen) prompt = 'Open Options to set a password, then press Protect PDF.';
  else if (openMode === 'none') prompt = `Choose the permissions ${beside}, then press Protect PDF.`;
  else prompt = `Set a password ${beside}, then press Protect PDF.`;

  const hint =
    openMode === 'password'
      ? 'Encrypts with AES-256. The file will ask for this password.'
      : 'Encrypts with AES-256. The file opens without a password.';

  const summary = made
    ? `${made.file.name} · ${formatBytes(made.file.size)}${pageCount ? ` · ${plural(pageCount, 'page')}` : ''}`
    : undefined;

  return (
    <ToolWorkspace
      toolId="protect-pdf"
      active={!!file}
      empty={<DropZone accept={ACCEPT} multiple={false} onFiles={acceptFile} hint="PDF to password-protect" />}
      title="Protect this PDF"
      prompt={prompt}
      promptTone={promptTone}
      optionsOpen={optionsOpen}
      onOptionsOpenChange={setOptionsOpen}
      fileBar={
        file ? (
          <WorkspaceFileBar
            file={file}
            extra={pageCount > 0 ? plural(pageCount, 'page') : hasPassword ? 'Locked' : undefined}
            onRemove={removeFile}
            onReplace={acceptFile}
            accept={ACCEPT}
            disabled={run.phase === 'running'}
          />
        ) : null
      }
      stage={stage}
      rail={rail}
      controls={controls}
      result={result}
      action={
        <ActionBar
          phase={run.phase}
          label="Protect PDF"
          runningLabel="Encrypting…"
          onRun={apply}
          disabledReason={disabledReason}
          hint={hint}
          progress={run.progress}
          progressLabel={run.progressLabel}
          onCancel={run.cancel}
          download={{ label: 'Download PDF', onDownload: download, ariaLabel: `Download PDF: ${outputName}` }}
          summary={summary}
          onEditAgain={run.invalidate}
          error={run.error}
        />
      }
    />
  );
}
