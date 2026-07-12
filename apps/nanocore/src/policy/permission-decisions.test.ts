import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadBootPolicyKernel } from '../bootstrap/policy.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  recordBootPolicySelfCheckDecisions,
  recordPermissionDecision,
  recordProductPermissionDecision,
} from './permission-decisions.js';

describe('permission decision recorder', () => {
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
        decisionId: 'pd_test_vault_deny',
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
        .get('pd_test_vault_deny') as {
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

  it('records boot policy self-check allow and deny decisions', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-permission-decision-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      recordBootPolicySelfCheckDecisions({
        bootId: 'boot_policy_test',
        coreDb,
        kernel: loadBootPolicyKernel(),
        now: new Date('2026-07-05T00:00:00.000Z'),
      });

      const rows = coreDb.sqlite
        .prepare(
          'SELECT decision_id, action, result, reason_code FROM permission_decisions ORDER BY decision_id'
        )
        .all() as Array<{
        action: string;
        decision_id: string;
        reason_code: string;
        result: string;
      }>;

      expect(rows).toEqual([
        {
          action: 'api.call',
          decision_id: 'boot_policy_test_policy_core_api_call',
          reason_code: 'association-grant',
          result: 'allow',
        },
        {
          action: 'vault.use',
          decision_id: 'boot_policy_test_policy_vault_use',
          reason_code: 'restriction',
          result: 'deny',
        },
      ]);
    } finally {
      coreDb.sqlite.close();
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
          decisionId: 'pd_missing_approval_kind',
          ownerScope: 'server',
          policyEngineVersion: 'nanocore-approval-policy:v1',
          policySnapshotId: 'policy_snapshot_test',
          subjectSummary: { kind: 'user', id: 'user_demo' },
          action: 'vault.use',
          resourceSummary: { kind: 'vault-reference', id: 'vault_demo' },
          contextSummary: { workspaceId: 'ws_demo' },
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
        decisionId: 'pd_requires_approval',
        ownerScope: 'server',
        policyEngineVersion: 'nanocore-approval-policy:v1',
        policySnapshotId: 'policy_snapshot_test',
        subjectSummary: { kind: 'agent', id: 'agent_demo' },
        action: 'vault.use',
        resourceSummary: { kind: 'vault-reference', id: 'vault_demo' },
        contextSummary: { workspaceId: 'ws_demo' },
        result: 'require_approval',
        reasonCode: 'approval_required',
        enforcementPoint: 'policy.test',
        requiredApprovalKind: 'permission',
        approvalId: 'ap_policy_1',
      });
      recordProductPermissionDecision({
        coreDb,
        decisionId: 'pd_requires_escalation',
        ownerScope: 'server',
        policyEngineVersion: 'nanocore-approval-policy:v1',
        policySnapshotId: 'policy_snapshot_test',
        subjectSummary: { kind: 'agent', id: 'agent_demo' },
        action: 'policy.change',
        resourceSummary: { kind: 'workspace', id: 'ws_demo' },
        contextSummary: { workspaceId: 'ws_demo' },
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
          decision_id: 'pd_requires_approval',
          reason_code: 'approval_required',
          required_approval_kind: 'permission',
          result: 'require_approval',
        },
        {
          approval_id: null,
          decision_id: 'pd_requires_escalation',
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      recordProductPermissionDecision({
        action: 'runtime.launch',
        contextSummary: { threadId: 'th_demo', turnId: 'turn_demo', workspaceId: 'ws_demo' },
        decisionId: 'pd_workspace_audit',
        enforcementPoint: 'runtime.worker_turn_loop.start',
        ownerScope: 'workspace',
        policyEngineVersion: 'nanocore-worker-policy:v1',
        policySnapshotId: 'worker_turn_launch_policy',
        reasonCode: 'worker_turn_start_allowed',
        resourceSummary: { kind: 'worker-turn', turnId: 'turn_demo' },
        result: 'allow',
        subjectSummary: { id: 'worker-coordinator', kind: 'nanocore' },
        workspaceDb,
        workspaceId: 'ws_demo',
        now: new Date('2026-07-05T00:00:00.000Z'),
      });

      const decision = workspaceDb.sqlite
        .prepare(
          'SELECT decision_id, audit_event_id FROM permission_decisions WHERE decision_id = ?'
        )
        .get('pd_workspace_audit') as {
        audit_event_id: string | null;
        decision_id: string;
      };
      const audit = workspaceDb.sqlite
        .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
        .get(decision.audit_event_id) as Record<string, unknown>;

      expect(decision.audit_event_id).toMatch(/^aud_/);
      expect(audit).toMatchObject({
        action: 'permission.decision',
        category: 'approval',
        created_at: '2026-07-05T00:00:00.000Z',
        error_code: null,
        outcome: 'succeeded',
        permission_decision_id: 'pd_workspace_audit',
        resource: 'permission:runtime.launch',
        severity: 'info',
        summary: 'Permission decision allow: runtime.launch',
        thread_id: 'th_demo',
        turn_id: 'turn_demo',
        workspace_id: 'ws_demo',
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
        decisionId: 'pd_server_audit',
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
        .get('pd_server_audit') as {
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
        permission_decision_id: 'pd_server_audit',
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'local-user', 'ws_demo');

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
          decisionId: 'pd_atomic_audit',
          enforcementPoint: 'repo.push.approval_response',
          ownerScope: 'workspace',
          policyEngineVersion: 'nanocore-approval-policy:v1',
          policySnapshotId: 'policy_snapshot_runtime',
          reasonCode: 'repo_push_approved',
          resourceSummary: { repositoryId: 'repo_default' },
          result: 'allow',
          subjectSummary: { kind: 'user' },
          workspaceDb,
          workspaceId: 'ws_demo',
        })
      ).toThrow('injected permission audit failure');
      expect(
        workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM permission_decisions WHERE decision_id = ?')
          .get('pd_atomic_audit')
      ).toEqual({ count: 0 });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
