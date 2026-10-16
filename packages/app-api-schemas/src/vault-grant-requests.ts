import { RequestIdSchema, ThreadIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { ApprovalEffectPreviewSchema } from './pending-request.js';
import { addRawSecretIssues } from './raw-secrets.js';
import { CreateWorkspaceVaultGrantRequestSchema } from './vault-admin.js';

/** Exact non-secret bounds admitted by the two current grant issuers. */
export const VaultGrantRequestTermsSchema = CreateWorkspaceVaultGrantRequestSchema.safeExtend({
  ownerScope: z.enum(['workspace', 'server']),
  lifetime: z.enum(['workspace', 'server']),
  injectionPath: z.enum(['gateway-only', 'runtime-env']),
  mcpSource: z
    .object({
      serverId: z.string().min(1).max(128),
      slot: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    })
    .strict()
    .optional(),
}).superRefine((value, ctx) => {
  addRawSecretIssues(value, ctx, []);
  if (value.ownerScope !== value.lifetime)
    ctx.addIssue({ code: 'custom', message: 'Grant lifetime must match its owning scope.' });
  if (value.ownerScope === 'server' && value.injectionPath !== 'gateway-only')
    ctx.addIssue({ code: 'custom', message: 'Server grants require Gateway-only visibility.' });
  if (value.injectionPath === 'runtime-env' && value.targetCapabilityId !== undefined)
    ctx.addIssue({
      code: 'custom',
      message: 'Runtime environment grants cannot target a capability.',
    });
});

/** Captures exact terms on a selected Thread; trusted Worker assembly supplies its own execution lineage. */
export const RequestVaultGrantSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    requestId: RequestIdSchema,
    terms: VaultGrantRequestTermsSchema,
  })
  .strict();

/** Reads requests on one currently visible Thread. */
export const ListVaultGrantRequestsSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
  })
  .strict();

/** Consumes the named approved intent; callers cannot replace its captured terms. */
export const IssueRequestedVaultGrantSchema = ListVaultGrantRequestsSchema.safeExtend({
  approvalRequestId: z.string().min(1),
}).strict();

/** Workflow projection preserves requested authority separately from the actual issued grant identity. */
export const VaultGrantRequestViewSchema = z
  .object({
    approvalRequestId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    raisingTurnId: z.string().min(1),
    responsibleUserId: z.string().min(1),
    requesterKind: z.enum(['person', 'worker']),
    agentId: z.string().nullable(),
    agentSessionId: z.string().nullable(),
    terms: VaultGrantRequestTermsSchema,
    state: z.enum(['pending', 'resolved', 'ended']),
    resolution: z.enum(['granted', 'denied', 'answered']).nullable(),
    ending: z.enum(['withdrawn', 'invalidated']).nullable(),
    claim: z.enum(['unclaimed', 'claimed', 'finished']),
    disposition: z
      .enum(['approved-executed', 'denied-not-executed', 'execution-error', 'outcome-unknown'])
      .nullable(),
    delivery: z.enum(['undelivered', 'frozen', 'delivered', 'delivery-unknown', 'closed-out']),
    decidingActorId: z.string().nullable(),
    grantId: z.string().nullable(),
    createdAt: z.string().datetime(),
    effect: ApprovalEffectPreviewSchema,
    canApprove: z.boolean(),
    canIssue: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));

/** Request inventory contains no credential material or credential authentication context. */
export const ListVaultGrantRequestsResponseSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    items: z.array(VaultGrantRequestViewSchema),
  })
  .strict();

/** Supported exact terms; this type is neither an approval nor a VaultGrant. */
export type VaultGrantRequestTerms = z.infer<typeof VaultGrantRequestTermsSchema>;
/** Current request and decision projection. */
export type VaultGrantRequestView = z.infer<typeof VaultGrantRequestViewSchema>;
