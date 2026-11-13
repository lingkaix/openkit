import { describe, expect, it } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { PolicyInterception } from './interception.js';
import { listExportableWorkspacePermissionDecisions } from './permission-decisions.js';
import {
  agentId,
  document,
  fixture,
  human,
  responsibleHumanId,
  workspaceId,
} from './test-support/e10-agent-fixture.js';

describe('E10 truthful review attribution', () => {
  it('records the review agent on behalf of the actual requester, not its accountable human', async () => {
    const f = fixture(document(true));
    const interception = new PolicyInterception(undefined, {
      id: agentId,
      invoke: async () => ({
        decision: 'allow',
        risk: 'Bounded read.',
        authorizationAssessment: 'Exact declared domain.',
        rationale: 'Current read only.',
      }),
    });
    expect((await interception.decide(f)).result).toBe('allow');
    const review = listExportableWorkspacePermissionDecisions(f.workspaceDb, workspaceId).find(
      (decision) => decision.mediation?.role === 'gate'
    );
    expect(review, 'The review must have its own retained PermissionDecision.').toBeDefined();
    expect(review?.mediation?.subject.principal).toEqual({
      kind: 'agent',
      id: agentId,
    });
    expect(review?.mediation?.subject.responsibleHumanId).toBe(responsibleHumanId);
    // E10 keeps these identities distinct; PolicySubjectV1 represents on-behalf-of as a User ID.
    expect(review?.mediation?.subject.onBehalfOf).toBe(human.id);
    const audit = listWorkspaceAuditEvents(f.workspaceDb, workspaceId).find(
      (event) => event.permissionDecisionId === review?.decisionId
    );
    expect(audit?.policyInvocation?.subject.onBehalfOf).toBe(human.id);
    expect(audit?.actor).toEqual({
      kind: 'agent',
      id: agentId,
      responsibleUserId: responsibleHumanId,
    });
  });
});
