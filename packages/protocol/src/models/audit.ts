import { z } from 'zod';
import {
  AccessTokenIdSchema,
  AgentIdSchema,
  AgentSessionIdSchema,
  AuditEventIdSchema,
  AuthenticationSessionIdSchema,
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
import { KnowledgeNotebookAdmissionSchema } from './knowledge-notebook.js';
import {
  PolicyDigestV1Schema,
  PolicyInvocationV1Schema,
  PolicyWriteOutcomeV1Schema,
} from './policy-v1.js';

/**
 * Stable audit event severity values.
 */
export const AuditSeveritySchema = z.enum(['info', 'warning', 'error']);

/** Non-secret authentication facts retained for credential incident attribution. */
export const AuditAuthenticationSchema = z
  .object({
    credentialKind: z.enum(['local', 'session', 'token']),
    credentialId: z.union([AccessTokenIdSchema, AuthenticationSessionIdSchema]).nullable(),
  })
  .strict();

const BootAuditReasonSchema = z
  .object({ code: z.string().min(1), blocks: z.array(z.string().min(1)) })
  .strict();
const BootAuditReadinessSchema = z.enum(['ready', 'degraded', 'failed']);
const BootAuditSubsystemSchema = z.enum([
  'config',
  'storage',
  'policy',
  'vault',
  'scheduler',
  'llmGateway',
  'knowledgeIndex',
]);
const BootAuditSubsystemStateSchema = z
  .object({ state: BootAuditReadinessSchema, reasons: z.array(BootAuditReasonSchema) })
  .strict();

/** Required redacted evidence for the existing Core Audit family. */
export const KernelAuditEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('boot.start'),
      bootId: z.string().min(1),
      layoutVersion: z.number().int().positive().nullable(),
      migrationIds: z.array(z.string().min(1)),
      lock: z
        .object({
          status: z.enum(['acquired', 'stale_broken']),
          staleHolder: z
            .object({
              bootId: z.string().min(1),
              pid: z.number().int().positive(),
              hostname: z.string().min(1).optional(),
            })
            .strict()
            .nullable(),
        })
        .strict()
        .nullable(),
      indexRebuilds: z.array(
        z
          .object({ workspaceId: WorkspaceIdSchema, itemCount: z.number().int().nonnegative() })
          .strict()
      ),
      storageRecovery: z.array(
        z
          .object({
            scope: z.enum(['server', 'workspace', 'user', 'app']),
            reason: z.string().min(1),
          })
          .strict()
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('boot.outcome'),
      bootId: z.string().min(1),
      acceptingProductWork: z.boolean(),
      overall: BootAuditReadinessSchema,
      subsystems: z.record(BootAuditSubsystemSchema, BootAuditSubsystemStateSchema),
      phases: z.array(
        z
          .object({
            name: z.string().min(1),
            subsystem: BootAuditSubsystemSchema,
            critical: z.boolean(),
            status: z.enum(['ok', 'degraded', 'failed']),
            reasons: z.array(BootAuditReasonSchema),
          })
          .strict()
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('boot.shutdown'),
      bootId: z.string().min(1),
      reason: z.string().min(1),
      stepsCompleted: z.array(z.string().min(1)),
      deadlineForcedExit: z.boolean(),
    })
    .strict(),
  z.strictObject({
    kind: z.literal('security.containment-evidence'),
    evidenceId: z.string().min(1).max(256),
    sourceKind: z.enum([
      'security-containment',
      'security-containment-gap',
      'security-containment-review',
    ]),
    backendType: z.string().min(1).max(128).nullable(),
    redactedEvidenceRefs: z
      .array(
        z.strictObject({
          kind: z.enum([
            'audit',
            'policy',
            'grant',
            'package',
            'scheduler-attempt',
            'vault-plan',
            'vault-grant',
            'vault-receipt',
          ]),
          ref: z.string().min(1).max(512),
        })
      )
      .max(128),
    contentDigests: z.array(PolicyDigestV1Schema).max(8),
  }),
  z.object({ kind: z.literal('vault.admin'), backendKind: z.literal('encrypted-file') }).strict(),
]);

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
    authentication: AuditAuthenticationSchema.optional(),
    subject: ActorRefSchema.nullable().default(null),
    agentId: AgentIdSchema.nullable().default(null),
    agentSessionId: AgentSessionIdSchema.nullable().default(null),
    category: z
      .enum(['command', 'approval', 'capability', 'knowledge', 'artifact', 'system'])
      .default('system'),
    action: z.string().min(1),
    resource: z.string().min(1).nullable().default(null),
    resourceRevision: z.number().int().positive().nullable().default(null),
    notebookAdmission: KnowledgeNotebookAdmissionSchema.optional(),
    policyInvocation: PolicyInvocationV1Schema.optional(),
    policyWriteOutcome: PolicyWriteOutcomeV1Schema.optional(),
    outcome: z.enum(['succeeded', 'failed', 'denied', 'cancelled', 'unknown']),
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

/** Native Audit carriage for required kernel lifecycle facts, independent of the App read contract. */
export const KernelAuditEventSchema = AuditEventSchema.extend({
  kernelEvidence: KernelAuditEvidenceSchema.optional(),
});

export type KernelAuditEvent = z.infer<typeof KernelAuditEventSchema>;
