import { useCallback, useEffect, useState } from 'react';
import DropZone from '@/components/islands/shared/DropZone';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageViewer from '@/components/islands/workspace/PageViewer';
import PageRail from '@/components/islands/workspace/PageRail';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import {
  EncryptionDetails,
  EyeToggle,
  LockedStage,
  PASSWORD_INPUT_CLASS,
  SECONDARY_BUTTON_CLASS,
  StageCaption,
} from '@/components/islands/protect-pdf/security-ui';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import { useMediaQuery } from '@/hooks/use-media-query';
import { PdfPasswordError } from '@/lib/pdf/doc-handle';
import { readEncryptionInfo, type EncryptionInfo } from '@/lib/pdf-encryption-info';
import { NOT_A_PDF_MESSAGE, WRONG_PASSWORD_MESSAGE } from '@/lib/pdf-protect';
import { downloadBlob } from '@/lib/download';
import { formatBytes, cn } from '@/lib/utils';

/**
 * Unlock PDF, in the shared workspace.
 *
 * A file that asks for a password shows a locked placeholder until the
 * password opens it (pdf.js, in the page); then its pages appear, so the
 * visitor sees it is the right file before anything is written. A file that
 * opens without a password but carries restrictions shows its pages and the
 * restrictions at once. qpdf removes the encryption with any password that
 * opens the file — the open password, the permissions password, or none at all
 * for a restrictions-only file. After a run the stage shows the unlocked
 * output, read back from its own bytes.
 */

const ACCEPT = ['application/pdf'];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
const note = 'text-sm text-[var(--color-text-secondary)]';

export default function UnlockPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  // What is typed, and what was last tried: the document opens with the latter.
  const [typed, setTyped] = useState('');
  const [tried, setTried] = useState<string | undefined>(undefined);
  const [showPassword, setShowPassword] = useState(false);
  const [encryption, setEncryption] = useState<{ file: File; info: EncryptionInfo } | null>(null);
  const { status, doc, pageCount, error } = usePdfDocument(file, { password: tried });
  const [pageIndex, setPageIndex] = useState(0);

  const run = useToolRun<File>();
  const output = usePdfDocument(run.result);
  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const [optionsOpen, setOptionsOpen] = useState(false);

  const active = !!file;
  const done = run.phase === 'done' && !!run.result;
  const { invalidate } = run;

  // The /Encrypt dictionary, read from the bytes: what the file allows, and
  // whether a file that opened without a password is encrypted at all.
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

  const locked = status === 'locked';
  const wrongPassword = locked && error instanceof PdfPasswordError && error.reason === 'incorrect';
  const unreadable = status === 'error';
  const ready = status === 'ready' && !!info;
  const restrictionsOnly = ready && info.encrypted && tried === undefined;
  const notEncrypted = ready && !info.encrypted;

  // On a phone the password field is in the Options panel: open it for a locked file.
  useEffect(() => {
    if (locked && phone) setOptionsOpen(true);
  }, [locked, phone]);

  const acceptFile = useCallback(
    (files: File[]) => {
      const next = files[0];
      if (!next) return;
      invalidate();
      setFile(next);
      setTyped('');
      setTried(undefined);
      setPageIndex(0);
    },
    [invalidate],
  );

  const removeFile = useCallback(() => {
    invalidate();
    setFile(null);
    setTyped('');
    setTried(undefined);
  }, [invalidate]);

  /** Open the file with what is typed, so its pages appear. */
  const tryPassword = useCallback(() => {
    if (!typed) return;
    invalidate();
    setTried(typed);
    setPageIndex(0);
  }, [typed, invalidate]);

  /* ── The run ──────────────────────────────────────────────────────────── */

  const outputName = `${(file?.name ?? 'document').replace(/\.pdf$/i, '')}-unlocked.pdf`;

  let disabledReason: string | null = null;
  if (unreadable) disabledReason = NOT_A_PDF_MESSAGE;
  else if (locked && !typed) disabledReason = 'Enter the password that opens this file.';
  else if (!locked && !ready) disabledReason = 'Opening your PDF…';
  else if (notEncrypted) disabledReason = 'This PDF has no password or restrictions, so there is nothing to unlock.';

  const apply = useCallback(() => {
    if (!file || disabledReason) return;
    // A locked file is unlocked with what is typed (and opened with it too, so
    // its pages appear); an open one with the password that opened it, or none.
    const password = locked ? typed : (tried ?? '');
    if (locked) setTried(typed);
    void run.start(async (work) => {
      const buffer = await file.arrayBuffer();
      const { port1, port2 } = new MessageChannel();
      try {
        const response = await work('pdf', { op: 'decrypt', buffer, password, progressPort: port2 }, [buffer, port2]);
        // No response without a cancel (a cancel makes the run ignore this)
        // means the worker itself failed: say so rather than going back to idle.
        if (!response) throw new Error('The PDF could not be unlocked: the PDF worker stopped. Try again.');
        if (response.status === 'error') throw new Error(response.message || 'The PDF could not be unlocked.');
        if (response.status !== 'success') throw new Error('The PDF could not be unlocked.');
        setPageIndex(0);
        return new File([response.result], outputName, { type: 'application/pdf' });
      } finally {
        port1.close();
      }
    });
  }, [file, disabledReason, locked, typed, tried, run, outputName]);

  const download = useCallback(() => {
    if (run.result) downloadBlob(run.result, run.result.name);
  }, [run.result]);

  /* ── The stage ────────────────────────────────────────────────────────── */

  const viewerDoc = done ? output.doc : doc;
  const shownCount = viewerDoc ? viewerDoc.pageCount : 0;
  const index = Math.min(pageIndex, Math.max(shownCount - 1, 0));
  const goToPage = useCallback(
    (next: number) => {
      if (next < 0 || next >= shownCount) return;
      setPageIndex(next);
    },
    [shownCount],
  );

  let caption = 'Opening…';
  if (done) caption = 'Unlocked — this is your file. It opens with no password.';
  else if (restrictionsOnly) caption = 'This file opens without a password, but carries restrictions.';
  else if (notEncrypted) caption = 'This PDF has no password or restrictions.';
  else if (ready) caption = 'Opened with your password. Check this is the right file.';

  let stage;
  if (!done && unreadable) {
    stage = (
      <LockedStage title={NOT_A_PDF_MESSAGE} testId="unreadable-stage" icon={false}>
        <p className={note}>Choose another file with Change file above.</p>
      </LockedStage>
    );
  } else if (!done && locked) {
    stage = (
      <LockedStage title="This PDF is locked">
        <p className={cn(note, 'max-w-sm')}>
          Enter its password {wide ? 'on the right' : 'in Options'} to see the pages and unlock it. The password stays on this device.
        </p>
      </LockedStage>
    );
  } else {
    stage = (
      <PageViewer
        doc={viewerDoc}
        pageIndex={index}
        onPageChange={goToPage}
        footer={<StageCaption testId={done ? 'output-caption' : 'unlock-caption'}>{caption}</StageCaption>}
        pageLabel={done ? 'Unlocked page' : 'Page'}
      />
    );
  }

  const rail = (
    <PageRail
      doc={!done && (locked || unreadable) ? null : viewerDoc}
      current={index}
      onSelect={goToPage}
      label={done ? 'Unlocked pages' : 'Pages'}
    />
  );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const passwordField = (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        tryPassword();
      }}
    >
      <label htmlFor="unlock-password" className={heading}>
        PDF password
      </label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            id="unlock-password"
            type={showPassword ? 'text' : 'password'}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              invalidate();
            }}
            data-testid="unlock-password"
            autoComplete="off"
            enterKeyHint="go"
            aria-invalid={wrongPassword ? true : undefined}
            aria-describedby="unlock-password-help"
            className={cn(PASSWORD_INPUT_CLASS, wrongPassword && 'border-[var(--color-error)]')}
          />
          <EyeToggle show={showPassword} onToggle={() => setShowPassword((v) => !v)} />
        </div>
        <button type="submit" disabled={!typed} data-testid="unlock-open" className={SECONDARY_BUTTON_CLASS}>
          Open
        </button>
      </div>
      {wrongPassword && (
        <p role="alert" data-testid="unlock-password-error" className="text-xs font-medium text-[var(--color-error)]">
          {WRONG_PASSWORD_MESSAGE}
        </p>
      )}
      <p id="unlock-password-help" className="text-xs text-[var(--color-text-muted)]">
        The password that opens the file, or its permissions password. Press Enter or Open to see the pages.
      </p>
    </form>
  );

  let state;
  if (unreadable) {
    state = (
      <p className={note} data-testid="unlock-state">
        {NOT_A_PDF_MESSAGE} Choose another file.
      </p>
    );
  } else if (restrictionsOnly) {
    state = (
      <div className="flex flex-col gap-1.5" data-testid="restrictions-only">
        <h3 className={heading}>Restrictions only</h3>
        <p className={note} data-testid="unlock-state">
          This file opens without a password, but records restrictions on what readers may do with it. No password is
          needed to remove them: Unlock PDF saves a copy without them.
        </p>
      </div>
    );
  } else if (notEncrypted) {
    state = (
      <p className={note} data-testid="unlock-state">
        This PDF has no password or restrictions, so there is nothing to unlock.
      </p>
    );
  } else if (ready) {
    state = (
      <p className={note} data-testid="unlock-state">
        The password opened the file. Unlock PDF saves a copy that opens with no password and has no restrictions.
      </p>
    );
  } else if (locked) {
    state = (
      <p className={note} data-testid="unlock-state">
        This file asks for a password before it opens.
      </p>
    );
  }

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={run.phase === 'running'}>
      {state}
      {(locked || (ready && tried !== undefined)) && passwordField}
      {info && info.encrypted && (
        <div className="border-t border-[var(--color-border)] pt-4">
          <EncryptionDetails encryption={info} />
        </div>
      )}
    </div>
  );

  const result = done && run.result ? (
    <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="unlock-result">
      <section className="flex flex-col gap-1.5" aria-labelledby="unlock-result-heading">
        <h3 id="unlock-result-heading" className={heading}>
          PDF unlocked
        </h3>
        <p className={note}>The copy opens with no password and carries no restrictions. Your original file is unchanged.</p>
        <p className={note}>Look through the pages, then download it. Press Make changes to go back.</p>
      </section>
      {info && info.encrypted && (
        <div className="border-t border-[var(--color-border)] pt-4">
          <EncryptionDetails encryption={info} />
        </div>
      )}
    </div>
  ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const beside = wide ? 'on the right' : 'below';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (unreadable) {
    prompt = `${NOT_A_PDF_MESSAGE} Choose another file.`;
    promptTone = 'error';
  } else if (run.phase === 'running') prompt = 'Unlocking your PDF…';
  else if (run.phase === 'error') {
    prompt =
      run.error === WRONG_PASSWORD_MESSAGE
        ? `${WRONG_PASSWORD_MESSAGE} Check it and try again.`
        : 'The PDF could not be unlocked. Try again.';
    promptTone = 'error';
  } else if (done) {
    prompt = 'Check the pages, then download your unlocked PDF.';
    promptTone = 'success';
  } else if (wrongPassword) {
    prompt = `${WRONG_PASSWORD_MESSAGE} Check it and try again.`;
    promptTone = 'error';
  } else if (locked) {
    prompt = phone && !optionsOpen ? 'Open Options and enter the password for this PDF.' : `Enter the password for this PDF ${beside}.`;
  } else if (!ready) prompt = 'Opening your PDF…';
  else if (notEncrypted) prompt = 'This PDF has no password or restrictions. There is nothing to unlock.';
  else if (restrictionsOnly) prompt = 'This PDF opens without a password. Press Unlock PDF to remove its restrictions.';
  else prompt = 'Check this is the right file, then press Unlock PDF.';

  let hint: string | undefined;
  if (locked) hint = 'Tries the password, then saves a copy that opens with no password.';
  else if (restrictionsOnly) hint = 'Saves a copy without the restrictions. No password is needed.';
  else hint = 'Saves a copy that opens with no password.';

  const outputPages = output.pageCount || pageCount;
  const summary = run.result
    ? `${run.result.name} · ${formatBytes(run.result.size)}${outputPages ? ` · ${plural(outputPages, 'page')}` : ''}`
    : undefined;

  return (
    <ToolWorkspace
      toolId="unlock-pdf"
      active={active}
      empty={<DropZone accept={ACCEPT} multiple={false} onFiles={acceptFile} hint="Password-protected PDF" />}
      title="Unlock this PDF"
      prompt={prompt}
      promptTone={promptTone}
      optionsOpen={optionsOpen}
      onOptionsOpenChange={setOptionsOpen}
      fileBar={
        file ? (
          <WorkspaceFileBar
            file={file}
            extra={pageCount > 0 ? plural(pageCount, 'page') : locked ? 'Locked' : undefined}
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
          label="Unlock PDF"
          runningLabel="Unlocking…"
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
