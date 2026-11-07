import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateAccess, type PolicyState } from '@openkit/policy-kernel';
import {
  type PolicyBindingV1,
  PolicyDelegationV1Schema,
  type PolicyDocumentV1,
} from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as audit from '../audit-events.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openUserDb, openWorkspaceDb, type UserDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { withHumanMcpApproval } from '../test-support/mcp-tool-policy.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import { PolicyInterception } from './interception.js';
import { selectMcpToolPermissions } from './mcp-tool-permissions.js';
import {
  listExportableWorkspacePermissionDecisions,
  policyStatementUsedByDecision,
  readPolicyStatementUseCount,
} from './permission-decisions.js';
import { readPermissionDecisionRowV1 } from './retained-records-v1.js';
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
  workspaceId,
  capabilityCallId: 'cap_00000000-0000-7000-8000-000000000001',
  resource: {
    kind: 'mcp-tool' as const,
    workspaceId: workspaceId,
    serverId: 'issues',
    toolName: 'read',
  },
  inputReferences: {
    argumentsDigest: policyDigest({ issue: 1 }),
    catalogRevision: 'catalog-fixture',
    packageSnapshotId: 'package-fixture',
    schemaDigest: null,
  },
  inputAttributes: {},
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
    mode,
    participant: { kind: 'deterministic', id: 'test', version: participantVersion },

    inputDisclosure: scope,
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
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});
function fixture(bindings: PolicyDocumentV1['statements']) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-policy-interception-'));
  const workspaceDb = openWorkspaceDb(root, workspaceId);
  cleanup.push(() => {
    workspaceDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
  const document: PolicyDocumentV1 = { schemaVersion: 1, statements: bindings };
  return {
    workspaceDb,
    document,
    proposal,
    resourceSummary: { serverId: 'issues', toolName: 'read' },
    contextSummary: {
      packageSnapshotId: proposal.inputReferences.packageSnapshotId,
      catalogRevision: proposal.inputReferences.catalogRevision,
    },
    authorizationRevision: policyDigest({ member: userId }),
    authorCurrent: () => true,
    anchorCurrent: () => true,
    participantAuthorized: () => true,
    stillCurrent: () => true,
    finalKernel: () => kernel(),
  };
}

describe('bounded native Policy pipeline', () => {
  it('consumes a finite admitted authorization in the existing final decision transaction', async () => {
    const finite = PolicyDelegationV1Schema.parse({
      id: 'goal-domain',
      kind: 'delegation',
      purpose: 'goal-domain',
      state: 'active',
      author: principal,
      authority: { kind: 'human', userId },
      authoredAt: '2026-10-18T00:00:00Z',
      delegate: { kind: 'agent', id: 'goal-coordinator' },
      source: {
        workspaceId,
        goalId: 'goal',
        planVersionId: 'plan',
        planDigest: policyDigest('plan'),
        approvalRequestId: 'approval',
      },
      scope: { ...scope, subjects: [{ kind: 'agent', id: 'worker' }] },
      lifetime: {
        anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'goal', id: 'goal' },
        uses: 1,
      },
    });
    const input = fixture([finite]);
    await openTestNativeWorkspace(input.workspaceDb);
    const statement = { id: finite.id, digest: policyDigest(finite) };
    const evaluation = {
      ...input,
      proposal: {
        ...proposal,
        subject: { ...proposal.subject, principal: { kind: 'agent', id: 'worker' } },
      },
      authorizationUses: [{ statement, limit: 1 }],
    };
    const pipeline = new PolicyInterception();
    expect(
      (await pipeline.decide({ ...evaluation, finalKernel: () => kernel(false) })).result
    ).toBe('deny');
    expect(readPolicyStatementUseCount(input.workspaceDb, statement)).toBe(0);
    const decision = await pipeline.decide(evaluation);
    expect(decision.result).toBe('allow');
    expect(readPolicyStatementUseCount(input.workspaceDb, statement)).toBe(1);
    expect(policyStatementUsedByDecision(input.workspaceDb, statement, decision)).toBe(true);
    expect(
      policyStatementUsedByDecision(input.workspaceDb, statement, {
        ...decision,
        proposalDigest: policyDigest('another-call'),
      })
    ).toBe(false);
    const beforeExhaustion = {
      decisions: listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId),
      audit: audit.listWorkspaceAuditEvents(input.workspaceDb, workspaceId),
    };
    await expect(pipeline.decide(evaluation)).rejects.toMatchObject({ commit: 'not-committed' });
    expect(readPolicyStatementUseCount(input.workspaceDb, statement)).toBe(1);
    expect({
      decisions: listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId),
      audit: audit.listWorkspaceAuditEvents(input.workspaceDb, workspaceId),
    }).toEqual(beforeExhaustion);
    expect(
      listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId).find(
        (row) => row.decisionId === decision.decisionId
      )?.mediation?.consumedStatements
    ).toEqual([statement]);
    input.workspaceDb.sqlite
      .prepare('DELETE FROM audit_events WHERE permission_decision_id = ?')
      .run(decision.decisionId);
    expect(policyStatementUsedByDecision(input.workspaceDb, statement, decision)).toBe(false);
  });

  it.each(['advise', 'transform'] as const)(
    'refuses active %s before disclosure until its safe output can be retained',
    async (mode) => {
      const input = fixture([binding('context', mode)]);
      const invoke = vi.fn(async () => ({ attributes: { risk: 'reviewed' } }));
      const finalKernel = vi.fn(() => kernel());
      await expect(
        new PolicyInterception({ id: 'test', version: participantVersion, invoke }).decide({
          ...input,
          finalKernel,
        })
      ).rejects.toThrow(/safe participant output reference/);
      expect(invoke).not.toHaveBeenCalled();
      expect(finalKernel).not.toHaveBeenCalled();
      expect(listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId)).toEqual(
        []
      );
    }
  );

  it('retains ordered gates before the real final Kernel deny', async () => {
    const input = fixture([binding('second'), { ...binding('first'), order: 1 }]);
    const order: string[] = [];
    const pipeline = new PolicyInterception({
      id: 'test',
      version: participantVersion,
      invoke: async ({ binding: current, advice }) => {
        order.push(current.id);
        expect(advice).toEqual([]);
        return { decision: 'allow' };
      },
    });
    const result = await pipeline.decide({
      ...input,
      finalKernel: ({ advice }) => {
        order.push('kernel');
        expect(advice).toEqual([]);
        return kernel(false);
      },
    });
    expect(order).toEqual(['second', 'first', 'kernel']);
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
        invocations: [{ kind: 'decision' }, { kind: 'decision' }],
      },
    });
    const events = audit.listWorkspaceAuditEvents(input.workspaceDb, workspaceId);
    expect(events.filter((event) => event.policyInvocation?.mode === 'gate')).toHaveLength(2);
  });

  it.each([false, true])(
    'exports actual matched Kernel IDs for final decisions with prohibited=%s',
    async (prohibited) => {
      const input = fixture([binding('review')]);
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
        operations: [{ id: 'tool.use', accessRights: ['tool-use', 'tool-review'] }],
        associations: [
          {
            id: 'grant:use',
            userAttribute: 'ua',
            targetAttribute: 'oa',
            accessRights: ['tool-use'],
          },
          {
            id: 'grant:review',
            userAttribute: 'ua',
            targetAttribute: 'oa',
            accessRights: ['tool-review'],
          },
        ],
        prohibitions: prohibited
          ? [
              {
                id: 'deny:use',
                kind: 'user',
                subject: 'u',
                accessRights: ['tool-use'],
                range: { type: 'disjunctive', include: ['oa'] },
              },
              {
                id: 'deny:review',
                kind: 'user',
                subject: 'u',
                accessRights: ['tool-review'],
                range: { type: 'disjunctive', include: ['oa'] },
              },
            ]
          : [],
      };
      const pipeline = new PolicyInterception({
        id: 'test',
        version: participantVersion,
        invoke: async () => ({ decision: 'allow' }),
      });
      const result = await pipeline.decide({
        ...input,
        finalKernel: () =>
          evaluateAccess(policy, { user: 'u', operation: 'tool.use', target: 'o' }),
      });
      expect(result.result).toBe(prohibited ? 'deny' : 'allow');
      const rows = listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId);
      expect(rows).toHaveLength(2);
      const gate = rows.find((row) => row.mediation?.role === 'gate')!;
      const final = rows.find((row) => row.decisionId === result.decisionId)!;
      expect(gate.result).toBe('allow');
      expect(gate.contextSummary).not.toHaveProperty('kernelTrace');
      expect(final.contextSummary).toEqual({
        capabilityCallId: proposal.capabilityCallId,
        packageSnapshotId: proposal.inputReferences.packageSnapshotId,
        catalogRevision: proposal.inputReferences.catalogRevision,
        threadId: proposal.subject.process!.threadId,
        turnId: proposal.subject.process!.turnId,
        kernelTrace: {
          matchedAssociations: ['grant:use', 'grant:review'],
          matchedProhibitions: prohibited ? ['deny:use', 'deny:review'] : [],
        },
      });
      expect(final).toMatchObject({
        policyEngineVersion: 'nanocore-policy:v1',
        policySnapshotId: policyDigest(input.document),
        result: prohibited ? 'deny' : 'allow',
        reasonCode: prohibited ? 'prohibited' : 'granted',
        mediation: {
          authorizationRevision: input.authorizationRevision,
          kernel: {
            effect: prohibited ? 'deny' : 'allow',
            reason: prohibited ? 'restriction' : 'association-grant',
          },
        },
      });
      const events = audit.listWorkspaceAuditEvents(input.workspaceDb, workspaceId);
      expect(events).toHaveLength(2);
      expect(events.find((event) => event.id === final.auditEventId)).toMatchObject({
        permissionDecisionId: final.decisionId,
        action: 'permission.decision',
        outcome: prohibited ? 'denied' : 'succeeded',
      });
    }
  );

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
    expect(
      listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId).every(
        (row) => !Object.hasOwn(row.contextSummary as object, 'kernelTrace')
      )
    ).toBe(true);
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

  it('rechecks the current Policy approval against the exact logical proposal and revisions', async () => {
    const base = fixture([]);
    const document = withHumanMcpApproval(base);
    const input = {
      ...base,
      document,
      permissions: selectMcpToolPermissions({
        document,
        proposal: { ...proposal, serverId: 'issues', toolName: 'read' },
        authorCurrent: base.authorCurrent,
      }),
    };
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
    const input = fixture([binding('context')]);
    await openTestNativeWorkspace(input.workspaceDb);
    const finalKernel = vi.fn(() => kernel());
    // The native owner must roll back the gate decision if its required Audit insert fails.
    input.workspaceDb.sqlite.exec(`
      CREATE TRIGGER reject_interception_permission_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'permission.decision'
      BEGIN
        SELECT RAISE(ABORT, 'injected participant audit failure');
      END
    `);
    const invoke = vi.fn(async () => ({ decision: 'allow' }));
    const pipeline = new PolicyInterception({
      id: 'test',
      version: participantVersion,
      invoke,
    });
    await expect(pipeline.decide({ ...input, finalKernel })).rejects.toMatchObject({
      commit: 'not-committed',
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(finalKernel).not.toHaveBeenCalled();
    expect(listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId)).toEqual([]);
    expect(audit.listWorkspaceAuditEvents(input.workspaceDb, workspaceId)).toEqual([]);
  });
});

// The User consent phase reuses the registered operation and SAME interception owner before its Workspace effect.
describe('User-owned Policy interception', () => {
  const resource = {
    kind: 'container' as const,
    container: { kind: 'user' as const, id: userId, owner: { kind: 'user' as const, userId } },
  };
  const userScope = { subjects: [principal], actions: ['vault.use'], resources: [resource] };

  /** The caller maps the existing Vault action into the real pure Kernel. */
  function userKernel(allow = true) {
    return evaluateAccess(
      {
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
        operations: [{ id: 'vault.use', accessRights: ['vault-use'] }],
        associations: allow
          ? [
              {
                id: 'owner-consent',
                userAttribute: 'ua',
                targetAttribute: 'oa',
                accessRights: ['vault-use'],
              },
            ]
          : [],
      },
      { user: 'u', operation: 'vault.use', target: 'o' }
    );
  }

  /** Uses a real User journal and current owner predicates, with no surrogate Workspace. */
  function userFixture(statements: PolicyDocumentV1['statements'], agent = false) {
    const root = mkdtempSync(join(tmpdir(), 'openkit-user-interception-'));
    const userDb = openUserDb(root, userId);
    cleanup.push(() => {
      userDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyScopedMigrations(userDb);
    userDb.sqlite.pragma('query_only = ON');
    const userProposal: PolicyProposal = {
      operation: 'vault.binding-replace',
      workspaceId: null,
      capabilityCallId: agent ? proposal.capabilityCallId : null,
      resource,
      inputReferences: {},
      inputAttributes: {},
      subject: agent
        ? proposal.subject
        : {
            principal,
            onBehalfOf: null,
            actor: { kind: 'user', id: userId },
            process: null,
            credentialKind: 'local',
            responsibleHumanId: userId,
          },
    };
    return {
      userDb,
      document: { schemaVersion: 1 as const, statements },
      proposal: userProposal,
      resourceSummary: resource,
      authorizationRevision: policyDigest({ userId, active: true }),
      authorCurrent: (authorId: string) => authorId === userId,
      anchorCurrent: (anchor: PolicyBindingV1['lifetime']['anchor']) =>
        anchor.owner.kind === 'user' &&
        anchor.owner.userId === userId &&
        anchor.kind === 'user' &&
        anchor.id === userId,
      participantAuthorized: () => true,
      stillCurrent: () => true,
      finalKernel: () => userKernel(),
    };
  }

  /** Authorizes only this exact User container at the existing operation/stage point. */
  function userBinding(id: string, mode: 'gate' | 'observe' = 'gate'): PolicyBindingV1 {
    return {
      ...binding(id, mode),
      operation: 'vault.binding-replace',
      scope: userScope,
      inputDisclosure: userScope,
      lifetime: { anchor: { owner: { kind: 'user', userId }, kind: 'user', id: userId } },
      failure: mode === 'gate' ? 'error' : 'continue',
    };
  }

  /** Observes retained identity and linkage; the pre-extension baseline needs no missing export. */
  function userDecisions(userDb: UserDb) {
    return userDb.sqlite
      .prepare('SELECT * FROM permission_decisions ORDER BY decision_id')
      .all()
      .map(readPermissionDecisionRowV1);
  }

  it.each(['deny', 'allow'] as const)(
    'retains the User gate %s and final Kernel with atomic linked User Audit',
    async (gateResult) => {
      const input = userFixture([userBinding('owner-consent')]);
      const finalKernel = vi.fn(() => userKernel());
      const invoke = vi.fn(async (_invocation: { proposal: PolicyProposal }) => ({
        decision: gateResult,
      }));
      const pipeline = new PolicyInterception({ id: 'test', version: participantVersion, invoke });
      const result = await pipeline.decide({ ...input, finalKernel });
      expect(result.result).toBe(gateResult);
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke.mock.calls[0]![0].proposal).toEqual(input.proposal);
      expect(finalKernel).toHaveBeenCalledOnce();
      const rows = userDecisions(input.userDb);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.ownerScope === 'user' && row.workspaceId === null)).toBe(true);
      expect(rows.find((row) => row.mediation?.role === 'gate')).toMatchObject({
        result: gateResult,
        resourceSummary: resource,
        mediation: {
          operation: 'vault.binding-replace',
          role: 'gate',
          subject: input.proposal.subject,
        },
      });
      expect(rows.find((row) => row.decisionId === result.decisionId)).toMatchObject({
        result: gateResult,
        policySnapshotId: policyDigest(input.document),
        mediation: {
          kernel: { effect: 'allow' },
          role: 'final',
          consumedStatements: [],
          subject: input.proposal.subject,
          invocations: [{ kind: 'decision' }],
        },
      });
      const events = audit.listSqliteAuditEvents(input.userDb.sqlite);
      expect(events).toHaveLength(2);
      for (const row of rows) {
        expect(events.find((event) => event.id === row.auditEventId)).toMatchObject({
          permissionDecisionId: row.decisionId,
          workspaceId: null,
          action: 'permission.decision',
        });
      }
      expect(events.find((event) => event.policyInvocation)).toMatchObject({
        policyInvocation: {
          operation: 'vault.binding-replace',
          mode: 'gate',
          outcome: 'completed',
          subject: input.proposal.subject,
        },
      });
    }
  );

  it('keeps Workspace agent process lineage descriptive on a User decision and completed observation', async () => {
    const input = userFixture([userBinding('completed', 'observe')], true);
    const invoke = vi.fn(async () => ({ observed: true }));
    const pipeline = new PolicyInterception({ id: 'test', version: participantVersion, invoke });
    const settled = await pipeline.decide(input);
    expect(settled.result).toBe('allow');
    const before = userDecisions(input.userDb);
    await pipeline.observe(input);
    expect(userDecisions(input.userDb)).toEqual(before);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      ownerScope: 'user',
      workspaceId: null,
      mediation: { subject: proposal.subject },
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(audit.listSqliteAuditEvents(input.userDb.sqlite)).toHaveLength(2);
    expect(
      audit.listSqliteAuditEvents(input.userDb.sqlite).find((event) => event.policyInvocation)
    ).toMatchObject({
      workspaceId: null,
      threadId: proposal.subject.process!.threadId,
      turnId: proposal.subject.process!.turnId,
      policyInvocation: {
        mode: 'observe',
        operation: 'vault.binding-replace',
        outcome: 'completed',
        subject: proposal.subject,
      },
    });
  });

  it.each(['author', 'anchor'] as const)(
    'does not disclose User input after current %s authority is lost',
    async (lost) => {
      const input = userFixture([userBinding('current-owner')]);
      const invoke = vi.fn(async () => ({ decision: 'allow' }));
      const pipeline = new PolicyInterception({ id: 'test', version: participantVersion, invoke });
      const result = await pipeline.decide({
        ...input,
        authorCurrent: () => lost !== 'author',
        anchorCurrent: () => lost !== 'anchor',
        stillCurrent: () => false,
        finalKernel: () => userKernel(false),
      });
      expect(result.result).toBe('error');
      expect(invoke).not.toHaveBeenCalled();
      expect(userDecisions(input.userDb)).toMatchObject([
        {
          decisionId: result.decisionId,
          ownerScope: 'user',
          workspaceId: null,
          result: 'error',
          mediation: { role: 'final', consumedStatements: [], invocations: [] },
        },
      ]);
    }
  );

  it.each(['foreign-user', 'contradictory-owner', 'workspace-resource'] as const)(
    'refuses %s before User participant disclosure or allowing publication',
    async (mismatch) => {
      const input = userFixture([userBinding('exact-owner')]);
      const foreignId = 'usr_00000000-0000-7000-8000-000000000002';
      const actualResource: PolicyProposal['resource'] =
        mismatch === 'workspace-resource'
          ? {
              kind: 'container',
              container: {
                kind: 'workspace',
                id: workspaceId,
                owner: { kind: 'workspace', workspaceId },
              },
            }
          : {
              kind: 'container',
              container: {
                kind: 'user',
                id: foreignId,
                owner: { kind: 'user', userId: mismatch === 'foreign-user' ? foreignId : userId },
              },
            };
      const invoke = vi.fn(async () => ({ decision: 'allow' }));
      const finalKernel = vi.fn(() => userKernel());
      const pipeline = new PolicyInterception({ id: 'test', version: participantVersion, invoke });
      await expect(
        pipeline.decide({
          ...input,
          finalKernel,
          proposal: { ...input.proposal, resource: actualResource },
        })
      ).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
      expect(finalKernel).not.toHaveBeenCalled();
      expect(userDecisions(input.userDb)).toEqual([]);
      expect(audit.listSqliteAuditEvents(input.userDb.sqlite)).toEqual([]);
    }
  );

  it('does not release a User gate result when its required native Audit fails', async () => {
    const input = userFixture([userBinding('required-evidence')]);
    input.userDb.sqlite.pragma('query_only = OFF');
    input.userDb.sqlite.exec(`CREATE TRIGGER reject_user_interception_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'permission.decision' BEGIN
      SELECT RAISE(ABORT, 'injected User participant Audit failure'); END`);
    input.userDb.sqlite.pragma('query_only = ON');
    const invoke = vi.fn(async () => ({ decision: 'allow' }));
    const finalKernel = vi.fn(() => userKernel());
    const pipeline = new PolicyInterception({ id: 'test', version: participantVersion, invoke });
    await expect(pipeline.decide({ ...input, finalKernel })).rejects.toMatchObject({
      commit: 'not-committed',
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(finalKernel).not.toHaveBeenCalled();
    expect(userDecisions(input.userDb)).toEqual([]);
    expect(audit.listSqliteAuditEvents(input.userDb.sqlite)).toEqual([]);
  });

  it.each(['foreign-user', 'workspace-proposal', 'contradictory-owner'] as const)(
    'refuses a completed %s under the actual User database before disclosure or evidence',
    async (mismatch) => {
      const input = userFixture([userBinding('completed-owner', 'observe')]);
      const otherUserId = 'usr_00000000-0000-7000-8000-000000000002';
      const otherDb = openUserDb(input.userDb.dataRoot, otherUserId);
      try {
        applyScopedMigrations(otherDb);
        otherDb.sqlite.pragma('query_only = ON');
        const invoke = vi.fn(async () => ({ observed: true }));
        const pipeline = new PolicyInterception({
          id: 'test',
          version: participantVersion,
          invoke,
        });
        let observation: Parameters<PolicyInterception['observe']>[0] = {
          ...input,
          userDb: otherDb,
        };
        if (mismatch === 'workspace-proposal') {
          const { workspaceDb: _workspaceDb, ...workspaceObservation } = fixture([
            binding('workspace-completed', 'observe'),
          ]);
          observation = { ...workspaceObservation, userDb: otherDb };
        }
        if (mismatch === 'contradictory-owner')
          observation = {
            ...observation,
            proposal: {
              ...input.proposal,
              resource: {
                kind: 'container',
                container: {
                  kind: 'user',
                  id: userId,
                  owner: { kind: 'user', userId: otherUserId },
                },
              },
            },
          };
        await expect(pipeline.observe(observation)).rejects.toThrow();
        expect(invoke).not.toHaveBeenCalled();
        expect(userDecisions(input.userDb)).toEqual([]);
        expect(userDecisions(otherDb)).toEqual([]);
        expect(audit.listSqliteAuditEvents(input.userDb.sqlite)).toEqual([]);
        expect(audit.listSqliteAuditEvents(otherDb.sqlite)).toEqual([]);
      } finally {
        otherDb.sqlite.close();
      }
    }
  );

  it('preserves an original User settlement when a completed observation presents another actual User owner', async () => {
    const input = userFixture([userBinding('settled-owner', 'observe')]);
    const otherDb = openUserDb(input.userDb.dataRoot, 'usr_00000000-0000-7000-8000-000000000002');
    try {
      applyScopedMigrations(otherDb);
      otherDb.sqlite.pragma('query_only = ON');
      const invoke = vi.fn(async () => ({ observed: true }));
      const pipeline = new PolicyInterception({ id: 'test', version: participantVersion, invoke });
      const settled = await pipeline.decide(input);
      expect(settled.result).toBe('allow');
      const original = { ...settled };
      const decisions = userDecisions(input.userDb);
      const events = audit.listSqliteAuditEvents(input.userDb.sqlite);
      expect(decisions).toHaveLength(1);
      expect(events).toHaveLength(1);
      await expect(pipeline.observe({ ...input, userDb: otherDb })).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
      expect(settled).toEqual(original);
      expect(userDecisions(input.userDb)).toEqual(decisions);
      expect(audit.listSqliteAuditEvents(input.userDb.sqlite)).toEqual(events);
      expect(userDecisions(otherDb)).toEqual([]);
      expect(audit.listSqliteAuditEvents(otherDb.sqlite)).toEqual([]);
    } finally {
      otherDb.sqlite.close();
    }
  });
});

// The trusted approved-intent owner supplies lineage; interception does not invent a Policy approval source.
describe('approved command lineage through the real mediated recorder', () => {
  it.each(['workspace', 'user'] as const)(
    'preserves exact existing identifiers and safe context in the %s native tuple',
    async (home) => {
      const requestId = '00000000-0000-4000-8000-000000000041';
      const requesterId = 'usr_00000000-0000-7000-8000-000000000002';
      const threadId = 'th_00000000-0000-7000-8000-000000000041';
      const turnId = 'tu_00000000-0000-7000-8000-000000000041';
      const contextSummary = {
        requestId,
        approvalRequestId: requestId,
        threadId,
        turnId,
        issuingActorId: userId,
        requesterId,
      };
      const resource =
        home === 'user'
          ? {
              kind: 'container' as const,
              container: {
                kind: 'user' as const,
                id: userId,
                owner: { kind: 'user' as const, userId },
              },
            }
          : {
              kind: 'container' as const,
              container: {
                kind: 'workspace' as const,
                id: workspaceId,
                owner: { kind: 'workspace' as const, workspaceId },
              },
            };
      const approvedProposal: PolicyProposal = {
        operation: 'vault.grant-issue',
        workspaceId: home === 'user' ? null : workspaceId,
        capabilityCallId: null,
        resource,
        inputReferences: {},
        inputAttributes: {},
        subject: {
          principal,
          onBehalfOf: null,
          actor: { kind: 'user', id: userId },
          process: null,
          credentialKind: 'local',
          responsibleHumanId: userId,
        },
      };
      const base = fixture([]);
      let userDb: UserDb | undefined;
      if (home === 'user') {
        userDb = openUserDb(base.workspaceDb.dataRoot, userId);
        applyScopedMigrations(userDb);
        userDb.sqlite.pragma('query_only = ON');
        const ownedUserDb = userDb;
        cleanup.unshift(() => ownedUserDb.sqlite.close());
      }
      const facts = {
        document: base.document,
        proposal: approvedProposal,
        authorizationRevision: base.authorizationRevision,
        resourceSummary: { referenceId: 'vault_00000000-0000-7000-8000-000000000041' },
        contextSummary,
        // These are existing retained request/approval fields, not an invented humanApproval binding.
        decisionLineage: { requestId, approvalId: requestId },
        authorCurrent: base.authorCurrent,
        anchorCurrent: base.anchorCurrent,
        participantAuthorized: base.participantAuthorized,
        stillCurrent: base.stillCurrent,
        finalKernel: () =>
          evaluateAccess(
            {
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
              operations: [{ id: 'vault.admin', accessRights: ['vault-admin'] }],
              associations: [
                {
                  id: 'current-issuer',
                  userAttribute: 'ua',
                  targetAttribute: 'oa',
                  accessRights: ['vault-admin'],
                },
              ],
            },
            { user: 'u', operation: 'vault.admin', target: 'o' }
          ),
      };
      const input = userDb ? { ...facts, userDb } : { ...facts, workspaceDb: base.workspaceDb };
      const result = await new PolicyInterception().decide(input);
      expect(result.result).toBe('allow');
      const ownerDb = userDb ?? base.workspaceDb;
      const rows = ownerDb.sqlite
        .prepare('SELECT * FROM permission_decisions')
        .all()
        .map(readPermissionDecisionRowV1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        decisionId: result.decisionId,
        ownerScope: home,
        workspaceId: home === 'user' ? null : workspaceId,
        result: 'allow',
        reasonCode: 'granted',
        approvalId: requestId,
        policyEngineVersion: 'nanocore-policy:v1',
        policySnapshotId: policyDigest(base.document),
        enforcementPoint: 'vault.grant-issue@decide',
        contextSummary,
        subjectSummary: {
          principal,
          responsibleHumanId: userId,
          actor: { kind: 'user', id: userId },
          process: null,
        },
        mediation: {
          operation: 'vault.grant-issue',
          stage: 'decide',
          role: 'final',
          subject: approvedProposal.subject,
          kernel: { effect: 'allow' },
        },
      });
      expect(rows[0]!.contextSummary).not.toHaveProperty('humanApprovalRequestId');
      expect(rows[0]!.contextSummary).not.toHaveProperty('approvalSourceDecisionId');
      expect(rows[0]!.contextSummary).not.toHaveProperty('humanApprovalDeciderId');
      expect(audit.listSqliteAuditEvents(ownerDb.sqlite)).toMatchObject([
        {
          id: rows[0]!.auditEventId,
          permissionDecisionId: result.decisionId,
          requestId,
          threadId,
          turnId,
          actor: { kind: 'user', id: userId },
          action: 'permission.decision',
        },
      ]);
    }
  );
});
