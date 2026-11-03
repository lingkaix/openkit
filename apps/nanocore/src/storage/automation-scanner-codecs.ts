import { TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  StoredAutomationCadenceV1Schema,
  StoredRecurringOccurrenceV1Schema,
} from './recurring-retained-v1.js';

/** Original bounded selectors and exact retained-row CAS, never a permission or persisted revision. */
const row = {
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  rowDigest: z.string().regex(/^[a-f0-9]{64}$/),
};
const occurrence = z
  .object({ ...row, scheduleId: z.string().min(1), scheduledAt: TimestampSchema })
  .strict();
const schedule = z
  .object({
    ...row,
    ...StoredAutomationCadenceV1Schema.shape,
    revision: z.number().int().positive(),
    nextScheduledAt: TimestampSchema.nullable(),
  })
  .strict()
  .refine((value) => StoredAutomationCadenceV1Schema.safeParse(value).success);
/** Only scheduling projections cross to Main; original prompt and package bodies remain in Core. */
export const AutomationScanPlanSchema = z
  .object({
    pending: z.array(occurrence).max(128),
    due: z.array(schedule).max(128),
    stale: z.array(occurrence).max(128),
    expired: z.array(schedule).max(128),
    pendingSchedules: z.array(schedule).max(128),
  })
  .strict();
export type AutomationScanPlan = z.infer<typeof AutomationScanPlanSchema>;
/** Exact closed scan request; actual Main guards remain process-local and held through ACK. */
export const ControlAutomationScannerSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('plan'), timestamp: TimestampSchema }).strict(),
  z
    .object({
      action: z.literal('publish'),
      timestamp: TimestampSchema,
      expected: AutomationScanPlanSchema,
      workspaceIds: z.array(z.string().min(1)).max(512),
    })
    .strict(),
]);
export type ControlAutomationScanner = z.infer<typeof ControlAutomationScannerSchema>;
/** A readonly projection or the original bounded occurrence list, never a new durable shape. */
export const ControlAutomationScannerResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), plan: AutomationScanPlanSchema }).strict(),
  z
    .object({
      kind: z.literal('published'),
      occurrences: z.array(StoredRecurringOccurrenceV1Schema).max(128),
    })
    .strict(),
]);
export type ControlAutomationScannerResult = z.infer<typeof ControlAutomationScannerResultSchema>;
