import { cn } from '@/lib/utils';

export type PromptTone = 'info' | 'success' | 'error';

interface StepPromptProps {
  /** One imperative sentence: what the visitor should do now. */
  text: string;
  tone?: PromptTone;
  className?: string;
}

const toneClasses: Record<PromptTone, string> = {
  info: 'bg-[var(--color-primary)]/5 text-[var(--color-text-primary)]',
  success: 'bg-[var(--color-success)]/5 text-[var(--color-text-primary)]',
  error: 'bg-[var(--color-error)]/5 text-[var(--color-error)]',
};

const dotClasses: Record<PromptTone, string> = {
  info: 'bg-[var(--color-primary)]',
  success: 'bg-[var(--color-success)]',
  error: 'bg-[var(--color-error)]',
};

/**
 * The current step, in words. Every workspace shows exactly one, always, so a
 * first-time visitor never has to work out what to click next. It is a polite
 * live region: a screen reader hears each new step as it becomes the step.
 */
export default function StepPrompt({ text, tone = 'info', className }: StepPromptProps) {
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="step-prompt"
      data-tone={tone}
      className={cn(
        'flex min-h-10 items-center gap-2.5 px-3 py-2 text-sm font-medium sm:px-4',
        toneClasses[tone],
        className,
      )}
    >
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', dotClasses[tone])} />
      <span>{text}</span>
    </p>
  );
}
