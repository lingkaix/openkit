import type { PolicyConfigurationWarning } from '@openkit/app-api-schemas';
import { OpenKitConfigSchema } from '@openkit/config-schema';
import type { PolicyDecision } from '@openkit/policy-kernel';
import {
  allocateEntityId,
  type KnowledgeOwnerScope,
  type PolicyContainerV1Schema,
  type PolicyDocumentV1,
  PolicyDocumentV1Schema,
  PolicySubjectV1Schema,
  PolicyWriteProposalV1Schema,
} from '@openkit/protocol';
import type { StorageAccess } from '@openkit/storage';
import type { z } from 'zod';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import {
  authorizeWorkspace,
  evaluateProductAuthorization,
  isCurrentServerPolicyAuthor,
  requireAdministratorOperation,
  requireCurrentDeploymentAdmin,
} from '../auth/operation-authorizer.js';
import { parseJsoncObject } from '../config/jsonc.js';
import {
  type RuntimeConfigFileService,
  RuntimeConfigFileServiceError,
} from '../config/runtime-config-files.js';
import type { FsStore } from '../lib/store.js';
import { readCurrentMcpToolSchemaSnapshot } from '../runtime/mcp-tool-schema-snapshots.js';
import {
  OPENKIT_GENERATIVE_MCP_ID,
  OPENKIT_GENERATIVE_TOOLS,
} from '../runtime/openkit-generative-supply.js';
import { OPENKIT_WORK_MCP_ID, OPENKIT_WORK_TOOLS } from '../runtime/openkit-work-supply.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  listExportableWorkspacePermissionDecisions,
  listServerPermissionDecisions,
  recordProductPermissionDecision,
} from './permission-decisions.js';
import {
  EMPTY_POLICY_DOCUMENT,
  policyDigest,
  preparePolicyDocument,
  validatePolicyDocument,
} from './statements.js';

/** Bounded new Policy target consumed by the existing configuration candidate owner. */
export interface PolicyConfigurationRequest {
  readonly targetFamily: 'policy';
  readonly targetId: 'server';
  readonly expectedRevision: string;
  readonly changes: {
    readonly proposed: PolicyDocumentV1;
    readonly rationale: string;
  };
}

/** Native preparation preserves unrelated server configuration and stamps the real author. */
export function preparePolicyConfiguration(input: {
  readonly request: PolicyConfigurationRequest;
  readonly actor: Actor;
  readonly coreDb: CoreDb;
  readonly files: Pick<RuntimeConfigFileService, 'readFile' | 'validate'>;
  readonly candidate?: z.infer<typeof PolicyWriteProposalV1Schema>;
  readonly loadedPolicy: unknown;
  readonly store: FsStore;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
}) {
  requireAdministratorOperation(input.coreDb, input.actor, 'workspace.configure');
  const read = input.files.readFile('server.jsonc');
  if (read.file.revision !== input.request.expectedRevision)
    throw new RuntimeConfigFileServiceError(
      'config_revision_conflict',
      'Policy configuration base revision changed.',
      409
    );
  const raw = parseJsoncObject(read.content, 'server.jsonc');
  const config = OpenKitConfigSchema.parse(raw);
  const currentDocument = validatePolicyDocument(config.policy?.mediation ?? EMPTY_POLICY_DOCUMENT);
  if (
    policyDigest(currentDocument) !==
    policyDigest(validatePolicyDocument(input.loadedPolicy ?? EMPTY_POLICY_DOCUMENT))
  )
    throw new RuntimeConfigFileServiceError(
      'policy_reload_required',
      'Policy file and loaded revision differ.',
      409
    );
  const proposed = PolicyDocumentV1Schema.parse(input.request.changes.proposed);
  const changed = proposed.statements.find((statement) => {
    const previous = currentDocument.statements.find(({ id }) => id === statement.id);
    return !previous || policyDigest(previous) !== policyDigest(statement);
  });
  // Revalidation uses the exact immutable candidate's server-stamped authorship,
  // rather than making application manufacture a new statement version.
  const authoredAt = input.candidate && changed ? changed.authoredAt : new Date().toISOString();
  const prepared = preparePolicyDocument({
    current: currentDocument,
    proposed,
    userId: input.actor.userId,
    now: authoredAt,
  });
  if (prepared.classification === 'unchanged')
    throw new RuntimeConfigFileServiceError(
      'configuration_changes_required',
      'Policy changes are required.',
      409
    );
  const changedIds = new Set([...prepared.diff.added, ...prepared.diff.changed]);
  for (const statement of prepared.document.statements) {
    if (
      statement.kind !== 'binding' ||
      statement.state === 'inactive' ||
      !changedIds.has(statement.id)
    )
      continue;
    // Recheck the input contract's sole Workspace at apply to prevent stale candidate authority.

    const resource = statement.inputDisclosure.resources[0];
    if (
      resource?.kind !== 'mcp-tool' ||
      !authorizeWorkspace(input.coreDb, input.actor, resource.workspaceId, {
        mutating: true,
        policyOperation: 'tool.use',
      })
    )
      throw new Error('Policy binding input authority is unavailable.');
  }
  // Restrictions may precede discovery. Their exact-name uncertainty belongs to the confirmed candidate, not a grant.
  const warnings: PolicyConfigurationWarning[] = [];
  const changedToolConditions = new Set([...prepared.diff.added, ...prepared.diff.changed]);
  for (const statement of prepared.document.statements) {
    if (
      !changedToolConditions.has(statement.id) ||
      statement.kind !== 'permission' ||
      statement.state !== 'active' ||
      statement.grant.kind !== 'ordinary' ||
      statement.authority.kind !== 'human'
    )
      continue;
    for (const resource of statement.scope.resources) {
      if (resource.kind !== 'mcp-tool') continue;
      const tools =
        resource.serverId === OPENKIT_WORK_MCP_ID
          ? OPENKIT_WORK_TOOLS
          : resource.serverId === OPENKIT_GENERATIVE_MCP_ID
            ? OPENKIT_GENERATIVE_TOOLS
            : readCurrentMcpToolSchemaSnapshot({
                catalogEntryId: resource.serverId,
                pinnedSchemaSnapshotId: null,
                workspaceDb: input.repositoryWorkspaceDb(resource.workspaceId),
                workspaceId: resource.workspaceId,
              })?.tools;
      if (!tools?.some((tool) => tool.name === resource.toolName)) {
        if (statement.effect !== 'prohibit' && statement.effect !== 'require_approval')
          throw new RuntimeConfigFileServiceError(
            'policy_mcp_tool_unobserved',
            'MCP Tool has no admitted schema observation.',
            409
          );
        if (
          !warnings.some(
            (warning) =>
              warning.workspaceId === resource.workspaceId &&
              warning.serverId === resource.serverId &&
              warning.toolName === resource.toolName
          )
        )
          warnings.push({
            code: 'mcp_tool_unobserved',
            workspaceId: resource.workspaceId,
            serverId: resource.serverId,
            toolName: resource.toolName,
            message: `MCP Tool ${resource.serverId}/${resource.toolName} has not been observed in Workspace ${resource.workspaceId}; the statement applies when a Tool with this exact name is exposed.`,
          });
      }
    }
  }

  // Goal statements are projections of one joint Plan approval. Their owner
  // publishes and withdraws them; an unrelated Server candidate must preserve them.
  const currentGoals = currentDocument.statements.filter(
    (statement) => statement.kind === 'delegation'
  );
  const proposedGoals = prepared.document.statements.filter(
    (statement) => statement.kind === 'delegation'
  );
  if (
    currentGoals.length !== proposedGoals.length ||
    currentGoals.some(
      (previous) =>
        !proposedGoals.some(
          (statement) =>
            statement.id === previous.id && policyDigest(statement) === policyDigest(previous)
        )
    )
  )
    throw new RuntimeConfigFileServiceError(
      'policy_goal_owner_required',
      'Goal-domain changes require their Goal owner.',
      409
    );

  // Activation is a distinct human decision over previously observed exact shadow bytes.
  for (const binding of prepared.document.statements) {
    if (
      binding.kind !== 'binding' ||
      binding.participant.kind !== 'agent' ||
      binding.state !== 'active'
    )
      continue;
    const previous = currentDocument.statements.find((s) => s.id === binding.id);
    if (previous && policyDigest(previous) === policyDigest(binding)) continue;
    const content = (value: typeof binding) => {
      const { state: _state, author: _author, authoredAt: _time, ...rest } = value;
      return rest;
    };
    if (
      previous?.kind !== 'binding' ||
      previous.state !== 'shadow' ||
      policyDigest(content(previous)) !== policyDigest(content(binding))
    )
      throw new RuntimeConfigFileServiceError(
        'policy_shadow_evidence_required',
        'Agent activation requires exact prior shadow evidence.',
        409
      );
    const anchor = binding.lifetime.anchor;
    if (anchor.owner.kind !== 'workspace')
      throw new RuntimeConfigFileServiceError(
        'policy_shadow_evidence_required',
        'Agent activation requires exact prior shadow evidence.',
        409
      );
    const workspaceId = anchor.owner.workspaceId;
    const db = input.repositoryWorkspaceDb(workspaceId);
    const events = listWorkspaceAuditEvents(db, workspaceId);
    const completed = listExportableWorkspacePermissionDecisions(db, workspaceId).some(
      (decision) =>
        decision.mediation?.role === 'gate' &&
        decision.mediation.binding?.id === previous.id &&
        decision.mediation.binding.digest === policyDigest(previous) &&
        events.some(
          (event) =>
            event.id === decision.auditEventId &&
            event.permissionDecisionId === decision.decisionId &&
            event.policyInvocation?.outcome === 'completed' &&
            event.policyInvocation.binding.digest === policyDigest(previous) &&
            event.policyInvocation.policyRevision === decision.policySnapshotId
        )
    );
    if (!completed)
      throw new RuntimeConfigFileServiceError(
        'policy_shadow_evidence_required',
        'Agent activation requires exact prior shadow evidence.',
        409
      );
  }

  const proposal = PolicyWriteProposalV1Schema.parse({
    schemaVersion: 1,
    proposer: { kind: 'human', id: input.actor.userId },
    rationale: input.request.changes.rationale,
    baseRevision: policyDigest(currentDocument),
    proposed: prepared.document,
    validation: 'valid',
  });
  if (input.candidate && policyDigest(input.candidate) !== policyDigest(proposal))
    throw new RuntimeConfigFileServiceError(
      'configuration_candidate_conflict',
      'Policy candidate changed during revalidation.',
      409
    );
  const nextPolicy = {
    ...(raw.policy as Record<string, unknown> | undefined),
    mediation: prepared.document,
  };
  const content = `${JSON.stringify({ ...raw, policy: nextPolicy }, null, 2)}\n`;
  const validation = input.files.validate({
    files: [{ id: 'server.jsonc', content }],
    mode: 'safe',
  });
  if (!validation.valid)
    throw new RuntimeConfigFileServiceError(
      'configuration_validation_failed',
      'Policy configuration validation failed.',
      409
    );
  // Reuse the native validation plan's warning channel without making it part of Policy authority.
  validation.plan.warnings.push(...warnings.map(({ code, message }) => ({ code, message })));
  return {
    warnings,
    plan: validation.plan,
    current: { read, value: currentDocument },
    changes: { proposed: prepared.document, rationale: input.request.changes.rationale },
    before: currentDocument,
    after: prepared.document,
    content,
    policyProposal: proposal,
    restartRequired: validation.plan.requiresRestart.length > 0,
  };
}

/** Loaded authority bytes need their actual native human Policy decision before use. */
export function readAdmittedPolicyDocument(coreDb: CoreDb, input: unknown): PolicyDocumentV1 {
  const document = validatePolicyDocument(input ?? EMPTY_POLICY_DOCUMENT);
  if (!document.statements.some((statement) => statement.state !== 'inactive')) return document;
  const revision = policyDigest(document);
  const admitted = listServerPermissionDecisions(coreDb).some((decision) => {
    const context = decision.contextSummary as { operation?: unknown } | null;
    if (
      decision.action !== 'workspace.configure' ||
      context?.operation !== 'policy.write' ||
      decision.result !== 'allow'
    )
      return false;
    const resource = decision.resourceSummary as { policyRevision?: unknown } | null;
    return resource?.policyRevision === revision;
  });
  if (!admitted) throw new Error('Loaded Policy revision has no admitted native Policy change.');
  // The current authored collection, anchor and human authority remain the grant.
  // A historical decision alone never makes an absent statement active.
  return document;
}

/**
 * Projects a current admitted human lease after the caller's mandatory credential/Kernel check.
 *
 * The native caller supplies the current loaded collection, owning Knowledge Base binding and
 * container facts on every Storage operation. A prior projection is not current authority.
 * Invalid Policy or storage failures stay errors; absent or expired authority returns null.
 */
export function readStorageLeaseAccess(input: {
  readonly coreDb: CoreDb;
  readonly policy: unknown;
  readonly statementId: string;
  readonly subject: z.infer<typeof PolicySubjectV1Schema>;
  readonly ownerScope: KnowledgeOwnerScope;
  readonly knowledgeBaseId: string;
  readonly action: 'knowledge.read' | 'knowledge.write';
  readonly kernel: PolicyDecision;
  readonly anchorCurrent: (anchor: z.infer<typeof PolicyContainerV1Schema>) => boolean;
  readonly now: number;
}): (StorageAccess & { readonly basis: 'lease' }) | null {
  if (input.kernel.effect !== 'allow' || !Number.isFinite(input.now)) return null;
  const subject = PolicySubjectV1Schema.parse(input.subject);
  if (
    subject.principal.kind !== 'human' ||
    subject.onBehalfOf !== null ||
    subject.actor.kind !== 'user' ||
    subject.actor.id !== subject.principal.id ||
    subject.responsibleHumanId !== subject.principal.id ||
    subject.credentialKind === 'worker-package'
  )
    return null;
  const document = readAdmittedPolicyDocument(input.coreDb, input.policy);
  const statement = document.statements.find(({ id }) => id === input.statementId);
  if (
    !statement ||
    statement.kind !== 'permission' ||
    statement.state !== 'active' ||
    statement.effect !== 'allow' ||
    statement.grant.kind !== 'storage-lease' ||
    statement.author.kind !== 'human' ||
    !statement.lifetime.notAfter ||
    Date.parse(statement.lifetime.notAfter) <= input.now ||
    statement.grant.knowledgeBaseId !== input.knowledgeBaseId ||
    !statement.scope.actions.includes(input.action) ||
    !statement.scope.subjects.some(
      (principal) => policyDigest(principal) === policyDigest(subject.principal)
    ) ||
    policyDigest(statement.lifetime.anchor.owner) !== policyDigest(input.ownerScope) ||
    !input.anchorCurrent(statement.lifetime.anchor)
  )
    return null;
  if (!isCurrentServerPolicyAuthor(input.coreDb, statement.author.id, input.now)) return null;
  return {
    basis: 'lease',
    grantId: statement.id,
    knowledgeBaseId: statement.grant.knowledgeBaseId,
    ownerScope: input.ownerScope,
    mount: statement.grant.mount,
    pathPrefix: statement.grant.pathPrefix,
    mode: statement.grant.mode,
    expiresAt: statement.lifetime.notAfter,
    revoked: false,
  };
}

/** Records the current human admission before the existing file writer can persist Policy. */
export function recordPolicyWriteDecision(input: {
  readonly coreDb: CoreDb;
  readonly actor: Actor;
  readonly candidate: { readonly artifactId: string; readonly contentDigest: string };
  readonly proposal: z.infer<typeof PolicyWriteProposalV1Schema>;
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
}) {
  const administrator = requireCurrentDeploymentAdmin(input.coreDb, input.actor);
  const kernel = evaluateProductAuthorization(
    input.coreDb,
    input.actor,
    { kind: 'server' },
    'workspace.configure',
    true
  );
  const policyRevision = input.proposal.baseRevision;
  const authorizationRevision = policyDigest({
    administrator,
    credentialKind: input.actor.kind,
    operation: 'workspace.configure',
    kernel,
  });
  const approval = {
    proposalDigest: input.candidate.contentDigest,
    policyRevision,
    authorizationRevision,
  };
  const subject = {
    principal: { kind: 'human' as const, id: input.actor.userId },
    onBehalfOf: null,
    actor: { kind: 'user' as const, id: input.actor.userId },
    process: null,
    credentialKind: input.actor.kind,
    responsibleHumanId: input.actor.userId,
  };
  const decisionId = allocateEntityId('pd');
  recordProductPermissionDecision({
    coreDb: input.coreDb,
    decisionId,
    ownerScope: 'server',
    action: 'workspace.configure',
    result: kernel.effect,
    reasonCode: kernel.effect === 'allow' ? 'granted' : 'not_granted',
    policyEngineVersion: 'nanocore-policy:v1',
    policySnapshotId: policyRevision,
    subjectSummary: {
      principal: subject.principal,
      responsibleHumanId: subject.responsibleHumanId,
    },
    resourceSummary: {
      kind: 'policy',
      policyRevision: policyDigest(input.proposal.proposed),
      candidateArtifactId: input.candidate.artifactId,
    },
    contextSummary: {
      operation: 'policy.write',
      requestId: input.requestId,
      threadId: input.threadId,
      turnId: input.turnId,
    },
    enforcementPoint: 'policy.write@decide',
    mediation: {
      operation: 'policy.write',
      stage: 'decide',
      proposalDigest: approval.proposalDigest,
      authorizationRevision: approval.authorizationRevision,
      subject,
      role: 'final',
      kernel: { effect: kernel.effect, reason: kernel.reasons[0]?.code ?? 'not_granted' },
      invocations: [],
      consumedStatements: [],
    },
    auditActor: subject.actor,
  });
  if (kernel.effect !== 'allow') throw new Error('Policy write was not granted.');
  return { decisionId, approval };
}
