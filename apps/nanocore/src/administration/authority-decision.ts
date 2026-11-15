import type { PolicyDecision } from '@openkit/policy-kernel';
import type { PolicyBindingV1, PolicySubjectV1Schema } from '@openkit/protocol';
import { policyDigest } from '@openkit/protocol/digest';
import type { z } from 'zod';
import { isCurrentServerPolicyAuthor } from '../auth/operation-authorizer.js';
import { readAdmittedPolicyDocument } from '../policy/configuration.js';
import {
  type RecordPermissionDecisionInput,
  recordPermissionDecision,
  recordProductPermissionDecision,
} from '../policy/permission-decisions.js';
import { EMPTY_POLICY_DOCUMENT, readPolicyAgentPrincipal } from '../policy/statements.js';
import { evaluatePolicyKernel } from '../policy/workspace-access.js';
import type { CoreDb } from '../storage/db.js';

/** Native investigation identity; its editable grant lives in human-authored Server Policy. */
export const SECURITY_INVESTIGATION_AGENT_ID = 'security-investigation';

/** Projects native current subject/declaration facts; only the shared Kernel decides the request. */
export function readAdministrationPolicyContext(
  coreDb: CoreDb,
  sourceSubject: z.infer<typeof PolicySubjectV1Schema>,
  operation: string,
  sourceDocument: unknown,
  now = Date.now()
) {
  const resource = {
    kind: 'container',
    container: {
      owner: { kind: 'server' },
      kind: 'server',
      id: 'server',
    },
  } as const;
  let document = EMPTY_POLICY_DOCUMENT;
  let subject = sourceSubject;
  let domain: { id: string; scope: PolicyBindingV1['scope'] } | null = null;
  const authorCurrent = (userId: string) => isCurrentServerPolicyAuthor(coreDb, userId, now);
  const anchorCurrent = (anchor: PolicyBindingV1['lifetime']['anchor']) =>
    anchor.owner.kind === 'server' && anchor.kind === 'server' && anchor.id === 'server';
  try {
    document = readAdmittedPolicyDocument(coreDb, sourceDocument);
    if (
      subject.principal.kind !== 'agent' ||
      subject.actor.kind !== 'agent' ||
      subject.actor.id !== subject.principal.id ||
      subject.onBehalfOf === null ||
      subject.actor.responsibleUserId !== subject.onBehalfOf ||
      subject.responsibleHumanId !== subject.onBehalfOf ||
      !subject.process
    )
      throw new Error('The native initiating human is unavailable.');
    const declaration = document.statements.find(
      (entry) => entry.kind === 'agent-principal' && entry.agentId === subject.principal.id
    );
    if (!declaration) throw new Error('The current agent declaration is unavailable.');
    const current = readPolicyAgentPrincipal({
      document,
      participant: { kind: 'agent', id: subject.principal.id, version: policyDigest(declaration) },
      proposal: { subject, workspaceId: subject.process.workspaceId, resource },
      operation,
      authorCurrent,
      anchorCurrent,
      now,
    });
    domain = { id: current.id, scope: current.scope };
    subject = {
      ...subject,
      responsibleHumanId: current.responsibleHumanId,
      actor: { ...subject.actor, responsibleUserId: current.responsibleHumanId },
    };
  } catch {
    // Missing/unadmitted/revoked declarations have no grant, not an implicit role fallback.
  }
  const facts = {
    subject,
    operation,
    resource,
    domain,
    policy: { document, now, authorCurrent, anchorCurrent },
  };
  return { ...facts, decision: evaluatePolicyKernel(facts) };
}

/** Shared administration projection through the existing Policy recorder; grants no authority. */
export async function recordAdministrationAuthorityDecision(
  input: Omit<RecordPermissionDecisionInput, 'policyDecision'>,
  decision: PolicyDecision,
  investigation: boolean
): Promise<void> {
  if (!investigation) {
    await recordPermissionDecision({ ...input, policyDecision: decision });
    return;
  }
  await recordProductPermissionDecision({
    ...input,
    result: decision.effect,
    reasonCode:
      decision.reasons[0]?.code === 'missing-privilege'
        ? 'not_granted'
        : (decision.reasons[0]?.code ?? 'unknown'),
    contextSummary: {
      ...input.contextSummary,
      kernelTrace: {
        matchedAssociations: decision.trace.matchedAssociations,
        matchedProhibitions: decision.trace.matchedProhibitions,
      },
    },
  });
}
