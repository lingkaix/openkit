import { describe, expect, it } from 'vitest';

import {
  projectPermissionDecision,
  readAuditEventRowV1,
  readPermissionDecisionRowV1,
} from './retained-records-v1.js';

const decisionRow = {
  schema_version: 1,
  decision_id: 'pd_00000000-0000-7000-8000-000000000001',
  owner_scope: 'server',
  workspace_id: null,
  policy_engine_version: 'fixture:v1',
  policy_snapshot_id: 'fixture',
  subject_summary_json: '{"kind":"agent","id":"worker"}',
  action: 'tool.use',
  resource_summary_json: '{"id":"tool"}',
  context_summary_json: '{}',
  result: 'allow',
  reason_code: 'allowed',
  enforcement_point: 'tool.use',
  required_approval_kind: null,
  approval_id: null,
  audit_event_id: null,
  created_at: '2026-10-18T00:00:00.000Z',
};
const auditRow = {
  schema_version: 1,
  audit_event_id: 'aud_00000000-0000-7000-8000-000000000001',
  workspace_id: null,
  protocol_version: null,
  thread_id: null,
  turn_id: null,
  item_id: null,
  capability_call_id: null,
  permission_decision_id: decisionRow.decision_id,
  vault_grant_id: null,
  request_id: null,
  actor_json: '{"kind":"user","id":"usr_00000000-0000-7000-8000-000000000001","note":"annotation"}',
  subject_json: null,
  agent_id: null,
  agent_session_id: null,
  category: 'approval',
  action: 'permission.decision',
  resource: 'permission:tool.use',
  resource_revision: null,
  notebook_admission_json: null,
  outcome: 'succeeded',
  severity: 'info',
  summary: 'Allowed.',
  error_code: null,
  created_at: decisionRow.created_at,
  occurred_at: decisionRow.created_at,
};

describe('independent version-one Policy and Audit decoders', () => {
  it('reads the frozen cores and ignores descriptive additions without forwarding a storage marker', () => {
    expect(readPermissionDecisionRowV1({ ...decisionRow, annotation: 'retained' })).toMatchObject({
      decisionId: decisionRow.decision_id,
      result: 'allow',
      subjectSummary: { kind: 'agent', id: 'worker' },
    });
    const audit = readAuditEventRowV1({ ...auditRow, annotation: 'retained' });
    expect(audit.actor).toEqual({ kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' });
    expect(audit).not.toHaveProperty('schemaVersion');
    expect(audit).not.toHaveProperty('annotation');
    expect(() => readAuditEventRowV1({ ...auditRow, outcome: 'unsupported' })).toThrow();
    expect(() => readPermissionDecisionRowV1({ ...decisionRow, result: 'unsupported' })).toThrow();
  });

  it('ignores nested invocation annotations while refusing unknown required meanings', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const invocation = {
      binding: { id: 'gate', digest, note: 'annotation' },
      operation: 'mcp.call-tool',
      stage: 'decide',
      mode: 'gate',
      policyRevision: digest,
      authorizationRevision: digest,
      proposalDigest: digest,
      subject: {
        principal: { kind: 'human', id: 'usr_00000000-0000-7000-8000-000000000001' },
        onBehalfOf: null,
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        process: null,
        credentialKind: 'local',
        responsibleHumanId: 'usr_00000000-0000-7000-8000-000000000001',
        note: 'annotation',
      },
      participant: { id: 'test', version: digest, note: 'annotation' },
      inputDigest: digest,
      outputDigest: null,
      outcome: 'error',
      startedAt: decisionRow.created_at,
      completedAt: decisionRow.created_at,
      capabilityCallId: null,
      note: 'annotation',
    };
    const read = (value: unknown) =>
      readAuditEventRowV1({ ...auditRow, policy_invocation_json: JSON.stringify(value) })
        .policyInvocation;
    expect(read(invocation)).not.toHaveProperty('note');
    expect(read(invocation)?.participant).not.toHaveProperty('note');
    expect(read(invocation)?.subject).not.toHaveProperty('note');
    expect(() => read({ ...invocation, mode: 'unknown' })).toThrow();
    expect(() => read({ ...invocation, outcome: 'unknown' })).toThrow();
    const mediation = {
      operation: invocation.operation,
      stage: invocation.stage,
      proposalDigest: digest,
      authorizationRevision: digest,
      subject: invocation.subject,
      role: 'final',
      kernel: { effect: 'allow', reason: 'granted' },
      invocations: [],
      consumedStatements: [],
      note: 'annotation',
    };
    const portable = projectPermissionDecision({ mediation }) as {
      mediation: unknown;
      enforcementPoint: string;
    };
    expect(portable.mediation).not.toHaveProperty('note');
    expect(portable.enforcementPoint).toBe('mcp.call-tool@decide');
    expect(() =>
      projectPermissionDecision({ mediation: { ...mediation, stage: 'unknown' } })
    ).toThrow();
  });

  it('derives a mediated subject and enforcement point from retained evidence and strips annotations', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const userId = 'usr_00000000-0000-7000-8000-000000000001';
    const staleUserId = 'usr_00000000-0000-7000-8000-000000000002';
    const subject = {
      principal: { kind: 'human', id: userId },
      onBehalfOf: null,
      actor: { kind: 'user', id: userId },
      process: null,
      credentialKind: 'local',
      responsibleHumanId: userId,
      note: 'annotation',
    };
    const mediation = {
      operation: 'mcp.call-tool',
      stage: 'decide',
      proposalDigest: digest,
      authorizationRevision: digest,
      subject,
      role: 'final',
      kernel: { effect: 'allow', reason: 'granted' },
      invocations: [],
      consumedStatements: [],
      note: 'annotation',
    };
    const row = {
      ...decisionRow,
      owner_scope: 'workspace',
      workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
      policy_snapshot_id: digest,
      // These stored projections contradict the mediated facts and must not be trusted.
      subject_summary_json: JSON.stringify({
        principal: { kind: 'human', id: staleUserId },
        actor: { kind: 'user', id: staleUserId },
        process: null,
        onBehalfOf: null,
        credentialKind: 'token',
        responsibleHumanId: staleUserId,
        stale: true,
      }),
      enforcement_point: 'stale.operation@commit',
      mediation_json: JSON.stringify(mediation),
    };

    const decoded = readPermissionDecisionRowV1(row);
    expect(decoded.subjectSummary).toEqual({
      principal: subject.principal,
      actor: subject.actor,
      process: null,
      onBehalfOf: null,
      credentialKind: 'local',
      responsibleHumanId: userId,
    });
    expect(decoded.subjectSummary).not.toHaveProperty('stale');
    expect(decoded.enforcementPoint).toBe('mcp.call-tool@decide');
    expect(decoded.mediation).not.toHaveProperty('note');
    expect(decoded.mediation?.subject).not.toHaveProperty('note');
    expect(() =>
      readPermissionDecisionRowV1({
        ...row,
        mediation_json: JSON.stringify({ ...mediation, stage: 'unknown' }),
      })
    ).toThrow();
  });

  it('refuses missing and unknown markers before interpreting mediated JSON', () => {
    const row = {
      ...decisionRow,
      subject_summary_json: 'not JSON',
      resource_summary_json: 'not JSON',
      context_summary_json: 'not JSON',
      mediation_json: 'not JSON',
    };
    for (const schema_version of [undefined, 0, 2]) {
      expect(() => readPermissionDecisionRowV1({ ...row, schema_version })).toThrow(
        'Unsupported retained record format.'
      );
      expect(() =>
        readAuditEventRowV1({
          ...auditRow,
          schema_version,
          actor_json: 'not JSON',
          policy_invocation_json: 'not JSON',
        })
      ).toThrow('Unsupported retained record format.');
    }
  });

  it('refuses missing and unknown markers before decoding either family JSON', () => {
    for (const schema_version of [undefined, 2]) {
      expect(() =>
        readPermissionDecisionRowV1({
          ...decisionRow,
          schema_version,
          subject_summary_json: 'not JSON',
        })
      ).toThrow('Unsupported retained record format.');
      expect(() =>
        readAuditEventRowV1({
          ...auditRow,
          schema_version,
          actor_json: 'not JSON',
        })
      ).toThrow('Unsupported retained record format.');
    }
  });
});
