import { z } from 'zod';
import {
  AgentIdSchema,
  ArtifactIdSchema,
  AuditEventIdSchema,
  AutomationIdSchema,
  CapabilityCallIdSchema,
  KnowledgeBaseIdSchema,
  PermissionDecisionIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '../common/ids.js';

// Frozen attribution core: live Actor wire changes cannot redefine retained Policy v1.
const PolicyActorV1Schema = z.union([
  z.object({ kind: z.literal('user'), id: UserIdSchema }),
  z.object({
    kind: z.enum(['agent', 'integration', 'system']),
    id: z.string().min(1),
    responsibleUserId: UserIdSchema.nullable(),
  }),
  z.object({
    kind: z.literal('automation'),
    id: AutomationIdSchema,
    responsibleUserId: UserIdSchema.nullable(),
  }),
]);

/** Exact content identity, independent of authored selectors and protocol versions. */
export const PolicyDigestV1Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Native operation stages; a completed observation cannot veto a released effect. */
export const PolicyStageV1Schema = z.enum(['propose', 'decide', 'commit', 'completed']);
/** Pre-stable participant modes; post-success reactions have no contract here. */
export const PolicyModeV1Schema = z.enum(['observe', 'advise', 'gate', 'transform']);
/** A scope owner supplies identity, never permission by itself. */
export const PolicyOwnerV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server') }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId: WorkspaceIdSchema }).strict(),
  z.object({ kind: z.literal('user'), userId: UserIdSchema }).strict(),
]);
/** Container kinds stay with their native owners; unsupported meanings cannot activate. */
export const PolicyContainerV1Schema = z
  .object({
    owner: PolicyOwnerV1Schema,
    kind: z.string().min(1),
    id: z.string().min(1),
  })
  .strict()
  .superRefine((container, context) => {
    const schema =
      container.kind === 'turn'
        ? TurnIdSchema
        : container.kind === 'thread'
          ? ThreadIdSchema
          : container.kind === 'workspace'
            ? WorkspaceIdSchema
            : container.kind === 'user'
              ? UserIdSchema
              : null;
    if (schema && !schema.safeParse(container.id).success)
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'Invalid native container identity.',
      });
  });
/** Scope and lifetime are independent; once is uses one, not a second lifetime kind. */
export const PolicyLifetimeV1Schema = z
  .object({
    anchor: PolicyContainerV1Schema,
    notAfter: z.iso.datetime({ offset: true }).optional(),
    uses: z.number().int().positive().optional(),
  })
  .strict();
/** A principal is the evaluated identity; an ActorRef records who actually acted. */
export const PolicyPrincipalV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), id: UserIdSchema }).strict(),
  z.object({ kind: z.literal('agent'), id: AgentIdSchema }).strict(),
]);
/** Native resource selectors are explicit, rather than inferred from a path or operation. */
export const PolicyResourceV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('container'), container: PolicyContainerV1Schema }).strict(),
  z
    .object({
      kind: z.literal('mcp-tool'),
      workspaceId: WorkspaceIdSchema,
      serverId: z.string().min(1),
      toolName: z.string().min(1),
    })
    .strict(),
]);
/** An empty selector set matches nothing; omission never means every subject or resource. */
export const PolicyScopeV1Schema = z
  .object({
    subjects: z.array(PolicyPrincipalV1Schema).min(1),
    actions: z.array(z.string().min(1)).min(1),
    resources: z.array(PolicyResourceV1Schema).min(1),
  })
  .strict();
/** Stable statement identity and exact content version; unrelated edits do not renew uses. */
export const PolicyStatementReferenceV1Schema = z
  .object({
    id: z.string().min(1),
    digest: PolicyDigestV1Schema,
  })
  .strict();
/** Attribution to a human root or an exact current delegation is mandatory. */
export const PolicyAuthorityV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), userId: UserIdSchema }).strict(),
  z.object({ kind: z.literal('delegation'), statement: PolicyStatementReferenceV1Schema }).strict(),
]);
/** Closed binding failure dispositions; neutral continuation never grants authority. */
export const PolicyFailureV1Schema = z.enum(['escalate-to-human', 'continue', 'error']);
const statementFields = {
  id: z.string().min(1),
  author: PolicyPrincipalV1Schema,
  authority: PolicyAuthorityV1Schema,
  authoredAt: z.iso.datetime({ offset: true }),
  scope: PolicyScopeV1Schema,
  lifetime: PolicyLifetimeV1Schema,
};
/** A binding is a Policy statement, not a participant-owned registration. */
export const PolicyBindingV1Schema = z
  .object({
    ...statementFields,
    kind: z.literal('binding'),
    state: z.enum(['inactive', 'shadow', 'active']),
    operation: z.string().min(1),
    stage: PolicyStageV1Schema,
    point: z.string().min(1),
    mode: PolicyModeV1Schema,
    participant: z
      .object({
        kind: z.literal('deterministic'),
        id: z.string().min(1),
        version: PolicyDigestV1Schema,
      })
      .strict(),
    inputContract: z.literal('mcp-tool-summary-v1'),
    inputDisclosure: PolicyScopeV1Schema,
    outputContract: z.enum(['observation-v1', 'advice-v1', 'gate-v1', 'replacement-v1']),
    order: z.number().int().nonnegative(),
    timeoutMs: z.number().int().min(1).max(60_000),
    failure: PolicyFailureV1Schema.default('escalate-to-human'),
    circuit: z
      .object({
        failures: z.number().int().min(1).max(100),
        recoveryAfterMs: z.number().int().min(1).max(3_600_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.point !== `${binding.operation}@${binding.stage}`)
      context.addIssue({
        code: 'custom',
        path: ['point'],
        message: 'Point must match operation and stage.',
      });
    const contract = {
      observe: 'observation-v1',
      advise: 'advice-v1',
      gate: 'gate-v1',
      transform: 'replacement-v1',
    };
    if (binding.outputContract !== contract[binding.mode])
      context.addIssue({
        code: 'custom',
        path: ['outputContract'],
        message: 'Output contract does not match mode.',
      });
    if (binding.failure === 'continue' && (binding.mode === 'gate' || binding.mode === 'transform'))
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Decisive modes cannot continue after failure.',
      });
  });
/** Native grant payloads remain in Policy; a lease does not create a Storage-owned record. */
export const PolicyGrantV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ordinary') }).strict(),
  z
    .object({
      kind: z.literal('gateway-tool-rule'),
      toolNames: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('storage-lease'),
      knowledgeBaseId: KnowledgeBaseIdSchema,
      mount: z.string().min(1),
      /** Empty selects the mount root; other values are normalized relative prefixes. */
      pathPrefix: z
        .string()
        .refine(
          (value) =>
            value === '' ||
            (!value.includes('\\') &&
              !value.includes('\0') &&
              value
                .split('/')
                .every((segment) => segment !== '' && segment !== '.' && segment !== '..')),
          'Lease prefix must be a normalized relative path.'
        ),
      mode: z.enum(['read-only', 'staged-write']),
    })
    .strict(),
]);
/** Permission conditions include the existing approval-required Tool rule. */
export const PolicyPermissionV1Schema = z
  .object({
    ...statementFields,
    kind: z.literal('permission'),
    state: z.enum(['inactive', 'active']),
    effect: z.enum(['allow', 'prohibit', 'require_approval']),
    grant: PolicyGrantV1Schema,
  })
  .strict();
/** A proposed Goal domain is not proof of completed Plan approval or Task intersection. */
export const PolicyDelegationV1Schema = z
  .object({
    ...statementFields,
    kind: z.literal('delegation'),
    state: z.enum(['inactive', 'active']),
    delegate: PolicyPrincipalV1Schema,
    purpose: z.enum(['goal-domain', 'participant-envelope']),
    source: z
      .object({
        workspaceId: WorkspaceIdSchema,
        goalId: z.string().min(1),
        planVersionId: z.string().min(1),
        planDigest: PolicyDigestV1Schema,
        approvalRequestId: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((statement, context) => {
    if (statement.purpose === 'goal-domain' && !statement.source)
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'Goal domain requires exact Plan approval lineage.',
      });
  });
/** Native administration stamps creator; the responsibility edge supplies no inherited rights. */
export const PolicyAgentPrincipalV1Schema = z
  .object({
    ...statementFields,
    kind: z.literal('agent-principal'),
    state: z.enum(['inactive', 'active']),
    principal: z.object({ kind: z.literal('agent'), id: AgentIdSchema }).strict(),
    creator: PolicyPrincipalV1Schema,
    responsiblePrincipal: PolicyPrincipalV1Schema,
  })
  .strict();
/** Shared authored Policy collection; resolved revision is its canonical content digest. */
export const PolicyDocumentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    statements: z.array(
      z.union([
        PolicyBindingV1Schema,
        PolicyPermissionV1Schema,
        PolicyDelegationV1Schema,
        PolicyAgentPrincipalV1Schema,
      ])
    ),
  })
  .strict()
  .superRefine((document, context) => {
    if (new Set(document.statements.map(({ id }) => id)).size !== document.statements.length)
      context.addIssue({
        code: 'custom',
        path: ['statements'],
        message: 'Statement selectors must be unique.',
      });
  });
/** Exact admitted process; direct human requests explicitly have no Turn. */
export const PolicySubjectV1Schema = z
  .object({
    principal: PolicyPrincipalV1Schema,
    onBehalfOf: UserIdSchema.nullable(),
    actor: PolicyActorV1Schema,
    process: z
      .object({ workspaceId: WorkspaceIdSchema, threadId: ThreadIdSchema, turnId: TurnIdSchema })
      .strict()
      .nullable(),
    credentialKind: z.enum(['local', 'session', 'token', 'worker-package']),
    responsibleHumanId: UserIdSchema,
  })
  .strict();
/** References keep invocations with their existing PermissionDecision or Audit owner. */
export const PolicyInvocationReferenceV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decision'), id: PermissionDecisionIdSchema }).strict(),
  z.object({ kind: z.literal('audit'), id: AuditEventIdSchema }).strict(),
]);
/** Kernel results remain separate from participant and combined product results. */
export const PolicyKernelResultV1Schema = z
  .object({
    effect: z.enum(['allow', 'deny']),
    reason: z.string().min(1),
  })
  .strict();
/** Retained Policy envelope on the existing PermissionDecision family. */
export const PolicyDecisionV1Schema = z
  .object({
    operation: z.string().min(1),
    stage: PolicyStageV1Schema,
    point: z.string().min(1),
    proposalDigest: PolicyDigestV1Schema,
    policyRevision: PolicyDigestV1Schema,
    authorizationRevision: PolicyDigestV1Schema,
    subject: PolicySubjectV1Schema,
    role: z.enum(['gate', 'final']),
    binding: PolicyStatementReferenceV1Schema.optional(),
    kernel: PolicyKernelResultV1Schema.nullable().optional(),
    invocations: z.array(PolicyInvocationReferenceV1Schema),
    consumedStatements: z.array(PolicyStatementReferenceV1Schema),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.point !== `${decision.operation}@${decision.stage}`)
      context.addIssue({
        code: 'custom',
        path: ['point'],
        message: 'Point must match operation and stage.',
      });
    if (decision.role === 'gate' && !decision.binding)
      context.addIssue({
        code: 'custom',
        path: ['binding'],
        message: 'Gate decision requires its binding.',
      });
    if (decision.role === 'final' && decision.kernel === undefined)
      context.addIssue({
        code: 'custom',
        path: ['kernel'],
        message: 'Final decision requires the actual Kernel result or explicit unavailability.',
      });
    if (decision.role === 'gate' && decision.kernel !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['kernel'],
        message: 'A participant cannot claim a Kernel result.',
      });
    if (decision.consumedStatements.length && decision.kernel?.effect !== 'allow')
      context.addIssue({
        code: 'custom',
        path: ['consumedStatements'],
        message: 'Consumption requires an actual Kernel allow.',
      });
    if (decision.role !== 'final' && decision.consumedStatements.length)
      context.addIssue({
        code: 'custom',
        path: ['consumedStatements'],
        message: 'Only final combined allow consumes uses.',
      });
  });
/** Safe invocation evidence carries content identities, never unrestricted input/output bodies. */
export const PolicyInvocationV1Schema = z
  .object({
    binding: PolicyStatementReferenceV1Schema,
    operation: z.string().min(1),
    stage: PolicyStageV1Schema,
    point: z.string().min(1),
    mode: PolicyModeV1Schema,
    policyRevision: PolicyDigestV1Schema,
    authorizationRevision: PolicyDigestV1Schema,
    proposalDigest: PolicyDigestV1Schema,
    subject: PolicySubjectV1Schema,
    participant: z.object({ id: z.string().min(1), version: PolicyDigestV1Schema }).strict(),
    inputDigest: PolicyDigestV1Schema,
    outputDigest: PolicyDigestV1Schema.nullable(),
    outcome: z.enum([
      'completed',
      'unavailable',
      'timeout',
      'open-circuit',
      'malformed',
      'error',
      'stale',
    ]),
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
    capabilityCallId: CapabilityCallIdSchema.nullable(),
  })
  .strict()
  .superRefine((invocation, context) => {
    if (invocation.point !== `${invocation.operation}@${invocation.stage}`)
      context.addIssue({
        code: 'custom',
        path: ['point'],
        message: 'Point must match operation and stage.',
      });
  });
/** Approval pins the exact candidate and authority rather than approving a mutable selector. */
export const PolicyApprovalBindingV1Schema = z
  .object({
    proposalDigest: PolicyDigestV1Schema,
    policyRevision: PolicyDigestV1Schema,
    authorizationRevision: PolicyDigestV1Schema,
  })
  .strict();
/** Policy proposals use the existing immutable configuration candidate Artifact. */
export const PolicyWriteProposalV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    proposer: PolicyPrincipalV1Schema,
    rationale: z.string().min(1),
    baseRevision: PolicyDigestV1Schema,
    proposed: PolicyDocumentV1Schema,
    diff: z
      .object({
        added: z.array(z.string().min(1)),
        changed: z.array(z.string().min(1)),
        removed: z.array(z.string().min(1)),
      })
      .strict(),
    classification: z.enum(['narrowing', 'widening', 'unchanged']),
    validation: z.enum(['valid', 'invalid']),
  })
  .strict();
/** Application outcome separates persistence and activation across their existing effect domains. */
export const PolicyWriteOutcomeV1Schema = z
  .object({
    candidate: z
      .object({
        artifactId: ArtifactIdSchema,
        version: z.number().int().positive(),
        digest: PolicyDigestV1Schema,
      })
      .strict(),
    decider: PolicyPrincipalV1Schema,
    decidedAt: z.iso.datetime({ offset: true }),
    approval: PolicyApprovalBindingV1Schema,
    validation: z.enum(['valid', 'invalid']),
    persistedRevision: PolicyDigestV1Schema.nullable(),
    activeRevision: PolicyDigestV1Schema.nullable(),
    outcome: z.enum(['validation-failed', 'persisted', 'active', 'failed', 'unknown']),
  })
  .strict();

/** Shared v1 statement shapes; native owners alone decide current activation. */
export type PolicyDocumentV1 = z.infer<typeof PolicyDocumentV1Schema>;
/** One versioned binding from the authored Policy collection. */
export type PolicyBindingV1 = z.infer<typeof PolicyBindingV1Schema>;
/** Typed retained final or participant permission evidence. */
export type PolicyDecisionV1 = z.infer<typeof PolicyDecisionV1Schema>;
/** Typed retained non-secret participant evidence. */
export type PolicyInvocationV1 = z.infer<typeof PolicyInvocationV1Schema>;
