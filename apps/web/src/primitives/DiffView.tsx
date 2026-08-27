/** Inputs for one labelled exact-text view. */
export interface CodeViewProps {
  /** Visible and accessible label for the exact text. */
  label: string;
  /** Exact immutable text to display without normalization. */
  value: string;
}

/** Read-only preformatted text view that preserves the supplied string exactly. */
export function CodeView({ label, value }: CodeViewProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs font-bold text-fg-strong">{label}</p>
      {/* biome-ignore lint/a11y/useSemanticElements: the labelled region must remain preformatted. */}
      <pre
        role="region"
        aria-label={label}
        className="min-h-32 overflow-auto rounded-ok border border-border bg-sunken p-3 font-mono text-xs text-fg"
      >
        <code>{value}</code>
      </pre>
    </div>
  );
}

/** Immutable exact-text inputs and labels for a two-pane comparison. */
export interface DiffViewProps {
  /** Exact earlier immutable text. */
  before: string;
  /** Exact later immutable text. */
  after: string;
  /** Label for the earlier text pane. */
  beforeLabel: string;
  /** Label for the later text pane. */
  afterLabel: string;
}

/** Side-by-side read-only comparison of two exact immutable text values. */
export function DiffView({ before, after, beforeLabel, afterLabel }: DiffViewProps) {
  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      <CodeView label={beforeLabel} value={before} />
      <CodeView label={afterLabel} value={after} />
    </div>
  );
}
