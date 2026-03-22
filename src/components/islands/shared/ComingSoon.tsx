interface Props {
  toolName: string;
  week: number;
}

export default function ComingSoon({ toolName, week }: Props) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[var(--color-border)] bg-[var(--color-background)] p-12 text-center">
      <div className="mb-4 text-4xl">🚧</div>
      <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
        {toolName}
      </h2>
      <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
        This tool is being built. Launching in Week {week}.
      </p>
    </div>
  );
}
