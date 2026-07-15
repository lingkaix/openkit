import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CapabilityUsageResponseSchema,
  ListThreadItemsResponseSchema,
  ListWorkspaceAuditEventsResponseSchema,
  ListWorkspaceEvidenceBundlesResponseSchema,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  type WorkspaceInputSnapshot,
  type WorkspaceMaterializationRecord,
} from '@openkit/app-api-schemas';
import type {
  AgentEnvironmentPackage,
  AgentEnvironmentValidationDiagnostic,
  WorkerGovernanceBackendCapabilities,
} from '@openkit/config-schema';
import {
  type WorkerCanonicalEventRecord,
  WorkerCanonicalEventRecordSchema,
  type WorkerLineage,
  type WorkerRuntimeNativeOriginIndexEntry,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  type WorkerRuntimeRawStreamManifest,
  WorkerRuntimeRawStreamManifestSchema,
} from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { listWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import { listInjectionPlans } from '../injection-plans.js';
import { listInjectionReceipts } from '../injection-receipts.js';
import type { FsStore } from '../lib/store.js';
import type {
  LLMGatewayDispatchContext,
  LLMGatewayProviderDispatcher,
} from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID, workspaceDbPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestWorkspaceReviewMaterialization } from '../test-support/workspace-sync.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import { getWorkerBackendSession } from './worker-backend-sessions.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';
import type {
  WorkerGovernanceArtifactRecord,
  WorkerGovernanceBackend,
  WorkerGovernanceEvidenceRecord,
  WorkerGovernanceMaterializationRecord,
  WorkerGovernanceWorkspaceChangeRecord,
} from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';
import {
  createWorkerRuntimeOriginRef,
  type ImportWorkerRuntimeProvenanceInput,
  importWorkerRuntimeProvenance,
} from './worker-runtime-provenance.js';
import type { WorkerTranscriptPayload } from './worker-transcript.js';
import { getFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
import {
  listBackendWorkspaceHandles,
  listWorkspaceChangeSets,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  listWorkspaceSyncReviews,
} from './workspace-sync-records.js';

const TURN_ROOT_NATIVE_ID = '019f1000-0000-7000-8000-000000000001';
const TURN_CHILD_NATIVE_ID = '019f1000-0000-7000-8000-000000000002';
const TURN_CHILD_B_NATIVE_ID = '019f1000-0000-7000-8000-000000000003';
const TURN_NATIVE_SESSION_ID = '019f1000-0000-7000-8000-000000000010';
const TURN_CHILD_RAW_MESSAGE = 'private child raw answer must not become a canonical item';

/**
 * Opens the migrated workspace database used by worker governance tests.
 *
 * @param coreDb Core database whose data root owns the workspace database.
 * @returns Migrated workspace database handle.
 */
function openTestWorkspaceDb(coreDb: CoreDb): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/** Dispatches the scheduler lease that authorizes one executor fixture. */
function dispatchExecutorLease(
  coreDb: CoreDb,
  input: {
    readonly agentSessionId: string;
    readonly packageSnapshotId: string;
    readonly sandboxBindingRef: string;
    readonly threadId: string;
    readonly turnId: string;
  }
): void {
  upsertSchedulerWorkerPool(coreDb, {
    allowedBackendKinds: ['openshell'],
    allowedPlacements: ['local'],
    allowedWorkspaceScopes: ['local'],
    budgetClass: 'interactive',
    currentAdmittedSessionCount: 0,
    currentQueueDepth: 1,
    defaultTimeoutMs: 900_000,
    healthSummary: 'ready',
    maxConcurrentSessions: 1,
    poolId: 'pool_executor_anchor',
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 1,
    inUseCount: 0,
    observationSource: 'configured',
    observedAt: '2026-07-15T00:00:00.000Z',
    poolId: 'pool_executor_anchor',
    queueDepth: 0,
    targetId: 'target_executor_anchor',
  });
  upsertSchedulerTargetHealthRecord(coreDb, {
    checkResults: [],
    consecutiveFailureCount: 0,
    consecutiveSuccessCount: 1,
    healthState: 'healthy',
    lastProbeAt: '2026-07-15T00:00:00.000Z',
    nextProbeAt: '2026-07-15T00:01:00.000Z',
    targetId: 'target_executor_anchor',
  });
  createSchedulerAdmissionEntry(coreDb, {
    priorityClass: 'interactive',
    profileRef: 'profile_worker',
    queueEntryId: `queue_${input.turnId}`,
    requestedAgentId: 'agent_codex_host',
    requiredPoolConstraints: ['openshell.local'],
    threadId: input.threadId,
    turnId: input.turnId,
    turnInput: 'Run governed worker',
    workspaceId: 'ws_demo',
    now: () => '2026-07-15T00:00:01.000Z',
  });
  dispatchNextSchedulerEntry(coreDb, {
    agentSessionId: input.agentSessionId,
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    leaseDurationMs: 900_000,
    leaseId: `lease_${input.turnId}`,
    now: () => '2026-07-15T00:00:02.000Z',
    packageSnapshotId: input.packageSnapshotId,
    planId: `plan_${input.turnId}`,
    sandboxBindingRef: input.sandboxBindingRef,
    schedulerEpoch: 1,
    startupTimeoutMs: 120_000,
  });
}

/**
 * Runs one Git command in a temporary test repository.
 *
 * @param cwd Repository working directory.
 * @param args Fixed Git arguments.
 * @returns Captured stdout.
 */
function runTestGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Creates one isolated workspace-change ingress fixture with trusted lineage records.
 *
 * @param name Stable test-case slug used for ids and temporary roots.
 * @param strategy Workspace synchronization strategy emitted by the worker.
 * @param repositoryStrategy Linked repository staging strategy, or `missing` for no exact link.
 * @returns Ingress dependencies and a valid baseline worker change record.
 */
function createWorkspaceChangeIngressFixture(
  name: string,
  strategy: 'git' | 'filesystem',
  repositoryStrategy: 'missing' | 'review-branch' | 'staging-root'
) {
  const timestamp = '2026-07-11T00:00:00.000Z';
  const workspaceId = 'ws_demo';
  const resourceId = 'repo';
  const reviewId = `swr_ingress_${name}`;
  const changeSetId = `wcs_ingress_${name}`;
  const inputSnapshotId = `wis_ingress_${name}`;
  const materializationRecordId = `wmr_ingress_${name}`;
  const repositoryPath = mkdtempSync(join(tmpdir(), `openkit-ingress-${name}-repository-`));
  const stagingRootPath = mkdtempSync(join(tmpdir(), `openkit-ingress-${name}-staging-`));
  const targetRootPath = mkdtempSync(join(tmpdir(), `openkit-ingress-${name}-target-`));
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-ingress-${name}-data-`));

  runTestGit(repositoryPath, ['init', '-b', 'main']);
  runTestGit(repositoryPath, ['config', 'user.email', 'repository@example.invalid']);
  runTestGit(repositoryPath, ['config', 'user.name', 'Repository User']);
  writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n', 'utf8');
  runTestGit(repositoryPath, ['add', 'README.md']);
  runTestGit(repositoryPath, ['commit', '-m', 'initial']);
  const baseCommit = runTestGit(repositoryPath, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n\nReviewed.\n', 'utf8');
  const patchText = runTestGit(repositoryPath, [
    'diff',
    '--binary',
    '--no-ext-diff',
    '--',
    'README.md',
  ]);
  writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n', 'utf8');
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
  const beforeDigest = `sha256:${'1'.repeat(64)}`;
  const afterDigest = `sha256:${'2'.repeat(64)}`;
  const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, workspaceId);
  applyScopedMigrations(workspaceDb);
  if (repositoryStrategy !== 'missing') {
    upsertWorkspaceRepositoryResource(workspaceDb, {
      displayName: 'Ingress validation repository',
      git: {
        authorEmail: 'approver@example.invalid',
        authorName: 'Approving Human',
        stagingStrategy: repositoryStrategy,
      },
      localPath: repositoryPath,
      resourceId,
      workspaceExists: (candidateWorkspaceId) => candidateWorkspaceId === workspaceId,
      workspaceId,
    });
  }

  const storeDataRoot = mkdtempSync(join(tmpdir(), `openkit-ingress-${name}-store-`));
  const store = createDemoStore({ dataRoot: storeDataRoot });
  const turn = store.createTurn(workspaceId, 'th_demo', `Validate ${name}`);
  const executor = new WorkerGovernanceTurnExecutor({
    backend: new FakeWorkerGovernanceBackend(),
    createAgentSessionId: () => `as_ingress_${name}`,
    environmentBackend: {
      workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
      kind: 'openshell',
      sandboxImageRef: 'openkit/worker-codex:dev',
    },
    now: () => timestamp,
  });
  const environmentPackage = {
    scope: {
      threadId: turn.threadId,
      turnId: turn.id,
      workspaceId,
    },
  } as AgentEnvironmentPackage;
  const version =
    strategy === 'git'
      ? { commit: baseCommit, contentDigest: null }
      : { commit: null, contentDigest: beforeDigest };
  const inputSnapshot = {
    backend: { capabilitySummary: [], kind: 'openshell', label: 'OpenShell worker backend' },
    base: version,
    createdAt: timestamp,
    generatedFiles: [],
    id: inputSnapshotId,
    ignoredPaths: [],
    pathScope: [resourceId],
    resourceId,
    resourceKind: strategy === 'git' ? 'git_repository' : 'filesystem',
    strategy,
    workspaceId,
    writableRoots: [resourceId],
  } satisfies WorkspaceInputSnapshot;
  const materializationRecord = {
    backendKind: 'openshell',
    base: version,
    createdAt: timestamp,
    id: materializationRecordId,
    inputSnapshotId,
    materializedRootRef: `/workspace/${resourceId}`,
    policyDigest: `sha256:${'3'.repeat(64)}`,
    readinessEvidence: [],
    strategy,
    workerSessionId: `session_ingress_${name}`,
    workspaceId,
  } satisfies WorkspaceMaterializationRecord;
  const record = {
    changeSet: {
      artifactIds: [],
      base: version,
      bundle: null,
      changedPaths: [{ binary: false, path: 'README.md', status: 'modified' }],
      createdAt: timestamp,
      evidenceRefs: [{ kind: 'worker', ref: turn.id }],
      head:
        strategy === 'git'
          ? { commit: 'f'.repeat(baseCommit.length), contentDigest: null }
          : { commit: null, contentDigest: afterDigest },
      id: changeSetId,
      inputSnapshotId,
      materializationRecordId,
      patch:
        strategy === 'git'
          ? {
              bytes: Buffer.byteLength(patchText, 'utf8'),
              digest: patchDigest,
              ref: 'worker-session://workspace.patch',
            }
          : null,
      redaction: { notes: [], status: 'no-sensitive-content-found' },
      resourceId,
      strategy,
      workspaceId,
    },
    filesystemApply:
      strategy === 'filesystem'
        ? {
            before: {
              contentDigest: beforeDigest,
              createdAt: timestamp,
              entries: [],
              resourceId,
              workspaceId,
            },
            stagingRootPath,
            targetRootPath,
          }
        : null,
    patchPayload:
      strategy === 'git'
        ? {
            bytes: Buffer.byteLength(patchText, 'utf8'),
            digest: patchDigest,
            mediaType: 'text/x-diff',
            text: patchText,
          }
        : null,
    review: {
      actionCenterRowId: `workspace-review:${reviewId}`,
      changeSetId,
      createdAt: timestamp,
      diffSummary: { additions: 1, deletions: 0, filesChanged: 1 },
      id: reviewId,
      riskSummary: 'One changed path staged for human review.',
      staging:
        strategy === 'git'
          ? {
              branch: `openkit/review/${reviewId}`,
              ref: `staging://workspace/${changeSetId}`,
              strategy: 'git_worktree',
            }
          : {
              branch: null,
              ref: `filesystem-staging://${reviewId}`,
              strategy: 'filesystem_staging',
            },
      status: 'pending',
      updatedAt: timestamp,
      validation: [],
      workspaceId,
    },
  } satisfies WorkerGovernanceWorkspaceChangeRecord;

  return {
    artifactId: `ar_workspace_changes_${turn.id}_${reviewId}`,
    environmentPackage,
    executor,
    inputSnapshot,
    materializationRecord,
    record,
    repositoryPath,
    reviewBranchRef: `refs/heads/openkit/review/${reviewId}`,
    reviewId,
    store,
    storeDataRoot,
    timestamp,
    workspaceDb,
    workspaceId,
  };
}

/**
 * Invokes the executor's workspace-change ingress boundary with explicit trusted lineage.
 *
 * @param fixture Isolated ingress fixture.
 * @param record Worker-emitted change record to validate.
 * @param inputStrategy Optional trusted input strategy override.
 * @param materializationStrategy Optional trusted materialization strategy override.
 * @returns Promise settled after validation and any accepted persistence.
 */
async function ingestWorkspaceChangeFixture(
  fixture: ReturnType<typeof createWorkspaceChangeIngressFixture>,
  record: WorkerGovernanceWorkspaceChangeRecord,
  inputStrategy?: 'git' | 'filesystem',
  materializationStrategy?: 'git' | 'filesystem'
): Promise<void> {
  recordTestWorkspaceReviewMaterialization(fixture.workspaceDb, {
    artifactId: fixture.artifactId,
    ...record,
  });
  const executor = fixture.executor as unknown as {
    createWorkspaceChangeArtifacts(
      store: FsStore,
      environmentPackage: AgentEnvironmentPackage,
      records: readonly WorkerGovernanceWorkspaceChangeRecord[],
      workspaceDb: WorkspaceDb | null,
      inputSnapshots: readonly WorkspaceInputSnapshot[],
      materializationRecords: readonly WorkspaceMaterializationRecord[]
    ): Promise<void>;
  };

  await executor.createWorkspaceChangeArtifacts(
    fixture.store,
    fixture.environmentPackage,
    [record],
    fixture.workspaceDb,
    [{ ...fixture.inputSnapshot, strategy: inputStrategy ?? fixture.inputSnapshot.strategy }],
    [
      {
        ...fixture.materializationRecord,
        strategy: materializationStrategy ?? fixture.materializationRecord.strategy,
      },
    ]
  );
}

/**
 * Checks whether one exact Git reference exists in a test repository.
 *
 * @param repositoryPath Test repository path.
 * @param reference Exact full Git reference.
 * @returns True only when the reference exists.
 */
function testGitRefExists(repositoryPath: string, reference: string): boolean {
  try {
    runTestGit(repositoryPath, ['show-ref', '--verify', '--quiet', reference]);
    return true;
  } catch {
    return false;
  }
}

describe('WorkerGovernanceTurnExecutor', () => {
  it('rejects direct interrupts when the executor advertises no interrupt support', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Keep the one-shot worker running');
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    expect(executor.capabilities.interrupts).toBe(false);
    await expect(
      executor.interruptTurn(store, turn.id, { requestId: 'req_unsupported_interrupt' })
    ).rejects.toThrow();
    expect(store.getTurnById(turn.id)).toEqual(turn);
    expect(
      store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
    ).toEqual([]);
  });

  it.each([
    { expectedStatus: 'completed', mode: 'exact' },
    { expectedStatus: 'failed', mode: 'missing' },
    { expectedStatus: 'failed', mode: 'conflict' },
  ] as const)('reconciles $mode transcript events against durable live acceptance', async ({
    expectedStatus,
    mode,
  }) => {
    const coreDb = openCoreDb(
      mkdtempSync(join(tmpdir(), `openkit-governance-live-events-${mode}-`))
    );
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', `Reconcile ${mode} worker events`);
    const backend = new FakeWorkerGovernanceBackend();
    backend.eventsJsonlFactory = (environmentPackage) => {
      const lineage: WorkerLineage = {
        agentSessionId: environmentPackage.scope.agentSessionId,
        packageSnapshotId: environmentPackage.snapshotId,
        requestId: environmentPackage.scope.requestId,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        workspaceId: environmentPackage.scope.workspaceId,
      };
      const transcriptRecord = WorkerCanonicalEventRecordSchema.parse({
        event: { data: { status: 'running' }, type: 'worker.heartbeat' },
        kind: 'event',
        lineage,
        schemaVersion: 1,
        sequence: 0,
      });

      if (mode !== 'missing') {
        const acceptedRecord: WorkerCanonicalEventRecord =
          mode === 'conflict'
            ? WorkerCanonicalEventRecordSchema.parse({
                ...transcriptRecord,
                event: { data: { status: 'different' }, type: 'worker.heartbeat' },
              })
            : transcriptRecord;
        recordWorkerControlAcceptedRecord(coreDb, {
          acceptedAt: '2026-07-15T00:00:00.000Z',
          lineage,
          operation: 'event_append',
          record: acceptedRecord,
          recordKey: String(acceptedRecord.sequence),
          sequence: acceptedRecord.sequence,
        });
      }

      return `${JSON.stringify(transcriptRecord)}\n`;
    };
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => `as_governance_live_events_${mode}`,
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => '2026-07-15T00:00:01.000Z',
    });
    const requestId = {
      conflict: '00000000-0000-4000-8000-000000000233',
      exact: '00000000-0000-4000-8000-000000000231',
      missing: '00000000-0000-4000-8000-000000000232',
    }[mode];
    const run = executor.startTurn(store, turn.id, `Reconcile ${mode} worker events`, {
      requestId,
      workspaceRoots: [],
    });

    if (mode === 'exact') {
      await expect(run).resolves.toBeUndefined();
    } else {
      await expect(run).rejects.toThrow('Worker transcript event reconciliation failed');
    }
    expect(store.getTurnById(turn.id).status).toBe(expectedStatus);
    coreDb.sqlite.close();
  });

  it('imports worker transcript records and tears down the materialized backend session', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-records-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run in OpenShell');
    const completedAt = new Date(
      new Date(turn.startedAt ?? Date.now()).getTime() + 1000
    ).toISOString();
    const backend = new FakeWorkerGovernanceBackend({ sandboxName: 'sandbox_governance_1' });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_1',
      environmentBackend: {
        codexModel: 'gpt-5-codex',
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => completedAt,
    });

    await executor.startTurn(store, turn.id, 'Run in OpenShell', {
      requestId: '00000000-0000-4000-8000-000000000201',
      workspaceCwd: '/Users/m5pro/Documents/AI/openkit',
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath: '/Users/m5pro/Documents/AI/openkit',
          workerPath: '/workspace/openkit',
        },
      ],
    });

    expect(backend.calls).toEqual([
      'materialize',
      'launch',
      'collectEvidence',
      'collectTranscript',
      'collectWorkspaceChanges',
      'collectArtifacts',
      'cleanupSession',
    ]);
    expect(backend.lastPackage?.extensions.openkit).toMatchObject({
      codexCommand: expect.arrayContaining(['--model', 'gpt-5-codex']),
      turnInput: 'Run in OpenShell',
    });
    expect(backend.lastPackage?.runtime.command.workingDirectory).toBe('/workspace/openkit');
    expect(backend.lastContext?.workspaceRoots).toEqual([
      expect.objectContaining({
        id: 'repo',
        sourcePath: '/Users/m5pro/Documents/AI/openkit',
        workerPath: '/workspace/openkit',
      }),
    ]);
    expect(store.getTurnById(turn.id)).toMatchObject({
      status: 'completed',
      completedAt,
    });
    const storedSession = store.getAgentSession('as_governance_1');
    expect(storedSession).toMatchObject({
      environmentPackageSnapshotId: `aepsnap_${turn.id}_as_governance_1`,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      status: 'idle',
    });
    expect(storedSession).not.toHaveProperty('environmentPackageSnapshot');
    expect(
      store
        .listThreadItems('ws_demo', 'th_demo')
        .filter((item) => item.type === 'assistant-message')
    ).toEqual([
      expect.objectContaining({
        text: 'Governed worker completed the task.',
        status: 'completed',
      }),
    ]);
    expect(store.listArtifacts('ws_demo')).toEqual([
      expect.objectContaining({
        title: 'Governed worker report',
        turnId: turn.id,
      }),
    ]);
    const workspaceDb = openTestWorkspaceDb(coreDb);
    expect(listWorkspaceInputSnapshots(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^wis_/),
        resourceId: 'repo',
        strategy: 'git',
      }),
    ]);
    expect(listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^wmr_/),
        inputSnapshotId: expect.stringMatching(/^wis_/),
        materializedRootRef: '/workspace/openkit/worktrees/main',
        workerSessionId: 'sandbox_governance_1',
      }),
    ]);
    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'cleaned',
        packageSnapshotId: `aepsnap_${turn.id}_as_governance_1`,
        workerSessionId: 'sandbox_governance_1',
      }),
    ]);
    expect(
      listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
        (record) => record.phase === 'teardown'
      )
    ).toEqual([
      expect.objectContaining({
        agentSessionId: 'as_governance_1',
        backendType: 'openshell',
        backendVersion: '0.0.63',
        outcome: 'succeeded',
        phase: 'teardown',
        placement: 'local',
        stopReason: 'completed',
        summary: 'Worker backend teardown succeeded.',
        threadId: 'th_demo',
        turnId: turn.id,
        workerImage: 'openkit/worker-codex:dev',
      }),
    ]);
    expect(listWorkspaceChangeSets(workspaceDb, 'ws_demo')).toEqual([]);
    expect(listWorkspaceSyncReviews(workspaceDb, 'ws_demo')).toEqual([]);
    expect(
      requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        'ws_demo',
        `aepsnap_${turn.id}_as_governance_1`
      )
    ).toMatchObject({
      snapshotId: `aepsnap_${turn.id}_as_governance_1`,
      workspaceId: 'ws_demo',
      turnId: turn.id,
      agentSessionId: 'as_governance_1',
      agentId: 'agent_codex_host',
    });

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('reconciles worker inference with runtime provenance before one canonical outer result', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-provenance-success-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Import governed runtime provenance');
    const backend = new FakeWorkerGovernanceBackend({
      capabilities: [
        'container',
        'transcript-sink',
        'worker-control',
        'trusted-worker-inference-relay',
        'worker.runtime-provenance.v1',
      ],
    });
    let capture: TurnRuntimeProvenanceCapture | null = null;
    backend.runtimeProvenanceFactory = (environmentPackage) => {
      capture = createTurnRuntimeProvenanceCapture(
        mkdtempSync(join(tmpdir(), 'openkit-governance-provenance-capture-')),
        environmentPackage
      );
      return capture.collection;
    };
    const workerToken = 'lease-binding:provenance-blackbox-1';
    const workerControlGateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });
    const workerRequests: Array<{ prompt_cache_key?: string }> = [];
    const llmGatewayDispatcher = {
      createResponses: vi.fn(
        async (
          _provider: unknown,
          request: { model: string; prompt_cache_key?: string },
          context: LLMGatewayDispatchContext
        ) => {
          workerRequests.push(request);
          context.onUsage?.({ input_tokens: 3, output_tokens: 1, total_tokens: 4 });
          return {
            id: 'resp_provenance_blackbox',
            model: request.model,
            object: 'response' as const,
            output: [],
            status: 'completed' as const,
          };
        }
      ),
    } as unknown as LLMGatewayProviderDispatcher;
    const app = createApp({
      coreDb,
      llmGatewayDispatcher,
      mode: 'local',
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Agent OpenRouter',
          id: 'agent-openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.2'],
          vendor: 'openrouter',
        },
      ]),
      store,
      workerControlGateway,
    });
    const materialize = backend.materialize.bind(backend);
    vi.spyOn(backend, 'materialize').mockImplementation(async (environmentPackage, context) => {
      workerControlGateway.registerSession(environmentPackage, { sandboxBindingRef: workerToken });
      return materialize(environmentPackage, context);
    });

    /**
     * Posts one canonical Codex worker-inference request through the authenticated relay route.
     *
     * @param nativeThreadId Runtime-native origin thread.
     * @param nativeCacheLineageId Runtime-native cache lineage.
     * @param parentNativeThreadId Optional runtime-native parent thread.
     * @param options Optional body overrides and expected response status.
     * @returns Worker inference route response.
     */
    async function postWorkerInference(
      nativeThreadId: string,
      nativeCacheLineageId: string,
      parentNativeThreadId?: string,
      options: { body?: Record<string, unknown>; expectedStatus?: number } = {}
    ): Promise<Response> {
      const turnMetadata = {
        ...(parentNativeThreadId
          ? { parent_thread_id: parentNativeThreadId, subagent_kind: 'thread_spawn' }
          : {}),
        request_kind: 'turn',
        session_id: TURN_NATIVE_SESSION_ID,
        thread_id: nativeThreadId,
      };
      const encodedMetadata = JSON.stringify(turnMetadata);
      const response = await app.request('/api/worker-inference/v1/responses', {
        body: JSON.stringify({
          client_metadata: {
            session_id: TURN_NATIVE_SESSION_ID,
            thread_id: nativeThreadId,
            ...(parentNativeThreadId
              ? {
                  'x-codex-parent-thread-id': parentNativeThreadId,
                  'x-openai-subagent': 'collab_spawn',
                }
              : {}),
            'x-codex-turn-metadata': encodedMetadata,
          },
          input: 'Deterministic worker inference',
          model: 'openai/gpt-5.2',
          prompt_cache_key: nativeCacheLineageId,
          ...options.body,
        }),
        headers: {
          authorization: `Bearer ${workerToken}`,
          'content-type': 'application/json',
          'session-id': TURN_NATIVE_SESSION_ID,
          'thread-id': nativeThreadId,
          'x-client-request-id': nativeThreadId,
          ...(parentNativeThreadId
            ? {
                'x-codex-parent-thread-id': parentNativeThreadId,
                'x-openai-subagent': 'collab_spawn',
              }
            : {}),
          'x-codex-turn-metadata': encodedMetadata,
        },
        method: 'POST',
      });

      expect(response.status, await response.clone().text()).toBe(options.expectedStatus ?? 200);
      return response;
    }

    const collectTranscript = backend.collectTranscript.bind(backend);
    vi.spyOn(backend, 'collectTranscript').mockImplementation(async () => {
      await postWorkerInference(TURN_ROOT_NATIVE_ID, 'cache_shared');
      await postWorkerInference(TURN_CHILD_NATIVE_ID, 'cache_child_a', TURN_ROOT_NATIVE_ID);
      await postWorkerInference(TURN_CHILD_B_NATIVE_ID, 'cache_shared', TURN_ROOT_NATIVE_ID);
      const bypassResponse = await postWorkerInference(
        TURN_ROOT_NATIVE_ID,
        'cache_shared',
        undefined,
        { body: { provider_id: 'public-default' }, expectedStatus: 403 }
      );
      await expect(bypassResponse.json()).resolves.toMatchObject({
        error: { code: 'worker_inference_lineage_mismatch' },
      });
      expect(workerRequests).toHaveLength(3);
      return collectTranscript();
    });
    const runtimeProvenanceImporter = vi.fn(async (input: ImportWorkerRuntimeProvenanceInput) => {
      backend.calls.push('importRuntimeProvenance');
      expect(
        store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.turnId === turn.id && item.type === 'assistant-message')
      ).toEqual([]);
      expect(capture).not.toBeNull();
      expect(input.capture).toEqual({
        nativeOriginIndexPath: capture?.nativeOriginIndexPath,
        rawStreamsRoot: capture?.rawStreamsRoot,
        streamManifestPath: capture?.streamManifestPath,
      });
      return importWorkerRuntimeProvenance(input);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_provenance_success_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => '2026-07-13T00:00:01.000Z',
      runtimeProvenanceImporter,
    });

    try {
      await executor.startTurn(store, turn.id, 'Import governed runtime provenance', {
        backendRequirements: {
          allowedKinds: ['openshell'],
          preferred: 'openshell',
          requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
        },
        providerSelection: {
          model: 'openai/gpt-5.2',
          providerId: 'agent-openrouter',
        },
        requestId: '00000000-0000-4000-8000-000000000220',
        workspaceRoots: [],
      });

      expect(runtimeProvenanceImporter).toHaveBeenCalledOnce();
      expect(backend.calls.indexOf('importRuntimeProvenance')).toBeGreaterThan(
        backend.calls.indexOf('collectTranscript')
      );
      expect(backend.calls.indexOf('importRuntimeProvenance')).toBeLessThan(
        backend.calls.indexOf('collectWorkspaceChanges')
      );
      const evidenceResponse = await app.request('/api/app/workspaces/ws_demo/evidence-bundles');
      expect(evidenceResponse.status, await evidenceResponse.clone().text()).toBe(200);
      const evidence = ListWorkspaceEvidenceBundlesResponseSchema.parse(
        await evidenceResponse.json()
      );
      const rawBundle = evidence.evidenceBundles.find(
        (bundle) => bundle.sourceKind === 'worker-runtime-provenance-raw'
      );
      const indexBundle = evidence.evidenceBundles.find(
        (bundle) => bundle.sourceKind === 'worker-runtime-provenance-index'
      );
      expect(
        evidence.evidenceBundles.filter(
          (bundle) => bundle.sourceKind === 'worker-runtime-provenance-raw'
        )
      ).toHaveLength(1);
      expect(
        evidence.evidenceBundles.filter(
          (bundle) => bundle.sourceKind === 'worker-runtime-provenance-index'
        )
      ).toHaveLength(1);
      expect(rawBundle).toMatchObject({
        importStatus: 'promoted',
        rawEvidenceRefs: [],
        retentionClass: 'restricted-raw',
      });
      expect(indexBundle).toMatchObject({
        importStatus: 'promoted',
        retentionClass: 'turn-evidence',
      });
      expect(indexBundle?.summary).toContain('4 streams');
      expect(indexBundle?.summary).toContain('2 children');
      expect(indexBundle?.summary).toContain('3/3 gateway calls reconciled');
      const upstreamCacheKeys = workerRequests.map((request) => request.prompt_cache_key);
      expect(upstreamCacheKeys).toEqual([
        expect.stringMatching(/^openkit:responses:[a-f0-9]{32}$/),
        expect.stringMatching(/^openkit:responses:[a-f0-9]{32}$/),
        expect.stringMatching(/^openkit:responses:[a-f0-9]{32}$/),
      ]);
      expect(upstreamCacheKeys[0]).toBe(upstreamCacheKeys[2]);
      expect(upstreamCacheKeys[1]).not.toBe(upstreamCacheKeys[2]);
      expect(JSON.stringify(workerRequests)).not.toContain('cache_shared');
      expect(JSON.stringify(workerRequests)).not.toContain('cache_child_a');

      const usageResponse = await app.request('/api/app/workspaces/ws_demo/capability-usage');
      expect(usageResponse.status, await usageResponse.clone().text()).toBe(200);
      const usage = CapabilityUsageResponseSchema.parse(await usageResponse.json());
      const workerCalls = usage.capabilityCalls.filter(
        (call) => call.serviceRef === 'worker-inference-gateway'
      );
      const packageSnapshotId = backend.lastPackage!.snapshotId;
      const rootOriginRef = createWorkerRuntimeOriginRef(packageSnapshotId, TURN_ROOT_NATIVE_ID);
      const childOriginRef = createWorkerRuntimeOriginRef(packageSnapshotId, TURN_CHILD_NATIVE_ID);
      const childBOriginRef = createWorkerRuntimeOriginRef(
        packageSnapshotId,
        TURN_CHILD_B_NATIVE_ID
      );
      const callsByOrigin = new Map(workerCalls.map((call) => [call.runtimeOriginRef, call]));
      const workerCallIds = new Set(workerCalls.map((call) => call.id));
      expect(workerCalls).toHaveLength(3);
      expect(new Set(workerCalls.map((call) => call.packageSnapshotId))).toEqual(
        new Set([packageSnapshotId])
      );
      expect(new Set(workerCalls.map((call) => call.requestId))).toHaveProperty('size', 3);
      expect(new Set(workerCalls.map((call) => call.runtimeOriginRef))).toEqual(
        new Set([rootOriginRef, childOriginRef, childBOriginRef])
      );
      expect(callsByOrigin.get(rootOriginRef)?.runtimeCacheLineageRef).toBe(
        callsByOrigin.get(childBOriginRef)?.runtimeCacheLineageRef
      );
      expect(callsByOrigin.get(childOriginRef)?.runtimeCacheLineageRef).not.toBe(
        callsByOrigin.get(childBOriginRef)?.runtimeCacheLineageRef
      );
      expect(
        new Set(
          usage.usageRecords
            .filter((record) => workerCallIds.has(record.capabilityCallId))
            .map((record) => record.capabilityCallId)
        )
      ).toEqual(workerCallIds);

      const auditResponse = await app.request('/api/app/workspaces/ws_demo/audit/events');
      expect(auditResponse.status, await auditResponse.clone().text()).toBe(200);
      const audit = ListWorkspaceAuditEventsResponseSchema.parse(await auditResponse.json());
      const linkedFinishEvents = audit.auditEvents.filter(
        (event) =>
          event.action === 'capability.finish' &&
          event.capabilityCallId !== null &&
          workerCallIds.has(event.capabilityCallId)
      );
      expect(new Set(linkedFinishEvents.map((event) => event.capabilityCallId))).toEqual(
        workerCallIds
      );
      expect(linkedFinishEvents.every((event) => event.outcome === 'succeeded')).toBe(true);

      const runtimeEvidenceResponse = await app.request(
        '/api/app/workspaces/ws_demo/runtime-evidence'
      );
      expect(runtimeEvidenceResponse.status, await runtimeEvidenceResponse.clone().text()).toBe(
        200
      );
      const runtimeEvidence = ListWorkspaceRuntimeEvidenceResponseSchema.parse(
        await runtimeEvidenceResponse.json()
      ).runtimeEvidence.filter((record) => record.phase === 'transcript-collection');
      expect(runtimeEvidence).toEqual([
        expect.objectContaining({
          outcome: 'succeeded',
          phase: 'transcript-collection',
        }),
      ]);
      expect(runtimeEvidence[0]?.evidenceBundleIds).toHaveLength(2);
      const itemsResponse = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/items');
      expect(itemsResponse.status, await itemsResponse.clone().text()).toBe(200);
      const turnItems = ListThreadItemsResponseSchema.parse(
        await itemsResponse.json()
      ).items.filter((item) => item.turnId === turn.id);
      expect(turnItems.filter((item) => item.type === 'assistant-message')).toEqual([
        expect.objectContaining({
          text: 'Governed worker completed the task.',
          type: 'assistant-message',
        }),
      ]);
      expect(JSON.stringify(turnItems)).not.toContain(TURN_CHILD_RAW_MESSAGE);
      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'completed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'missing',
    'tampered',
  ] as const)('fails the outer turn while retaining %s runtime provenance quarantine evidence', async (failure) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `openkit-governance-provenance-${failure}-`));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn('ws_demo', 'th_demo', `Reject ${failure} runtime provenance`);
    const backend = new FakeWorkerGovernanceBackend({
      capabilities: [
        'container',
        'transcript-sink',
        'worker-control',
        'trusted-worker-inference-relay',
        'worker.runtime-provenance.v1',
      ],
    });
    backend.runtimeProvenanceFactory = (environmentPackage) =>
      createTurnRuntimeProvenanceCapture(
        mkdtempSync(join(tmpdir(), `openkit-governance-provenance-${failure}-capture-`)),
        environmentPackage,
        failure
      ).collection;
    const runtimeProvenanceImporter = vi.fn(async (input: ImportWorkerRuntimeProvenanceInput) => {
      backend.calls.push('importRuntimeProvenance');
      return importWorkerRuntimeProvenance(input);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => `as_governance_provenance_${failure}_1`,
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => '2026-07-13T00:00:01.000Z',
      runtimeProvenanceImporter,
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, `Reject ${failure} runtime provenance`, {
          backendRequirements: {
            allowedKinds: ['openshell'],
            preferred: 'openshell',
            requiredCapabilities: [
              'trusted-worker-inference-relay',
              'worker.runtime-provenance.v1',
            ],
          },
          providerSelection: {
            model: 'openai/gpt-5.2',
            providerId: 'agent-openrouter',
          },
          requestId: `00000000-0000-4000-8000-${failure === 'missing' ? '000000000221' : '000000000222'}`,
          workspaceRoots: [],
        })
      ).rejects.toThrow();

      expect(runtimeProvenanceImporter).toHaveBeenCalledOnce();
      expect(backend.calls.at(-1)).toBe('cleanupSession');
      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(
        store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.turnId === turn.id && item.type === 'assistant-message')
      ).toEqual([]);
      const workspaceDb = openTestWorkspaceDb(coreDb);
      expect(listWorkspaceEvidenceBundles(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          importStatus: 'quarantined',
          sourceKind: 'worker-runtime-provenance-raw',
        }),
      ]);
      const runtimeEvidence = listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
        (record) => record.phase === 'transcript-collection'
      );
      expect(runtimeEvidence).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          phase: 'transcript-collection',
        }),
      ]);
      expect(runtimeEvidence[0]?.evidenceBundleIds).toHaveLength(1);
      workspaceDb.sqlite.close();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('binds the trusted provider selection into the materialized package', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run trusted worker inference');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      createAgentSessionId: () => 'as_governance_relay_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    await executor.startTurn(store, turn.id, 'Run trusted worker inference', {
      backendRequirements: {
        allowedKinds: ['openshell'],
        preferred: 'openshell',
        requiredCapabilities: ['trusted-worker-inference-relay'],
      },
      providerSelection: {
        model: 'openai/gpt-5.2',
        providerId: 'agent-openrouter',
      },
      requestId: '00000000-0000-4000-8000-000000000214',
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    });

    expect(backend.lastPackage?.llm.routes).toEqual([
      expect.objectContaining({
        model: 'openai/gpt-5.2',
        providerInstanceId: 'agent-openrouter',
      }),
    ]);
    expect(backend.lastPackage?.providers.providerInstances).toEqual([
      expect.objectContaining({
        id: 'agent-openrouter',
        kind: 'gateway',
        models: ['openai/gpt-5.2'],
      }),
    ]);
    expect(
      (backend.lastPackage?.extensions.openkit as { codexCommand?: string[] }).codexCommand
    ).toEqual(expect.arrayContaining(['--model', 'openai/gpt-5.2']));
  });

  it('stages linked review branches while ingesting production worker changes', async () => {
    const fixture = createWorkspaceChangeIngressFixture(
      'staged_review_branch',
      'git',
      'review-branch'
    );
    const baseCommit = runTestGit(fixture.repositoryPath, ['rev-parse', 'HEAD']).trim();
    const initialStatus = runTestGit(fixture.repositoryPath, ['status', '--short']);
    const initialWorktrees = runTestGit(fixture.repositoryPath, [
      'worktree',
      'list',
      '--porcelain',
    ]);

    recordTestWorkspaceReviewMaterialization(fixture.workspaceDb, {
      artifactId: fixture.artifactId,
      ...fixture.record,
    });

    await ingestWorkspaceChangeFixture(fixture, fixture.record);

    const branchCommit = runTestGit(fixture.repositoryPath, [
      'rev-parse',
      '--verify',
      fixture.reviewBranchRef,
    ]).trim();
    expect(branchCommit).not.toBe(baseCommit);
    expect(runTestGit(fixture.repositoryPath, ['show', `${branchCommit}:README.md`])).toBe(
      '# Demo\n\nReviewed.\n'
    );
    expect(runTestGit(fixture.repositoryPath, ['rev-parse', 'HEAD']).trim()).toBe(baseCommit);
    expect(runTestGit(fixture.repositoryPath, ['status', '--short'])).toBe(initialStatus);
    expect(runTestGit(fixture.repositoryPath, ['worktree', 'list', '--porcelain'])).toBe(
      initialWorktrees
    );
    expect(listWorkspaceChangeSets(fixture.workspaceDb, fixture.workspaceId)).toEqual([
      expect.objectContaining({
        head: expect.objectContaining({ commit: branchCommit }),
        id: fixture.record.changeSet.id,
      }),
    ]);
    const artifact = fixture.store.getArtifact(fixture.workspaceId, fixture.artifactId);
    expect(artifact.content.format).toBe('json');
    expect(artifact.content.body).toContain(branchCommit);
    fixture.workspaceDb.sqlite.close();
  });

  it('accepts equivalent workspace bases with different object key order', async () => {
    const fixture = createWorkspaceChangeIngressFixture(
      'equivalent_base_key_order',
      'git',
      'staging-root'
    );
    const record = {
      ...fixture.record,
      changeSet: {
        ...fixture.record.changeSet,
        base: {
          contentDigest: fixture.record.changeSet.base.contentDigest,
          commit: fixture.record.changeSet.base.commit,
        },
      },
    } satisfies WorkerGovernanceWorkspaceChangeRecord;

    await ingestWorkspaceChangeFixture(fixture, record);

    expect(listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId)).toEqual([
      expect.objectContaining({ review: expect.objectContaining({ id: fixture.reviewId }) }),
    ]);
    fixture.workspaceDb.sqlite.close();
  });

  it('keeps Git workspace changes reviewable when durable workspace storage is disabled', async () => {
    const fixture = createWorkspaceChangeIngressFixture('git_without_core_db', 'git', 'missing');
    const backend = new FakeWorkerGovernanceBackend();
    const collectWorkspaceChanges = vi
      .spyOn(backend, 'collectWorkspaceChanges')
      .mockResolvedValue([fixture.record]);
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      createAgentSessionId: () => 'as_git_without_core_db_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => fixture.timestamp,
    });

    try {
      await executor.startTurn(
        fixture.store,
        fixture.environmentPackage.scope.turnId,
        'Review Git changes without durable workspace storage',
        { requestId: '00000000-0000-4000-8000-000000000202', workspaceRoots: [] }
      );

      expect(fixture.store.getArtifact(fixture.workspaceId, fixture.artifactId)).toMatchObject({
        id: fixture.artifactId,
        kind: 'diff',
        status: 'ready',
      });
      expect(fixture.store.getTurnById(fixture.environmentPackage.scope.turnId)).toMatchObject({
        status: 'completed',
      });
    } finally {
      collectWorkspaceChanges.mockRestore();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('scopes worker packages and workspace synchronization records to the store actor', async () => {
    const actorId = 'user_governance_actor';
    const fixture = createWorkspaceChangeIngressFixture('actor_scope', 'git', 'missing');
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-actor-scope-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ userId: actorId });
    const workspace = store.listWorkspaces().find((candidate) => candidate.kind === 'code');
    if (!workspace) {
      throw new Error('Actor-scoped demo workspace was not created.');
    }
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) {
      throw new Error('Actor-scoped demo thread was not created.');
    }
    const turn = store.createTurn(workspace.id, thread.id, 'Persist actor-scoped review records');
    const setupDb = openWorkspaceDb(dataRoot, store.getUserId(), workspace.id);
    applyScopedMigrations(setupDb);
    upsertWorkspaceRepositoryResource(setupDb, {
      displayName: 'Actor-scoped repository',
      git: {
        authorEmail: 'actor@example.invalid',
        authorName: 'Actor User',
        stagingStrategy: 'staging-root',
      },
      localPath: fixture.repositoryPath,
      resourceId: 'repo',
      workspaceExists: (candidateWorkspaceId) => candidateWorkspaceId === workspace.id,
      workspaceId: workspace.id,
    });
    setupDb.sqlite.close();
    const backend = new FakeWorkerGovernanceBackend();
    const collectWorkspaceChanges = vi
      .spyOn(backend, 'collectWorkspaceChanges')
      .mockImplementation(async () => {
        if (!backend.lastPackage) {
          throw new Error('Actor-scoped package was not materialized.');
        }
        const commit = backend.lastPackage.workspace.inputs[0]?.source.commit;
        if (typeof commit !== 'string') {
          throw new Error('Actor-scoped package did not capture its Git base.');
        }
        const base = { commit, contentDigest: null };
        return [
          {
            ...fixture.record,
            changeSet: {
              ...fixture.record.changeSet,
              base,
              evidenceRefs: [{ kind: 'worker', ref: turn.id }],
              inputSnapshotId: `wis_${backend.lastPackage.snapshotId}_repo`,
              materializationRecordId: `wmr_${backend.lastPackage.snapshotId}_repo`,
              workspaceId: workspace.id,
            },
            review: {
              ...fixture.record.review,
              workspaceId: workspace.id,
            },
          },
        ];
      });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_actor_scope_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => fixture.timestamp,
    });
    let startError: unknown = null;

    try {
      try {
        await executor.startTurn(store, turn.id, 'Persist actor-scoped review records', {
          requestId: '00000000-0000-4000-8000-000000000203',
          workspaceCwd: fixture.repositoryPath,
          workspaceRoots: [
            {
              access: 'read-write',
              id: 'repo',
              sourceKind: 'host-dir',
              sourcePath: fixture.repositoryPath,
              workerPath: '/workspace/repo',
            },
          ],
        });
      } catch (error) {
        startError = error;
      }

      const actorDb = openWorkspaceDb(dataRoot, store.getUserId(), workspace.id);
      applyScopedMigrations(actorDb);
      const localDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, workspace.id);
      applyScopedMigrations(localDb);
      try {
        expect.soft(startError).toBeNull();
        expect.soft(backend.lastPackage?.scope.userId).toBe(store.getUserId());
        expect.soft(listWorkspaceInputSnapshots(actorDb, workspace.id)).toHaveLength(1);
        expect.soft(listWorkspaceSyncReviews(actorDb, workspace.id)).toEqual([
          expect.objectContaining({
            review: expect.objectContaining({
              id: fixture.reviewId,
              staging: expect.objectContaining({ branch: null }),
            }),
          }),
        ]);
        expect.soft(listWorkspaceInputSnapshots(localDb, workspace.id)).toEqual([]);
        expect.soft(listWorkspaceSyncReviews(localDb, workspace.id)).toEqual([]);
      } finally {
        actorDb.sqlite.close();
        localDb.sqlite.close();
      }
    } finally {
      collectWorkspaceChanges.mockRestore();
      fixture.workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('compensates a persisted review artifact when ingress persistence fails', async () => {
    const fixture = createWorkspaceChangeIngressFixture(
      'artifact_compensation',
      'git',
      'review-branch'
    );
    const createArtifact = fixture.store.createArtifact.bind(fixture.store);
    fixture.store.createArtifact = (artifact) => {
      const created = createArtifact(artifact);

      if (artifact.id === fixture.artifactId) {
        throw new Error('artifact persistence failed after write');
      }
      return created;
    };

    recordTestWorkspaceReviewMaterialization(fixture.workspaceDb, {
      artifactId: fixture.artifactId,
      ...fixture.record,
    });

    await expect(ingestWorkspaceChangeFixture(fixture, fixture.record)).rejects.toThrow(
      'artifact persistence failed after write'
    );

    expect(fixture.store.listArtifacts(fixture.workspaceId)).toEqual([]);
    expect(
      createDemoStore({ dataRoot: fixture.storeDataRoot }).listArtifacts(fixture.workspaceId)
    ).toEqual([]);
    expect(testGitRefExists(fixture.repositoryPath, fixture.reviewBranchRef)).toBe(false);
    expect(listWorkspaceChangeSets(fixture.workspaceDb, fixture.workspaceId)).toEqual([]);
    expect(listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId)).toEqual([]);
    fixture.workspaceDb.sqlite.close();
  });

  const rejectedIngressCases: readonly {
    readonly inputStrategy?: 'git' | 'filesystem';
    readonly materializationStrategy?: 'git' | 'filesystem';
    readonly mutate: (
      record: WorkerGovernanceWorkspaceChangeRecord
    ) => WorkerGovernanceWorkspaceChangeRecord;
    readonly name: string;
    readonly repositoryStrategy: 'missing' | 'review-branch' | 'staging-root';
    readonly strategy: 'git' | 'filesystem';
  }[] = [
    ...(['accepted', 'needs_refinement', 'rejected', 'blocked'] as const).map((status) => ({
      mutate: (record: WorkerGovernanceWorkspaceChangeRecord) => ({
        ...record,
        review: { ...record.review, status },
      }),
      name: `non-pending ${status} review`,
      repositoryStrategy: 'review-branch' as const,
      strategy: 'git' as const,
    })),
    {
      mutate: (record) => ({
        ...record,
        review: {
          ...record.review,
          staging: {
            branch: null,
            ref: `filesystem-staging://${record.review.id}`,
            strategy: 'filesystem_staging',
          },
        },
      }),
      name: 'Git change set with filesystem staging',
      repositoryStrategy: 'review-branch',
      strategy: 'git',
    },
    {
      mutate: (record) => ({
        ...record,
        review: {
          ...record.review,
          staging: {
            branch: `openkit/review/${record.review.id}`,
            ref: `staging://workspace/${record.changeSet.id}`,
            strategy: 'git_worktree',
          },
        },
      }),
      name: 'filesystem change set with Git staging',
      repositoryStrategy: 'missing',
      strategy: 'filesystem',
    },
    {
      inputStrategy: 'filesystem',
      mutate: (record) => record,
      name: 'change-set and input-snapshot strategy mismatch',
      repositoryStrategy: 'review-branch',
      strategy: 'git',
    },
    {
      materializationStrategy: 'filesystem',
      mutate: (record) => record,
      name: 'change-set and materialization strategy mismatch',
      repositoryStrategy: 'review-branch',
      strategy: 'git',
    },
    {
      mutate: (record) => record,
      name: 'Git change set without its exact repository resource',
      repositoryStrategy: 'missing',
      strategy: 'git',
    },
    {
      mutate: (record) => ({ ...record, filesystemApply: null }),
      name: 'filesystem change set without apply metadata',
      repositoryStrategy: 'missing',
      strategy: 'filesystem',
    },
    {
      mutate: (record) => ({
        ...record,
        filesystemApply: record.filesystemApply
          ? {
              ...record.filesystemApply,
              before: { ...record.filesystemApply.before, workspaceId: 'ws_other' },
            }
          : null,
      }),
      name: 'filesystem before snapshot from another workspace',
      repositoryStrategy: 'missing',
      strategy: 'filesystem',
    },
    {
      mutate: (record) => ({
        ...record,
        filesystemApply: record.filesystemApply
          ? {
              ...record.filesystemApply,
              before: { ...record.filesystemApply.before, resourceId: 'repo_other' },
            }
          : null,
      }),
      name: 'filesystem before snapshot from another resource',
      repositoryStrategy: 'missing',
      strategy: 'filesystem',
    },
    {
      mutate: (record) => ({
        ...record,
        filesystemApply: record.filesystemApply
          ? {
              ...record.filesystemApply,
              before: {
                ...record.filesystemApply.before,
                contentDigest: `sha256:${'9'.repeat(64)}`,
              },
            }
          : null,
      }),
      name: 'filesystem before snapshot with another content digest',
      repositoryStrategy: 'missing',
      strategy: 'filesystem',
    },
    {
      mutate: (record) => ({ ...record, patchPayload: null }),
      name: 'Git change set without patch payload',
      repositoryStrategy: 'staging-root',
      strategy: 'git',
    },
    {
      mutate: (record) => ({
        ...record,
        changeSet: { ...record.changeSet, patch: null },
      }),
      name: 'Git change set without patch reference',
      repositoryStrategy: 'staging-root',
      strategy: 'git',
    },
    {
      mutate: (record) => ({
        ...record,
        patchPayload: record.patchPayload
          ? { ...record.patchPayload, digest: `sha256:${'8'.repeat(64)}` }
          : null,
      }),
      name: 'Git patch payload that mismatches its reference',
      repositoryStrategy: 'staging-root',
      strategy: 'git',
    },
  ];

  it('reports a non-secret workspace review actionability reason', async () => {
    const fixture = createWorkspaceChangeIngressFixture(
      'actionability_reason',
      'git',
      'staging-root'
    );
    let ingressError: unknown;

    try {
      await ingestWorkspaceChangeFixture(fixture, {
        ...fixture.record,
        patchPayload: null,
      });
    } catch (error) {
      ingressError = error;
    }

    expect(ingressError).toMatchObject({
      message: `Workspace review is not actionable (git_patch_invalid): ${fixture.reviewId}`,
    });
    fixture.workspaceDb.sqlite.close();
  });

  it.each(rejectedIngressCases)('rejects $name before review effects', async ({
    inputStrategy,
    materializationStrategy,
    mutate,
    name,
    repositoryStrategy,
    strategy,
  }) => {
    const fixture = createWorkspaceChangeIngressFixture(
      name.replaceAll(/[^a-z0-9]+/gi, '_').toLowerCase(),
      strategy,
      repositoryStrategy
    );
    let ingressError: unknown;

    try {
      await ingestWorkspaceChangeFixture(
        fixture,
        mutate(fixture.record),
        inputStrategy,
        materializationStrategy
      );
    } catch (error) {
      ingressError = error;
    }

    expect({
      branchExists: testGitRefExists(fixture.repositoryPath, fixture.reviewBranchRef),
      changeSetIds: listWorkspaceChangeSets(fixture.workspaceDb, fixture.workspaceId).map(
        (changeSet) => changeSet.id
      ),
      filesystemStagingExists: Boolean(
        getFilesystemWorkspaceStagingRoot(
          fixture.workspaceDb,
          fixture.workspaceId,
          fixture.reviewId
        )
      ),
      rejected: ingressError instanceof Error,
      reviewArtifactIds: fixture.store
        .listArtifacts(fixture.workspaceId)
        .filter((artifact) => artifact.id === fixture.artifactId)
        .map((artifact) => artifact.id),
      reviewIds: listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId).map(
        (item) => item.review.id
      ),
    }).toEqual({
      branchExists: false,
      changeSetIds: [],
      filesystemStagingExists: false,
      rejected: true,
      reviewArtifactIds: [],
      reviewIds: [],
    });
    fixture.workspaceDb.sqlite.close();
  });

  it('rejects a conflicting pre-existing review artifact without overwriting or deleting it', async () => {
    const fixture = createWorkspaceChangeIngressFixture(
      'conflicting_artifact',
      'git',
      'review-branch'
    );
    const existingArtifact = fixture.store.createArtifact({
      content: { body: 'Unrelated artifact content.', format: 'markdown' },
      createdAt: fixture.timestamp,
      id: fixture.artifactId,
      kind: 'diff',
      status: 'ready',
      summary: 'Existing unrelated artifact.',
      threadId: fixture.environmentPackage.scope.threadId,
      title: 'Existing unrelated artifact',
      turnId: fixture.environmentPackage.scope.turnId,
      updatedAt: fixture.timestamp,
      version: 1,
      workspaceId: fixture.workspaceId,
    });
    let ingressError: unknown;

    try {
      await ingestWorkspaceChangeFixture(fixture, fixture.record);
    } catch (error) {
      ingressError = error;
    }

    expect({
      artifactUnchanged:
        JSON.stringify(fixture.store.getArtifact(fixture.workspaceId, fixture.artifactId)) ===
        JSON.stringify(existingArtifact),
      branchExists: testGitRefExists(fixture.repositoryPath, fixture.reviewBranchRef),
      changeSetIds: listWorkspaceChangeSets(fixture.workspaceDb, fixture.workspaceId).map(
        (changeSet) => changeSet.id
      ),
      rejected: ingressError instanceof Error,
      reviewIds: listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId).map(
        (item) => item.review.id
      ),
    }).toEqual({
      artifactUnchanged: true,
      branchExists: false,
      changeSetIds: [],
      rejected: true,
      reviewIds: [],
    });
    fixture.workspaceDb.sqlite.close();
  });

  it('adopts an exact orphan review artifact without rewriting it', async () => {
    const fixture = createWorkspaceChangeIngressFixture(
      'exact_orphan_artifact',
      'git',
      'staging-root'
    );
    const review = {
      ...fixture.record.review,
      staging: { ...fixture.record.review.staging, branch: null },
    };
    const orphanArtifact = fixture.store.createArtifact({
      content: {
        body: JSON.stringify(
          {
            changeSet: fixture.record.changeSet,
            patchPayload: fixture.record.patchPayload,
            review,
          },
          null,
          2
        ),
        format: 'json',
      },
      createdAt: fixture.timestamp,
      id: fixture.artifactId,
      kind: 'diff',
      status: 'ready',
      summary: review.riskSummary,
      threadId: fixture.environmentPackage.scope.threadId,
      title: 'Workspace changes ready for review',
      turnId: fixture.environmentPackage.scope.turnId,
      updatedAt: fixture.timestamp,
      version: 1,
      workspaceId: fixture.workspaceId,
    });
    const createArtifact = vi.spyOn(fixture.store, 'createArtifact');

    try {
      recordTestWorkspaceReviewMaterialization(fixture.workspaceDb, {
        artifactId: fixture.artifactId,
        ...fixture.record,
      });
      await ingestWorkspaceChangeFixture(fixture, fixture.record);

      expect(createArtifact.mock.calls.length).toBe(0);
      expect(fixture.store.getArtifact(fixture.workspaceId, fixture.artifactId)).toEqual(
        orphanArtifact
      );
      expect(listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId)).toEqual([
        expect.objectContaining({ artifactId: fixture.artifactId, review }),
      ]);
    } finally {
      createArtifact.mockRestore();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('passes user-declared sandbox access into the resolved worker package', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-sandbox-access-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run with sandbox access');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_sandbox_access_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => '2026-06-16T00:00:00.000Z',
    });

    await executor.startTurn(store, turn.id, 'Run with sandbox access', {
      requestId: '00000000-0000-4000-8000-000000000204',
      sandboxAccess: {
        filesystem: [
          {
            access: 'read-write',
            id: 'tool_cache',
            purpose: 'Tool cache',
            targetPath: '/sandbox/.cache/tool',
          },
        ],
        network: [
          {
            host: 'registry.npmjs.org',
            id: 'npm_registry',
            port: 443,
            purpose: 'Install dependencies',
          },
        ],
      },
      workspaceRoots: [],
    });

    expect(backend.lastPackage?.policy.filesystem?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tool_cache',
          workerPath: '/sandbox/.cache/tool',
        }),
      ])
    );
    expect(backend.lastPackage?.policy.network?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: 'registry.npmjs.org',
          id: 'npm_registry',
          port: 443,
        }),
      ])
    );

    coreDb.sqlite.close();
  });

  it('keeps workspace handles pending and omits teardown evidence when cleanup fails', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-teardown-fail-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run in OpenShell');
    const backend = new FakeWorkerGovernanceBackend({ sandboxName: 'sandbox_teardown_fail_1' });
    backend.failTeardown = true;
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_teardown_fail_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => '2026-06-16T00:00:00.000Z',
    });

    await expect(
      executor.startTurn(store, turn.id, 'Run in OpenShell', {
        requestId: '00000000-0000-4000-8000-000000000205',
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: '/Users/m5pro/Documents/AI/openkit',
            workerPath: '/workspace/openkit',
          },
        ],
      })
    ).rejects.toThrow('teardown failed');

    const workspaceDb = openTestWorkspaceDb(coreDb);

    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'pending',
        workerSessionId: 'sandbox_teardown_fail_1',
      }),
    ]);
    expect(
      listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
        (record) => record.phase === 'teardown'
      )
    ).toEqual([]);

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('retries teardown during final cleanup and records a successful retry', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-teardown-retry-')));
    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Retry OpenShell teardown');
    const backend = new FakeWorkerGovernanceBackend({ sandboxName: 'sandbox_teardown_retry_1' });
    backend.teardownFailuresRemaining = 1;
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_teardown_retry_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    await expect(
      executor.startTurn(store, turn.id, 'Retry OpenShell teardown', {
        requestId: '00000000-0000-4000-8000-000000000206',
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: '/Users/m5pro/Documents/AI/openkit',
            workerPath: '/workspace/openkit',
          },
        ],
      })
    ).rejects.toThrow('teardown failed');

    expect(backend.calls.filter((call) => call === 'cleanupSession')).toHaveLength(2);
    expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
    const workspaceDb = openTestWorkspaceDb(coreDb);
    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'cleaned',
        workerSessionId: 'sandbox_teardown_retry_1',
      }),
    ]);
    expect(
      listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
        (record) => record.phase === 'teardown'
      )
    ).toEqual([
      expect.objectContaining({
        agentSessionId: 'as_teardown_retry_1',
        outcome: 'succeeded',
        stopReason: 'completed',
        summary: 'Worker backend teardown succeeded.',
      }),
    ]);
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('closes workspace storage and fails the turn when cleanup status persistence fails', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-cleanup-status-')));
    applyMigrations(coreDb);

    const setupDb = openTestWorkspaceDb(coreDb);
    const sqlitePrototype = Object.getPrototypeOf(setupDb.sqlite) as {
      close: typeof setupDb.sqlite.close;
      prepare: typeof setupDb.sqlite.prepare;
    };
    const prepare = sqlitePrototype.prepare;
    const prepareSpy = vi.spyOn(sqlitePrototype, 'prepare').mockImplementation(function (sql) {
      if (sql.includes('UPDATE backend_workspace_handles')) {
        return {
          run: () => {
            throw new Error('cleanup status persistence failed');
          },
        } as ReturnType<typeof setupDb.sqlite.prepare>;
      }
      return prepare.call(this, sql);
    });
    const closeSpy = vi.spyOn(sqlitePrototype, 'close');
    setupDb.sqlite.close();
    closeSpy.mockClear();

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Fail cleanup status persistence');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_cleanup_status_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Fail cleanup status persistence', {
          requestId: '00000000-0000-4000-8000-000000000207',
          workspaceRoots: [
            {
              access: 'read-write',
              id: 'repo',
              sourceKind: 'host-dir',
              sourcePath: '/Users/m5pro/Documents/AI/openkit',
              workerPath: '/workspace/openkit',
            },
          ],
        })
      ).rejects.toThrow('cleanup status persistence failed');

      expect(backend.calls.filter((call) => call === 'cleanupSession')).toHaveLength(1);
      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
      prepareSpy.mockRestore();
    }

    const workspaceDb = openTestWorkspaceDb(coreDb);
    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'pending',
        workerSessionId: 'openkit-as_cleanup_status_1',
      }),
    ]);
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('fails with one terminal outcome when workspace storage cannot be opened', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-workspace-open-fail-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    mkdirSync(workspaceDbPath(dataRoot, LOCAL_USER_ID, 'ws_demo'), { recursive: true });

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Fail workspace storage open');
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      coreDb,
      createAgentSessionId: () => 'as_workspace_open_fail_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Fail workspace storage open', {
          requestId: '00000000-0000-4000-8000-000000000208',
          workspaceRoots: [],
        })
      ).rejects.toThrow();

      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(
        store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: 'error' }),
        }),
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails with one terminal outcome when workspace storage migration fails', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-workspace-migrate-fail-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const setupDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, 'ws_demo');
    const sqlitePrototype = Object.getPrototypeOf(setupDb.sqlite) as {
      exec: typeof setupDb.sqlite.exec;
    };
    setupDb.sqlite.close();
    const execSpy = vi.spyOn(sqlitePrototype, 'exec').mockImplementationOnce(() => {
      throw new Error('injected workspace migration failure');
    });

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Fail workspace storage migration');
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      coreDb,
      createAgentSessionId: () => 'as_workspace_migrate_fail_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Fail workspace storage migration', {
          requestId: '00000000-0000-4000-8000-000000000209',
          workspaceRoots: [],
        })
      ).rejects.toThrow('Failed to apply migration workspace_0000_baseline');

      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(
        store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: 'error' }),
        }),
      ]);
    } finally {
      execSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('does not emit completed before failed when workspace storage close fails', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-close-fail-')));
    applyMigrations(coreDb);
    const setupDb = openTestWorkspaceDb(coreDb);
    const sqlitePrototype = Object.getPrototypeOf(setupDb.sqlite) as {
      close: typeof setupDb.sqlite.close;
    };
    setupDb.sqlite.close();
    const closeSpy = vi.spyOn(sqlitePrototype, 'close').mockImplementationOnce(() => {
      throw new Error('workspace storage close failed');
    });

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Fail workspace storage close');
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      coreDb,
      createAgentSessionId: () => 'as_workspace_close_fail_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Fail workspace storage close', {
          requestId: '00000000-0000-4000-8000-000000000210',
          workspaceRoots: [],
        })
      ).rejects.toThrow('workspace storage close failed');

      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(
        store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: 'error' }),
        }),
      ]);
    } finally {
      closeSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('fails terminally when completed turn persistence fails after the session becomes idle', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Fail completed turn persistence');
    const updateTurn = store.updateTurn.bind(store);
    const updateTurnSpy = vi.spyOn(store, 'updateTurn').mockImplementation((turnId, patch) => {
      if (patch.status === 'completed') {
        throw new Error('completed turn persistence failed');
      }
      return updateTurn(turnId, patch);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      createAgentSessionId: () => 'as_completed_turn_persistence_fail_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Fail completed turn persistence', {
          requestId: '00000000-0000-4000-8000-000000000211',
          workspaceRoots: [],
        })
      ).rejects.toThrow('completed turn persistence failed');

      expect(store.getAgentSession('as_completed_turn_persistence_fail_1')).toMatchObject({
        status: 'failed',
      });
      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(
        store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: 'error' }),
        }),
      ]);
    } finally {
      updateTurnSpy.mockRestore();
    }
  });

  it('fails terminally when the backend rejects without an error value', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Reject without an error value');
    const backend = new FakeWorkerGovernanceBackend();
    const collectEvidenceSpy = vi.spyOn(backend, 'collectEvidence').mockRejectedValue(undefined);
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      createAgentSessionId: () => 'as_falsey_rejection_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });
    let rejected = false;

    try {
      await executor.startTurn(store, turn.id, 'Reject without an error value', {
        requestId: '00000000-0000-4000-8000-000000000101',
        workspaceRoots: [],
      });
    } catch {
      rejected = true;
    } finally {
      collectEvidenceSpy.mockRestore();
    }

    expect({
      rejected,
      status: store.getTurnById(turn.id).status,
      terminalEvents: store
        .getTurnEvents(turn.id)
        .filter((event) => event.event === 'turn.completed'),
    }).toEqual({
      rejected: true,
      status: 'failed',
      terminalEvents: [
        expect.objectContaining({ data: expect.objectContaining({ stopReason: 'error' }) }),
      ],
    });
  });

  it('keeps one terminal outcome when completion notification fails before persistence', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-terminal-notify-fail-'));
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Fail completion notification');
    const unsubscribe = store.addTurnListener(turn.id, (event) => {
      if (event.data.type === 'turn-completed' && event.data.stopReason === 'completed') {
        throw new Error('completion notification failed before persistence');
      }
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      createAgentSessionId: () => 'as_terminal_notify_fail_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });
    let failure: unknown = null;

    try {
      await executor.startTurn(store, turn.id, 'Fail completion notification', {
        requestId: '00000000-0000-4000-8000-000000000102',
        workspaceRoots: [],
      });
    } catch (error) {
      failure = error;
    } finally {
      unsubscribe();
    }

    const durableStore = createDemoStore({ dataRoot });
    const durableTurn = durableStore.getTurnById(turn.id);
    const terminalEvents = durableStore
      .getTurnEvents(turn.id)
      .filter((event) => event.event === 'turn.completed');

    expect(failure).toBeInstanceOf(Error);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toMatchObject({
      data: { turn: { status: durableTurn.status } },
    });
  });

  it.each([
    'agent-session',
    'turn',
    'agent-session-event',
  ] as const)('terminalizes after the failed %s write reports an after-write failure', async (failurePoint) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `openkit-governance-${failurePoint}-fail-`));
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn('ws_demo', 'th_demo', `Fail ${failurePoint} persistence`);
    const backend = new FakeWorkerGovernanceBackend();
    const requestId =
      failurePoint === 'agent-session'
        ? '00000000-0000-4000-8000-000000000103'
        : failurePoint === 'turn'
          ? '00000000-0000-4000-8000-000000000104'
          : '00000000-0000-4000-8000-000000000105';
    const collectEvidenceSpy = vi
      .spyOn(backend, 'collectEvidence')
      .mockRejectedValue(new Error('worker execution failed'));
    let restoreFailure = (): void => {};
    let injected = false;

    if (failurePoint === 'agent-session') {
      const updateAgentSession = store.updateAgentSession.bind(store);
      const spy = vi.spyOn(store, 'updateAgentSession').mockImplementation((id, patch) => {
        const updated = updateAgentSession(id, patch);
        if (!injected && patch.status === 'failed') {
          injected = true;
          throw new Error('failed agent session persistence reported failure after write');
        }
        return updated;
      });
      restoreFailure = () => spy.mockRestore();
    } else if (failurePoint === 'turn') {
      const updateTurn = store.updateTurn.bind(store);
      const spy = vi.spyOn(store, 'updateTurn').mockImplementation((id, patch) => {
        const updated = updateTurn(id, patch);
        if (!injected && patch.status === 'failed') {
          injected = true;
          throw new Error('failed turn persistence reported failure after write');
        }
        return updated;
      });
      restoreFailure = () => spy.mockRestore();
    } else {
      const emitTurnEvent = store.emitTurnEvent.bind(store);
      const spy = vi.spyOn(store, 'emitTurnEvent').mockImplementation((id, event) => {
        const emitted = emitTurnEvent(id, event);
        if (
          !injected &&
          event.data.type === 'agent-session-updated' &&
          event.data.agentSession.status === 'failed'
        ) {
          injected = true;
          throw new Error('failed agent session event reported failure after write');
        }
        return emitted;
      });
      restoreFailure = () => spy.mockRestore();
    }

    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      createAgentSessionId: () => `as_${failurePoint}_fail_1`,
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });
    let failure: unknown = null;

    try {
      await executor.startTurn(store, turn.id, `Fail ${failurePoint} persistence`, {
        requestId,
        workspaceRoots: [],
      });
    } catch (error) {
      failure = error;
    } finally {
      restoreFailure();
      collectEvidenceSpy.mockRestore();
    }

    const durableStore = createDemoStore({ dataRoot });
    expect(failure).toBeInstanceOf(AggregateError);
    expect(durableStore.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
    expect(
      durableStore.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ stopReason: 'error' }),
      }),
    ]);
  });

  it('terminalizes setup failures after the turn and worker session exist', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-setup-fail-'));
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Fail worker setup');
    const createItem = store.createItem.bind(store);
    const createItemSpy = vi.spyOn(store, 'createItem').mockImplementation((item) => {
      const created = createItem(item);
      if (item.id === `it_user_${turn.id}`) {
        throw new Error('worker setup failed after item persistence');
      }
      return created;
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      createAgentSessionId: () => 'as_setup_fail_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });
    let failure: unknown = null;

    try {
      await executor.startTurn(store, turn.id, 'Fail worker setup', {
        requestId: '00000000-0000-4000-8000-000000000106',
        workspaceRoots: [],
      });
    } catch (error) {
      failure = error;
    } finally {
      createItemSpy.mockRestore();
    }

    const durableStore = createDemoStore({ dataRoot });
    expect(failure).toBeInstanceOf(Error);
    expect(durableStore.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
    expect(
      durableStore.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ stopReason: 'error' }),
      }),
    ]);
  });

  it('passes workspace source catalog context into the resolved AEP snapshot', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-source-ref-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run with source catalog');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_source_ref_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    await executor.startTurn(store, turn.id, 'Run with source catalog', {
      requestId: '00000000-0000-4000-8000-000000000212',
      workspaceDataSourceCatalog: {
        schemaVersion: 1,
        sources: [
          {
            access: 'read-write',
            allowedSlotKinds: ['worktree'],
            displayName: 'Main repository',
            id: 'repo_default',
            kind: 'git',
            locator: { repositoryResourceId: 'repo_default' },
            sensitivity: 'internal',
            status: 'active',
          },
        ],
      },
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo_default',
          sourceKind: 'host-dir',
          sourcePath: '/Users/m5pro/Documents/AI/openkit',
          workerPath: '/workspace/openkit',
        },
      ],
      workspaceSourceRefs: { repo_default: 'repo_default' },
    });

    expect(backend.lastPackage?.workspace.inputs[0]?.source).toMatchObject({
      catalogEntryDigest: expect.stringMatching(/^sha256:/),
      kind: 'git',
      locator: { repositoryResourceId: 'repo_default' },
      sourceId: 'repo_default',
      sourceRef: 'repo_default',
    });
    const workspaceDb = openTestWorkspaceDb(coreDb);

    expect(listWorkspaceInputSnapshots(workspaceDb, 'ws_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: 'repo_default',
          sourceId: 'repo_default',
        }),
      ])
    );
    expect(listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'repo_default',
        }),
      ])
    );

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('persists remote-container workspace synchronization evidence', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-remote-governance-records-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run in remote OpenShell');
    const completedAt = new Date(
      new Date(turn.startedAt ?? Date.now()).getTime() + 1000
    ).toISOString();
    const backend = new FakeWorkerGovernanceBackend({
      capabilities: [
        'container',
        'transcript-sink',
        'worker-control',
        'remote-gateway',
        'backend-service-readiness',
        'file-upload-download',
        'git-materialization',
        'change-set-collection',
      ],
      materializationStatus: {
        gatewayEndpoint: 'https://a1.example.com:17670',
        gatewayName: 'a1-openshell',
        health: 'ready',
        version: '0.0.63',
      },
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_remote_governance_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.example.com/api/worker-control',
        gatewayUrl: 'https://a1.example.com:17670',
        kind: 'openshell',
        placement: 'remote',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => completedAt,
    });

    await executor.startTurn(store, turn.id, 'Run in remote OpenShell', {
      requestId: '00000000-0000-4000-8000-000000000213',
      workspaceCwd: '/Users/m5pro/Documents/AI/openkit',
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath: '/Users/m5pro/Documents/AI/openkit',
          workerPath: '/workspace/openkit',
        },
      ],
    });

    expect(backend.lastPackage?.backend.requiredCapabilities).toEqual(
      expect.arrayContaining([
        'remote-gateway',
        'backend-service-readiness',
        'file-upload-download',
        'git-materialization',
        'change-set-collection',
      ])
    );
    expect(backend.lastPackage?.backend.extensions?.openshell).toMatchObject({
      gatewayUrlRef: 'runtime://openshell/gateway-url',
      placement: 'remote',
    });
    expect(JSON.stringify(backend.lastPackage)).not.toContain('https://a1.example.com:17670');
    const workspaceDb = openTestWorkspaceDb(coreDb);
    expect(listWorkspaceInputSnapshots(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        backend: expect.objectContaining({
          capabilitySummary: expect.arrayContaining(['remote-gateway', 'git-materialization']),
          kind: 'openshell',
        }),
      }),
    ]);
    expect(listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        backendKind: 'openshell',
        readinessEvidence: expect.arrayContaining([
          { kind: 'backend.ready', ref: 'version:0.0.63' },
        ]),
      }),
    ]);
    expect(listWorkspaceSyncReviews(workspaceDb, 'ws_demo')).toEqual([]);

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('passes scheduler-owned lineage into backend materialization', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-binding-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run with scheduler binding');
    const agentSessionId = 'as_governance_binding_1';
    const sandboxBindingRef = 'lease-binding:executor_1';
    dispatchExecutorLease(coreDb, {
      agentSessionId,
      packageSnapshotId: `aepsnap_${turn.id}_${agentSessionId}`,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_unexpected_random_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    await executor.startTurn(store, turn.id, 'Run with scheduler binding', {
      agentSessionId,
      requestId: '00000000-0000-4000-8000-000000000214',
      sandboxBindingRef,
      workspaceRoots: [],
    });

    expect(backend.lastContext?.sandboxBindingRef).toBe('lease-binding:executor_1');
    expect(backend.lastPackage?.scope.agentSessionId).toBe('as_governance_binding_1');
    expect(backend.lastPackage?.snapshotId).toBe(`aepsnap_${turn.id}_as_governance_binding_1`);
    expect(store.getAgentSession('as_governance_binding_1')).toMatchObject({
      id: 'as_governance_binding_1',
      status: 'idle',
    });

    coreDb.sqlite.close();
  });

  it('writes a package-scoped backend anchor before materialization and cleans it for zero-input turns', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-anchor-order-')));
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Anchor before effect');
    const agentSessionId = 'as_anchor_order_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:anchor-order';
    dispatchExecutorLease(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const materialize = backend.materialize.bind(backend);
    const materializeSpy = vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        backendSessionId: `openkit-${agentSessionId}`,
        packageSnapshotId,
        state: 'materializing',
      });
      return materialize(...args);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await executor.startTurn(store, turn.id, 'Anchor before effect', {
        agentSessionId,
        requestId: '00000000-0000-4000-8000-000000000250',
        sandboxBindingRef,
        workspaceRoots: [],
      });

      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        state: 'cleaned',
      });
    } finally {
      materializeSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['cleanup succeeds', false, 'cleaned'],
    ['cleanup fails', true, 'cleanup-failed'],
  ] as const)('records materialize-after-effect failure when %s', async (_description, failTeardown, expectedState) => {
    const coreDb = openCoreDb(
      mkdtempSync(join(tmpdir(), 'openkit-governance-materialize-failure-'))
    );
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Fail after materialize effect');
    const agentSessionId = 'as_materialize_failure_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:materialize-failure';
    dispatchExecutorLease(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    backend.failTeardown = failTeardown;
    const materialize = backend.materialize.bind(backend);
    const materializeSpy = vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      await materialize(...args);
      throw new Error('materialize failed after external effect');
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Fail after materialize effect', {
          agentSessionId,
          requestId: '00000000-0000-4000-8000-000000000251',
          sandboxBindingRef,
          workspaceRoots: [],
        })
      ).rejects.toThrow('materialize failed after external effect');
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        state: expectedState,
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
               FROM scheduler_session_leases AS leases
               JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
               WHERE leases.lease_id = ?`
          )
          .get(`lease_${turn.id}`)
      ).toEqual({ inUseCount: 1, status: 'acquired' });
    } finally {
      materializeSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('does not launch when the scheduler lease stops being live during materialization', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-prelaunch-gate-')));
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Lose lease before launch');
    const agentSessionId = 'as_prelaunch_gate_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:prelaunch-gate';
    dispatchExecutorLease(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const materialize = backend.materialize.bind(backend);
    const materializeSpy = vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      const result = await materialize(...args);
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'stale', release_reason = 'heartbeat-timeout' WHERE lease_id = ?"
        )
        .run(`lease_${turn.id}`);
      return result;
    });
    const launchSpy = vi.spyOn(backend, 'launch');
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Lose lease before launch', {
          agentSessionId,
          requestId: '00000000-0000-4000-8000-000000000252',
          sandboxBindingRef,
          workspaceRoots: [],
        })
      ).rejects.toThrow('Scheduler lease is not live for worker backend launch.');
      expect(launchSpy).not.toHaveBeenCalled();
      expect(backend.calls.filter((call) => call === 'cleanupSession')).toHaveLength(1);
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        state: 'cleaned',
      });
    } finally {
      launchSpy.mockRestore();
      materializeSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('does not launch when the startup deadline elapses during materialization', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-deadline-gate-')));
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Expire before launch');
    const agentSessionId = 'as_deadline_gate_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:deadline-gate';
    let timestamp = '2026-07-15T00:00:03.000Z';
    dispatchExecutorLease(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const materialize = backend.materialize.bind(backend);
    const materializeSpy = vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      const result = await materialize(...args);
      timestamp = '2026-07-15T00:03:00.000Z';
      return result;
    });
    const launchSpy = vi.spyOn(backend, 'launch');
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => timestamp,
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Expire before launch', {
          agentSessionId,
          requestId: '00000000-0000-4000-8000-000000000253',
          sandboxBindingRef,
          workspaceRoots: [],
        })
      ).rejects.toThrow('Scheduler lease is not live for worker backend launch.');
      expect(launchSpy).not.toHaveBeenCalled();
      expect(backend.calls.filter((call) => call === 'cleanupSession')).toHaveLength(1);
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get(`lease_${turn.id}`)
      ).toEqual({ status: 'acquired' });
    } finally {
      launchSpy.mockRestore();
      materializeSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('passes vault backend dependencies into worker package resolution', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-vault-grants-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const timestamp = '2026-07-05T00:00:00.000Z';

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 8) });
    vaultUnlockState.backend().store({
      material: 'ghp_governance_token',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github_read',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_github_read',
      displayName: 'GitHub read token',
      ownerScope: 'server',
      referenceId: 'vault_github_read',
      secretKind: 'github-token',
      now: () => timestamp,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['backend-provider'],
      expiresAt: '2099-07-05T01:00:00.000Z',
      grantId: 'grant_github_read',
      lifetime: 'turn',
      ownerScope: 'server',
      policyDecisionId: 'pd_repo_read_1',
      targetAgentSessionId: 'as_governance_vault_1',
      vaultReferenceId: 'vault_github_read',
      now: () => timestamp,
    });

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run GitHub MCP in OpenShell');
    const baseAgent = store.getAgent('ws_demo', 'agent_codex_host');
    store.upsertAgent('ws_demo', {
      ...baseAgent,
      config: {
        ...baseAgent.config,
        mcpServerIds: ['github'],
      },
    });
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_vault_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => timestamp,
      vaultBackend: () => vaultUnlockState.backend(),
    });

    try {
      await executor.startTurn(store, turn.id, 'Run GitHub MCP in OpenShell', {
        requestId: '00000000-0000-4000-8000-000000000215',
        workspaceRoots: [],
      });

      expect(backend.lastPackage?.vault.grants).toEqual([
        expect.objectContaining({
          expiresAt: '2099-07-05T01:00:00.000Z',
          id: 'grant_github_read',
        }),
      ]);
      expect(listInjectionPlans(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_read',
          packageSnapshotId: backend.lastPackage?.snapshotId,
        }),
      ]);
      expect(listInjectionReceipts(coreDb)).toEqual([
        expect.objectContaining({
          agentSessionId: 'as_governance_vault_1',
          grantId: 'grant_github_read',
        }),
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_read',
          outcome: 'succeeded',
          resolvingPath: 'grant',
        }),
      ]);
      expect(JSON.stringify(backend.lastPackage)).not.toContain('ghp_governance_token');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('passes vault-backed runtime files into backend-private materialization context', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-runtime-file-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const timestamp = '2026-07-05T00:00:00.000Z';

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 10) });
    vaultUnlockState.backend().store({
      material: '{"tokens":{"openai":"codex_executor_secret"}}',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_codex_auth_json',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_codex_auth_json',
      displayName: 'Codex auth JSON',
      ownerScope: 'server',
      referenceId: 'vault_codex_auth_json',
      secretKind: 'codex-auth-json',
      now: () => timestamp,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-file'],
      grantId: 'grant_codex_auth_json',
      lifetime: 'agent-session',
      ownerScope: 'server',
      targetAgentSessionId: 'as_governance_runtime_file_1',
      vaultReferenceId: 'vault_codex_auth_json',
      now: () => timestamp,
    });

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run Codex auth runtime file');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_runtime_file_1',
      environmentBackend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      now: () => timestamp,
      vaultBackend: () => vaultUnlockState.backend(),
    });

    try {
      await executor.startTurn(store, turn.id, 'Run Codex auth runtime file', {
        requestId: '00000000-0000-4000-8000-000000000216',
        workspaceRoots: [],
      });

      expect(backend.lastContext?.runtimeFileCredentials).toEqual([
        {
          credentialValue: '{"tokens":{"openai":"codex_executor_secret"}}',
          targetPath: '/sandbox/.codex/auth.json',
        },
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_codex_auth_json',
          outcome: 'succeeded',
          resolvingPath: 'grant',
        }),
      ]);
      expect(JSON.stringify(backend.lastPackage)).not.toContain('codex_executor_secret');
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/** One native JSON frame and its restricted origin claims. */
interface TurnRuntimeNativeFrame {
  /** Exact native JSON object retained in the raw stream. */
  record: Record<string, unknown>;
  /** Restricted native-origin fields for this frame. */
  origin: Partial<
    Pick<
      WorkerRuntimeNativeOriginIndexEntry,
      | 'nativeSessionId'
      | 'nativeThreadId'
      | 'parentNativeThreadId'
      | 'nativeTurnId'
      | 'runtimeRole'
      | 'runtimeNickname'
      | 'runtimeDepth'
    >
  >;
}

/** One synthetic raw stream plus its manifest and native-index rows. */
interface TurnRuntimeStream {
  /** Exact raw JSONL bytes. */
  bytes: Buffer;
  /** Native index rows covering every physical frame. */
  entries: WorkerRuntimeNativeOriginIndexEntry[];
  /** Restricted stream manifest row. */
  manifest: WorkerRuntimeRawStreamManifest['streams'][number];
}

/** Backend-local provenance capture returned by the fake transcript collector. */
interface TurnRuntimeProvenanceCapture {
  /** Worker transcript collection projection. */
  collection: NonNullable<WorkerTranscriptPayload['runtimeProvenance']>;
  /** Backend-local native-origin index path. */
  nativeOriginIndexPath: string;
  /** Backend-local synthetic raw stream directory. */
  rawStreamsRoot: string;
  /** Backend-local raw stream manifest path. */
  streamManifestPath: string;
}

/**
 * Creates a small complete, missing, or digest-tampered runtime forest for turn gating.
 *
 * @param root Isolated backend-local collection root.
 * @param environmentPackage Provenance-required outer AEP.
 * @param failure Optional collection failure mode.
 * @returns Backend transcript projection and canonical importer paths.
 */
function createTurnRuntimeProvenanceCapture(
  root: string,
  environmentPackage: AgentEnvironmentPackage,
  failure: 'missing' | 'tampered' | null = null
): TurnRuntimeProvenanceCapture {
  const lineage = turnRuntimeLineage(environmentPackage);
  const rawStreamsRoot = join(root, 'runtime', 'raw');
  const streamManifestPath = join(root, 'runtime', 'raw-streams.json');
  const nativeOriginIndexPath = join(root, 'runtime', 'native-origin-index.jsonl');
  const streams = [
    createTurnRuntimeStream(lineage, 'stream-0000.jsonl', 'primary', [
      {
        record: { thread_id: TURN_ROOT_NATIVE_ID, type: 'thread.started' },
        origin: { nativeThreadId: TURN_ROOT_NATIVE_ID },
      },
      {
        record: {
          item: {
            receiver_thread_ids: [TURN_CHILD_NATIVE_ID, TURN_CHILD_B_NATIVE_ID],
            sender_thread_id: TURN_ROOT_NATIVE_ID,
            status: 'completed',
            tool: 'spawn_agent',
            type: 'collab_tool_call',
          },
          type: 'item.completed',
        },
        origin: { nativeThreadId: TURN_ROOT_NATIVE_ID },
      },
    ]),
    createTurnRuntimeStream(lineage, 'stream-0001.jsonl', 'runtime-thread', [
      {
        record: turnRuntimeSessionMeta(TURN_ROOT_NATIVE_ID),
        origin: {
          nativeSessionId: TURN_NATIVE_SESSION_ID,
          nativeThreadId: TURN_ROOT_NATIVE_ID,
        },
      },
    ]),
    createTurnRuntimeStream(lineage, 'stream-0002.jsonl', 'runtime-thread', [
      {
        record: turnRuntimeSessionMeta(TURN_CHILD_NATIVE_ID, TURN_ROOT_NATIVE_ID),
        origin: {
          nativeSessionId: TURN_NATIVE_SESSION_ID,
          nativeThreadId: TURN_CHILD_NATIVE_ID,
          parentNativeThreadId: TURN_ROOT_NATIVE_ID,
          runtimeDepth: 1,
          runtimeNickname: 'Curie',
          runtimeRole: 'researcher',
        },
      },
      {
        record: {
          payload: {
            content: [{ text: TURN_CHILD_RAW_MESSAGE, type: 'output_text' }],
            role: 'assistant',
            type: 'message',
          },
          timestamp: '2026-07-13T00:00:01.000Z',
          type: 'response_item',
        },
        origin: {
          nativeSessionId: TURN_NATIVE_SESSION_ID,
          nativeThreadId: TURN_CHILD_NATIVE_ID,
          parentNativeThreadId: TURN_ROOT_NATIVE_ID,
          runtimeDepth: 1,
          runtimeNickname: 'Curie',
          runtimeRole: 'researcher',
        },
      },
    ]),
    createTurnRuntimeStream(lineage, 'stream-0003.jsonl', 'runtime-thread', [
      {
        record: turnRuntimeSessionMeta(TURN_CHILD_B_NATIVE_ID, TURN_ROOT_NATIVE_ID),
        origin: {
          nativeSessionId: TURN_NATIVE_SESSION_ID,
          nativeThreadId: TURN_CHILD_B_NATIVE_ID,
          parentNativeThreadId: TURN_ROOT_NATIVE_ID,
          runtimeDepth: 1,
          runtimeNickname: 'Curie',
          runtimeRole: 'researcher',
        },
      },
    ]),
  ];
  const manifest = WorkerRuntimeRawStreamManifestSchema.parse({
    adapterVersion: '0.144.1',
    captureStatus: 'complete',
    lineage,
    primaryStreamRef: 'stream-0000.jsonl',
    runtimeFamily: 'codex',
    schemaVersion: 1,
    streams: streams.map((stream, index) =>
      failure === 'tampered' && index === 2
        ? { ...stream.manifest, sha256: `sha256:${'f'.repeat(64)}` }
        : stream.manifest
    ),
  });
  mkdirSync(rawStreamsRoot, { recursive: true });
  for (const stream of streams) {
    writeFileSync(join(rawStreamsRoot, stream.manifest.streamRef), stream.bytes);
  }
  writeFileSync(
    nativeOriginIndexPath,
    `${streams
      .flatMap((stream) => stream.entries)
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`
  );

  if (failure !== 'missing') {
    writeFileSync(streamManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return {
    collection: {
      diagnostics: failure
        ? [
            {
              code: `worker_runtime_provenance_${failure}`,
              message: `Runtime provenance collection is ${failure}.`,
              path: '/openkit/session/runtime/raw-streams.json',
            },
          ]
        : [],
      manifestPath: streamManifestPath,
      missingPaths: failure === 'missing' ? ['/openkit/session/runtime/raw-streams.json'] : [],
      nativeOriginIndexPath,
      rawStreamPaths: Object.fromEntries(
        streams.map((stream) => [
          stream.manifest.streamRef,
          join(rawStreamsRoot, stream.manifest.streamRef),
        ])
      ),
    },
    nativeOriginIndexPath,
    rawStreamsRoot,
    streamManifestPath,
  };
}

/**
 * Builds one exact LF-framed runtime stream and matching index rows.
 *
 * @param lineage Authoritative outer worker lineage.
 * @param streamRef Synthetic stream reference.
 * @param sourceKind Primary or runtime-thread stream class.
 * @param frames Native frames and adapter origin claims.
 * @returns Exact raw bytes, manifest row, and index rows.
 */
function createTurnRuntimeStream(
  lineage: WorkerLineage,
  streamRef: string,
  sourceKind: 'primary' | 'runtime-thread',
  frames: TurnRuntimeNativeFrame[]
): TurnRuntimeStream {
  const chunks: Buffer[] = [];
  const entries: WorkerRuntimeNativeOriginIndexEntry[] = [];
  let byteOffset = 0;
  for (const [frameSequence, frame] of frames.entries()) {
    const bytes = Buffer.from(`${JSON.stringify(frame.record)}\n`);
    chunks.push(bytes);
    entries.push(
      WorkerRuntimeNativeOriginIndexEntrySchema.parse({
        adapterVersion: '0.144.1',
        byteLength: bytes.byteLength,
        byteOffset,
        eventKind: frame.record.type,
        frameSequence,
        frameSha256: turnRuntimeSha256(bytes),
        lineage,
        ...frame.origin,
        parseStatus: 'parsed',
        runtimeFamily: 'codex',
        schemaVersion: 1,
        streamRef,
      })
    );
    byteOffset += bytes.byteLength;
  }
  const bytes = Buffer.concat(chunks);
  return {
    bytes,
    entries,
    manifest: {
      bytes: bytes.byteLength,
      captureStatus: 'complete',
      frameCount: frames.length,
      sha256: turnRuntimeSha256(bytes),
      sourceKind,
      stableTerminal: true,
      streamRef,
    },
  };
}

/**
 * Builds pinned Codex session metadata for a root or child runtime thread.
 *
 * @param threadId Native thread id.
 * @param parentThreadId Native parent id for a child thread.
 * @returns One Codex rollout session metadata record.
 */
function turnRuntimeSessionMeta(
  threadId: string,
  parentThreadId?: string
): Record<string, unknown> {
  return {
    payload: {
      cwd: '/private/runtime-provenance',
      id: threadId,
      originator: 'codex_exec',
      ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
      session_id: TURN_NATIVE_SESSION_ID,
      source: parentThreadId
        ? {
            subagent: {
              thread_spawn: {
                agent_nickname: 'Curie',
                agent_role: 'researcher',
                depth: 1,
                parent_thread_id: parentThreadId,
              },
            },
          }
        : 'exec',
      timestamp: '2026-07-13T00:00:00.000Z',
    },
    timestamp: '2026-07-13T00:00:00.000Z',
    type: 'session_meta',
  };
}

/** Builds authoritative runtime provenance lineage from a materialized AEP. */
function turnRuntimeLineage(environmentPackage: AgentEnvironmentPackage): WorkerLineage {
  return {
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId ?? null,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    workspaceId: environmentPackage.scope.workspaceId,
  };
}

/** Computes one canonical prefixed SHA-256 digest. */
function turnRuntimeSha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

class FakeWorkerGovernanceBackend implements WorkerGovernanceBackend {
  public readonly calls: string[] = [];
  public failTeardown = false;
  public teardownFailuresRemaining = 0;
  public lastContext: Parameters<WorkerGovernanceBackend['materialize']>[1] | null = null;
  public lastPackage: AgentEnvironmentPackage | null = null;
  /** Optional canonical event transcript factory used by reconciliation tests. */
  public eventsJsonlFactory: ((environmentPackage: AgentEnvironmentPackage) => string) | null =
    null;
  public runtimeProvenanceFactory:
    | ((
        environmentPackage: AgentEnvironmentPackage
      ) => NonNullable<WorkerTranscriptPayload['runtimeProvenance']>)
    | null = null;
  private readonly capabilities: string[];
  private readonly materializationStatus:
    | WorkerGovernanceMaterializationRecord['backendStatus']
    | undefined;
  /** Optional sandbox id distinct from package lineage. */
  private readonly sandboxName: string | undefined;

  public constructor(
    options: {
      capabilities?: string[];
      materializationStatus?: WorkerGovernanceMaterializationRecord['backendStatus'];
      /** Product-safe sandbox name returned by materialization. */
      sandboxName?: string;
    } = {}
  ) {
    this.capabilities = options.capabilities ?? ['container', 'transcript-sink', 'worker-control'];
    this.materializationStatus = options.materializationStatus ?? {
      gatewayEndpoint: null,
      gatewayName: 'openshell',
      health: 'ready',
      version: '0.0.63',
    };
    this.sandboxName = options.sandboxName;
  }

  public async describeCapabilities(): Promise<WorkerGovernanceBackendCapabilities> {
    return {
      capabilities: this.capabilities,
      dynamicCapabilities: [],
      kind: 'openshell',
      version: '0.0.63',
    };
  }

  public async validatePackage(): Promise<AgentEnvironmentValidationDiagnostic[]> {
    return [];
  }

  public planSession(environmentPackage: AgentEnvironmentPackage) {
    return {
      agentSessionId: environmentPackage.scope.agentSessionId,
      backendKind: 'openshell' as const,
      backendSessionId: this.sandboxName ?? `openkit-${environmentPackage.scope.agentSessionId}`,
      backendTarget: {
        cellTargetId: 'cell-test',
        gatewayEndpoint: null,
        gatewayName: 'openshell',
        placement: 'local' as const,
      },
      deploymentId: 'deployment_fake_executor',
      packageSnapshotId: environmentPackage.snapshotId,
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/${environmentPackage.snapshotId}`,
      transientProviderInstanceId: null,
    };
  }

  /** Cleans one exact fake physical session. */
  public async cleanupSession(): Promise<void> {
    this.calls.push('cleanupSession');

    if (this.teardownFailuresRemaining > 0) {
      this.teardownFailuresRemaining -= 1;
      throw new Error('teardown failed');
    }

    if (this.failTeardown) {
      throw new Error('teardown failed');
    }
  }

  public async materialize(
    environmentPackage: AgentEnvironmentPackage,
    context?: Parameters<WorkerGovernanceBackend['materialize']>[1]
  ): Promise<WorkerGovernanceMaterializationRecord> {
    this.calls.push('materialize');
    this.lastContext = context ?? null;
    this.lastPackage = environmentPackage;

    return {
      backendKind: 'openshell',
      command: {
        argv: environmentPackage.runtime.command.argv,
        workingDirectory: environmentPackage.runtime.command.workingDirectory,
      },
      controlMode: environmentPackage.control.mode,
      packageId: environmentPackage.packageId,
      packageSnapshotId: environmentPackage.snapshotId,
      requiredCapabilities: environmentPackage.backend.requiredCapabilities,
      ...(this.materializationStatus ? { backendStatus: this.materializationStatus } : {}),
      sandbox: {
        name: this.sandboxName ?? `openkit-${environmentPackage.scope.agentSessionId}`,
        source: 'openkit/worker-codex:dev',
        state: 'created' as const,
      },
      workspaceInputs: environmentPackage.workspace.inputs.map((input) => ({
        access: input.access,
        id: input.id,
        kind: input.kind,
        target: sessionWorkspaceInputTarget(environmentPackage, input.id),
      })),
    };
  }

  public async launch(): Promise<WorkerGovernanceEvidenceRecord> {
    this.calls.push('launch');

    return {
      data: {},
      kind: 'fake.launch',
      timestamp: '2026-06-16T00:00:00.000Z',
    };
  }

  public async update(): Promise<AgentEnvironmentValidationDiagnostic[]> {
    return [];
  }

  public async collectEvidence(): Promise<WorkerGovernanceEvidenceRecord[]> {
    this.calls.push('collectEvidence');

    return [];
  }

  public async collectProviderRefreshStatuses(): Promise<WorkerGovernanceEvidenceRecord[]> {
    this.calls.push('collectProviderRefreshStatuses');

    return [];
  }

  public async collectTranscript(): Promise<WorkerTranscriptPayload> {
    this.calls.push('collectTranscript');

    if (!this.lastPackage) {
      throw new Error('Package was not materialized.');
    }

    return {
      ...(this.eventsJsonlFactory
        ? { eventsJsonl: this.eventsJsonlFactory(this.lastPackage) }
        : {}),
      artifactsJsonl: `${JSON.stringify({
        schemaVersion: 1,
        kind: 'artifact',
        lineage: {
          workspaceId: this.lastPackage.scope.workspaceId,
          threadId: this.lastPackage.scope.threadId,
          turnId: this.lastPackage.scope.turnId,
          agentSessionId: this.lastPackage.scope.agentSessionId,
          packageSnapshotId: this.lastPackage.snapshotId,
          requestId: this.lastPackage.scope.requestId,
        },
        sequence: 2,
        artifact: {
          kind: 'report',
          mediaType: 'text/markdown',
          path: '/openkit/artifacts/report.md',
          title: 'Governed worker report',
        },
      })}\n`,
      itemsJsonl: `${JSON.stringify({
        schemaVersion: 1,
        kind: 'item',
        lineage: {
          workspaceId: this.lastPackage.scope.workspaceId,
          threadId: this.lastPackage.scope.threadId,
          turnId: this.lastPackage.scope.turnId,
          agentSessionId: this.lastPackage.scope.agentSessionId,
          packageSnapshotId: this.lastPackage.snapshotId,
          requestId: this.lastPackage.scope.requestId,
        },
        sequence: 1,
        item: {
          type: 'assistant-message',
          status: 'completed',
          text: 'Governed worker completed the task.',
        },
      })}\n`,
      ...(this.runtimeProvenanceFactory
        ? { runtimeProvenance: this.runtimeProvenanceFactory(this.lastPackage) }
        : {}),
    };
  }

  public async collectWorkspaceChanges(): Promise<WorkerGovernanceWorkspaceChangeRecord[]> {
    this.calls.push('collectWorkspaceChanges');

    if (!this.lastPackage) {
      throw new Error('Package was not materialized.');
    }

    return [];
  }

  public async collectArtifacts(): Promise<WorkerGovernanceArtifactRecord[]> {
    this.calls.push('collectArtifacts');

    return [];
  }
}

/**
 * Reads the planned slot target for a package workspace input.
 *
 * @param environmentPackage Package carrying the OpenKit session workspace extension.
 * @param inputId Workspace input id.
 * @returns Worker-visible materialized target path.
 */
function sessionWorkspaceInputTarget(
  environmentPackage: AgentEnvironmentPackage,
  inputId: string
): string {
  const openkit = environmentPackage.extensions.openkit as
    | {
        sessionWorkspace?: {
          layout: { slots: Array<{ id: string; path: string }> };
          materialization: { inputs: Array<{ inputId: string; slotId: string }> };
        };
      }
    | undefined;
  const slotId = openkit?.sessionWorkspace?.materialization.inputs.find(
    (input) => input.inputId === inputId
  )?.slotId;
  const path = openkit?.sessionWorkspace?.layout.slots.find((slot) => slot.id === slotId)?.path;

  if (!path) {
    throw new Error(`session workspace target missing for input: ${inputId}`);
  }

  return path;
}
