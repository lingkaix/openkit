import { z } from 'zod';

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

/** Validates an explicit preference without inventing a default for retained absence. */
export const ReasoningEffortSchema = z.enum(REASONING_EFFORT_LEVELS);
