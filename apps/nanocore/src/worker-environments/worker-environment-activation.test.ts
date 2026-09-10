import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ActivateWorkerEnvironmentRequest,
  type WorkerEnvironmentAffectedStorage,
  type WorkerEnvironmentAuthoredCandidateArtifact,
  type WorkerEnvironmentReplaceNow,
  type WorkerEnvironmentResolvedCandidateArtifact,
  workerEnvironmentActivationConfirmation,
} from '@openkit/app-api-schemas';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Actor, ensureLocalUser } from '../auth/identity.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import type { FsStore } from '../lib/store.js';
import {
  activateWorkerStorageAttachment,
  createWorkerStorageBinding,
  reserveWorkerStorageAttachment,
  type WorkerStorageLayout,
} from '../runtime/worker-storage-bindings.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  createWorkerEnvironmentActivation,
  createWorkerEnvironmentAffectedStorageDeriver,
} from './worker-environment-activation.js';
import type { ReadWorkerEnvironmentResolvedCandidate } from './worker-environment-preparation.js';

const NOW = '2026-09-11T00:00:00.000Z';
const CONFIG_REVISION = `sha256:${'a'.repeat(64)}`;
const WRITTEN_REVISION = `sha256:${'b'.repeat(64)}`;
const CANDIDATE_DIGEST = `sha256:${'c'.repeat(64)}`;
const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const TARGET = { agentId: 'agent_worker_fixture', kind: 'agent' as const };
const CONFIGURATION = {
  expectedRevision: CONFIG_REVISION,
  fileId: 'agents/agent_worker_fixture.agent.jsonc',
};
const DECLARATION = {
  kind: 'reference' as const,
  pullPolicy: 'if-not-present' as const,
  ref: 'ghcr.io/openkit/worker-fixture:mutable',
};
const DOCKERFILE = 'FROM scratch\n';
const BUILD_DECLARATION = {
  arguments: {},
  contextDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  contextRef: 'build-context://empty/v1' as const,
  egress: [{ host: 'registry.npmjs.org', port: 443 }],
  input: {
    content: DOCKERFILE,
    digest: `sha256:${createHash('sha256').update(DOCKERFILE).digest('hex')}`,
    kind: 'dockerfile' as const,
  },
  kind: 'build' as const,
  layerLimit: 128,
  outputLimitBytes: 21_474_836_480,
  timeLimitSeconds: 1800,
};
const PINNED_IMAGE = {
  kind: 'reference',
  pullPolicy: 'never',
  ref: IMAGE_DIGEST,
};
const LAYOUT: WorkerStorageLayout = {
  family: 'openkit-worker',
  gid: 1000,
  platform: { architecture: 'amd64', os: 'linux' },
  targets: [{ target: '/workspace' }, { target: '/sandbox' }],
  uid: 1000,
  version: '1',
  workingDirectory: '/tmp/openkit-bootstrap',
};
const ACTOR: Actor = { kind: 'local', userId: 'user_local' };

const openDbs: CoreDb[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const coreDb of openDbs.splice(0)) coreDb.sqlite.close();
});

interface BaseFixture {
  readonly administrationThreadId: string;
  readonly administrationWorkspaceId: string;
  readonly coreDb: CoreDb;
  readonly store: FsStore;
}

/** Creates Core storage plus one private administration Thread. */
function createBaseFixture(): BaseFixture {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-environment-activation-'));
  const coreDb = openCoreDb(dataRoot);
  openDbs.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  const privateWorkspace = store.ensureQuickChatWorkspace(ACTOR.userId);
  const administrationThread = store.createThread(
    privateWorkspace.id,
    'Administration',
    'thread_administration',
    'administration'
  );
  return {
    administrationThreadId: administrationThread.id,
    administrationWorkspaceId: privateWorkspace.id,
    coreDb,
    store,
  };
}

/** Returns one valid Agent configuration source with a different current image. */
function agentConfigurationSource(): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      requiredFeatures: [],
      id: TARGET.agentId,
      displayName: 'Worker Fixture',
      models: {
        preferredLogicalModelId: 'reasoning',
        allowedLogicalModelIds: ['reasoning'],
      },
      runtime: {
        kind: 'future-runtime',
        adapter: 'future-adapter',
        image: {
          kind: 'reference',
          ref: 'ghcr.io/openkit/worker-fixture:old',
          pullPolicy: 'if-not-present',
        },
        binaries: [
          { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
          { id: 'future-runtime', path: '/usr/local/bin/future-runtime' },
        ],
      },
      sandbox: { network: [] },
    },
    null,
    2
  );
}

/** Creates an exact immutable A/B pair for one activation request. */
function candidatePair(
  fixture: BaseFixture,
  affectedStorage: readonly WorkerEnvironmentAffectedStorage[],
  replaceNow: WorkerEnvironmentReplaceNow | null,
  declaration: WorkerEnvironmentAuthoredCandidateArtifact['declaration'] = DECLARATION
): ReadWorkerEnvironmentResolvedCandidate {
  const authoredCandidate = {
    artifactId: 'artifact_authored_environment',
    artifactVersion: 1 as const,
    contentDigest: CANDIDATE_DIGEST,
  };
  const resolvedCandidate = {
    artifactId: 'artifact_resolved_environment',
    artifactVersion: 1 as const,
    contentDigest: `sha256:${'e'.repeat(64)}`,
  };
  const authored: WorkerEnvironmentAuthoredCandidateArtifact = {
    affectedStorage: [...affectedStorage],
    configuration: CONFIGURATION,
    declaration,
    kind: 'worker-environment-authored-candidate',
    replaceNow,
    schemaVersion: 1,
    target: TARGET,
  };
  const resolved: WorkerEnvironmentResolvedCandidateArtifact = {
    affectedStorage: [...affectedStorage],
    authoredCandidate,
    configuration: CONFIGURATION,
    image: {
      digest: IMAGE_DIGEST,
      platform: LAYOUT.platform,
      storageLayout: {
        family: LAYOUT.family,
        gid: LAYOUT.gid,
        targets: LAYOUT.targets,
        uid: LAYOUT.uid,
        version: LAYOUT.version,
        workingDirectory: LAYOUT.workingDirectory,
      },
    },
    kind: 'worker-environment-resolved-candidate',
    replaceNow,
    schemaVersion: 1,
    target: TARGET,
  };
  return {
    authored,
    authoredCandidate,
    resolved,
    resolvedCandidate,
    threadId: fixture.administrationThreadId,
    workspaceId: fixture.administrationWorkspaceId,
  };
}

/** Creates one canonical activation request for a candidate pair. */
function activationRequest(
  pair: ReadWorkerEnvironmentResolvedCandidate,
  requestId = '11111111-1111-4111-8111-111111111111'
): ActivateWorkerEnvironmentRequest {
  const facts = {
    affectedStorage: pair.resolved.affectedStorage,
    configuration: pair.resolved.configuration,
    replaceNow: pair.resolved.replaceNow,
    resolvedCandidate: pair.resolvedCandidate,
    target: pair.resolved.target,
  };
  return {
    ...facts,
    confirmation: workerEnvironmentActivationConfirmation(facts),
    requestId,
  };
}

/** Creates a deterministic in-memory configuration service with exact CAS observation. */
function configurationService() {
  let content = agentConfigurationSource();
  let revision = CONFIG_REVISION;
  const readFile = vi.fn((_id: string) => ({
    content,
    file: {
      exists: true,
      id: CONFIGURATION.fileId,
      kind: 'agent' as const,
      path: `DATA_ROOT/config/${CONFIGURATION.fileId}`,
      revision,
      updatedAt: NOW,
    },
  }));
  const updateFile = vi.fn((input: Parameters<RuntimeConfigFileService['updateFile']>[0]) => {
    if (input.expectedRevision !== revision || !input.content) throw new Error('stale');
    content = input.content;
    revision = WRITTEN_REVISION;
    return {
      diagnostics: [],
      file: {
        exists: true,
        id: CONFIGURATION.fileId,
        kind: 'agent' as const,
        path: `DATA_ROOT/config/${CONFIGURATION.fileId}`,
        revision,
        updatedAt: NOW,
      },
    };
  });
  return {
    files: { readFile, updateFile } as Pick<RuntimeConfigFileService, 'readFile' | 'updateFile'>,
    readContent: () => content,
    readFile,
    updateFile,
  };
}

/** Returns the only reload fact consumed by the activation owner. */
function reloadResult(status: 'applied' | 'failed') {
  return { status } as ReturnType<RuntimeConfigManager['reload']>;
}

describe('Worker environment activation', () => {
  it.each([
    ['mutable reference tag', DECLARATION],
    ['build declaration', BUILD_DECLARATION],
  ] as const)('pins resolved B after a %s by exact SHA CAS and replays the immutable result Artifact', async (_kind, declaration) => {
    const fixture = createBaseFixture();
    const pair = candidatePair(fixture, [], null, declaration);
    const request = activationRequest(pair);
    const config = configurationService();
    const replaceResidentWork = vi.fn();
    const activation = createWorkerEnvironmentActivation({
      configFilesForActor: () => config.files,
      coreDb: fixture.coreDb,
      now: () => NOW,
      preparation: { readResolved: () => pair },
      reloadRuntimeConfig: () => reloadResult('applied'),
      replaceResidentWork,
      requireCurrentAdministrator: vi.fn(),
      store: fixture.store,
    });

    const first = await activation.activate({ actor: ACTOR }, request);
    const replay = await activation.activate({ actor: ACTOR }, request);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      affected: [],
      configuration: { fileId: CONFIGURATION.fileId, revision: WRITTEN_REVISION },
    });
    expect(config.updateFile).toHaveBeenCalledTimes(1);
    expect(replaceResidentWork).not.toHaveBeenCalled();
    expect(parse(config.readContent())).toMatchObject({
      displayName: 'Worker Fixture',
      runtime: { image: PINNED_IMAGE },
    });
    const activationArtifacts = fixture.store
      .listArtifacts(fixture.administrationWorkspaceId)
      .filter((artifact) => artifact.title === 'Worker environment activation result');
    expect(activationArtifacts).toHaveLength(1);
    expect(JSON.parse(activationArtifacts[0]!.content.body)).toEqual(first);
  });

  it('never repeats configuration effects after a result-Artifact write failure', async () => {
    const fixture = createBaseFixture();
    const pair = candidatePair(fixture, [], null);
    const request = activationRequest(pair);
    const config = configurationService();
    const activation = createWorkerEnvironmentActivation({
      configFilesForActor: () => config.files,
      coreDb: fixture.coreDb,
      now: () => NOW,
      preparation: { readResolved: () => pair },
      reloadRuntimeConfig: () => reloadResult('applied'),
      replaceResidentWork: vi.fn(),
      requireCurrentAdministrator: vi.fn(),
      store: fixture.store,
    });
    vi.spyOn(fixture.store, 'createArtifact').mockImplementationOnce(() => {
      throw new Error('durable result unavailable');
    });

    await expect(activation.activate({ actor: ACTOR }, request)).rejects.toThrow(
      'durable result unavailable'
    );
    await expect(activation.activate({ actor: ACTOR }, request)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(config.updateFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale configuration SHA before creating an activation Turn', async () => {
    const fixture = createBaseFixture();
    const pair = candidatePair(fixture, [], null);
    const request = activationRequest(pair);
    const config = configurationService();
    config.readFile.mockImplementation(() => ({
      content: agentConfigurationSource(),
      file: {
        exists: true,
        id: CONFIGURATION.fileId,
        kind: 'agent',
        path: `DATA_ROOT/config/${CONFIGURATION.fileId}`,
        revision: WRITTEN_REVISION,
        updatedAt: NOW,
      },
    }));
    const activation = createWorkerEnvironmentActivation({
      configFilesForActor: () => config.files,
      coreDb: fixture.coreDb,
      now: () => NOW,
      preparation: { readResolved: () => pair },
      reloadRuntimeConfig: () => reloadResult('applied'),
      replaceResidentWork: vi.fn(),
      requireCurrentAdministrator: vi.fn(),
      store: fixture.store,
    });

    await expect(activation.activate({ actor: ACTOR }, request)).rejects.toMatchObject({
      code: 'revision_conflict',
    });
    expect(config.updateFile).not.toHaveBeenCalled();
    expect(
      fixture.store.listThreadTurns(
        fixture.administrationWorkspaceId,
        fixture.administrationThreadId
      )
    ).toEqual([]);
  });

  it('derives the sole complete sharing group and denies a different responsible user', () => {
    const fixture = createResidentFixture();
    const deriveAffectedStorage = createWorkerEnvironmentAffectedStorageDeriver({
      coreDb: fixture.coreDb,
      store: fixture.store,
    });
    const input = {
      actor: ACTOR,
      configuration: CONFIGURATION,
      replaceNow: fixture.replaceNow,
      target: TARGET,
    };

    expect(deriveAffectedStorage(input)).toEqual([
      { expectedRevision: fixture.bindingRevision, storageRef: fixture.storageRef },
    ]);
    fixture.coreDb.sqlite
      .prepare(
        `UPDATE worker_storage_contributors
         SET responsible_user_id = 'user_other'
         WHERE storage_ref = ?`
      )
      .run(fixture.storageRef);
    expect(() => deriveAffectedStorage(input)).toThrow(
      'resident Worker environment source audience is unavailable'
    );
  });

  it('preserves the written configuration and reports unknown when replacement is uncertain', async () => {
    const resident = createResidentFixture();
    const pair = candidatePair(
      resident,
      [{ expectedRevision: resident.bindingRevision, storageRef: resident.storageRef }],
      resident.replaceNow
    );
    const request = activationRequest(pair);
    const config = configurationService();
    const replaceResidentWork = vi.fn(async () => {
      throw new Error('ordinary successor outcome unavailable');
    });
    const activation = createWorkerEnvironmentActivation({
      configFilesForActor: () => config.files,
      coreDb: resident.coreDb,
      now: () => NOW,
      preparation: { readResolved: () => pair },
      reloadRuntimeConfig: () => reloadResult('applied'),
      replaceResidentWork,
      requireCurrentAdministrator: vi.fn(),
      store: resident.store,
    });

    const response = await activation.activate({ actor: ACTOR }, request);

    expect(response.configuration).toEqual({
      fileId: CONFIGURATION.fileId,
      revision: WRITTEN_REVISION,
    });
    expect(response.affected).toEqual([
      {
        disposition: 'unknown',
        expectedRevision: resident.bindingRevision,
        storageRef: resident.storageRef,
      },
    ]);
    expect(replaceResidentWork).toHaveBeenCalledWith(
      expect.objectContaining({
        residentMembers: [{ threadId: resident.replaceNow.threadId, turnId: null }],
        replaceNow: resident.replaceNow,
      })
    );
  });
});

interface ResidentFixture extends BaseFixture {
  readonly bindingRevision: number;
  readonly replaceNow: WorkerEnvironmentReplaceNow;
  readonly storageRef: string;
  readonly workspaceId: string;
}

/** Adds one attached retained association and its exact durable Sandbox sharing-group joins. */
function createResidentFixture(): ResidentFixture {
  const fixture = createBaseFixture();
  const workspace = fixture.store.listWorkspaces().find((candidate) => candidate.kind === 'code');
  const thread = workspace ? fixture.store.listThreads(workspace.id)[0] : undefined;
  if (!workspace || !thread) throw new Error('Expected Demo Workspace fixture.');
  recordWorkspaceOwnerMembership({
    coreDb: fixture.coreDb,
    ownerUserId: ACTOR.userId,
    workspaceId: workspace.id,
  });
  fixture.coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_runtime_targets (
         target_id, identity_id, deployment_id, connection_generation,
         predecessor_fenced, ready, fresh_empty, observed_at, slot_count
       ) VALUES ('target_activation', 'identity_activation', 'deployment_activation',
         1, 1, 1, 1, ?, 1)`
    )
    .run(NOW);
  const created = createWorkerStorageBinding(fixture.coreDb, {
    deploymentId: 'deployment_activation',
    layout: LAYOUT,
    now: NOW,
    runtimeTargetId: 'target_activation',
    workspaceId: workspace.id,
  });
  const reserved = reserveWorkerStorageAttachment(fixture.coreDb, {
    agentSessionId: 'agent_session_activation',
    authorizeContributor: () => true,
    expectedRevision: created.revision,
    layout: LAYOUT,
    purpose: 'work',
    responsibleUserId: ACTOR.userId,
    runtimeTargetId: 'target_activation',
    storageRef: created.storageRef,
    threadId: thread.id,
    workspaceId: workspace.id,
  });
  const attached = activateWorkerStorageAttachment(fixture.coreDb, {
    attachmentGeneration: reserved.attachmentGeneration,
    expectedRevision: reserved.revision,
    sandboxBindingRef: 'sandbox_binding_activation',
    storageRef: created.storageRef,
    targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
  });
  fixture.coreDb.sqlite
    .prepare(
      `INSERT INTO sandbox_runtime_records (
         sandbox_runtime_id, runtime_target_id, sandbox_binding_ref,
         sandbox_integration_binding_ref, sandbox_compatibility_key, image_digest,
         environment_class, max_open_sessions, max_harnesses, max_active_turns,
         lifecycle_state, health_state, drain_state, cleanup_state, created_at, updated_at
       ) VALUES (
         'sandbox_runtime_activation', 'target_activation', 'sandbox_binding_activation',
         'sandbox_integration_activation', 'compatibility_activation', ?,
         'worker', 8, 8, 1, 'open', 'ready', 'accepting', 'clean', ?, ?
       )`
    )
    .run(`sha256:${'f'.repeat(64)}`, NOW, NOW);
  fixture.coreDb.sqlite
    .prepare(
      `INSERT INTO harness_instance_records (
         harness_instance_id, sandbox_runtime_id, harness_binding_ref,
         harness_compatibility_key, runtime_family, adapter_id, adapter_version,
         protocol_version, capabilities_json, max_open_sessions, max_active_turns,
         open_session_count, active_turn_count, lifecycle_state, drain_state,
         next_sequence, operation_state, created_at, updated_at
       ) VALUES (
         'harness_activation', 'sandbox_runtime_activation', 'harness_binding_activation',
         'harness_compatibility_activation', 'future-runtime', 'future-adapter', '1',
         1, '[]', 8, 1, 1, 0, 'open', 'accepting', 0, 'idle', ?, ?
       )`
    )
    .run(NOW, NOW);
  fixture.coreDb.sqlite
    .prepare(
      `INSERT INTO agent_session_runtime_bindings (
         agent_session_runtime_binding_id, harness_instance_id, agent_session_id,
         workspace_id, thread_id, agent_session_compatibility_key,
         effective_setup_generation, native_handle_state, lifecycle_state,
         next_turn_sequence, cleanup_state, created_at, updated_at
       ) VALUES (
         'binding_activation', 'harness_activation', 'agent_session_activation',
         ?, ?, 'session_compatibility_activation', 1, 'ready', 'open', 0, 'clean', ?, ?
       )`
    )
    .run(workspace.id, thread.id, NOW, NOW);
  return {
    ...fixture,
    bindingRevision: attached.revision,
    replaceNow: {
      prompt: 'Continue the work with the prepared image.',
      threadId: thread.id,
      workspaceId: workspace.id,
    },
    storageRef: attached.storageRef,
    workspaceId: workspace.id,
  };
}
