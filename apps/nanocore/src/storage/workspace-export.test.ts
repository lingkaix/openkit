import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb } from './db.js';
import { LOCAL_USER_ID } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';
import {
  dryRunWorkspaceImport,
  readWorkspaceImportSnapshot,
  verifyWorkspaceExportTree,
  WORKSPACE_EXPORT_MANIFEST_FILE,
  WORKSPACE_EXPORT_NON_PORTABLE_WORKSPACE_SQLITE_TABLES,
  WORKSPACE_EXPORT_PORTABLE_WORKSPACE_SQLITE_TABLES,
  writeWorkspaceExportTree,
} from './workspace-export.js';

const timestamp = '2026-07-05T00:00:00.000Z';

/**
 * Writes a minimal export tree fixture.
 *
 * @returns Export root path.
 */
function writeExportTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-'));
  const recordsDir = join(root, 'records');

  mkdirSync(recordsDir);
  writeFileSync(join(recordsDir, 'workspace.json'), '{"id":"ws_demo"}');
  writeFileSync(
    join(root, WORKSPACE_EXPORT_MANIFEST_FILE),
    JSON.stringify({
      schemaVersion: 1,
      recordType: 'workspace-export',
      id: 'wsexp_1',
      ownerScope: 'workspace',
      lineage: { workspaceId: 'ws_demo' },
      createdAt: timestamp,
      updatedAt: timestamp,
      contentDigest: 'sha256:manifest',
      redactionLevel: 'metadata',
      sensitivity: 'internal',
      requiredFeatures: [],
      extensions: {},
      sourceDeploymentId: 'dep_source',
      workspaceId: 'ws_demo',
      exportCreatedAt: timestamp,
      exportFormatVersion: 1,
      contentInventory: [
        {
          path: 'records/workspace.json',
          digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
          bytes: 16,
        },
      ],
    })
  );

  return root;
}

describe('workspace export verifier', () => {
  it('verifies manifest shape and inventory file digests offline', () => {
    const verified = verifyWorkspaceExportTree({ exportRoot: writeExportTree() });

    expect(verified.manifest.workspaceId).toBe('ws_demo');
    expect(verified.checkedFiles).toEqual(['records/workspace.json']);
  });

  it('rejects tampered or extra files', () => {
    const tamperedRoot = writeExportTree();
    writeFileSync(join(tamperedRoot, 'records', 'workspace.json'), '{"id":"changed"}');

    expect(() => verifyWorkspaceExportTree({ exportRoot: tamperedRoot })).toThrow(
      'Digest mismatch for export file records/workspace.json'
    );

    const extraRoot = writeExportTree();
    writeFileSync(join(extraRoot, 'records', 'extra.json'), '{}');

    expect(() => verifyWorkspaceExportTree({ exportRoot: extraRoot })).toThrow(
      'Export file missing from inventory: records/extra.json'
    );
  });

  it('writes a verifiable workspace export tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-write-'));
    const exported = writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 1 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [
        {
          id: 'th_demo',
          workspaceId: 'ws_demo',
          name: 'Demo thread',
          preview: 'Demo thread',
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      knowledge: [
        {
          id: 'kn_demo',
          workspaceId: 'ws_demo',
          title: 'Release cadence',
          body: 'Review releases every Friday.',
          tags: [],
          sourceRefs: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      threadItems: [],
      workspaceQuarantineRecords: [
        {
          id: 'wqr_1',
          workspaceId: 'ws_demo',
          lifecycleRecordIds: ['wrr_1', 'wom_1'],
          failureKind: 'digest_mismatch',
          storageRef: 'quarantine/workspace-sync/wqr_1',
          retentionClass: 'restricted-evidence',
          requiredHumanDecision: 'inspect_quarantined_output',
          resolution: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
          resolvedAt: null,
        },
      ],
      workspaceSyncEvidenceBundles: [
        {
          id: 'wseb_1',
          workspaceId: 'ws_demo',
          lifecycleRecordIds: ['wrr_1', 'wom_1'],
          evidenceBundleIds: ['evb_workspace_materialization_wmr_1'],
          backendEvidenceRefs: [{ kind: 'backend.openshell', ref: 'session/session_1/output' }],
          redactedEvidenceManifest: [
            {
              kind: 'worker-log',
              ref: 'evidence/workspace-sync/wseb_1/log',
              digest: 'sha256:log',
              bytes: 42,
            },
          ],
          contentDigests: ['sha256:bundle'],
          retentionClass: 'workspace-audit',
          createdAt: timestamp,
        },
      ],
    });

    expect(existsSync(join(root, WORKSPACE_EXPORT_MANIFEST_FILE))).toBe(true);
    expect(exported.checkedFiles).toEqual([
      'records/knowledge.jsonl',
      'records/thread-items.jsonl',
      'records/threads.jsonl',
      'records/workspace-quarantine-records.jsonl',
      'records/workspace-sync-evidence-bundles.jsonl',
      'records/workspace.json',
    ]);
    expect(
      JSON.parse(
        readFileSync(join(root, 'records', 'workspace-quarantine-records.jsonl'), 'utf8').trim()
      )
    ).toMatchObject({ id: 'wqr_1', workspaceId: 'ws_demo' });
    expect(
      JSON.parse(
        readFileSync(join(root, 'records', 'workspace-sync-evidence-bundles.jsonl'), 'utf8').trim()
      )
    ).toMatchObject({ id: 'wseb_1', workspaceId: 'ws_demo' });
    expect(JSON.parse(readFileSync(join(root, 'records', 'workspace.json'), 'utf8'))).toMatchObject(
      {
        id: 'ws_demo',
      }
    );
    expect(verifyWorkspaceExportTree({ exportRoot: root }).manifest.workspaceId).toBe('ws_demo');
  });

  it('dry-runs workspace import verification and collision preview without mutating', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-dry-run-'));
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      threadItems: [],
    });

    expect(
      dryRunWorkspaceImport({
        exportRoot: root,
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
      })
    ).toMatchObject({
      mode: 'dry-run',
      exportId: 'wsexp_demo',
      exportedWorkspaceId: 'ws_demo',
      collision: {
        status: 'collides',
        workspaceId: 'ws_demo',
        suggestedWorkspaceId: 'ws_imported_ws_demo',
      },
      verification: {
        fileCount: 4,
        checkedFiles: [
          'records/knowledge.jsonl',
          'records/thread-items.jsonl',
          'records/threads.jsonl',
          'records/workspace.json',
        ],
      },
    });
  });

  it('rejects imported records with unsupported required features', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-record-feature-'));
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
        requiredFeatures: ['workspace.record.future'],
      },
      threads: [],
      knowledge: [],
      threadItems: [],
    });

    expect(() =>
      readWorkspaceImportSnapshot({
        exportRoot: root,
        targetWorkspaceId: 'ws_imported_demo',
      })
    ).toThrow('Unsupported requiredFeatures in records/workspace.json: workspace.record.future');
  });

  it('strips unknown optional evidence fields while reading workspace imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-evidence-extra-'));
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      threadItems: [],
      evidenceBundles: [
        {
          id: 'evb_extra',
          workspaceId: 'ws_demo',
          threadId: null,
          goalId: null,
          turnId: null,
          agentSessionId: null,
          backendType: null,
          sourceKind: 'manual',
          summary: 'Evidence with future metadata.',
          rawEvidenceRefs: [],
          redactedEvidenceRefs: [{ kind: 'workspace', ref: 'ws_demo' }],
          contentDigests: ['sha256:evidence'],
          retentionClass: 'workspace-audit',
          sensitivityClass: 'product-safe',
          importStatus: 'promoted',
          requiredFeatures: ['evidence.bundle.v1'],
          createdAt: timestamp,
          futureOptionalNote: 'ignored by this reader',
        },
      ],
      runtimeEvidence: [
        {
          id: 'rte_extra',
          workspaceId: 'ws_demo',
          threadId: null,
          turnId: null,
          goalId: null,
          taskId: null,
          agentSessionId: null,
          backendType: 'openshell',
          backendVersion: null,
          placement: 'local',
          phase: 'teardown',
          summary: 'Runtime evidence with future metadata.',
          policyDigest: null,
          workerImage: null,
          sandboxSummary: null,
          capabilitySummary: null,
          uploadManifest: [],
          downloadManifest: [],
          transcriptSummary: null,
          workspaceChangeSummary: null,
          controlSummary: null,
          outcome: 'succeeded',
          exitCode: 0,
          signal: null,
          stopReason: 'completed',
          errorCode: null,
          errorMessage: null,
          redactedStdoutSummary: null,
          redactedStderrSummary: null,
          evidenceBundleIds: [],
          contentDigests: ['sha256:runtime'],
          requiredFeatures: ['runtime.evidence.v1'],
          createdAt: timestamp,
          startedAt: timestamp,
          completedAt: timestamp,
          collectedAt: timestamp,
          futureOptionalNote: 'ignored by this reader',
        },
      ],
    });

    const snapshot = readWorkspaceImportSnapshot({
      exportRoot: root,
      targetWorkspaceId: 'ws_imported_demo',
    });

    expect(snapshot.evidenceBundles).toEqual([
      expect.objectContaining({
        id: 'evb_extra',
        workspaceId: 'ws_imported_demo',
        redactedEvidenceRefs: [{ kind: 'workspace', ref: 'ws_imported_demo' }],
      }),
    ]);
    expect(snapshot.runtimeEvidence).toEqual([
      expect.objectContaining({
        id: 'rte_extra',
        workspaceId: 'ws_imported_demo',
      }),
    ]);
    expect(snapshot.evidenceBundles[0]).not.toHaveProperty('futureOptionalNote');
    expect(snapshot.runtimeEvidence[0]).not.toHaveProperty('futureOptionalNote');
  });

  it('strips unknown optional usage ledger fields while reading workspace imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-usage-extra-'));
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      threadItems: [],
      capabilityCalls: [
        {
          id: 'cap_extra',
          workspaceId: 'ws_demo',
          threadId: null,
          turnId: null,
          itemId: null,
          agentId: null,
          agentSessionId: null,
          requestId: null,
          sourceIds: [],
          capabilityId: 'runtime.worker_turn',
          status: 'succeeded',
          summary: 'Imported capability call.',
          errorCode: null,
          startedAt: timestamp,
          completedAt: timestamp,
          family: 'runtime',
          operation: 'worker.checkpoint.terminal',
          providerRef: 'nanocore-runtime',
          serviceRef: 'worker-checkpoint',
          redactionClass: 'metadata-only',
          futureOptionalNote: 'ignored by this reader',
        },
      ],
      usageRecords: [
        {
          id: 'use_extra',
          workspaceId: 'ws_demo',
          threadId: null,
          turnId: null,
          itemId: null,
          capabilityCallId: 'cap_extra',
          requestId: null,
          agentId: null,
          agentSessionId: null,
          sourceIds: [],
          category: 'runtime',
          unit: 'sandbox_sessions',
          quantity: 1,
          modelId: null,
          providerRef: 'nanocore-runtime',
          source: 'worker-checkpoint-terminal',
          recordedAt: timestamp,
          futureOptionalNote: 'ignored by this reader',
        },
      ],
    });

    const snapshot = readWorkspaceImportSnapshot({
      exportRoot: root,
      targetWorkspaceId: 'ws_imported_demo',
    });

    expect(snapshot.capabilityCalls).toEqual([
      expect.objectContaining({ id: 'cap_extra', workspaceId: 'ws_imported_demo' }),
    ]);
    expect(snapshot.usageRecords).toEqual([
      expect.objectContaining({ id: 'use_extra', workspaceId: 'ws_imported_demo' }),
    ]);
    expect(snapshot.capabilityCalls[0]).not.toHaveProperty('futureOptionalNote');
    expect(snapshot.usageRecords[0]).not.toHaveProperty('futureOptionalNote');
  });

  it('strips unknown optional Git push record fields while reading workspace imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-git-push-extra-'));
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      threadItems: [],
      gitPushRecords: [
        {
          id: 'gpr_extra',
          workspaceId: 'ws_demo',
          repositoryResourceId: 'repo_default',
          approvalRowId: 'act_git_push_1',
          policyDecisionId: 'pd_git_push_1',
          actorId: 'user_local',
          remoteSummary: 'GitHub repository openkit on origin',
          sourceRef: 'HEAD',
          targetBranch: 'main',
          commitIds: ['abc123'],
          reviewIds: ['wr_review_1'],
          remoteHeadBefore: 'abc000',
          remoteHeadAfter: 'def456',
          outcome: 'pushed',
          errorSummary: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          requestId: '00000000-0000-4000-8000-00000000d753',
          futureOptionalNote: 'ignored by this reader',
        },
      ],
    });

    const snapshot = readWorkspaceImportSnapshot({
      exportRoot: root,
      targetWorkspaceId: 'ws_imported_demo',
    });

    expect(snapshot.gitPushRecords).toEqual([
      expect.objectContaining({
        id: 'gpr_extra',
        workspaceId: 'ws_imported_demo',
        repositoryResourceId: 'repo_default',
        outcome: 'pushed',
      }),
    ]);
    expect(snapshot.gitPushRecords[0]).not.toHaveProperty('futureOptionalNote');
  });

  it('rewrites workspace quarantine records while reading workspace imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-quarantine-'));
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      threadItems: [],
      workspaceQuarantineRecords: [
        {
          id: 'wqr_import',
          workspaceId: 'ws_demo',
          lifecycleRecordIds: ['wrr_import'],
          failureKind: 'schema_failure',
          storageRef: 'quarantine/workspace-sync/wqr_import',
          retentionClass: 'restricted-evidence',
          requiredHumanDecision: null,
          resolution: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
          resolvedAt: null,
        },
      ],
    });

    const snapshot = readWorkspaceImportSnapshot({
      exportRoot: root,
      targetWorkspaceId: 'ws_imported_demo',
    });

    expect(snapshot.workspaceQuarantineRecords).toEqual([
      expect.objectContaining({
        id: 'wqr_import',
        workspaceId: 'ws_imported_demo',
        storageRef: 'quarantine/workspace-sync/wqr_import',
      }),
    ]);
  });

  it('rewrites workspace sync evidence bundles while reading workspace imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-sync-evidence-'));
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      threadItems: [],
      workspaceSyncEvidenceBundles: [
        {
          id: 'wseb_import',
          workspaceId: 'ws_demo',
          lifecycleRecordIds: ['wrr_import'],
          evidenceBundleIds: ['evb_import'],
          backendEvidenceRefs: [{ kind: 'backend.openshell', ref: 'session/session_1/output' }],
          redactedEvidenceManifest: [
            {
              kind: 'worker-log',
              ref: 'evidence/workspace-sync/wseb_import/log',
              digest: 'sha256:log',
              bytes: 42,
            },
          ],
          contentDigests: ['sha256:bundle'],
          retentionClass: 'workspace-audit',
          createdAt: timestamp,
        },
      ],
    });

    const snapshot = readWorkspaceImportSnapshot({
      exportRoot: root,
      targetWorkspaceId: 'ws_imported_demo',
    });

    expect(snapshot.workspaceSyncEvidenceBundles).toEqual([
      expect.objectContaining({
        id: 'wseb_import',
        workspaceId: 'ws_imported_demo',
        evidenceBundleIds: ['evb_import'],
      }),
    ]);
  });

  it('exports and imports redacted worker setup evidence rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-worker-evidence-'));
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      threadItems: [],
      resolvedAgentSetups: [
        {
          id: 'ras_demo',
          workspaceId: 'ws_demo',
          turnId: 'turn_1',
          requestId: 'req_1',
          agentId: 'agent_codex_host',
          providerId: 'openai_codex',
          runtimeKind: 'codex',
          runtimeAdapter: 'codex-app-server',
          requiredFeatures: ['knowledge.read'],
          setup: {
            agent: { displayName: 'Codex Agent', id: 'agent_codex_host' },
            deployment: {
              config: { args: ['app-server'], command: 'codex' },
              mode: 'local',
              origin: 'agent-config',
            },
            origins: {
              deployment: 'agent-config',
              provider: 'server-providers',
              runtime: 'agent-config',
              transport: 'adapter-defaults',
            },
            provider: {
              model: 'gpt-5',
              origin: 'server-providers',
              providerId: 'openai_codex',
              secretRef: null,
            },
            requiredFeatures: ['knowledge.read'],
            runtime: { adapter: 'codex-app-server', kind: 'codex', version: '0.130.0' },
            transport: { kind: 'stdio', origin: 'adapter-defaults' },
          },
          createdAt: timestamp,
        },
      ],
      agentEnvironmentPackageSnapshots: [
        {
          snapshotId: 'aepsnap_demo',
          workspaceId: 'ws_demo',
          turnId: 'turn_1',
          threadId: 'th_1',
          agentSessionId: 'as_1',
          agentId: 'agent_codex_host',
          packageId: 'aep_demo',
          runtimeKind: 'codex',
          backendKind: 'openshell',
          contentDigest: 'digest_demo',
          snapshot: {
            snapshotId: 'aepsnap_demo',
            packageId: 'aep_demo',
            scope: {
              workspaceId: 'ws_demo',
              threadId: 'th_1',
              turnId: 'turn_1',
              agentSessionId: 'as_1',
            },
            agent: { agentId: 'agent_codex_host', runtimeKind: 'codex' },
            backend: { preferred: 'openshell' },
          },
          createdAt: timestamp,
        },
      ],
    });

    expect(readFileSync(join(root, 'records', 'resolved-agent-setups.jsonl'), 'utf8')).toContain(
      'ras_demo'
    );
    expect(
      readFileSync(join(root, 'records', 'agent-environment-package-snapshots.jsonl'), 'utf8')
    ).toContain('aepsnap_demo');

    const snapshot = readWorkspaceImportSnapshot({
      exportRoot: root,
      targetWorkspaceId: 'ws_imported_demo',
    });

    expect(snapshot.resolvedAgentSetups).toEqual([
      expect.objectContaining({
        id: 'ras_demo',
        workspaceId: 'ws_imported_demo',
        setup: expect.objectContaining({
          agent: { displayName: 'Codex Agent', id: 'agent_codex_host' },
        }),
      }),
    ]);
    expect(snapshot.agentEnvironmentPackageSnapshots).toEqual([
      expect.objectContaining({
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        snapshotId: 'aepsnap_demo',
        workspaceId: 'ws_imported_demo',
        snapshot: expect.objectContaining({
          scope: expect.objectContaining({ workspaceId: 'ws_imported_demo' }),
        }),
      }),
    ]);
    expect(snapshot.agentEnvironmentPackageSnapshots[0]!.contentDigest).not.toBe('digest_demo');
  });

  it('imports workspace-family capability call rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-capability-family-'));
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      threadItems: [],
      capabilityCalls: [
        {
          id: 'cap_workspace_read',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          itemId: null,
          agentId: null,
          agentSessionId: null,
          requestId: null,
          sourceIds: [],
          capabilityId: 'assistant.repository.read',
          family: 'workspace',
          operation: 'repository.root_list',
          summary: 'Assistant read linked repository root entries.',
          providerRef: null,
          serviceRef: 'workspace-repository',
          redactionClass: 'metadata',
          status: 'succeeded',
          errorCode: null,
          startedAt: timestamp,
          completedAt: timestamp,
        },
      ],
    });

    expect(
      readWorkspaceImportSnapshot({
        exportRoot: root,
        targetWorkspaceId: 'ws_imported_demo',
      }).capabilityCalls
    ).toEqual([
      expect.objectContaining({
        capabilityId: 'assistant.repository.read',
        family: 'workspace',
        workspaceId: 'ws_imported_demo',
      }),
    ]);
  });

  it('keeps workspace sqlite table export coverage explicit', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-coverage-'));
    const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      const tables = (
        workspaceDb.sqlite
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'
             ORDER BY name ASC`
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      const covered = [
        ...WORKSPACE_EXPORT_PORTABLE_WORKSPACE_SQLITE_TABLES,
        ...WORKSPACE_EXPORT_NON_PORTABLE_WORKSPACE_SQLITE_TABLES.map((entry) => entry.table),
      ].sort();

      expect(covered).toEqual(tables);
      expect(WORKSPACE_EXPORT_NON_PORTABLE_WORKSPACE_SQLITE_TABLES).toEqual([
        {
          table: 'workspace_filesystem_staging_roots',
          reason: 'host-local apply staging paths are not portable export history',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
