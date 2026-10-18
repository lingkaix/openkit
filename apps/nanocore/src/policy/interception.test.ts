import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateAccess, type PolicyState } from '@openkit/policy-kernel';
import type { PolicyBindingV1, PolicyDocumentV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as audit from '../audit-events.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { PolicyInterception } from './interception.js';
import { listExportableWorkspacePermissionDecisions } from './permission-decisions.js';
import { type PolicyProposal, policyDigest } from './statements.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const principal = { kind: 'human' as const, id: userId };
const participantVersion = `sha256:${'1'.repeat(64)}`;
const scope = {
  subjects: [principal],
  actions: ['tool.use'],
  resources: [{ kind: 'mcp-tool' as const, workspaceId, serverId: 'issues', toolName: 'read' }],
};
const proposal: PolicyProposal = {
  operation: 'mcp.call-tool',
  catalogRevision: 'catalog-fixture',
  packageDigest: 'package-fixture',
  workspaceId,
  serverId: 'issues',
  toolName: 'read',
  argumentsDigest: policyDigest({ issue: 1 }),
  schemaDigest: null,
  capabilityCallId: 'cap_00000000-0000-7000-8000-000000000001',
  subject: {
    principal,
    onBehalfOf: null,
    actor: { kind: 'agent', id: 'worker', responsibleUserId: userId },
    process: {
      workspaceId,
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-7000-8000-000000000001',
    },
    credentialKind: 'worker-package',
    responsibleHumanId: userId,
  },
};
function binding(id: string, mode: PolicyBindingV1['mode'] = 'gate'): PolicyBindingV1 {
  return {
    id,
    kind: 'binding',
    author: principal,
    authority: { kind: 'human', userId },
    authoredAt: '2026-10-18T00:00:00Z',
    scope,
    lifetime: {
      anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'workspace', id: workspaceId },
    },
    state: 'active',
    operation: 'mcp.call-tool',
    stage: mode === 'gate' ? 'decide' : mode === 'observe' ? 'completed' : 'propose',
    point: `mcp.call-tool@${mode === 'gate' ? 'decide' : mode === 'observe' ? 'completed' : 'propose'}`,
    mode,
    participant: { kind: 'deterministic', id: 'test', version: participantVersion },
    inputContract: 'mcp-tool-summary-v1',
    inputDisclosure: scope,
    outputContract:
      mode === 'gate'
        ? 'gate-v1'
        : mode === 'advise'
          ? 'advice-v1'
          : mode === 'observe'
            ? 'observation-v1'
            : 'replacement-v1',
    order: 0,
    timeoutMs: 100,
    failure: 'escalate-to-human',
    circuit: { failures: 1, recoveryAfterMs: 60_000 },
  };
}
/** Uses the real pure Kernel for both allow and deny oracles. */
function kernel(allow = true, operation = 'tool.use') {
  const policy: PolicyState = {
    elements: [
      { id: 'u', kind: 'user' },
      { id: 'ua', kind: 'userAttribute' },
      { id: 'o', kind: 'object' },
      { id: 'oa', kind: 'objectAttribute' },
      { id: 'pc', kind: 'policyClass' },
    ],
    assignments: [
      { child: 'u', parent: 'ua' },
      { child: 'ua', parent: 'pc' },
      { child: 'o', parent: 'oa' },
      { child: 'oa', parent: 'pc' },
    ],
    operations: [{ id: 'tool.use', accessRights: ['tool-use'] }],
    associations: allow
      ? [{ id: 'grant', userAttribute: 'ua', targetAttribute: 'oa', accessRights: ['tool-use'] }]
      : [],
  };
  return evaluateAccess(policy, { user: 'u', operation, target: 'o' });
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});
function fixture(bindings: PolicyBindingV1[]) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-policy-interception-'));
  const workspaceDb = openWorkspaceDb(root, workspaceId);
  cleanup.push(() => {
    workspaceDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(workspaceDb);
  const document: PolicyDocumentV1 = { schemaVersion: 1, statements: bindings };
  return {
    workspaceDb,
    document,
    proposal,
    authorizationRevision: policyDigest({ member: userId }),
    authorCurrent: () => true,
    anchorCurrent: () => true,
    participantAuthorized: () => true,
    stillCurrent: () => true,
    finalKernel: () => kernel(),
  };
}

describe('bounded native Policy pipeline', () => {
  it('retains advice before ordered gates and the real final Kernel deny', async () => {
    const input = fixture([
      binding('second'),
      { ...binding('first'), order: 1 },
      binding('context', 'advise'),
    ]);
    const order: string[] = [];
    const pipeline = new PolicyInterception({
      id: 'test',
      version: participantVersion,
      invoke: async ({ binding: current, advice }) => {
        order.push(current.id);
        if (current.mode === 'advise') return { attributes: { risk: 'reviewed' } };
        expect(advice).toMatchObject([
          { binding: { id: 'context' }, attributes: { risk: 'reviewed' } },
        ]);
        return { decision: 'allow' };
      },
    });
    const result = await pipeline.decide({
      ...input,
      finalKernel: ({ advice }) => {
        order.push('kernel');
        expect(advice).toHaveLength(1);
        return kernel(false);
      },
    });
    expect(order).toEqual(['context', 'second', 'first', 'kernel']);
    expect(result.result).toBe('deny');
    const rows = listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId);
    expect(rows.filter((row) => row.mediation?.role === 'gate').map((row) => row.result)).toEqual([
      'allow',
      'allow',
    ]);
    expect(rows.find((row) => row.decisionId === result.decisionId)).toMatchObject({
      result: 'deny',
      mediation: {
        kernel: { effect: 'deny', reason: 'missing-privilege' },
        consumedStatements: [],
        invocations: [{ kind: 'audit' }, { kind: 'decision' }, { kind: 'decision' }],
      },
    });
    const events = audit.listWorkspaceAuditEvents(input.workspaceDb, workspaceId);
    expect(events.filter((event) => event.policyInvocation?.mode === 'gate')).toHaveLength(2);
    expect(events.filter((event) => event.policyInvocation?.mode === 'advise')).toHaveLength(1);
  });

  it('does not disclose a selected proposal outside the binding input scope', async () => {
    const guarded = binding('private-review');
    const other = { kind: 'human' as const, id: 'usr_00000000-0000-7000-8000-000000000002' };
    const input = fixture([
      {
        ...guarded,
        scope: { ...scope, subjects: [principal, other] },
        inputDisclosure: { ...scope, subjects: [other] },
      },
    ]);
    const invoke = vi.fn(async () => ({ decision: 'allow' }));
    const pipeline = new PolicyInterception({ id: 'test', version: participantVersion, invoke });
    expect((await pipeline.decide(input)).result).toBe('require_escalation');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('records timeout and open circuit as human escalation while preserving the actual Kernel allow', async () => {
    const input = fixture([{ ...binding('slow'), timeoutMs: 5 }]);
    const invoke = vi.fn(async () => new Promise<unknown>(() => {}));
    const pipeline = new PolicyInterception({ id: 'test', version: participantVersion, invoke });
    expect((await pipeline.decide(input)).result).toBe('require_escalation');
    expect((await pipeline.decide(input)).result).toBe('require_escalation');
    expect(invoke).toHaveBeenCalledTimes(1);
    const events = audit.listWorkspaceAuditEvents(input.workspaceDb, workspaceId);
    expect(
      events
        .flatMap((event) => (event.policyInvocation ? [event.policyInvocation.outcome] : []))
        .sort()
    ).toEqual(['open-circuit', 'timeout']);
    const finals = listExportableWorkspacePermissionDecisions(
      input.workspaceDb,
      workspaceId
    ).filter((row) => row.mediation?.role === 'final');
    expect(
      finals.every(
        (row) => row.result === 'require_escalation' && row.mediation?.kernel?.effect === 'allow'
      )
    ).toBe(true);
  });

  it('retains current-authority loss as an error with no invented Kernel result', async () => {
    const input = fixture([binding('gate')]);
    let current = true;
    const pipeline = new PolicyInterception({
      id: 'test',
      version: participantVersion,
      invoke: async () => {
        current = false;
        return { decision: 'allow' };
      },
    });
    const result = await pipeline.decide({
      ...input,
      stillCurrent: () => current,
      finalKernel: () => {
        throw new Error('Current membership was removed before evaluation.');
      },
    });
    expect(result.result).toBe('error');
    expect(
      listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId).find(
        (row) => row.decisionId === result.decisionId
      )
    ).toMatchObject({ result: 'error', mediation: { kernel: null, consumedStatements: [] } });
  });

  it('keeps a real Kernel configuration error distinct from a substantive denial', async () => {
    const input = fixture([]);
    const pipeline = new PolicyInterception();
    const result = await pipeline.decide({
      ...input,
      finalKernel: () => kernel(true, 'missing-operation'),
    });
    expect(result.result).toBe('error');
    expect(
      listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId).find(
        (row) => row.decisionId === result.decisionId
      )
    ).toMatchObject({
      result: 'error',
      reasonCode: 'evaluation_error',
      mediation: { kernel: { effect: 'deny', reason: 'missing-operation' } },
    });
  });

  it('rechecks the existing catalog approval against the exact logical proposal and revisions', async () => {
    const input = { ...fixture([]), requiresHumanApproval: true };
    const pipeline = new PolicyInterception();
    const pending = await pipeline.decide(input);
    expect(pending.result).toBe('require_approval');
    const approved = {
      ...input,
      humanApproval: {
        requestId: 'ap_catalog_fixture',
        sourceDecisionId: pending.decisionId,
        deciderId: userId,
        binding: {
          proposalDigest: pending.proposalDigest,
          policyRevision: pending.policyRevision,
          authorizationRevision: pending.authorizationRevision,
        },
      },
    };
    expect((await pipeline.decide(approved)).result).toBe('allow');
    expect(
      (await pipeline.decide({ ...approved, authorizationRevision: policyDigest('changed') }))
        .result
    ).toBe('require_approval');
    expect(
      listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId).find(
        (row) => row.decisionId === pending.decisionId
      )
    ).toMatchObject({
      result: 'require_approval',
      requiredApprovalKind: 'permission',
      reasonCode: 'require_approval',
      mediation: { kernel: { effect: 'allow' } },
    });
  });

  it('retains shadow denials and failed observations without changing the Kernel allow', async () => {
    const input = fixture([
      { ...binding('shadow'), state: 'shadow' },
      { ...binding('completed', 'observe'), failure: 'continue' },
    ]);
    const pipeline = new PolicyInterception({
      id: 'test',
      version: participantVersion,
      invoke: async ({ binding: current }) => {
        if (current.mode === 'observe') throw new Error('Observer unavailable.');
        return { decision: 'deny' };
      },
    });
    const result = await pipeline.decide(input);
    expect(result.result).toBe('allow');
    await pipeline.observe(input);
    const rows = listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId);
    expect(rows.find((row) => row.mediation?.role === 'gate')?.result).toBe('deny');
    expect(rows.find((row) => row.decisionId === result.decisionId)?.result).toBe('allow');
    expect(
      audit
        .listWorkspaceAuditEvents(input.workspaceDb, workspaceId)
        .find((event) => event.policyInvocation?.mode === 'observe')
    ).toMatchObject({ outcome: 'failed', policyInvocation: { outcome: 'error' } });
  });

  it('does not release participant output when required Audit evidence cannot be written', async () => {
    const input = fixture([binding('context', 'advise')]);
    const finalKernel = vi.fn(() => kernel());
    vi.spyOn(audit, 'recordWorkspaceAuditEvent').mockImplementation(() => {
      throw new Error('Audit write failed.');
    });
    const pipeline = new PolicyInterception({
      id: 'test',
      version: participantVersion,
      invoke: async () => ({ attributes: { risk: 'reviewed' } }),
    });
    await expect(pipeline.decide({ ...input, finalKernel })).rejects.toThrow('Audit write failed.');
    expect(finalKernel).not.toHaveBeenCalled();
  });
});
