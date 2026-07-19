import { z } from 'zod';

import {
  AgentIdSchema,
  AgentSessionIdSchema,
  AuditEventIdSchema,
  CapabilityCallIdSchema,
  ItemIdSchema,
  PermissionDecisionIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  VaultGrantIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';
import { ActorRefSchema } from './actor.js';

/**
 * Stable audit event severity values.
 */
export const AuditSeveritySchema = z.enum(['info', 'warning', 'error']);

/**
 * Product-visible audit event without secret or adapter-native payloads.
 */
export const AuditEventSchema = z
  .object({
    id: AuditEventIdSchema,
    workspaceId: WorkspaceIdSchema.nullable().default(null),
    protocolVersion: z.string().min(1).optional(),
    threadId: ThreadIdSchema.nullable().default(null),
    turnId: TurnIdSchema.nullable().default(null),
    itemId: ItemIdSchema.nullable().default(null),
    capabilityCallId: CapabilityCallIdSchema.nullable().default(null),
    permissionDecisionId: PermissionDecisionIdSchema.nullable().default(null),
    vaultGrantId: VaultGrantIdSchema.nullable().default(null),
    requestId: RequestIdSchema.nullable().default(null),
    actor: ActorRefSchema.nullable().default(null),
    subject: ActorRefSchema.nullable().default(null),
    agentId: AgentIdSchema.nullable().default(null),
    agentSessionId: AgentSessionIdSchema.nullable().default(null),
    category: z
      .enum(['command', 'approval', 'capability', 'knowledge', 'artifact', 'system'])
      .default('system'),
    action: z.string().min(1),
    resource: z.string().min(1).nullable().default(null),
    resourceRevision: z.number().int().positive().nullable().default(null),
    outcome: z.enum(['succeeded', 'failed', 'denied', 'cancelled']),
    severity: AuditSeveritySchema.default('info'),
    summary: z.string().min(1),
    errorCode: z.string().min(1).nullable().default(null),
    createdAt: TimestampSchema.optional(),
    occurredAt: TimestampSchema.optional(),
  })
  .strict();

/**
 * Product-visible audit event without secret or adapter-native payloads.
 */
export type AuditEvent = z.infer<typeof AuditEventSchema>;
