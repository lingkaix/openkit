import {
  AutomationAttemptCodeSchema,
  AutomationDefinitionSnapshotSchema,
  AutomationOccurrenceSchema,
  AutomationExpiredRangeSchema,
  MaterializedWorkspaceRootSchema,
} from '@openkit/app-api-schemas';
import { ReasoningEffortSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Exact complete scheduler payload frozen by the first successful selection resolution. */
export const RecurringAdmissionPayloadSchema = z.object({
  backendId: z.string().min(1),
  requestedAgentId: z.string().min(1),
  profileRef: z.string().min(1).nullable(),
  modelId: z.string().min(1),
  workspaceCwd: z.string().min(1).nullable(),
  workspaceRoots: z.array(MaterializedWorkspaceRootSchema),
  reasoningEffort: ReasoningEffortSchema.optional(),
  requiredFeatures: z.array(z.never()).optional(),
});
/** Closed trigger outcome codes; summaries never contain dependency exception text. */
export const RecurringAttemptCodeSchema = AutomationAttemptCodeSchema;
/** Immutable authored request shared by individual occurrences and expired ranges. */
export const RecurringDefinitionSnapshotSchema = AutomationDefinitionSnapshotSchema;
/** Durable admission history for exactly one nominal UTC instant. */
export const RecurringOccurrenceSchema = AutomationOccurrenceSchema.omit({
  resolvedSelection: true,
  schedulerStatus: true,
}).extend({
  resolvedPayload: RecurringAdmissionPayloadSchema.nullable(),
  requiredFeatures: z.array(z.never()).optional(),
});
/** Lossless, immutable old-definition coverage for an arbitrary outage interval. */
export const ExpiredOccurrenceRangeSchema = AutomationExpiredRangeSchema.extend({
  requiredFeatures: z.array(z.never()).optional(),
});
/** Frozen scheduler request, including complete root selection. */
export type RecurringAdmissionPayload = z.infer<typeof RecurringAdmissionPayloadSchema>;
/** Individual durable occurrence. */
export type RecurringOccurrence = z.infer<typeof RecurringOccurrenceSchema>;
/** Bounded missed-history record. */
export type ExpiredOccurrenceRange = z.infer<typeof ExpiredOccurrenceRangeSchema>;
/** Typed committed attempt outcome. */
export type RecurringAttemptCode = z.infer<typeof RecurringAttemptCodeSchema>;
/** Bounded pre-admission result; no worker or external-effect handle is accepted. */
export type RecurringPreparation =
  | { readonly kind: 'ready'; readonly payload: RecurringAdmissionPayload }
  | {
      readonly kind: 'failure';
      readonly code: Exclude<RecurringAttemptCode, 'accepted'>;
      readonly payload?: RecurringAdmissionPayload;
    }
  | { readonly kind: 'recovery_required' };
