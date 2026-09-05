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
 * Product-visible capability call attribution and summary.
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
  })
  .superRefine((call, context) => {
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
