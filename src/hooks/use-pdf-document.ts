import { useEffect, useState } from 'react';
import { openPdf, PdfPasswordError, type PdfDocHandle } from '@/lib/pdf/doc-handle';

/**
 * `idle`    no file.
 * `loading` the file is being opened.
 * `ready`   `doc` is open; `pageCount` is known.
 * `locked`  the file needs a password (or the one given was wrong — see `error.reason`).
 * `error`   the file could not be read as a PDF.
 */
export type PdfDocumentStatus = 'idle' | 'loading' | 'ready' | 'locked' | 'error';

export interface UsePdfDocumentResult {
  status: PdfDocumentStatus;
  /** The open document while `status === 'ready'`, otherwise null. */
  doc: PdfDocHandle | null;
  /** 0 until the document is open. */
  pageCount: number;
  /** `PdfPasswordError` when `locked`, `PdfParseError` when `error`, otherwise null. */
  error: Error | null;
}

export interface UsePdfDocumentOptions {
  /** Password to open an encrypted file with. Changing it re-opens the file. */
  password?: string;
}

const IDLE: UsePdfDocumentResult = { status: 'idle', doc: null, pageCount: 0, error: null };
const LOADING: UsePdfDocumentResult = { status: 'loading', doc: null, pageCount: 0, error: null };

/**
 * Keep one `PdfDocHandle` open for `source` and destroy it when the source
 * changes or the component unmounts.
 *
 *     const { status, doc, pageCount } = usePdfDocument(file);
 *
 * Pass the `File` the user dropped (preferred — its bytes are not copied) or an
 * `ArrayBuffer`. The source is compared by identity, so keep it in state rather
 * than creating a new one on every render. `doc` is never a destroyed handle:
 * the render that follows a source change already sees `doc: null`.
 */
export function usePdfDocument(
  source: File | ArrayBuffer | null | undefined,
  options: UsePdfDocumentOptions = {},
): UsePdfDocumentResult {
  const { password } = options;
  const [state, setState] = useState<{ source: unknown; password: unknown; result: UsePdfDocumentResult }>({
    source: null,
    password: undefined,
    result: IDLE,
  });

  useEffect(() => {
    if (!source) return;
    let live = true;
    let handle: PdfDocHandle | null = null;

    openPdf(source, { password }).then(
      (opened) => {
        if (!live) {
          void opened.destroy();
          return;
        }
        handle = opened;
        setState({
          source,
          password,
          result: { status: 'ready', doc: opened, pageCount: opened.pageCount, error: null },
        });
      },
      (err: Error) => {
        if (!live) return;
        setState({
          source,
          password,
          result: {
            status: err instanceof PdfPasswordError ? 'locked' : 'error',
            doc: null,
            pageCount: 0,
            error: err,
          },
        });
      },
    );

    return () => {
      live = false;
      void handle?.destroy();
    };
  }, [source, password]);

  // What is in state belongs to an earlier source until the effect has answered
  // for this one; never hand that (possibly destroyed) document to the caller.
  if (!source) return IDLE;
  if (state.source !== source || state.password !== password) return LOADING;
  return state.result;
}
