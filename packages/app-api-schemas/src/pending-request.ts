import { z } from 'zod';

/** Derived human disclosure; no preview state or argument copy is persisted. */
export const ApprovalEffectPreviewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), summary: z.string(), detail: z.string() }).strip(),
  z.object({ status: z.literal('unavailable'), reason: z.string() }).strip(),
]);
export type ApprovalEffectPreview = z.infer<typeof ApprovalEffectPreviewSchema>;
