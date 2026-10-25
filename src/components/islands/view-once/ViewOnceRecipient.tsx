import { useEffect, useRef, useState } from 'react';
import { VIEW_ONCE_API, VIEW_ONCE_TYPES, openSealed, parseLink, safeImageType, type ParsedLink } from '@/lib/view-once';

/**
 * The page a view-once link opens (/view/<id>#<key>.<iv>).
 *
 * Nothing is fetched until the recipient presses "Open image": the first fetch
 * deletes the image from the server, so a link preview, a prefetch or an
 * accidental reload must not use it up. The image is then decrypted here with
 * the key from the link (which never leaves this page) and shown.
 *
 * A link can be made by anyone with any bytes in it, so the decrypted type is
 * trusted only if it is one of the plain image types; anything else is
 * refused rather than handed to the browser.
 *
 * Test ids: `view-once-ready`, `view-once-open`, `view-once-image`,
 * `view-once-save`, `view-once-error`.
 */

type State =
  | { kind: 'start' }
  | { kind: 'ready'; link: ParsedLink; problem?: string }
  | { kind: 'opening' }
  | { kind: 'shown'; url: string; name: string }
  | { kind: 'error'; title: string; message: string };

const GONE = {
  kind: 'error',
  title: 'This image is no longer available',
  message: 'It has already been opened, or its link expired before anyone opened it. Ask the sender for a new link.',
} as const;

async function fetchAndOpen(link: ParsedLink): Promise<{ url: string; name: string }> {
  let res: Response;
  try {
    res = await fetch(`${VIEW_ONCE_API}/${link.id}`, { cache: 'no-store' });
  } catch {
    throw Object.assign(new Error('Could not reach docukit.uk. Check the connection and try again.'), { retry: true });
  }
  if (res.status === 404 || res.status === 410) throw Object.assign(new Error('gone'), { gone: true });
  if (!res.ok) throw Object.assign(new Error(`The server could not hand over the image (error ${res.status}).`), { retry: true });
  const cipher = new Uint8Array(await res.arrayBuffer());

  let opened: { type: string; image: Uint8Array };
  try {
    opened = await openSealed(cipher, link);
  } catch {
    throw new Error(
      'The image could not be decrypted: the link may be incomplete or changed. It has now been deleted from the server, so ask the sender for a new link.',
    );
  }
  const type = safeImageType(opened.type);
  if (!type) throw new Error('This link does not hold an image this page can show.');
  const url = URL.createObjectURL(new Blob([opened.image as BlobPart], { type }));
  return { url, name: `image.${VIEW_ONCE_TYPES[type]}` };
}

export default function ViewOnceRecipient() {
  const [state, setState] = useState<State>({ kind: 'start' });
  const shownUrl = useRef<string | null>(null);

  useEffect(() => {
    const link = parseLink(window.location.pathname, window.location.hash);
    if ('error' in link) setState({ kind: 'error', title: 'This link is not complete', message: link.error });
    else setState({ kind: 'ready', link });
    return () => {
      if (shownUrl.current) URL.revokeObjectURL(shownUrl.current);
    };
  }, []);

  const open = async (link: ParsedLink) => {
    setState({ kind: 'opening' });
    try {
      const shown = await fetchAndOpen(link);
      shownUrl.current = shown.url;
      setState({ kind: 'shown', ...shown });
    } catch (err) {
      const e = err as Error & { gone?: boolean; retry?: boolean };
      if (e.gone) setState(GONE);
      else if (e.retry) setState({ kind: 'ready', link, problem: e.message });
      else setState({ kind: 'error', title: 'The image could not be shown', message: e.message });
    }
  };

  if (state.kind === 'start' || state.kind === 'opening') {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center" role="status">
        <svg className="h-10 w-10 animate-spin text-[var(--color-primary)]" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {state.kind === 'opening' ? 'Fetching and decrypting the image…' : 'Reading the link…'}
        </p>
      </div>
    );
  }

  if (state.kind === 'ready') {
    return (
      <div className="flex flex-col items-center gap-5 py-12 text-center" data-testid="view-once-ready">
        <div className="max-w-md">
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Someone sent you an image that opens once</h2>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            When you open it, it is deleted from the server: this link will not work again, here or anywhere else. Open
            it when you are ready to look at it.
          </p>
        </div>
        {state.problem && (
          <p role="alert" data-testid="view-once-problem" className="max-w-md text-sm font-medium text-[var(--color-error)]">
            {state.problem}
          </p>
        )}
        <button
          type="button"
          onClick={() => void open(state.link)}
          data-testid="view-once-open"
          className="h-11 rounded-lg bg-[var(--color-text-primary)] px-6 text-sm font-medium text-[var(--color-background)] hover:opacity-80"
        >
          Open image
        </button>
        <p className="max-w-md text-xs text-[var(--color-text-muted)]">
          The image is decrypted in this browser with the key in the link. The key is never sent to the server.
        </p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="flex flex-col items-center gap-6 py-16 text-center" data-testid="view-once-error">
        <div className="max-w-md">
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">{state.title}</h2>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{state.message}</p>
        </div>
        <a
          href="/view-once-image/"
          className="rounded-lg border border-[var(--color-border)] px-5 py-2.5 text-sm font-medium text-[var(--color-text-primary)] hover:border-[var(--color-primary)]"
        >
          Make a view-once link
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-5 py-6">
      <p className="text-center text-sm text-[var(--color-text-secondary)]" role="status">
        Decrypted in this browser. The image has been deleted from the server; this link will not open it again.
      </p>
      <img
        src={state.url}
        alt="The image you were sent"
        data-testid="view-once-image"
        className="max-h-[70vh] max-w-full rounded-lg object-contain shadow-lg"
      />
      <a
        href={state.url}
        download={state.name}
        data-testid="view-once-save"
        className="inline-flex h-11 items-center rounded-lg bg-[var(--color-text-primary)] px-6 text-sm font-medium text-[var(--color-background)] hover:opacity-80"
      >
        Save image
      </a>
      <p className="text-xs text-[var(--color-text-muted)]">Leaving or reloading this page closes the image for good.</p>
    </div>
  );
}
