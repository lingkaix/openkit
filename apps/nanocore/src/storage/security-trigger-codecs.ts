import {
  AccessTokenIdSchema,
  ActorRefSchema,
  AuditEventIdSchema,
  AuditEventSchema,
  ThreadIdSchema,
  TimestampSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { SecurityThreadDestinationSchema } from './security-thread-destination-codecs.js';

const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveCounter = Counter.positive();
const Actor = z
  .object({
    kind: z.enum(['local', 'session', 'token']),
    userId: UserIdSchema,
    sessionId: z.string().min(1).optional(),
    tokenId: AccessTokenIdSchema.optional(),
    tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
    tokenWorkspaceIds: z.array(WorkspaceIdSchema).max(512).optional(),
    adminTokenId: AccessTokenIdSchema.optional(),
  })
  .strict();
const Cursor = z.object({ createdAt: TimestampSchema, auditEventId: z.string().min(1) }).strict();

/** A current projection, never a caller assertion or a persisted authority boolean. */
export const SecurityTriggerSnapshotSchema = z
  .object({
    state: z.enum(['off', 'on', 'stopping']),
    enableGeneration: Counter,
    enablingUserId: UserIdSchema.nullable(),
    delegationCurrent: z.boolean(),
    stoppingReason: z.enum(['monitoring-off', 'lost-authority']).nullable(),
    failedOutcome: z.literal('no-current-administrator').nullable(),
  })
  .strict();
export type SecurityTriggerSnapshot = z.infer<typeof SecurityTriggerSnapshotSchema>;

/** Original alarm notice inputs; the native owner assigns counters and recomputes identity. */
export const SecurityAlarmRowSchema = z
  .object({
    requestId: z.string().uuid(),
    recipientUserId: UserIdSchema,
    rule: z.enum(['R1', 'R8']),
    key: z.tuple([
      z.literal('gap'),
      PositiveCounter,
      z.enum(['monitoring-off', 'lost-authority']),
      z.string().uuid(),
    ]),
    occurrence: z
      .object({
        kind: z.enum(['initial', 'reopen', 'reminder', 'renotice', 'conflict']),
        n: PositiveCounter,
      })
      .strict(),
    raised: z.boolean(),
  })
  .strict();
export type SecurityAlarmRow = z.infer<typeof SecurityAlarmRowSchema>;

export const SecurityAuditActionSchema = z.enum([
  'auth.token.issue',
  'auth.token.revoke',
  'auth.token.rotate',
  'auth.admin-recovery.issue',
  'auth.bootstrap.consume',
  'administration.configuration.apply',
  'server.config.update',
  'policy.write',
  'user.disable',
  'app.update.start',
  'channel.pairing.bind',
  'channel.pairing.unbind',
  'auth.failure-threshold',
  'auth.revoked-credential-presented',
]);
export type SecurityAuditAction = z.infer<typeof SecurityAuditActionSchema>;
export const SecurityAuditMissingFieldSchema = z.enum([
  'actor',
  'target-user',
  'successful-outcome',
  'token-id',
  'scope',
  'owner',
  'principal',
  'expiry',
  'changed-sections',
  'changed-keys',
  'full-diff-classification',
  'target-digest',
  'channel-kind',
  'binding-revision',
  'administrator-at-event',
  'kind',
  'key-kind',
  'window',
  'count',
  'status',
  'source',
  'bootstrap-actor-semantics',
]);
export type SecurityAuditMissingField = z.infer<typeof SecurityAuditMissingFieldSchema>;
export type SecurityAuditCursor = z.infer<typeof Cursor>;

/** Original source facts and the native assessment, not reconstructed credential/config history. */
export const SecurityAuditAssessmentSchema = z
  .object({
    auditEventId: AuditEventIdSchema,
    createdAt: TimestampSchema,
    enableGeneration: PositiveCounter,
    action: SecurityAuditActionSchema,
    actor: ActorRefSchema.nullable(),
    targetUserId: UserIdSchema.nullable(),
    status: z.enum(['detected', 'unsupported']),
    rule: z.enum(['R1', 'R1d']).nullable(),
    notify: z.enum(['immediate', 'daily']).nullable(),
    missingFields: z
      .array(SecurityAuditMissingFieldSchema)
      .max(22)
      .refine((fields) => new Set(fields).size === fields.length),
    recipientCount: Counter,
  })
  .strict();
export type SecurityAuditAssessment = z.infer<typeof SecurityAuditAssessmentSchema>;

/** Initial event obligations only; no caller allocation or downstream delivery acknowledgement. */
export const SecurityEventOutboxRowSchema = z
  .object({
    requestId: z.string().uuid(),
    recipientUserId: UserIdSchema,
    key: z.tuple([z.literal('event'), AuditEventIdSchema]),
    rule: z.enum(['R1', 'R1d']),
    notify: z.enum(['immediate', 'daily']),
    occurrence: z.object({ kind: z.literal('initial'), n: z.literal(1) }).strict(),
    raised: z.boolean(),
  })
  .strict();
export type SecurityEventOutboxRow = z.infer<typeof SecurityEventOutboxRowSchema>;

/** Only the closed Server security family crosses the existing Core native connection. */
export const ControlSecurityTriggerSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('current'), timestamp: TimestampSchema }).strict(),
  z.object({ action: z.literal('enable'), actor: Actor, timestamp: TimestampSchema }).strict(),
  z.object({ action: z.literal('stop'), actor: Actor, timestamp: TimestampSchema }).strict(),
  z
    .object({
      action: z.literal('audit'),
      after: Cursor.optional(),
      limit: z.number().int().min(1).max(128),
      timestamp: TimestampSchema,
    })
    .strict(),
  z.object({ action: z.literal('alarms') }).strict(),
  z
    .object({
      action: z.literal('audit-detect'),
      limit: z.number().int().min(1).max(128),
      timestamp: TimestampSchema,
    })
    .strict(),
  z.object({ action: z.literal('detection-progress') }).strict(),
  z
    .object({
      action: z.literal('detections'),
      after: Cursor.optional(),
      limit: z.number().int().min(1).max(128),
    })
    .strict(),
  z.object({ action: z.literal('event-outbox') }).strict(),
  z.object({ action: z.literal('alarm-read'), requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('destination-reserve'), requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('destination-read'), threadId: ThreadIdSchema }).strict(),
  z
    .object({
      action: z.literal('destination-ready'),
      threadId: ThreadIdSchema,
      requestId: z.string().uuid(),
    })
    .strict(),
]);
export type ControlSecurityTrigger = z.infer<typeof ControlSecurityTriggerSchema>;

/** A refused Audit is a committed native check: its loss alarm must survive the refusal. */
export const ControlSecurityTriggerResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), snapshot: SecurityTriggerSnapshotSchema }).strict(),
  z
    .object({
      kind: z.literal('audit'),
      events: z.array(AuditEventSchema).max(128),
      next: Cursor.nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal('audit-unavailable'), snapshot: SecurityTriggerSnapshotSchema })
    .strict(),
  z.object({ kind: z.literal('alarms'), rows: z.array(SecurityAlarmRowSchema).max(128) }).strict(),
  z
    .object({
      kind: z.literal('audit-detection'),
      cursor: Cursor.nullable(),
      scanned: Counter.max(128),
      detected: Counter.max(128),
      unsupported: Counter.max(128),
    })
    .strict(),
  z
    .object({ kind: z.literal('detection-progress'), cursor: Cursor.nullable(), assessed: Counter })
    .strict(),
  z
    .object({
      kind: z.literal('detections'),
      events: z.array(SecurityAuditAssessmentSchema).max(128),
      next: Cursor.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('event-outbox'),
      rows: z.array(SecurityEventOutboxRowSchema).max(128),
    })
    .strict(),
  z.object({ kind: z.literal('alarm'), row: SecurityAlarmRowSchema }).strict(),
  z
    .object({
      kind: z.literal('destination'),
      destination: SecurityThreadDestinationSchema,
      fresh: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('destination-read'),
      destination: SecurityThreadDestinationSchema.nullable(),
    })
    .strict(),
]);
export type ControlSecurityTriggerResult = z.infer<typeof ControlSecurityTriggerResultSchema>;

export const SECURITY_TRIGGER_REFUSALS = {
  forbidden: { message: 'Current administrator authority is required.', status: 403 },
  recovery_required: { message: 'Security trigger original tuple requires recovery.', status: 409 },
  unsupported_retained_format: { message: 'Unsupported retained record format.', status: 409 },
} as const;
export type SecurityTriggerRefusalCode = keyof typeof SECURITY_TRIGGER_REFUSALS;
/** Fixed non-secret domain diagnostic; never an exception/SQL-message transport. */
export class SecurityTriggerRefusal extends Error {
  constructor(readonly code: SecurityTriggerRefusalCode) {
    super(SECURITY_TRIGGER_REFUSALS[code].message);
  }
}
export const ControlSecurityTriggerRefusalSchema = z
  .object({
    operation: z.literal('security-trigger'),
    code: z.enum(['forbidden', 'recovery_required', 'unsupported_retained_format']),
    message: z.string(),
    status: z.number(),
  })
  .strict()
  .refine((value) => {
    const fixed = SECURITY_TRIGGER_REFUSALS[value.code];
    return value.message === fixed.message && value.status === fixed.status;
  });
