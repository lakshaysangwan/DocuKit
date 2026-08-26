/**
 * Contextual "next step" suggestion shown in a tool's success panel — a
 * consistent, in-flow cross-tool hand-off (distinct from the static RelatedTools
 * SEO section at the bottom of the page). Keep the prompt short and the link to a
 * single genuinely-useful next tool.
 */
interface NextStepProps {
  /** Route of the suggested next tool, e.g. "/compress-pdf". */
  href: string;
  /** Visible link label, e.g. "Compress PDF". */
  label: string;
  /** The lead-in prompt, e.g. "Large file?". */
  children: React.ReactNode;
}

export default function NextStep({ href, label, children }: NextStepProps) {
  return (
    <div
      data-testid="next-step"
      className="rounded-lg border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/5 p-3 text-sm text-[var(--color-text-secondary)]"
    >
      {children}{' '}
      <a href={href} className="font-medium text-[var(--color-primary)] underline hover:no-underline">
        {label}
      </a>
      .
    </div>
  );
}
