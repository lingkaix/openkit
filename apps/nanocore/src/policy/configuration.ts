import { createHash } from 'node:crypto';
import { OpenKitConfigSchema } from '@openkit/config-schema';
import {
  allocateEntityId,
  type PolicyDocumentV1,
  PolicyDocumentV1Schema,
  PolicyWriteProposalV1Schema,
} from '@openkit/protocol';
import type { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { requireCurrentDeploymentAdmin } from '../auth/operation-authorizer.js';
import { parseJsoncObject } from '../config/jsonc.js';
import type { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import type { FsStore } from '../lib/store.js';
import { readGoalView } from '../runtime/goal-owner.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  listServerPermissionDecisions,
  recordProductPermissionDecision,
} from './permission-decisions.js';
import { evaluateServerAccess } from './server-access.js';
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
  requireCurrentDeploymentAdmin(input.coreDb, input.actor);
  const read = input.files.readFile('server.jsonc');
  if (read.file.revision !== input.request.expectedRevision)
    throw new Error('Policy configuration base changed.');
  const raw = parseJsoncObject(read.content, 'server.jsonc');
  const config = OpenKitConfigSchema.parse(raw);
  const currentDocument = validatePolicyDocument(config.policy?.mediation ?? EMPTY_POLICY_DOCUMENT);
  if (
    policyDigest(currentDocument) !==
    policyDigest(validatePolicyDocument(input.loadedPolicy ?? EMPTY_POLICY_DOCUMENT))
  )
    throw new Error('Policy file and loaded revision differ; inspect and reload first.');
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
  if (prepared.classification === 'unchanged') throw new Error('Policy changes are required.');
  for (const statement of prepared.document.statements) {
    if (statement.kind !== 'delegation' || statement.purpose !== 'goal-domain') continue;
    const source = statement.source!;
    const view = readGoalView(
      input.store,
      input.repositoryWorkspaceDb(source.workspaceId),
      source.goalId
    );
    const version = view.versions.find((item) => item.planVersionId === source.planVersionId);
    const request = view.requests.find((item) => item.requestId === source.approvalRequestId);
    if (
      !view.goal ||
      view.goal.workspaceId !== source.workspaceId ||
      view.goal.disposition !== null ||
      view.goal.activePlanVersionId !== source.planVersionId ||
      !version ||
      version.digest !== source.planDigest ||
      `sha256:${createHash('sha256').update(version.bytes).digest('hex')}` !== source.planDigest ||
      version.pendingRequestId !== source.approvalRequestId ||
      request?.state !== 'resolved' ||
      request.resolution !== 'granted' ||
      request.disposition !== 'approved-executed'
    )
      throw new Error(
        'Goal domain requires the exact current approved Plan and completed approval.'
      );
  }

  const proposal = PolicyWriteProposalV1Schema.parse({
    schemaVersion: 1,
    proposer: { kind: 'human', id: input.actor.userId },
    rationale: input.request.changes.rationale,
    baseRevision: policyDigest(currentDocument),
    proposed: prepared.document,
    diff: prepared.diff,
    classification: prepared.classification,
    validation: 'valid',
  });
  if (input.candidate && policyDigest(input.candidate) !== policyDigest(proposal))
    throw new Error('Policy candidate changed during revalidation.');
  const nextPolicy = {
    ...(raw.policy as Record<string, unknown> | undefined),
    mediation: prepared.document,
  };
  const content = `${JSON.stringify({ ...raw, policy: nextPolicy }, null, 2)}\n`;
  const validation = input.files.validate({
    files: [{ id: 'server.jsonc', content }],
    mode: 'safe',
  });
  if (!validation.valid) throw new Error('Policy configuration validation failed.');
  return {
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
  const kernel = evaluateServerAccess({
    userId: input.actor.userId,
    operation: 'workspace.configure',
  });
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
      point: 'policy.write@decide',
      ...approval,
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
