import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createSearch, entryHref, parseSearchIndex, SUGGESTED_QUERIES } from '@/lib/tool-search';

interface ToolSearchProps {
  /** serializeSearchIndex() output, built from the tool and task-page registries at build time. */
  index: string;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * Homepage search: type to jump to a tool or a task page.
 *
 * An editable combobox with a listbox popup (WAI-ARIA 1.2). Focus stays in the
 * field and `aria-activedescendant` tracks the highlighted result. The results
 * are real links, so a click, a middle-click or "open in new tab" behave like any
 * other link on the page; Enter clicks the highlighted one.
 *
 * The popup is positioned over the grid rather than pushing it down, and the
 * server-rendered markup is the same height before and after hydration, so
 * nothing on the homepage moves when this island loads or when results appear.
 */
export default function ToolSearch({ index }: ToolSearchProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const optionId = (position: number) => `${id}-option-${position}`;

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Marks the field as wired up. Tests wait for it before typing.
  const [hydrated, setHydrated] = useState(false);

  const search = useMemo(() => createSearch(parseSearchIndex(index)), [index]);
  const results = useMemo(() => search(query), [search, query]);

  const hasQuery = query.trim() !== '';
  const showList = open && results.length > 0;
  const showEmpty = open && hasQuery && results.length === 0;
  const popupVisible = showList || showEmpty;

  useEffect(() => {
    setHydrated(true);
    // Anything typed before this island hydrated is still in the field — React
    // leaves it there, but the state behind it starts empty.
    const typed = inputRef.current?.value ?? '';
    if (typed !== '') {
      setQuery(typed);
      setOpen(document.activeElement === inputRef.current);
    }
  }, []);

  // "/" or Ctrl/Cmd+K puts the cursor in the field from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const input = inputRef.current;
      if (!input || e.defaultPrevented) return;
      const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey;
      const commandK = e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if (!slash && !commandK) return;
      if (slash && isTypingTarget(e.target)) return;
      e.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Keep the highlighted result inside the popup's own scroll area. Scrolls the
  // list only — scrollIntoView() would also drag the page around on each key.
  useEffect(() => {
    const list = listRef.current;
    const option = list?.children[active] as HTMLElement | undefined;
    if (!showList || !list || !option) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [active, showList, results]);

  // When the popup opens partly off-screen — below the fold, or behind a phone's
  // on-screen keyboard — bring the field to the top so the results can be seen.
  // Once per opening, never while the visitor is already reading the list.
  useEffect(() => {
    const popup = showList ? listRef.current : emptyRef.current;
    const root = rootRef.current;
    if (!popupVisible || !popup || !root) return;
    const viewport = window.visualViewport;
    const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    if (popup.getBoundingClientRect().bottom <= visibleBottom) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'instant' : 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the popup opens
  }, [popupVisible]);

  const clear = () => {
    setQuery('');
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Leave the keys alone while an input method is composing a character.
    if (e.nativeEvent.isComposing) return;

    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (results.length === 0) return;
        e.preventDefault();
        if (!showList) {
          setOpen(true);
          return;
        }
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((current) => (current + step + results.length) % results.length);
        return;
      }
      case 'Enter': {
        if (results.length === 0) return;
        e.preventDefault();
        if (!showList) {
          setOpen(true);
          return;
        }
        // Click the link itself, so it navigates exactly as a mouse click would.
        document.getElementById(optionId(active))?.click();
        return;
      }
      case 'Escape': {
        if (popupVisible) {
          e.preventDefault();
          setOpen(false);
        } else if (query !== '') {
          e.preventDefault();
          clear();
        }
        return;
      }
    }
  };

  const count = results.length;
  const status = !open || !hasQuery
    ? ''
    : count === 0
      ? `No tools match ${query.trim()}`
      : `${count} ${count === 1 ? 'result' : 'results'}`;

  const popupClasses = cn(
    'absolute inset-x-0 top-full z-30 mt-2 rounded-xl border border-[var(--color-border)]',
    'bg-[var(--color-surface)] shadow-[var(--shadow-card-hover)]',
  );

  return (
    <div
      ref={rootRef}
      className="relative scroll-mt-20"
      data-testid="tool-search"
      data-hydrated={hydrated ? 'true' : 'false'}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={inputId} className="sr-only">Search tools</label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-[var(--color-text-muted)]"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? optionId(active) : undefined}
          aria-describedby={hintId}
          aria-keyshortcuts="/ Control+K Meta+K"
          inputMode="search"
          enterKeyHint="go"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Search tools — try “pdf to jpg”"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={cn(
            // text-base (16px): anything smaller makes iOS zoom the page on focus.
            'h-12 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] pl-11 pr-12',
            'text-base text-[var(--color-text-primary)] shadow-[var(--shadow-card)] transition-colors duration-150',
            'placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]',
            'focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]',
          )}
        />
        {query === '' ? (
          <kbd
            className={cn(
              'pointer-events-none absolute right-3.5 top-1/2 hidden h-6 min-w-6 -translate-y-1/2 items-center justify-center',
              'rounded-md border border-[var(--color-border)] px-1.5 font-sans text-xs text-[var(--color-text-muted)]',
              // A keyboard hint is noise on a touch screen.
              'pointer-fine:flex',
            )}
            aria-hidden="true"
          >
            /
          </kbd>
        ) : (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              clear();
              inputRef.current?.focus();
            }}
            className={cn(
              'absolute right-1.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg',
              'text-[var(--color-text-muted)] transition-colors duration-150',
              'hover:bg-[var(--color-background)] hover:text-[var(--color-text-primary)]',
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <p id={hintId} className="sr-only">
        Results appear as you type. Use the up and down arrow keys to choose one and Enter to open it.
      </p>
      <p role="status" aria-live="polite" className="sr-only" data-testid="tool-search-status">
        {status}
      </p>

      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Matching tools"
        hidden={!showList}
        // Keep focus in the field when a result is pressed; the click still lands.
        onMouseDown={(e) => e.preventDefault()}
        className={cn(popupClasses, 'max-h-60 overflow-y-auto overscroll-contain p-1.5 sm:max-h-80')}
      >
        {results.map((entry, position) => (
          <a
            key={entry.slug}
            id={optionId(position)}
            role="option"
            aria-selected={position === active}
            href={entryHref(entry)}
            tabIndex={-1}
            onPointerMove={() => setActive(position)}
            className={cn(
              'group relative flex items-center gap-3 rounded-lg px-3 py-2.5',
              'aria-selected:bg-[var(--color-background)]',
            )}
          >
            <span
              className={cn(
                'absolute inset-y-2.5 left-0 w-0.5 rounded-full opacity-0 group-aria-selected:opacity-100',
                entry.category === 'pdf' ? 'bg-[var(--color-pdf)]' : 'bg-[var(--color-image)]',
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                entry.category === 'pdf' ? 'bg-[var(--color-pdf)]' : 'bg-[var(--color-image)]',
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-[var(--color-text-primary)]">
                {entry.name}
              </span>
              <span className="block truncate text-[13px] leading-snug text-[var(--color-text-muted)]">
                {entry.description}
              </span>
            </span>
          </a>
        ))}
      </div>

      {showEmpty && (
        <div ref={emptyRef} className={cn(popupClasses, 'px-4 py-4')} data-testid="tool-search-empty">
          <p className="break-words text-sm font-medium text-[var(--color-text-primary)]">
            No tools match “{query.trim()}”
          </p>
          <p className="mt-1 text-[13px] leading-snug text-[var(--color-text-muted)]">
            Try a file type or a task, like “{SUGGESTED_QUERIES[0]}”, “{SUGGESTED_QUERIES[1]}” or “{SUGGESTED_QUERIES[2]}”.
          </p>
        </div>
      )}
    </div>
  );
}
