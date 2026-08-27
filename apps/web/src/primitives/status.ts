/**
 * Shared status + worker-identity vocabulary for the primitive tier.
 *
 * Centralizes the fixed status families (DESIGN.md §4.2) and worker hues
 * (DESIGN.md §4.3) so every primitive that renders state or identity resolves it
 * the same way. Values are Tailwind utility strings backed by the token bridge —
 * never raw palette.
 */

/** The five status families. Status is always text + semantic color. */
export type StatusTone = 'informative' | 'notice' | 'positive' | 'negative' | 'neutral';

/** Tinted background + foreground utility pair per status family (chips, glyphs). */
export const STATUS_CLASS: Record<StatusTone, string> = {
  informative: 'bg-info-bg text-info-fg',
  notice: 'bg-notice-bg text-notice-fg',
  positive: 'bg-positive-bg text-positive-fg',
  negative: 'bg-negative-bg text-negative-fg',
  neutral: 'bg-neutral-bg text-neutral-fg',
};

/** Named worker hues; the human ("you") is rendered as a circle, workers as rounded squares. */
export type WorkerHue = 'scout' | 'quill' | 'ledger' | 'pixel' | 'you';

/** Avatar background + foreground utility pair per worker identity (theme-invariant). */
export const WORKER_CLASS: Record<WorkerHue, string> = {
  scout: 'bg-worker-scout text-worker-scout-fg',
  quill: 'bg-worker-quill text-worker-quill-fg',
  ledger: 'bg-worker-ledger text-worker-ledger-fg',
  pixel: 'bg-worker-pixel text-worker-pixel-fg',
  you: 'bg-worker-you text-worker-you-fg',
};
