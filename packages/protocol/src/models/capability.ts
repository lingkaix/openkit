import { z } from 'zod';

import {
  AgentIdSchema,
  AgentSessionIdSchema,
  CapabilityCallIdSchema,
  ItemIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';

/**
 * Product-safe capability call status.
 */
export const CapabilityCallStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'denied',
  'aborted',
  'timed-out',
  'interrupted',
  'unknown',
]);

/**
 * Lowercase SHA-256 digest of the pre-adapter system prompt Core intended for one family llm call.
 */
export const SystemPromptDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * Returns whether a CapabilityCall capability id identifies an LLM Gateway entry opened above the provider split.
 *
 * @param capabilityId Product capability id stored on the CapabilityCall.
 * @returns True for public Gateway and worker-inference chat_completions and responses calls.
 */
export function isGatewayEntryLlmCapabilityId(capabilityId: string): boolean {
  return capabilityId === 'llm.chat_completions' || capabilityId === 'llm.responses';
}

const capabilityCallLifecycleProjection = {
  allOf: [
    {
      anyOf: [
        { not: { properties: { status: { const: 'queued' } }, required: ['status'] } },
        { properties: { completedAt: { type: 'null' }, startedAt: { type: 'null' } } },
      ],
    },
    {
      anyOf: [
        { not: { properties: { status: { const: 'running' } }, required: ['status'] } },
        { properties: { completedAt: { type: 'null' }, startedAt: { type: 'string' } } },
      ],
    },
    {
      anyOf: [
        {
          not: {
            properties: {
              status: {
                enum: CapabilityCallStatusSchema.options.filter(
                  (status) => status !== 'queued' && status !== 'running'
                ),
              },
            },
            required: ['status'],
          },
        },
        { properties: { completedAt: { type: 'string' }, startedAt: { type: 'string' } } },
      ],
    },
  ],
  description:
    'Capability call timestamp nullability is determined by status. Parsed-instant ordering of terminal timestamps is enforced by the canonical Zod schema because JSON Schema cannot compare sibling date-time values.',
};

/**
 * Product-visible capability call attribution and summary. `systemPromptDigest` is valid only on CapabilityCall records opened above the provider split (`llm.chat_completions` and `llm.responses`); other families and other family-llm usage rows omit it.
 */
export const CapabilityCallSchema = z
  .object({
    id: CapabilityCallIdSchema,
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema.nullable(),
    turnId: TurnIdSchema.nullable(),
    itemId: ItemIdSchema.nullable().default(null),
    agentId: AgentIdSchema.nullable().default(null),
    agentSessionId: AgentSessionIdSchema.nullable(),
    packageSnapshotId: z.string().min(1).nullable().default(null),
    schemaSnapshotId: z.string().min(1).nullable().default(null),
    runtimeOriginRef: z
      .string()
      .regex(/^rto_[a-f0-9]{24}$/)
      .nullable()
      .default(null),
    runtimeCacheLineageRef: z
      .string()
      .regex(/^rcl_[a-f0-9]{24}$/)
      .nullable()
      .default(null),
    requestId: RequestIdSchema.nullable().default(null),
    sourceIds: z.array(z.string().min(1)).default([]),
    capabilityId: z.string().min(1),
    status: CapabilityCallStatusSchema,
    summary: z.string().min(1).nullable(),
    errorCode: z.string().min(1).nullable(),
    startedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
    systemPromptDigest: SystemPromptDigestSchema.optional(),
  })
  .superRefine((call, context) => {
    if (
      call.systemPromptDigest !== undefined &&
      !isGatewayEntryLlmCapabilityId(call.capabilityId)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'System-prompt digest is carried only on CapabilityCall records opened above the provider split.',
        path: ['systemPromptDigest'],
      });
    }
    const startedAt = call.startedAt === null ? null : Date.parse(call.startedAt);
    const completedAt = call.completedAt === null ? null : Date.parse(call.completedAt);
    if (call.status === 'queued') {
      if (call.startedAt !== null || call.completedAt !== null) {
        context.addIssue({
          code: 'custom',
          message: 'Queued capability calls have no timestamps.',
        });
      }
      return;
    }
    if (call.status === 'running') {
      if (startedAt === null || !Number.isFinite(startedAt) || call.completedAt !== null) {
        context.addIssue({
          code: 'custom',
          message: 'Running capability calls require only a start timestamp.',
        });
      }
      return;
    }
    if (
      startedAt === null ||
      completedAt === null ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) ||
      completedAt < startedAt
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Terminal capability calls require ordered start and completion timestamps.',
      });
    }
  })
  .meta(capabilityCallLifecycleProjection);

/**
 * Product-visible capability call attribution and summary.
 */
export type CapabilityCall = z.infer<typeof CapabilityCallSchema>;
