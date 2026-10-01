import {
  CapabilityCallSchema,
  GatewayFailureKindSchema,
  isGatewayEntryLlmCapabilityId,
  UsageRecordSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Read-only capability call evidence with ledger routing metadata. */
const routeEntryProjection = {
  routeMemberId: z.string().min(1),
  selectionReason: z.string().min(1),
  failureKind: GatewayFailureKindSchema.optional(),
};
/** Workspace audit projection excludes Provider/native-model identity and measurement links. */
export const CapabilityUsageRouteLineageSchema = z.object({
  logicalModelId: z.string().min(1),
  entries: z.array(
    z.discriminatedUnion('kind', [
      z.object({ ...routeEntryProjection, kind: z.literal('unavailable') }),
      z.object({
        ...routeEntryProjection,
        kind: z.literal('attempt'),
        attemptOrder: z.number().int().nonnegative(),
        retryIndex: z.number().int().nonnegative(),
        outputBegan: z.boolean(),
        terminalResult: z.enum([
          'unknown',
          'succeeded',
          'failed',
          'interrupted',
          'incomplete',
          'refused',
        ]),
        released: z.boolean(),
      }),
    ])
  ),
});
export const CapabilityUsageCallSchema = CapabilityCallSchema.safeExtend({
  extensions: z.never().optional(),
  routeLineage: CapabilityUsageRouteLineageSchema.optional(),
  family: z.enum(['llm', 'mcp', 'knowledge', 'network', 'runtime', 'storage', 'workspace']),
  operation: z.string().min(1),
  providerRef: z.string().min(1).nullable().default(null),
  serviceRef: z.string().min(1).nullable().default(null),
  redactionClass: z.string().min(1),
})
  .superRefine((call, context) => {
    if (
      call.systemPromptDigest !== undefined &&
      (call.family !== 'llm' || !isGatewayEntryLlmCapabilityId(call.capabilityId))
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'System-prompt digest is carried only on gateway-entry family llm CapabilityCall records.',
        path: ['systemPromptDigest'],
      });
    }
  })
  .meta({ ...CapabilityCallSchema.meta() });

/** Read-only capability usage evidence for one workspace. */
export const CapabilityUsageResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    capabilityCalls: z.array(CapabilityUsageCallSchema),
    usageRecords: z.array(UsageRecordSchema),
  })
  .strict();

/** Read-only capability call evidence with ledger routing metadata. */
export type CapabilityUsageCall = z.infer<typeof CapabilityUsageCallSchema>;

/** Read-only capability usage evidence for one workspace. */
export type CapabilityUsageResponse = z.infer<typeof CapabilityUsageResponseSchema>;
