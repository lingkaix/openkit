import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ListServerPermissionDecisionsResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
} from '@openkit/app-api-schemas';
import { isEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';

import { loadBootPolicyKernel } from '../bootstrap/policy.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  listExportableWorkspacePermissionDecisions,
  listServerPermissionDecisions,
  recordBootPolicySelfCheckDecisions,
  recordPermissionDecision,
  recordProductPermissionDecision,
} from './permission-decisions.js';

describe('permission decision recorder', () => {
  it.each([
    'workspace',
    'server',
  ] as const)('preserves ordinary fixture context in %s canonical writes, retained reads and public lists', (ownerScope) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-public-fixture-'));
    let coreDb = openCoreDb(dataRoot);
    let workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const contextSummary = { fixture: 'ghp_publicFixture sk-Latn', nested: ['hf_publicFixture'] };
    try {
      applyMigrations(coreDb);
      applyScopedMigrations(workspaceDb);
      recordProductPermissionDecision({
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
      workspaceDb.sqlite.close();
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
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records a policy-kernel decision as a durable server-scope row', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      const kernel = loadBootPolicyKernel();
      const policyDecision = kernel.evaluate({
        process: 'process:nanocore',
        operation: 'vault.use',
        target: 'object:baseline-vault-secret',
      });

      recordPermissionDecision({
        coreDb,
        decisionId: 'pd_00000000-0000-7e76-af55-371b5a65dcf3',
        ownerScope: 'server',
        policyDecision,
        policyEngineVersion: 'policy-kernel:v1',
        policySnapshotId: 'policy_snapshot_boot_baseline',
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
      expect(JSON.parse(row.context_summary_json)).toEqual({ boot: true });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retains canonical boot decisions across exact retry and reopen with separate boot correlation', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-boot-'));
    let coreDb = openCoreDb(dataRoot);
    const now = new Date('2026-07-05T00:00:00.000Z');
    const kernel = loadBootPolicyKernel();
    try {
      applyMigrations(coreDb);
      recordBootPolicySelfCheckDecisions({ bootId: 'boot_policy_test', coreDb, kernel, now });
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
        { boot: true, bootId: 'boot_policy_test' },
        { boot: true, bootId: 'boot_policy_test' },
      ]);
      const auditCount = () =>
        coreDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get();
      const originalAuditCount = auditCount();
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      recordBootPolicySelfCheckDecisions({
        bootId: 'boot_policy_test',
        coreDb,
        kernel,
        now: new Date('2026-07-05T00:01:00.000Z'),
      });
      expect(
        listServerPermissionDecisions(coreDb).sort((a, b) => a.action.localeCompare(b.action))
      ).toEqual(original);
      expect(auditCount()).toEqual(originalAuditCount);
      recordBootPolicySelfCheckDecisions({ bootId: 'boot_policy_next', coreDb, kernel, now });
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
      expect(() =>
        recordBootPolicySelfCheckDecisions({ bootId: 'boot_policy_test', coreDb, kernel, now })
      ).toThrow('Boot policy self-check record is contradictory.');
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
      expect(() =>
        recordBootPolicySelfCheckDecisions({ bootId: 'boot_policy_test', coreDb, kernel, now })
      ).toThrow('Boot policy self-check record is contradictory.');
      expect(
        coreDb.sqlite.prepare('SELECT * FROM permission_decisions ORDER BY decision_id').all()
      ).toEqual(partialRows);
      expect(
        coreDb.sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all()
      ).toEqual(partialAudits);
    } finally {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('publishes neither boot decision nor Audit when the second decision lacks entropy', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-boot-entropy-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      const nativeEntropy = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
      const entropy = vi
        .spyOn(globalThis.crypto, 'getRandomValues')
        .mockImplementationOnce((value) => nativeEntropy(value))
        .mockImplementationOnce((value) => nativeEntropy(value))
        .mockImplementation(() => {
          throw new Error('Synthetic boot entropy failure.');
        });
      try {
        expect(() =>
          recordBootPolicySelfCheckDecisions({
            bootId: 'boot_entropy',
            coreDb,
            kernel: loadBootPolicyKernel(),
          })
        ).toThrow('Synthetic boot entropy failure.');
      } finally {
        entropy.mockRestore();
      }
      expect(coreDb.sqlite.prepare('SELECT * FROM permission_decisions').all()).toEqual([]);
      expect(coreDb.sqlite.prepare('SELECT * FROM audit_events').all()).toEqual([]);
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('requires an approval kind for require_approval decisions', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      expect(() =>
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
      ).toThrow('require_approval permission decisions require requiredApprovalKind.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records approval and escalation outcome mappings as durable rows', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      recordProductPermissionDecision({
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
      recordProductPermissionDecision({
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

      expect(rows).toEqual([
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
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records linked audit events for workspace-scoped permission decisions', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-audit-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      recordProductPermissionDecision({
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
      workspaceDb.sqlite.close();
    }
  });

  it('records linked audit events for server-scoped permission decisions', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-server-audit-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      recordProductPermissionDecision({
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
      coreDb.sqlite.close();
    }
  });

  it('rolls back a permission decision when its linked audit event cannot persist', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-atomic-audit-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      workspaceDb.sqlite.exec(`
        CREATE TRIGGER reject_permission_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'permission.decision'
        BEGIN
          SELECT RAISE(ABORT, 'injected permission audit failure');
        END
      `);

      expect(() =>
        recordProductPermissionDecision({
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
      ).toThrow('injected permission audit failure');
      expect(
        workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM permission_decisions WHERE decision_id = ?')
          .get('pd_00000000-0000-7ffa-93d2-ae49f80adb52')
      ).toEqual({ count: 0 });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('permits only one terminal permission decision for an approval', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-terminal-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
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

      recordProductPermissionDecision({
        ...base,
        decisionId: 'pd_00000000-0000-7d59-952b-a37801be80df',
        reasonCode: 'repo_push_requires_approval',
        result: 'require_approval',
      });
      recordProductPermissionDecision({
        ...base,
        decisionId: 'pd_00000000-0000-7cda-9251-4f38c967a8d3',
        reasonCode: 'repo_push_approved',
        result: 'allow',
      });
      expect(() =>
        recordProductPermissionDecision({
          ...base,
          decisionId: 'pd_00000000-0000-7f80-b7a7-2ab5b94b69ef',
          reasonCode: 'repo_push_denied',
          result: 'deny',
        })
      ).toThrow();

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
        { decisionId: 'pd_00000000-0000-7cda-9251-4f38c967a8d3', result: 'allow' },
      ]);
      expect(
        workspaceDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'permission.decision'"
          )
          .get()
      ).toEqual({ count: 2 });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
