import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ListServerPermissionDecisionsResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
} from '@openkit/app-api-schemas';
import { evaluateAccess } from '@openkit/policy-kernel';
import {
  allocateEntityId,
  canonicalIdentifierName,
  isEntityId,
  type PolicyDecisionV1,
  type PolicyInvocationV1,
} from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  listSqliteAuditEvents,
  listWorkspaceAuditEvents,
  recordWorkspaceAuditEvent,
} from '../audit-events.js';

import { loadBootPolicyKernel } from '../bootstrap/policy.js';
import {
  ControlStoreWorkerError,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openUserDb, openWorkspaceDb, type UserDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  armBootSecondDecisionEntropyFailure,
  releaseBootEntropyFailure,
} from '../test-support/control-native-transport.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import * as permissionDecisions from './permission-decisions.js';
import {
  listExportableWorkspacePermissionDecisions,
  listPolicyApprovalSourceDecisions,
  listServerPermissionDecisions,
  readPolicyStatementUseCount,
  recordBootPolicySelfCheckDecisions,
  recordPermissionDecision,
  recordProductPermissionDecision,
} from './permission-decisions.js';
import { readPermissionDecisionRowV1, retainPermissionDecision } from './retained-records-v1.js';

// Keep the real native owner and entry; only the selected allocation is faulted in its thread.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  return { ...actual, Worker: nativeCommitWorker(actual.Worker) };
});

describe('permission decision recorder', () => {
  it('roundtrips mediation and atomically consumes only final Workspace allows', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-policy-consumption-'));
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    const digest = `sha256:${'a'.repeat(64)}`;
    const statement = { id: 'once-review', digest };
    const userId = 'usr_00000000-0000-7000-8000-000000000001';
    const threadId = 'th_00000000-0000-7000-8000-000000000001';
    const turnId = 'tu_00000000-0000-7000-8000-000000000001';
    const capabilityCallId = 'cap_00000000-0000-7000-8000-000000000001';
    const mediation: PolicyDecisionV1 = {
      operation: 'mcp.call-tool',
      stage: 'decide',
      authorizationRevision: digest,
      proposalDigest: digest,
      role: 'final',
      kernel: { effect: 'allow', reason: 'granted' },
      subject: {
        principal: { kind: 'human', id: userId },
        onBehalfOf: null,
        actor: { kind: 'agent', id: 'worker', responsibleUserId: userId },
        process: { workspaceId, threadId, turnId },
        credentialKind: 'worker-package',
        responsibleHumanId: userId,
      },
      invocations: [],
      consumedStatements: [],
    };
    const base = {
      workspaceDb,
      workspaceId,
      ownerScope: 'workspace' as const,
      policyEngineVersion: 'fixture:v1',
      policySnapshotId: digest,
      subjectSummary: {},
      action: 'tool.use',
      resourceSummary: {},
      contextSummary: { threadId, turnId, capabilityCallId },
      reasonCode: 'granted',
      enforcementPoint: 'mcp.call-tool@decide',
    };
    const policyInvocation: PolicyInvocationV1 = {
      binding: statement,
      operation: mediation.operation,
      stage: mediation.stage,
      mode: 'gate',
      policyRevision: digest,
      authorizationRevision: digest,
      proposalDigest: digest,
      subject: mediation.subject,
      participant: { id: 'fixture', version: digest },
      inputDigest: digest,
      outputDigest: digest,
      outcome: 'completed' as const,
      startedAt: '2026-10-18T00:00:00Z',
      completedAt: '2026-10-18T00:00:01Z',
      capabilityCallId,
    };
    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await openTestNativeWorkspace(workspaceDb);
      const gateId = allocateEntityId('pd');
      await recordProductPermissionDecision({
        ...base,
        decisionId: gateId,
        result: 'allow',
        mediation: { ...mediation, role: 'gate', binding: statement, kernel: undefined },
        policyInvocation,
      });
      await expect(
        async () =>
          await recordProductPermissionDecision({
            ...base,
            decisionId: allocateEntityId('pd'),
            result: 'deny',
            mediation: { ...mediation, kernel: null },
          })
      ).rejects.toThrow();
      await recordProductPermissionDecision({
        ...base,
        decisionId: allocateEntityId('pd'),
        result: 'error',
        mediation: { ...mediation, kernel: null },
      });
      await recordProductPermissionDecision({
        ...base,
        decisionId: allocateEntityId('pd'),
        result: 'deny',
        mediation: { ...mediation, kernel: { effect: 'deny', reason: 'prohibited' } },
      });
      expect(readPolicyStatementUseCount(workspaceDb, statement)).toBe(0);
      const final = {
        ...base,
        decisionId: allocateEntityId('pd'),
        result: 'allow' as const,
        mediation: { ...mediation, consumedStatements: [statement] },
        uses: [{ statement, limit: 1 }],
      };
      await expect(
        async () =>
          await recordProductPermissionDecision({ ...final, policySnapshotId: 'mutable-label' })
      ).rejects.toThrow();
      await expect(
        async () =>
          await recordProductPermissionDecision({ ...final, enforcementPoint: 'wrong@decide' })
      ).rejects.toThrow();
      await expect(
        async () =>
          await recordProductPermissionDecision({
            ...final,
            workspaceId: 'ws_00000000-0000-7000-8000-000000000002',
          })
      ).rejects.toThrow();
      await recordProductPermissionDecision(final);
      expect(readPolicyStatementUseCount(workspaceDb, statement)).toBe(1);
      const decisions = listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId);
      const audits = listWorkspaceAuditEvents(workspaceDb, workspaceId);
      expect(decisions).toHaveLength(4);
      expect(
        decisions.find(({ decisionId }) => decisionId === final.decisionId)?.mediation
      ).toEqual(final.mediation);
      expect(audits).toHaveLength(4);
      expect(audits.every((event) => event.capabilityCallId === capabilityCallId)).toBe(true);
      expect(
        audits.find((event) => event.permissionDecisionId === gateId)?.policyInvocation
      ).toEqual(policyInvocation);
      expect(
        audits.find((event) => event.permissionDecisionId === final.decisionId)
      ).not.toHaveProperty('policyInvocation');
      await expect(
        async () =>
          await recordProductPermissionDecision({
            ...base,
            decisionId: allocateEntityId('pd'),
            result: 'allow',
            mediation,
            policyInvocation,
          })
      ).rejects.toThrow();
      await expect(
        async () =>
          await recordProductPermissionDecision({
            ...base,
            decisionId: allocateEntityId('pd'),
            result: 'allow',
            mediation: { ...mediation, role: 'gate', binding: statement, kernel: undefined },
            policyInvocation: { ...policyInvocation, proposalDigest: `sha256:${'c'.repeat(64)}` },
          })
      ).rejects.toThrow();
      const nextRevision = `sha256:${'b'.repeat(64)}`;
      await expect(
        async () =>
          await recordProductPermissionDecision({
            ...final,
            decisionId: allocateEntityId('pd'),
            policySnapshotId: nextRevision,
            mediation: final.mediation,
          })
      ).rejects.toThrow();
      expect(readPolicyStatementUseCount(workspaceDb, statement)).toBe(1);
      expect(listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId)).toEqual(
        decisions
      );
      expect(listWorkspaceAuditEvents(workspaceDb, workspaceId)).toEqual(audits);
      const raw = workspaceDb.sqlite
        .prepare('SELECT * FROM permission_decisions WHERE decision_id=?')
        .get(final.decisionId) as Record<string, unknown>;
      expect(raw.subject_summary_json).toBe('null');
      expect(raw.enforcement_point).toBe('');
      expect(raw.policy_snapshot_id).toBe(digest);
      expect(JSON.parse(String(raw.mediation_json))).not.toHaveProperty('point');
      expect(JSON.parse(String(raw.mediation_json))).not.toHaveProperty('policyRevision');
      const portable = decisions.map((decision) => retainPermissionDecision({ ...decision }));
      expect(portable[0]).not.toHaveProperty('subjectSummary');
      expect(portable[0]).not.toHaveProperty('enforcementPoint');

      const policyWriteOutcome = {
        candidate: { artifactId: 'ar_00000000-0000-7000-8000-000000000001', version: 1, digest },
        decider: { kind: 'human' as const, id: userId },
        decidedAt: '2026-10-18T00:00:00Z',
        approval: { proposalDigest: digest, policyRevision: digest, authorizationRevision: digest },
        validation: 'valid' as const,
        persistedRevision: digest,
        activeRevision: null,
        outcome: 'persisted' as const,
      };
      const event = recordWorkspaceAuditEvent({
        workspaceDb,
        workspaceId,
        action: 'policy.fixture',
        outcome: 'succeeded',
        summary: 'Policy evidence.',
        policyInvocation: { ...policyInvocation, mode: 'advise' },
        policyWriteOutcome,
      });
      expect(
        listWorkspaceAuditEvents(workspaceDb, workspaceId).find(({ id }) => id === event.id)
      ).toMatchObject({
        policyInvocation: { ...policyInvocation, mode: 'advise' },
        policyWriteOutcome,
      });
      expect(() =>
        recordWorkspaceAuditEvent({
          workspaceDb,
          workspaceId,
          action: 'policy.fixture',
          outcome: 'failed',
          summary: 'Invalid evidence.',
          policyInvocation: {
            ...policyInvocation,
            rawBody: 'unapproved body',
          } as PolicyInvocationV1,
        })
      ).toThrow();
      expect(listWorkspaceAuditEvents(workspaceDb, workspaceId)).toHaveLength(5);
      workspaceDb.sqlite
        .prepare(
          "UPDATE permission_decisions SET schema_version = 2, mediation_json = 'not JSON' WHERE decision_id = ?"
        )
        .run(final.decisionId);
      expect(() => readPolicyStatementUseCount(workspaceDb, statement)).toThrow(TypeError);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('checks an approval source marker before decoding authority facts', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-policy-record-version-'));
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await openTestNativeWorkspace(workspaceDb);
      await recordProductPermissionDecision({
        workspaceDb,
        workspaceId,
        ownerScope: 'workspace',
        decisionId: 'pd_00000000-0000-7000-8000-000000000001',
        policyEngineVersion: 'fixture:v1',
        policySnapshotId: 'fixture',
        subjectSummary: {},
        action: 'tool.use',
        resourceSummary: {},
        contextSummary: {},
        result: 'require_approval',
        requiredApprovalKind: 'tool',
        approvalId: 'fixture',
        reasonCode: 'require_approval',
        enforcementPoint: 'tool.use',
      });
      expect(listPolicyApprovalSourceDecisions(workspaceDb, workspaceId, 'fixture')).toHaveLength(
        1
      );
      workspaceDb.sqlite
        .prepare(
          "UPDATE permission_decisions SET schema_version = 2, subject_summary_json = 'not JSON'"
        )
        .run();
      expect(() => listPolicyApprovalSourceDecisions(workspaceDb, workspaceId, 'fixture')).toThrow(
        TypeError
      );
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each(['workspace', 'server'] as const)(
    'preserves ordinary fixture context in %s canonical writes, retained reads and public lists',
    async (ownerScope) => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-public-fixture-'));
      let coreDb = openCoreDb(dataRoot);
      let workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const contextSummary = { fixture: 'ghp_publicFixture sk-Latn', nested: ['hf_publicFixture'] };
      try {
        applyMigrations(coreDb);
        applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
        if (ownerScope === 'workspace') await openTestNativeWorkspace(workspaceDb);
        const recorded = await recordProductPermissionDecision({
          coreDb,
          workspaceDb,
          ownerScope,
          ...(ownerScope === 'workspace'
            ? { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' }
            : {}),
          decisionId: 'pd_00000000-0000-7765-a6ea-e9fc6f79d306',
          policyEngineVersion: 'test:v1',
          policySnapshotId: 'test_snapshot',
          subjectSummary: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          action: 'read',
          resourceSummary: { fixture: 'okt_publicFixture' },
          contextSummary,
          result: 'allow',
          reasonCode: 'allowed',
          enforcementPoint: 'test',
        });
        if (ownerScope === 'workspace') await recorded;
        await shutdownControlStoreWorkerClient();
        workspaceDb.sqlite.close();
        await shutdownControlStoreWorkerClient();
        coreDb.sqlite.close();
        coreDb = openCoreDb(dataRoot);
        workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
        const rows =
          ownerScope === 'workspace'
            ? listExportableWorkspacePermissionDecisions(
                workspaceDb,
                'ws_00000000-0000-7000-8000-000000000001'
              )
            : listServerPermissionDecisions(coreDb);
        const response =
          ownerScope === 'workspace'
            ? ListWorkspacePermissionDecisionsResponseSchema.parse({
                workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                permissionDecisions: rows,
              })
            : ListServerPermissionDecisionsResponseSchema.parse({ permissionDecisions: rows });
        expect(response.permissionDecisions[0]?.contextSummary).toEqual(contextSummary);
        expect(response.permissionDecisions[0]?.resourceSummary).toEqual({
          fixture: 'okt_publicFixture',
        });
      } finally {
        await shutdownControlStoreWorkerClient();
        workspaceDb.sqlite.close();
        await shutdownControlStoreWorkerClient();
        coreDb.sqlite.close();
      }
    }
  );

  it('retains all matched Kernel rule IDs through server list and Core reopen', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-'));
    let coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      const baseline = loadBootPolicyKernel().policy;
      const policy = {
        ...baseline,
        operations: baseline.operations.map((operation) =>
          operation.id === 'vault.use'
            ? { ...operation, accessRights: ['ar:vault-use', 'ar:vault-extra'] }
            : operation
        ),
        associations: [
          ...baseline.associations,
          {
            id: 'assoc:vault-extra',
            userAttribute: 'ua:core-process',
            targetAttribute: 'oa:vault-secrets',
            accessRights: ['ar:vault-extra'],
          },
        ],
        prohibitions: [
          ...baseline.prohibitions!,
          {
            ...baseline.prohibitions![0]!,
            id: 'deny:vault-extra',
            accessRights: ['ar:vault-extra'],
          },
        ],
      };
      const policyDecision = evaluateAccess(policy, {
        process: 'process:nanocore',
        operation: 'vault.use',
        target: 'object:baseline-vault-secret',
      });

      await recordPermissionDecision({
        coreDb,
        decisionId: 'pd_00000000-0000-7e76-af55-371b5a65dcf3',
        ownerScope: 'server',
        policyDecision,
        policyEngineVersion: 'policy-kernel:v1',
        policySnapshotId: `sha256:${'b'.repeat(64)}`,
        subjectSummary: { id: 'process:nanocore', kind: 'process' },
        action: 'vault.use',
        resourceSummary: { id: 'object:baseline-vault-secret', kind: 'vault-reference' },
        contextSummary: { boot: true },
        enforcementPoint: 'boot.policy.self_check',
        now: new Date('2026-07-05T00:00:00.000Z'),
      });

      const row = coreDb.sqlite
        .prepare('SELECT * FROM permission_decisions WHERE decision_id = ?')
        .get('pd_00000000-0000-7e76-af55-371b5a65dcf3') as {
        action: string;
        context_summary_json: string;
        created_at: string;
        enforcement_point: string;
        owner_scope: string;
        policy_engine_version: string;
        reason_code: string;
        resource_summary_json: string;
        result: string;
        subject_summary_json: string;
      };

      expect(row).toMatchObject({
        schema_version: 1,
        action: 'vault.use',
        created_at: '2026-07-05T00:00:00.000Z',
        enforcement_point: 'boot.policy.self_check',
        owner_scope: 'server',
        policy_engine_version: 'policy-kernel:v1',
        reason_code: 'restriction',
        result: 'deny',
      });
      expect(JSON.parse(row.subject_summary_json)).toEqual({
        id: 'process:nanocore',
        kind: 'process',
      });
      expect(JSON.parse(row.resource_summary_json)).toEqual({
        id: 'object:baseline-vault-secret',
        kind: 'vault-reference',
      });
      const expectedContext = {
        boot: true,
        kernelTrace: {
          matchedAssociations: ['assoc:baseline-vault-use', 'assoc:vault-extra'],
          matchedProhibitions: ['deny:baseline-vault-use', 'deny:vault-extra'],
        },
      };
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      const response = ListServerPermissionDecisionsResponseSchema.parse({
        permissionDecisions: listServerPermissionDecisions(coreDb),
      });
      expect(response.permissionDecisions).toHaveLength(1);
      expect(response.permissionDecisions[0]).toMatchObject({
        policyEngineVersion: 'policy-kernel:v1',
        policySnapshotId: `sha256:${'b'.repeat(64)}`,
        result: 'deny',
        reasonCode: 'restriction',
        contextSummary: expectedContext,
      });
      expect(response.permissionDecisions[0]?.contextSummary).toEqual(expectedContext);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('retains canonical boot decisions across exact retry and reopen with separate boot correlation', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-boot-'));
    let coreDb = openCoreDb(dataRoot);
    const now = new Date('2026-07-05T00:00:00.000Z');
    const kernel = loadBootPolicyKernel();
    try {
      applyMigrations(coreDb);
      await recordBootPolicySelfCheckDecisions({ bootId: 'boot_policy_test', coreDb, kernel, now });
      const original = listServerPermissionDecisions(coreDb).sort((a, b) =>
        a.action.localeCompare(b.action)
      );
      expect(
        original.map((row) => ({
          action: row.action,
          result: row.result,
          reasonCode: row.reasonCode,
        }))
      ).toEqual([
        { action: 'api.call', result: 'allow', reasonCode: 'association-grant' },
        { action: 'vault.use', result: 'deny', reasonCode: 'restriction' },
      ]);
      expect(
        original.every(
          (row) => isEntityId('pd', row.decisionId) && row.decisionId.split('_')[1]![14] === '7'
        )
      ).toBe(true);
      expect(original.map((row) => row.contextSummary)).toEqual([
        {
          boot: true,
          bootId: 'boot_policy_test',
          kernelTrace: { matchedAssociations: ['assoc:core-api-call'], matchedProhibitions: [] },
        },
        {
          boot: true,
          bootId: 'boot_policy_test',
          kernelTrace: {
            matchedAssociations: ['assoc:baseline-vault-use'],
            matchedProhibitions: ['deny:baseline-vault-use'],
          },
        },
      ]);
      const auditCount = () =>
        coreDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get();
      const originalAuditCount = auditCount();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      await recordBootPolicySelfCheckDecisions({
        bootId: 'boot_policy_test',
        coreDb,
        kernel,
        now: new Date('2026-07-05T00:01:00.000Z'),
      });
      expect(
        listServerPermissionDecisions(coreDb).sort((a, b) => a.action.localeCompare(b.action))
      ).toEqual(original);
      expect(auditCount()).toEqual(originalAuditCount);
      await recordBootPolicySelfCheckDecisions({ bootId: 'boot_policy_next', coreDb, kernel, now });
      const next = listServerPermissionDecisions(coreDb);
      expect(next).toHaveLength(4);
      expect(new Set(next.map((row) => row.decisionId)).size).toBe(4);
      expect(next.every((row) => isEntityId('pd', row.decisionId))).toBe(true);
      const retained = coreDb.sqlite
        .prepare('SELECT * FROM permission_decisions ORDER BY decision_id')
        .all();
      coreDb.sqlite
        .prepare('DELETE FROM audit_events WHERE audit_event_id = ?')
        .run(original[0]!.auditEventId);
      await expect(
        recordBootPolicySelfCheckDecisions({ bootId: 'boot_policy_test', coreDb, kernel, now })
      ).rejects.toThrow('Boot policy self-check record is contradictory.');
      expect(
        coreDb.sqlite.prepare('SELECT * FROM permission_decisions ORDER BY decision_id').all()
      ).toEqual(retained);
      coreDb.sqlite
        .prepare('DELETE FROM permission_decisions WHERE decision_id = ?')
        .run(original[0]!.decisionId);
      const partialRows = coreDb.sqlite
        .prepare('SELECT * FROM permission_decisions ORDER BY decision_id')
        .all();
      const partialAudits = coreDb.sqlite
        .prepare('SELECT * FROM audit_events ORDER BY audit_event_id')
        .all();
      await expect(
        recordBootPolicySelfCheckDecisions({ bootId: 'boot_policy_test', coreDb, kernel, now })
      ).rejects.toThrow('Boot policy self-check record is contradictory.');
      expect(
        coreDb.sqlite.prepare('SELECT * FROM permission_decisions ORDER BY decision_id').all()
      ).toEqual(partialRows);
      expect(
        coreDb.sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all()
      ).toEqual(partialAudits);
    } finally {
      await shutdownControlStoreWorkerClient();
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('pins boot rule versions to the canonical evaluated PolicyState despite unchanged rule IDs', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-boot-snapshot-'));
    const coreDb = openCoreDb(dataRoot);
    const baseline = loadBootPolicyKernel();
    const changed = loadBootPolicyKernel({
      associations: baseline.policy.associations.map((association) => ({
        ...association,
        accessRights: [...association.accessRights, 'ar:additional-right'],
      })),
    });
    try {
      applyMigrations(coreDb);
      await recordBootPolicySelfCheckDecisions({
        bootId: 'boot_original',
        coreDb,
        kernel: baseline,
      });
      await recordBootPolicySelfCheckDecisions({ bootId: 'boot_same', coreDb, kernel: baseline });
      await recordBootPolicySelfCheckDecisions({ bootId: 'boot_changed', coreDb, kernel: changed });
      const rows = listServerPermissionDecisions(coreDb);
      const original = rows.filter(
        (row) => (row.contextSummary as { bootId: string }).bootId === 'boot_original'
      );
      const same = rows.filter(
        (row) => (row.contextSummary as { bootId: string }).bootId === 'boot_same'
      );
      const revised = rows.filter(
        (row) => (row.contextSummary as { bootId: string }).bootId === 'boot_changed'
      );
      expect(original).toHaveLength(2);
      expect(same).toHaveLength(2);
      expect(revised).toHaveLength(2);
      const baselineDigest = `sha256:${createHash('sha256')
        .update(canonicalIdentifierName(baseline.policy))
        .digest('hex')}`;
      const changedDigest = `sha256:${createHash('sha256')
        .update(canonicalIdentifierName(changed.policy))
        .digest('hex')}`;
      expect(changedDigest).not.toBe(baselineDigest);
      expect(original.map((row) => row.policySnapshotId)).toEqual([baselineDigest, baselineDigest]);
      expect(same.map((row) => row.policySnapshotId)).toEqual([baselineDigest, baselineDigest]);
      expect(revised.map((row) => row.policySnapshotId)).toEqual([changedDigest, changedDigest]);
      const verdicts = (decisions: typeof rows) =>
        decisions
          .map((row) => ({
            action: row.action,
            result: row.result,
            reasonCode: row.reasonCode,
            kernelTrace: (row.contextSummary as { kernelTrace: unknown }).kernelTrace,
          }))
          .sort((left, right) => left.action.localeCompare(right.action));
      expect(verdicts(revised)).toEqual(verdicts(original));
      const retained = listServerPermissionDecisions(coreDb);
      await expect(
        recordBootPolicySelfCheckDecisions({
          bootId: 'boot_original',
          coreDb,
          kernel: changed,
        })
      ).rejects.toThrow('Boot policy self-check record is contradictory.');
      expect(listServerPermissionDecisions(coreDb)).toEqual(retained);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['outcome', 'denied'],
    ['resource', 'permission:vault.use'],
    ['actor_json', '{"kind":"user","userId":"usr_00000000-0000-7000-8000-000000000001"}'],
    ['workspace_id', 'ws_00000000-0000-7000-8000-000000000001'],
    ['thread_id', 'th_00000000-0000-7000-8000-000000000001'],
    ['severity', 'warning'],
    ['error_code', 'contradictory'],
    ['occurred_at', '2026-07-05T00:01:00.000Z'],
  ])(
    'refuses boot retry with contradictory linked Audit %s without changing retained rows',
    async (field, value) => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-boot-audit-'));
      const coreDb = openCoreDb(dataRoot);
      const input = {
        bootId: 'boot_audit_contradiction',
        coreDb,
        kernel: loadBootPolicyKernel(),
        now: new Date('2026-07-05T00:00:00.000Z'),
      };
      try {
        applyMigrations(coreDb);
        await recordBootPolicySelfCheckDecisions(input);
        const decision = listServerPermissionDecisions(coreDb).find(
          (row) => row.action === 'api.call'
        )!;
        // The column comes only from the closed fixture table above.
        coreDb.sqlite
          .prepare(`UPDATE audit_events SET ${field} = ? WHERE audit_event_id = ?`)
          .run(value, decision.auditEventId);
        const decisions = coreDb.sqlite
          .prepare('SELECT * FROM permission_decisions ORDER BY decision_id')
          .all();
        const audits = coreDb.sqlite
          .prepare('SELECT * FROM audit_events ORDER BY audit_event_id')
          .all();
        await expect(recordBootPolicySelfCheckDecisions(input)).rejects.toThrow(
          'Boot policy self-check record is contradictory.'
        );
        expect(
          coreDb.sqlite.prepare('SELECT * FROM permission_decisions ORDER BY decision_id').all()
        ).toEqual(decisions);
        expect(
          coreDb.sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all()
        ).toEqual(audits);
      } finally {
        await shutdownControlStoreWorkerClient();
        coreDb.sqlite.close();
        rmSync(dataRoot, { recursive: true, force: true });
      }
    }
  );

  it('publishes neither boot decision nor Audit when the second decision lacks entropy', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-boot-entropy-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      // Earlier tests can own a native host. Start this selection in a fresh intercepted lifetime.
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.pragma('query_only = ON');
      const entropy = armBootSecondDecisionEntropyFailure();
      const failure: unknown = await Promise.resolve()
        .then(() =>
          recordBootPolicySelfCheckDecisions({
            bootId: 'boot_entropy',
            coreDb,
            kernel: loadBootPolicyKernel(),
          })
        )
        .then(
          () => undefined,
          (error: unknown) => error
        );
      // Prove actual Worker fault entry before judging the transport's redacted refusal.
      expect(Atomics.load(entropy, 1)).toBe(1);
      expect(Atomics.load(entropy, 2)).toBe(3);
      expect(Atomics.load(entropy, 3)).toBe(1);
      expect(failure).toBeInstanceOf(ControlStoreWorkerError);
      expect(failure).toMatchObject({ code: 'sql-failed', commit: 'not-committed' });
      expect(coreDb.sqlite.prepare('SELECT * FROM permission_decisions').all()).toEqual([]);
      expect(coreDb.sqlite.prepare('SELECT * FROM audit_events').all()).toEqual([]);
    } finally {
      releaseBootEntropyFailure();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('requires an approval kind for require_approval decisions', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      await expect(
        recordProductPermissionDecision({
          coreDb,
          decisionId: 'pd_00000000-0000-75a1-9ff1-d6ec6ed0f953',
          ownerScope: 'server',
          policyEngineVersion: 'nanocore-approval-policy:v1',
          policySnapshotId: 'policy_snapshot_test',
          subjectSummary: { kind: 'user', id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0' },
          action: 'vault.use',
          resourceSummary: {
            kind: 'vault-reference',
            id: 'vault_00000000-0000-78b6-b4ac-a24bcc5d78a3',
          },
          contextSummary: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          result: 'require_approval',
          reasonCode: 'approval_required',
          enforcementPoint: 'policy.test',
        })
      ).rejects.toThrow('require_approval permission decisions require requiredApprovalKind.');
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('records approval and escalation outcome mappings as durable rows', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      await recordProductPermissionDecision({
        coreDb,
        decisionId: 'pd_00000000-0000-7d59-952b-a37801be80df',
        ownerScope: 'server',
        policyEngineVersion: 'nanocore-approval-policy:v1',
        policySnapshotId: 'policy_snapshot_test',
        subjectSummary: { kind: 'agent', id: 'agent_demo' },
        action: 'vault.use',
        resourceSummary: {
          kind: 'vault-reference',
          id: 'vault_00000000-0000-78b6-b4ac-a24bcc5d78a3',
        },
        contextSummary: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        result: 'require_approval',
        reasonCode: 'approval_required',
        enforcementPoint: 'policy.test',
        requiredApprovalKind: 'permission',
        approvalId: 'ap_policy_1',
      });
      await recordProductPermissionDecision({
        coreDb,
        decisionId: 'pd_00000000-0000-7d04-af43-41da70aefdc8',
        ownerScope: 'server',
        policyEngineVersion: 'nanocore-approval-policy:v1',
        policySnapshotId: 'policy_snapshot_test',
        subjectSummary: { kind: 'agent', id: 'agent_demo' },
        action: 'policy.change',
        resourceSummary: { kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001' },
        contextSummary: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        result: 'require_escalation',
        reasonCode: 'higher_authority_required',
        enforcementPoint: 'policy.test',
      });

      const rows = coreDb.sqlite
        .prepare(
          `SELECT decision_id, result, reason_code, required_approval_kind, approval_id
           FROM permission_decisions
           ORDER BY decision_id`
        )
        .all() as Array<{
        approval_id: string | null;
        decision_id: string;
        reason_code: string;
        required_approval_kind: string | null;
        result: string;
      }>;

      expect(rows).toEqual(
        [
          {
            approval_id: 'ap_policy_1',
            decision_id: 'pd_00000000-0000-7d59-952b-a37801be80df',
            reason_code: 'approval_required',
            required_approval_kind: 'permission',
            result: 'require_approval',
          },
          {
            approval_id: null,
            decision_id: 'pd_00000000-0000-7d04-af43-41da70aefdc8',
            reason_code: 'higher_authority_required',
            required_approval_kind: null,
            result: 'require_escalation',
          },
        ].sort((left, right) => left.decision_id.localeCompare(right.decision_id))
      );
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('records linked audit events for workspace-scoped permission decisions', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-audit-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await openTestNativeWorkspace(workspaceDb);

      await recordProductPermissionDecision({
        action: 'runtime.launch',
        auditActor: { kind: 'user', id: 'usr_00000000-0000-7968-a053-ad9e71464afe' },
        contextSummary: {
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        },
        decisionId: 'pd_00000000-0000-7197-aa8e-3647a1d39856',
        enforcementPoint: 'runtime.worker_turn_loop.start',
        ownerScope: 'workspace',
        policyEngineVersion: 'nanocore-worker-policy:v1',
        policySnapshotId: 'worker_turn_launch_policy',
        reasonCode: 'worker_turn_start_allowed',
        resourceSummary: { kind: 'worker-turn', turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64' },
        result: 'allow',
        subjectSummary: { id: 'worker-coordinator', kind: 'nanocore' },
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        now: new Date('2026-07-05T00:00:00.000Z'),
      });

      const decision = workspaceDb.sqlite
        .prepare(
          'SELECT decision_id, audit_event_id FROM permission_decisions WHERE decision_id = ?'
        )
        .get('pd_00000000-0000-7197-aa8e-3647a1d39856') as {
        audit_event_id: string | null;
        decision_id: string;
      };
      const audit = workspaceDb.sqlite
        .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
        .get(decision.audit_event_id) as Record<string, unknown>;

      expect(decision.audit_event_id).toMatch(/^aud_/);
      expect(audit).toMatchObject({
        action: 'permission.decision',
        actor_json: JSON.stringify({
          kind: 'user',
          id: 'usr_00000000-0000-7968-a053-ad9e71464afe',
        }),
        category: 'approval',
        created_at: '2026-07-05T00:00:00.000Z',
        error_code: null,
        outcome: 'succeeded',
        permission_decision_id: 'pd_00000000-0000-7197-aa8e-3647a1d39856',
        resource: 'permission:runtime.launch',
        severity: 'info',
        summary: 'Permission decision allow: runtime.launch',
        thread_id: 'th_00000000-0000-7000-8000-000000000001',
        turn_id: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('records linked audit events for server-scoped permission decisions', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-server-audit-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      await recordProductPermissionDecision({
        action: 'llm.gateway.responses',
        contextSummary: { requestId: 'req_gateway_policy' },
        coreDb,
        decisionId: 'pd_00000000-0000-729c-8c31-7d153b685f61',
        enforcementPoint: 'llm.gateway.policy',
        ownerScope: 'server',
        policyEngineVersion: 'nanocore-gateway-policy:v1',
        policySnapshotId: 'gateway_policy',
        reasonCode: 'gateway_allowed',
        resourceSummary: { kind: 'provider', providerId: 'openai' },
        result: 'allow',
        subjectSummary: { id: 'public-gateway', kind: 'service' },
        now: new Date('2026-07-05T00:00:00.000Z'),
      });

      const decision = coreDb.sqlite
        .prepare(
          'SELECT decision_id, audit_event_id FROM permission_decisions WHERE decision_id = ?'
        )
        .get('pd_00000000-0000-729c-8c31-7d153b685f61') as {
        audit_event_id: string | null;
        decision_id: string;
      };
      const audit = coreDb.sqlite
        .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
        .get(decision.audit_event_id) as Record<string, unknown>;

      expect(decision.audit_event_id).toMatch(/^aud_/);
      expect(audit).toMatchObject({
        action: 'permission.decision',
        category: 'approval',
        created_at: '2026-07-05T00:00:00.000Z',
        error_code: null,
        outcome: 'succeeded',
        permission_decision_id: 'pd_00000000-0000-729c-8c31-7d153b685f61',
        resource: 'permission:llm.gateway.responses',
        severity: 'info',
        summary: 'Permission decision allow: llm.gateway.responses',
        workspace_id: null,
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('rolls back a permission decision when its linked audit event cannot persist', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-atomic-audit-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await openTestNativeWorkspace(workspaceDb);
      workspaceDb.sqlite.exec(`
        CREATE TRIGGER reject_permission_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'permission.decision'
        BEGIN
          SELECT RAISE(ABORT, 'injected permission audit failure');
        END
      `);

      await expect(
        async () =>
          await recordProductPermissionDecision({
            action: 'repo.push',
            contextSummary: { requestId: 'request_atomic_audit' },
            decisionId: 'pd_00000000-0000-7ffa-93d2-ae49f80adb52',
            enforcementPoint: 'repo.push.approval_response',
            ownerScope: 'workspace',
            policyEngineVersion: 'nanocore-approval-policy:v1',
            policySnapshotId: 'policy_snapshot_runtime',
            reasonCode: 'repo_push_approved',
            resourceSummary: { repositoryId: 'repo_default' },
            result: 'allow',
            subjectSummary: { kind: 'user' },
            workspaceDb,
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          })
      ).rejects.toThrow();
      expect(
        workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM permission_decisions WHERE decision_id = ?')
          .get('pd_00000000-0000-7ffa-93d2-ae49f80adb52')
      ).toEqual({ count: 0 });
      expect(listWorkspaceAuditEvents(workspaceDb, workspaceDb.workspaceId)).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('permits only one terminal permission decision for an approval', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-terminal-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await openTestNativeWorkspace(workspaceDb);
      const base = {
        action: 'repo.push',
        approvalId: 'approval_terminal_1',
        auditActor: { kind: 'user' as const, id: 'usr_00000000-0000-7968-a053-ad9e71464afe' },
        contextSummary: { requestId: '00000000-0000-4000-8000-000000000015' },
        enforcementPoint: 'repo.push.approval_response',
        ownerScope: 'workspace' as const,
        policyEngineVersion: 'nanocore-approval-policy:v1',
        policySnapshotId: 'policy_snapshot_runtime',
        requiredApprovalKind: 'permission',
        resourceSummary: { repositoryId: 'repo_default' },
        subjectSummary: { kind: 'agent', id: 'agent_demo' },
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      };

      // Same-millisecond records tie-break by decision ID, so fixture IDs ascend in recording order.
      await recordProductPermissionDecision({
        ...base,
        decisionId: 'pd_00000000-0000-7d59-952b-a37801be80df',
        reasonCode: 'repo_push_requires_approval',
        result: 'require_approval',
      });
      await recordProductPermissionDecision({
        ...base,
        decisionId: 'pd_00000000-0000-7e1a-9251-4f38c967a8d3',
        reasonCode: 'repo_push_approved',
        result: 'allow',
      });
      await expect(
        async () =>
          await recordProductPermissionDecision({
            ...base,
            decisionId: 'pd_00000000-0000-7f80-b7a7-2ab5b94b69ef',
            reasonCode: 'repo_push_denied',
            result: 'deny',
          })
      ).rejects.toThrow();

      expect(
        listExportableWorkspacePermissionDecisions(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001'
        ).map((decision) => ({
          decisionId: decision.decisionId,
          result: decision.result,
        }))
      ).toEqual([
        { decisionId: 'pd_00000000-0000-7d59-952b-a37801be80df', result: 'require_approval' },
        { decisionId: 'pd_00000000-0000-7e1a-9251-4f38c967a8d3', result: 'allow' },
      ]);
      expect(
        workspaceDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'permission.decision'"
          )
          .get()
      ).toEqual({ count: 2 });
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });
});

// Storage Scope Homing keeps User identity decisions and their Audit in the actual User database.
describe('User permission decision ownership', () => {
  const userId = 'usr_00000000-0000-7000-8000-000000000001';
  const otherUserId = 'usr_00000000-0000-7000-8000-000000000002';
  const digest = `sha256:${'a'.repeat(64)}`;
  const resource = {
    kind: 'container' as const,
    container: { kind: 'user' as const, id: userId, owner: { kind: 'user' as const, userId } },
  };

  /** Reads through the retained family codec without importing a not-yet-implemented User reader. */
  function retained(userDb: UserDb) {
    return userDb.sqlite
      .prepare('SELECT * FROM permission_decisions ORDER BY decision_id')
      .all()
      .map(readPermissionDecisionRowV1);
  }

  /** Uses the existing public recorder input; no Login operation or credential material is created. */
  function decision(userDb: UserDb) {
    return {
      userDb,
      ownerScope: 'user' as const,
      workspaceId: null,
      decisionId: allocateEntityId('pd'),
      policyEngineVersion: 'nanocore-policy:v1',
      policySnapshotId: digest,
      subjectSummary: { kind: 'human', id: userId },
      action: 'vault.use',
      resourceSummary: resource,
      contextSummary: {},
      enforcementPoint: 'vault.binding-replace@decide',
      reasonCode: 'granted',
      result: 'allow' as const,
      auditActor: { kind: 'user' as const, id: userId },
    };
  }

  it('awaits native User decision and linked Audit with Main query-only and survives cold reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-user-policy-retained-'));
    let userDb = openUserDb(root, userId);
    const otherDb = openUserDb(root, otherUserId);
    try {
      applyScopedMigrations(userDb);
      applyScopedMigrations(otherDb);
      userDb.sqlite.pragma('query_only = ON');
      const input = decision(userDb);
      await recordProductPermissionDecision(input);
      const rows = retained(userDb);
      expect(rows).toHaveLength(1);
      expect(permissionDecisions.listUserPermissionDecisions(userDb)).toEqual(rows);
      expect(rows[0]).toMatchObject({
        decisionId: input.decisionId,
        ownerScope: 'user',
        workspaceId: null,
        resourceSummary: resource,
        result: 'allow',
      });
      const events = listSqliteAuditEvents(userDb.sqlite);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: rows[0]!.auditEventId,
        permissionDecisionId: input.decisionId,
        workspaceId: null,
        actor: input.auditActor,
        action: 'permission.decision',
        outcome: 'succeeded',
      });
      expect(retained(otherDb)).toEqual([]);
      expect(listSqliteAuditEvents(otherDb.sqlite)).toEqual([]);
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      userDb = openUserDb(root, userId);
      expect(retained(userDb)).toEqual(rows);
      expect(permissionDecisions.listUserPermissionDecisions(userDb)).toEqual(rows);
      expect(listSqliteAuditEvents(userDb.sqlite)).toEqual(events);
      // Fault only the retained marker after valid owner production; unknown core formats refuse.
      userDb.sqlite
        .prepare('UPDATE permission_decisions SET schema_version = 999 WHERE decision_id = ?')
        .run(input.decisionId);
      expect(() => retained(userDb)).toThrow();
      expect(() => permissionDecisions.listUserPermissionDecisions(userDb)).toThrow();
    } finally {
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      otherDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects a real Kernel denial into the same native User decision and Audit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-user-policy-kernel-'));
    const userDb = openUserDb(root, userId);
    try {
      applyScopedMigrations(userDb);
      const kernel = loadBootPolicyKernel();
      const policyDecision = kernel.evaluate({
        process: 'process:nanocore',
        operation: 'vault.use',
        target: 'object:baseline-vault-secret',
      });
      expect(policyDecision.effect).toBe('deny');
      userDb.sqlite.pragma('query_only = ON');
      const input = { ...decision(userDb), policyDecision };
      await recordPermissionDecision(input);
      expect(retained(userDb)).toMatchObject([
        {
          decisionId: input.decisionId,
          ownerScope: 'user',
          workspaceId: null,
          result: 'deny',
          contextSummary: {
            kernelTrace: {
              matchedAssociations: policyDecision.trace.matchedAssociations,
              matchedProhibitions: policyDecision.trace.matchedProhibitions,
            },
          },
        },
      ]);
      expect(listSqliteAuditEvents(userDb.sqlite)).toMatchObject([
        {
          permissionDecisionId: input.decisionId,
          outcome: 'denied',
          workspaceId: null,
        },
      ]);
    } finally {
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back the User decision when its required linked Audit insert fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-user-policy-atomic-'));
    const userDb = openUserDb(root, userId);
    try {
      applyScopedMigrations(userDb);
      userDb.sqlite.exec(`CREATE TRIGGER reject_user_permission_audit BEFORE INSERT ON audit_events
        WHEN NEW.action = 'permission.decision' BEGIN
        SELECT RAISE(ABORT, 'injected User permission Audit failure'); END`);
      userDb.sqlite.pragma('query_only = ON');
      await expect(
        async () => await recordProductPermissionDecision(decision(userDb))
      ).rejects.toMatchObject({ commit: 'not-committed' });
      expect(retained(userDb)).toEqual([]);
      expect(listSqliteAuditEvents(userDb.sqlite)).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a User handle whose physical database belongs to another User', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-user-policy-physical-'));
    const userDb = openUserDb(root, userId);
    const otherDb = openUserDb(root, otherUserId);
    try {
      applyScopedMigrations(userDb);
      applyScopedMigrations(otherDb);
      await expect(
        async () =>
          await recordProductPermissionDecision({
            ...decision(userDb),
            userDb: { ...userDb, sqlite: otherDb.sqlite },
          })
      ).rejects.toThrow();
      expect(retained(userDb)).toEqual([]);
      expect(retained(otherDb)).toEqual([]);
      expect(listSqliteAuditEvents(userDb.sqlite)).toEqual([]);
      expect(listSqliteAuditEvents(otherDb.sqlite)).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      otherDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('consumes one finite User binding use atomically across concurrent last-use attempts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-user-policy-last-use-'));
    const userDb = openUserDb(root, userId);
    const statement = { id: 'owner-once', digest };
    const mediation: PolicyDecisionV1 = {
      operation: 'vault.binding-replace',
      stage: 'decide',
      authorizationRevision: digest,
      proposalDigest: digest,
      role: 'final',
      kernel: { effect: 'allow', reason: 'association-grant' },
      subject: {
        principal: { kind: 'human', id: userId },
        onBehalfOf: null,
        actor: { kind: 'user', id: userId },
        process: null,
        credentialKind: 'local',
        responsibleHumanId: userId,
      },
      invocations: [],
      consumedStatements: [],
    };
    try {
      applyScopedMigrations(userDb);
      userDb.sqlite.pragma('query_only = ON');
      await recordProductPermissionDecision({
        ...decision(userDb),
        mediation: { ...mediation, role: 'gate', binding: statement, kernel: undefined },
      });
      await recordProductPermissionDecision({
        ...decision(userDb),
        result: 'deny',
        reasonCode: 'prohibited',
        mediation: { ...mediation, kernel: { effect: 'deny', reason: 'restriction' } },
      });
      expect(
        permissionDecisions
          .listUserPermissionDecisions(userDb)
          .every((row) => row.mediation?.consumedStatements.length === 0)
      ).toBe(true);
      const attempts = [allocateEntityId('pd'), allocateEntityId('pd')];
      const results = await Promise.allSettled(
        attempts.map((decisionId) =>
          recordProductPermissionDecision({
            ...decision(userDb),
            decisionId,
            mediation: { ...mediation, consumedStatements: [statement] },
            uses: [{ statement, limit: 1 }],
          })
        )
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const failure = results.find((result) => result.status === 'rejected');
      expect(failure).toMatchObject({ status: 'rejected', reason: { commit: 'not-committed' } });
      const rows = permissionDecisions.listUserPermissionDecisions(userDb);
      expect(rows).toHaveLength(3);
      const winners = rows.filter((row) => attempts.includes(row.decisionId));
      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({
        result: 'allow',
        ownerScope: 'user',
        workspaceId: null,
        mediation: { role: 'final', kernel: { effect: 'allow' }, consumedStatements: [statement] },
      });
      const events = listSqliteAuditEvents(userDb.sqlite);
      expect(events).toHaveLength(3);
      expect(events.find((event) => event.id === winners[0]!.auditEventId)).toMatchObject({
        permissionDecisionId: winners[0]!.decisionId,
        outcome: 'succeeded',
        workspaceId: null,
      });
      const loserId = attempts.find((id) => id !== winners[0]!.decisionId);
      expect(events.some((event) => event.permissionDecisionId === loserId)).toBe(false);
      await expect(
        recordProductPermissionDecision({
          ...decision(userDb),
          mediation: { ...mediation, consumedStatements: [statement] },
          uses: [{ statement, limit: 1 }],
        })
      ).rejects.toMatchObject({ commit: 'not-committed' });
      expect(permissionDecisions.listUserPermissionDecisions(userDb)).toEqual(rows);
      expect(listSqliteAuditEvents(userDb.sqlite)).toEqual(events);
    } finally {
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a contradictory physical User reader without exposing or changing another User decision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-user-policy-reader-physical-'));
    const userDb = openUserDb(root, userId);
    const otherDb = openUserDb(root, otherUserId);
    try {
      applyScopedMigrations(userDb);
      applyScopedMigrations(otherDb);
      userDb.sqlite.pragma('query_only = ON');
      otherDb.sqlite.pragma('query_only = ON');
      const input = {
        ...decision(otherDb),
        subjectSummary: { kind: 'human', id: otherUserId },
        resourceSummary: {
          kind: 'container',
          container: {
            kind: 'user',
            id: otherUserId,
            owner: { kind: 'user', userId: otherUserId },
          },
        },
        auditActor: { kind: 'user' as const, id: otherUserId },
      };
      await recordProductPermissionDecision(input);
      const rows = permissionDecisions.listUserPermissionDecisions(otherDb);
      const events = listSqliteAuditEvents(otherDb.sqlite);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        decisionId: input.decisionId,
        ownerScope: 'user',
        workspaceId: null,
        subjectSummary: input.subjectSummary,
        resourceSummary: input.resourceSummary,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: rows[0]!.auditEventId,
        permissionDecisionId: input.decisionId,
        actor: input.auditActor,
      });
      expect(() =>
        permissionDecisions.listUserPermissionDecisions({ ...userDb, sqlite: otherDb.sqlite })
      ).toThrow();
      expect(permissionDecisions.listUserPermissionDecisions(otherDb)).toEqual(rows);
      expect(retained(otherDb)).toEqual(rows);
      expect(listSqliteAuditEvents(otherDb.sqlite)).toEqual(events);
      expect(permissionDecisions.listUserPermissionDecisions(userDb)).toEqual([]);
      expect(listSqliteAuditEvents(userDb.sqlite)).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      otherDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Workspace publication proves the same retained links, rollback boundary, finite-use contention
// and cold-read identity through its exported recorder and list operations.
describe('Workspace permission decision links and finite uses', () => {
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const userId = 'usr_00000000-0000-7000-8000-000000000001';
  const digest = `sha256:${'a'.repeat(64)}`;

  /** Fixed mediated evidence independent of any private schema import. */
  function mediation(consumedStatements: PolicyDecisionV1['consumedStatements']): PolicyDecisionV1 {
    return {
      operation: 'mcp.call-tool',
      stage: 'decide',
      proposalDigest: digest,
      authorizationRevision: digest,
      subject: {
        principal: { kind: 'human', id: userId },
        onBehalfOf: null,
        actor: { kind: 'user', id: userId },
        process: null,
        credentialKind: 'local',
        responsibleHumanId: userId,
      },
      role: 'final',
      kernel: { effect: 'allow', reason: 'granted' },
      invocations: [],
      consumedStatements,
    };
  }

  /** Shared public recorder input; only the case-specific facts vary. */
  function decision(
    workspaceDb: ReturnType<typeof openWorkspaceDb>,
    facts: Record<string, unknown>
  ) {
    return {
      workspaceDb,
      workspaceId,
      ownerScope: 'workspace' as const,
      policyEngineVersion: 'fixture:v1',
      policySnapshotId: digest,
      subjectSummary: {},
      action: 'tool.use',
      resourceSummary: {},
      contextSummary: {},
      reasonCode: 'granted',
      result: 'allow' as const,
      enforcementPoint: 'mcp.call-tool@decide',
      ...facts,
    };
  }

  it('publishes one exact Audit link per decision and keeps both identical after a cold reopen', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-policy-links-'));
    let workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await openTestNativeWorkspace(workspaceDb);
      await recordProductPermissionDecision(
        decision(workspaceDb, {
          decisionId: 'pd_00000000-0000-7000-8000-000000000001',
          action: 'repo.push',
          result: 'require_approval',
          requiredApprovalKind: 'permission',
          approvalId: 'approval_links',
          reasonCode: 'approval_required',
          enforcementPoint: 'repo.push.approval_response',
          contextSummary: { requestId: '00000000-0000-4000-8000-000000000001' },
          now: new Date('2026-10-18T00:00:00.000Z'),
        })
      );
      await recordProductPermissionDecision(
        decision(workspaceDb, {
          decisionId: 'pd_00000000-0000-7000-8000-000000000002',
          mediation: mediation([]),
          now: new Date('2026-10-18T00:00:01.000Z'),
        })
      );

      const decisions = listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId);
      const audits = listWorkspaceAuditEvents(workspaceDb, workspaceId);
      expect(decisions).toHaveLength(2);
      expect(audits).toHaveLength(2);
      for (const recorded of decisions) {
        expect(recorded.auditEventId).toMatch(/^aud_/);
        const linked = audits.filter((event) => event.permissionDecisionId === recorded.decisionId);
        expect(linked).toHaveLength(1);
        expect(linked[0]).toMatchObject({
          id: recorded.auditEventId,
          workspaceId,
          action: 'permission.decision',
          resource: `permission:${recorded.action}`,
          outcome: 'succeeded',
        });
        expect(audits.filter((event) => event.id === recorded.auditEventId)).toHaveLength(1);
      }
      expect(audits.every((event) => event.permissionDecisionId !== null)).toBe(true);

      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
      expect(listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId)).toEqual(
        decisions
      );
      expect(listWorkspaceAuditEvents(workspaceDb, workspaceId)).toEqual(audits);
    } finally {
      await shutdownControlStoreWorkerClient();
      if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('rolls back a finite-use decision when its linked Audit cannot publish', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-policy-use-rollback-'));
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    const statement = { id: 'workspace-once', digest };
    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await openTestNativeWorkspace(workspaceDb);
      workspaceDb.sqlite.exec(`
        CREATE TRIGGER reject_workspace_permission_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'permission.decision'
        BEGIN
          SELECT RAISE(ABORT, 'injected workspace permission audit failure');
        END
      `);

      await expect(
        async () =>
          await recordProductPermissionDecision(
            decision(workspaceDb, {
              decisionId: 'pd_00000000-0000-7000-8000-000000000003',
              mediation: mediation([statement]),
              uses: [{ statement, limit: 1 }],
            })
          )
      ).rejects.toThrow();
      expect(
        workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM permission_decisions').get()
      ).toEqual({ count: 0 });
      expect(
        workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()
      ).toEqual({ count: 0 });
      expect(readPolicyStatementUseCount(workspaceDb, statement)).toBe(0);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('accepts one concurrent finite-use decision and preserves the winner after a cold reopen', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-policy-contention-'));
    let workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    const statement = { id: 'workspace-contended-once', digest };
    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await openTestNativeWorkspace(workspaceDb);
      const attempts = [
        'pd_00000000-0000-7000-8000-000000000004',
        'pd_00000000-0000-7000-8000-000000000005',
      ];
      const results = await Promise.allSettled(
        attempts.map((decisionId) =>
          recordProductPermissionDecision(
            decision(workspaceDb, {
              decisionId,
              mediation: mediation([statement]),
              uses: [{ statement, limit: 1 }],
            })
          )
        )
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const decisions = listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId);
      const audits = listWorkspaceAuditEvents(workspaceDb, workspaceId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        result: 'allow',
        mediation: {
          role: 'final',
          kernel: { effect: 'allow' },
          consumedStatements: [statement],
        },
      });
      expect(attempts).toContain(decisions[0]!.decisionId);
      expect(readPolicyStatementUseCount(workspaceDb, statement)).toBe(1);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        id: decisions[0]!.auditEventId,
        permissionDecisionId: decisions[0]!.decisionId,
        outcome: 'succeeded',
        workspaceId,
      });

      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
      expect(listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId)).toEqual(
        decisions
      );
      expect(listWorkspaceAuditEvents(workspaceDb, workspaceId)).toEqual(audits);
      expect(readPolicyStatementUseCount(workspaceDb, statement)).toBe(1);
    } finally {
      await shutdownControlStoreWorkerClient();
      if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
