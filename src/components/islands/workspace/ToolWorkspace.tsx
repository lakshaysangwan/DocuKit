import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import StepPrompt, { type PromptTone } from './StepPrompt';

/**
 * The shared tool workspace.
 *
 * Before a file is added (`active` false) this renders `empty` — the tool's
 * dropzone — in the same narrow column every tool has always had, so the page
 * is identical to its server-rendered HTML and nothing shifts on hydration.
 *
 * Once a file is accepted (`active` true) it becomes a frame the height of the
 * viewport: the document on the left, the controls on the right, and one action
 * slot. The frame is scrolled under the site header and focus moves to its
 * heading. The layout itself is CSS (`.ws-*` in global.css):
 *
 *   ≥1280px   rail | document | controls 380px
 *   ≥1024px          document | controls 320px      (pager instead of the rail)
 *   ≥768px    document, then controls, stacked; the action bar pinned
 *   phone     document, then an "Options" panel that opens above the pinned
 *             action bar and never takes the document off screen
 *
 * A tool composes it from the other workspace pieces:
 *
 *     <ToolWorkspace
 *       toolId="sign-pdf" active={!!file} empty={<DropZone … />}
 *       title="Sign this PDF" prompt="Create your signature on the right."
 *       fileBar={<WorkspaceFileBar file={file} … />}
 *       stage={<PageViewer … />} rail={<PageRail … />}
 *       controls={…} result={phase === 'done' ? … : undefined}
 *       action={<ActionBar … />}
 *     />
 */

interface WorkspaceContextValue {
  /** Whether the phone "Options" panel is open. Always true from 768px up. */
  optionsOpen: boolean;
  setOptionsOpen: (open: boolean) => void;
  /** id of the options region, for `aria-controls`. */
  optionsId: string;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** The workspace a component is inside, or null outside one. */
export function useWorkspace(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}

export interface ToolWorkspaceProps {
  /** The tool's slug; exposed as `data-tool` on the frame. */
  toolId: string;
  /** False: show `empty`. True: show the workspace. Flip it in the file-accept handler. */
  active: boolean;
  /** What is shown before a file is added — the dropzone. */
  empty: ReactNode;
  /** The workspace heading (an `h2`); focus lands here on entry. */
  title: string;
  /** Required: one imperative sentence saying what to do now. */
  prompt: string;
  promptTone?: PromptTone;
  fileBar: ReactNode;
  /** The document pane. Give it something that fills its box, e.g. `<PageViewer>`. */
  stage: ReactNode;
  /** Page thumbnails; shown from 1280px up. Without one the document has that column too. */
  rail?: ReactNode;
  /** The options. */
  controls: ReactNode;
  /** When set, shown in place of `controls` (result details after a run). */
  result?: ReactNode;
  /** The single action slot — an `<ActionBar>`. */
  action: ReactNode;
  /** Phone only: whether the Options panel is open. Uncontrolled (closed) if omitted. */
  optionsOpen?: boolean;
  onOptionsOpenChange?: (open: boolean) => void;
}

const PHONE = '(max-width: 767px)';

export default function ToolWorkspace({
  toolId,
  active,
  empty,
  title,
  prompt,
  promptTone,
  fileBar,
  stage,
  rail,
  controls,
  result,
  action,
  optionsOpen,
  onOptionsOpenChange,
}: ToolWorkspaceProps) {
  const frameRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const headingId = `${id}-title`;
  const stageId = `${id}-stage`;
  const optionsId = `${id}-options`;

  const [ownOpen, setOwnOpen] = useState(false);
  const open = optionsOpen ?? ownOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      setOwnOpen(next);
      onOptionsOpenChange?.(next);
    },
    [onOptionsOpenChange],
  );

  // Entering the workspace: put the frame under the header and move focus to its
  // heading. This runs in the commit that follows the file-accept handler, so the
  // jump is part of the visitor's own action, not a layout shift.
  useLayoutEffect(() => {
    if (!active) return;
    frameRef.current?.scrollIntoView({ block: 'start' });
    headingRef.current?.focus({ preventScroll: true });
  }, [active]);

  // The same switch as `:has([data-ws="active"])`, for engines without `:has()`.
  useEffect(() => {
    if (!active) return;
    document.documentElement.dataset.ws = 'active';
    return () => {
      delete document.documentElement.dataset.ws;
    };
  }, [active]);

  // On a phone, opening the options brings the panel fully above the action
  // bar, and closing them puts the frame — now shorter — back under the header.
  const wasOpen = useRef(open);
  useEffect(() => {
    const changed = wasOpen.current !== open;
    wasOpen.current = open;
    if (!active) return;
    if (typeof matchMedia !== 'function' || !matchMedia(PHONE).matches) return;
    if (open) optionsRef.current?.scrollIntoView({ block: 'nearest' });
    else if (changed) frameRef.current?.scrollIntoView({ block: 'start' });
  }, [active, open]);

  const context = useMemo<WorkspaceContextValue>(
    () => ({ optionsOpen: open, setOptionsOpen: setOpen, optionsId }),
    [open, setOpen, optionsId],
  );

  if (!active) {
    // The same root every unmigrated tool has, so the page before upload is unchanged.
    return <div className="flex flex-col gap-6">{empty}</div>;
  }

  const skipTo = (target: 'stage' | 'options') => (e: React.MouseEvent) => {
    e.preventDefault();
    if (target === 'options') {
      setOpen(true);
      // The panel may have been display:none until this render.
      requestAnimationFrame(() => optionsRef.current?.focus());
    } else {
      stageRef.current?.focus();
    }
  };

  return (
    <WorkspaceContext.Provider value={context}>
      <section
        ref={frameRef}
        className="ws-frame"
        data-testid="workspace"
        data-ws="active"
        data-tool={toolId}
        data-options={open ? 'open' : 'closed'}
        data-rail={rail ? undefined : 'none'}
        aria-labelledby={headingId}
      >
        <div className="ws-bar flex min-h-11 items-center gap-3 px-3 py-1.5 sm:px-4">
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            data-testid="workspace-title"
            className="shrink-0 text-sm font-semibold text-[var(--color-text-primary)] outline-none max-sm:sr-only"
          >
            {title}
          </h2>
          <a
            href={`#${optionsId}`}
            onClick={skipTo('options')}
            className="sr-only rounded-md bg-[var(--color-surface)] px-2 py-1 text-xs font-medium text-[var(--color-primary)] focus:not-sr-only"
          >
            Skip to options
          </a>
          <a
            href={`#${stageId}`}
            onClick={skipTo('stage')}
            className="sr-only rounded-md bg-[var(--color-surface)] px-2 py-1 text-xs font-medium text-[var(--color-primary)] focus:not-sr-only"
          >
            Skip to document
          </a>
          <div className="min-w-0 flex-1">{fileBar}</div>
        </div>

        <StepPrompt className="ws-prompt" text={prompt} tone={promptTone} />

        <div
          ref={stageRef}
          id={stageId}
          className="ws-stage outline-none"
          data-testid="ws-stage"
          role="region"
          aria-label="Document"
          tabIndex={-1}
        >
          {stage}
        </div>

        {rail && <div className="ws-rail">{rail}</div>}

        <div
          ref={optionsRef}
          id={optionsId}
          className="ws-options outline-none"
          data-testid="ws-controls"
          role="region"
          aria-label={result ? 'Result' : 'Options'}
          tabIndex={-1}
        >
          {result ?? controls}
        </div>

        <div className="ws-action">{action}</div>
      </section>
    </WorkspaceContext.Provider>
  );
}
