/** Closed Core reasoning-effort vocabulary in ascending fitting order. */
export const REASONING_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/** One admitted Core reasoning-effort preference. */
export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];
