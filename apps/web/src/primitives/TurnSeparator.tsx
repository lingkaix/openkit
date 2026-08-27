export interface TurnSeparatorProps {
  /** Turn label, e.g. "Turn 2 · retry". */
  label: string;
  /** Optional one-line note carried on the divider. */
  note?: string;
}

/**
 * Turn separator (`ok-turn-sep`, DESIGN.md §9.6).
 *
 * A light labeled divider that groups the items of one Turn (a bounded execution
 * step/attempt) without boxing the stream. Quiet by default; reflects the
 * Thread → Turn → Item work model.
 */
export function TurnSeparator({ label, note }: TurnSeparatorProps) {
  return (
    <div className="flex items-center gap-3 py-1 text-xs text-fg-muted">
      <span className="font-bold uppercase tracking-wide">{label}</span>
      {note ? <span className="truncate font-normal">{note}</span> : null}
      <span className="h-px flex-1 bg-separator" aria-hidden />
    </div>
  );
}
