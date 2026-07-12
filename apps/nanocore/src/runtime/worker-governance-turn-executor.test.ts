import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  WorkspaceInputSnapshot,
  WorkspaceMaterializationRecord,
} from '@openkit/app-api-schemas';
import type {
  AgentEnvironmentPackage,
  AgentEnvironmentValidationDiagnostic,
  WorkerGovernanceBackendCapabilities,
} from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';
import { listInjectionPlans } from '../injection-plans.js';
import { listInjectionReceipts } from '../injection-receipts.js';
import type { FsStore } from '../lib/store.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID, workspaceDbPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import type {
  WorkerGovernanceArtifactRecord,
  WorkerGovernanceBackend,
  WorkerGovernanceEvidenceRecord,
  WorkerGovernanceMaterializationRecord,
  WorkerGovernanceWorkspaceChangeRecord,
} from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';
import type { WorkerTranscriptPayload } from './worker-transcript.js';
import { getFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
import {
  listBackendWorkspaceHandles,
  listWorkspaceChangeSets,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  listWorkspaceSyncReviews,
} from './workspace-sync-records.js';

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
      controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

  it('imports worker transcript records and tears down the materialized backend session', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-records-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run in OpenShell');
    const completedAt = new Date(
      new Date(turn.startedAt ?? Date.now()).getTime() + 1000
    ).toISOString();
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_1',
      environmentBackend: {
        codexModel: 'gpt-5-codex',
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
      'teardown',
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
        workerSessionId: expect.any(String),
      }),
    ]);
    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'cleaned',
        workerSessionId: `aepsnap_${turn.id}_as_governance_1`,
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        const base = { commit: null, contentDigest: null };
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

  it('marks backend workspace handles failed when teardown fails', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-teardown-fail-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run in OpenShell');
    const backend = new FakeWorkerGovernanceBackend();
    backend.failTeardown = true;
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_teardown_fail_1',
      environmentBackend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
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
        cleanupStatus: 'failed',
        workerSessionId: `aepsnap_${turn.id}_as_teardown_fail_1`,
      }),
    ]);

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('retries teardown during final cleanup and records a successful retry', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-teardown-retry-')));
    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Retry OpenShell teardown');
    const backend = new FakeWorkerGovernanceBackend();
    backend.teardownFailuresRemaining = 1;
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_teardown_retry_1',
      environmentBackend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

    expect(backend.calls.filter((call) => call === 'teardown')).toHaveLength(2);
    expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
    const workspaceDb = openTestWorkspaceDb(coreDb);
    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'cleaned',
        workerSessionId: `aepsnap_${turn.id}_as_teardown_retry_1`,
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

      expect(backend.calls.filter((call) => call === 'teardown')).toHaveLength(1);
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
        workerSessionId: `aepsnap_${turn.id}_as_cleanup_status_1`,
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        'sidecar-control-endpoint',
        'sidecar-capability-endpoint',
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
        controlRelayUpstream: 'https://nanocore.example.com/api/worker-control',
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
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_unexpected_random_1',
      environmentBackend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
    });

    await executor.startTurn(store, turn.id, 'Run with scheduler binding', {
      agentSessionId: 'as_governance_binding_1',
      requestId: '00000000-0000-4000-8000-000000000214',
      sandboxBindingRef: 'lease-binding:executor_1',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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

class FakeWorkerGovernanceBackend implements WorkerGovernanceBackend {
  public readonly calls: string[] = [];
  public failTeardown = false;
  public teardownFailuresRemaining = 0;
  public lastContext: Parameters<WorkerGovernanceBackend['materialize']>[1] | null = null;
  public lastPackage: AgentEnvironmentPackage | null = null;
  private readonly capabilities: string[];
  private readonly materializationStatus:
    | WorkerGovernanceMaterializationRecord['backendStatus']
    | undefined;

  public constructor(
    options: {
      capabilities?: string[];
      materializationStatus?: WorkerGovernanceMaterializationRecord['backendStatus'];
    } = {}
  ) {
    this.capabilities = options.capabilities ?? [
      'container',
      'transcript-sink',
      'sidecar-control-endpoint',
      'sidecar-capability-endpoint',
    ];
    this.materializationStatus = options.materializationStatus;
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

  public async teardown(): Promise<WorkerGovernanceEvidenceRecord> {
    this.calls.push('teardown');

    if (this.teardownFailuresRemaining > 0) {
      this.teardownFailuresRemaining -= 1;
      throw new Error('teardown failed');
    }

    if (this.failTeardown) {
      throw new Error('teardown failed');
    }

    return {
      data: {},
      kind: 'fake.teardown',
      timestamp: '2026-06-16T00:00:00.000Z',
    };
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
