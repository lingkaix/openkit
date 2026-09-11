import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  PrepareWorkerEnvironmentRequest,
  WorkerEnvironmentImageDeclaration,
} from '@openkit/app-api-schemas';
import {
  type AuthoredAgentConfig,
  EMPTY_BUILD_CONTEXT_DIGEST,
  EMPTY_BUILD_CONTEXT_REF,
} from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Actor } from '../auth/identity.js';
import { FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { IdempotencyKeyConflictError } from '../runtime/idempotent-command.js';
import type { WorkerEnvironmentRuntimeEffects } from '../runtime/worker-environment-runtime-effects.js';
import { WorkerEnvironmentOperationError } from './worker-environment-operations.js';
import {
  createWorkerEnvironmentPreparation,
  readWorkerEnvironmentTargetManifest,
} from './worker-environment-preparation.js';

const actor: Actor = {
  kind: 'token',
  tokenId: 'token_admin',
  tokenScope: 'server-admin',
  tokenWorkspaceIds: [],
  userId: 'user_admin',
};
const timestamp = '2026-09-11T01:02:03.000Z';
const storageRef = `wst_${'a'.repeat(32)}`;
const imageDigest = `sha256:${'b'.repeat(64)}`;
const layoutDigest = `sha256:${'c'.repeat(64)}`;
const dataRoots: string[] = [];

afterEach(() => {
  for (const dataRoot of dataRoots.splice(0)) rmSync(dataRoot, { force: true, recursive: true });
});

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function manifest(): AuthoredAgentConfig {
  return {
    displayName: 'Worker Agent',
    id: 'agent_worker',
    models: {
      allowedLogicalModelIds: ['reasoning'],
      preferredLogicalModelId: 'reasoning',
    },
    requiredFeatures: [],
    runtime: {
      adapter: 'codex',
      binaries: [{ id: 'worker-shim', path: '/usr/local/bin/openkit-worker-shim' }],
      image: {
        kind: 'reference',
        pullPolicy: 'if-not-present',
        ref: 'registry.example.com/openkit/worker:old',
      },
      kind: 'codex',
      version: '1',
    },
    schemaVersion: 1,
  };
}

function buildDeclaration(): WorkerEnvironmentImageDeclaration {
  const content = 'FROM scratch\n';
  return {
    arguments: { ZETA: 'last', ALPHA: 'first' },
    contextDigest: EMPTY_BUILD_CONTEXT_DIGEST,
    contextRef: EMPTY_BUILD_CONTEXT_REF,
    egress: [{ host: 'registry.example.com', port: 443 }],
    input: { content, digest: sha256(content), kind: 'dockerfile' },
    kind: 'build',
    layerLimit: 8,
    outputLimitBytes: 1_000_000,
    timeLimitSeconds: 120,
  };
}

function referenceDeclaration(
  ref = 'registry.example.com/openkit/worker:new'
): WorkerEnvironmentImageDeclaration {
  return { kind: 'reference', pullPolicy: 'if-not-present', ref };
}

function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-environment-preparation-'));
  dataRoots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = store.ensureQuickChatWorkspace(actor.userId);
  const thread = store.createThread(
    workspace.id,
    'Administration',
    'thread_admin',
    'administration'
  );
  const agentManifest = manifest();
  const content = JSON.stringify(agentManifest);
  const configuration = {
    expectedRevision: sha256(content),
    fileId: 'agents/worker.agent.jsonc',
  } as const;
  const state = {
    administrator: true,
    affectedRevision: 7,
    configRevision: configuration.expectedRevision as string,
    privateHome: true,
  };
  const order: string[] = [];
  const runtimeEffects: WorkerEnvironmentRuntimeEffects = {
    inspectStorage: vi.fn(),
    prepareImage: vi.fn(async (input) => {
      order.push('prepare');
      if (!input.authorize()) throw new Error('authorization lost');
      return {
        imageDigest,
        layout: {
          family: 'openkit-worker',
          gid: 1000,
          platform: { architecture: 'arm64', os: 'linux' },
          targets: [{ target: '/workspace' }, { target: '/sandbox' }],
          uid: 1000,
          version: '1',
          workingDirectory: '/workspace',
        },
        layoutDigest,
      };
    }),
    purgeStorage: vi.fn(),
    recoverImageEffect: vi.fn(async () => {
      order.push('recover');
      return { imageDigest };
    }),
  };

  const createService = (serviceStore = store) =>
    createWorkerEnvironmentPreparation({
      authorizePrivateHome: ({ actor: current, workspaceId }) =>
        state.privateHome &&
        current.userId === actor.userId &&
        workspaceId === quickChatWorkspaceIdForUser(actor.userId),
      configFilesForActor: () => ({
        readFile: () => ({
          content,
          file: {
            exists: true,
            id: configuration.fileId,
            kind: 'agent' as const,
            path: configuration.fileId,
            revision: state.configRevision,
            updatedAt: timestamp,
          },
        }),
      }),
      deriveAffectedStorage: ({ replaceNow }) =>
        replaceNow ? [{ expectedRevision: state.affectedRevision, storageRef }] : [],
      now: () => timestamp,
      privateWorkspaceIdForUser: quickChatWorkspaceIdForUser,
      requireCurrentAdministrator: () => {
        if (!state.administrator) throw new Error('administrator authority is unavailable');
      },
      runtimeEffects,
      store: serviceStore,
    });

  return {
    configuration,
    createService,
    dataRoot,
    order,
    runtimeEffects,
    state,
    store,
    thread,
    workspace,
  };
}

function prepareRequest(
  threadId: string,
  configuration: { readonly expectedRevision: string; readonly fileId: string },
  declaration: WorkerEnvironmentImageDeclaration = referenceDeclaration(),
  requestId = randomUUID()
): Extract<PrepareWorkerEnvironmentRequest, { readonly mode: 'prepare' }> {
  return {
    administrationThreadId: threadId,
    configuration,
    declaration,
    mode: 'prepare',
    replaceNow: null,
    requestId,
    target: { agentId: 'agent_worker', kind: 'agent' },
  };
}

describe('Worker environment preparation', () => {
  it('persists canonical A and B Artifacts and reads them after an FsStore restart', async () => {
    const fixture = createFixture();
    const request = prepareRequest(fixture.thread.id, fixture.configuration, buildDeclaration());
    const response = await fixture.createService().prepare({ actor }, request);

    expect(response.activationConfirmation).toContain(response.resolvedCandidate.artifactId);
    expect(fixture.store.listArtifacts(fixture.workspace.id)).toHaveLength(2);
    expect(fixture.runtimeEffects.prepareImage).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: response.authoredCandidate,
        image: expect.objectContaining({
          argumentsDigest: sha256(JSON.stringify({ ALPHA: 'first', ZETA: 'last' })),
          kind: 'build',
        }),
      })
    );
    const restarted = new FsStore({ dataRoot: fixture.dataRoot });
    const read = fixture
      .createService(restarted)
      .readResolved({ actor }, response.resolvedCandidate);
    expect(read).toMatchObject({
      authored: { declaration: request.declaration },
      authoredCandidate: response.authoredCandidate,
      resolved: { authoredCandidate: response.authoredCandidate },
      resolvedCandidate: response.resolvedCandidate,
      threadId: fixture.thread.id,
      workspaceId: fixture.workspace.id,
    });
    expect(restarted.listThreadTurns(fixture.workspace.id, fixture.thread.id)).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
  });

  it('replays an identical command and conflicts when its request id names different input', async () => {
    const fixture = createFixture();
    const request = prepareRequest(fixture.thread.id, fixture.configuration);
    const service = fixture.createService();
    const first = await service.prepare({ actor }, request);
    const repeated = await service.prepare({ actor }, request);

    expect(repeated).toEqual(first);
    expect(fixture.runtimeEffects.prepareImage).toHaveBeenCalledTimes(1);
    await expect(
      service.prepare(
        { actor },
        { ...request, declaration: referenceDeclaration('registry.example.com/worker:other') }
      )
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  it('recovers only the retained result on a fresh causation Turn without rewriting A history', async () => {
    const fixture = createFixture();
    const initialRequest = prepareRequest(fixture.thread.id, fixture.configuration, {
      kind: 'reference',
      pullPolicy: 'never',
      ref: imageDigest,
    });
    vi.mocked(fixture.runtimeEffects.prepareImage).mockRejectedValueOnce(
      new Error('lost response')
    );
    await expect(fixture.createService().prepare({ actor }, initialRequest)).rejects.toMatchObject({
      code: 'effect_failed',
    });
    const authoredArtifact = fixture.store.listArtifacts(fixture.workspace.id)[0]!;
    expect(fixture.store.listArtifacts(fixture.workspace.id)).toHaveLength(1);
    expect(authoredArtifact.origin.kind).toBe('turn-output');
    if (authoredArtifact.origin.kind !== 'turn-output') throw new Error('unexpected origin');
    const recoveryThread = fixture.store.createThread(
      fixture.workspace.id,
      'Recovery',
      'thread_recovery',
      'administration'
    );
    const recoveryRequestId = randomUUID();
    const recoveryRequest = {
      administrationThreadId: recoveryThread.id,
      mode: 'recover' as const,
      recoverFrom: {
        artifactId: authoredArtifact.id,
        artifactVersion: 1 as const,
        contentDigest: authoredArtifact.contentDigest,
      },
      requestId: recoveryRequestId,
    };
    expect(
      fixture.store.getTurn(fixture.workspace.id, fixture.thread.id, authoredArtifact.origin.turnId)
        .status
    ).toBe('failed');
    fixture.order.length = 0;
    const response = await fixture.createService().prepare({ actor }, recoveryRequest);

    expect(fixture.order).toEqual(['recover', 'prepare']);
    expect(fixture.runtimeEffects.recoverImageEffect).toHaveBeenCalledWith({
      candidate: recoveryRequest.recoverFrom,
      image: initialRequest.declaration,
      operation: 'image.acquire',
    });
    const resolved = fixture.store.getArtifact(
      fixture.workspace.id,
      response.resolvedCandidate.artifactId
    );
    expect(resolved.origin).toMatchObject({
      kind: 'turn-output',
      requestId: recoveryRequestId,
      threadId: recoveryThread.id,
    });
    expect(
      fixture.store.getTurn(fixture.workspace.id, fixture.thread.id, authoredArtifact.origin.turnId)
        .status
    ).toBe('failed');
    expect(fixture.store.listThreadItems(fixture.workspace.id, recoveryThread.id)).toContainEqual(
      expect.objectContaining({ causationId: initialRequest.requestId, type: 'status' })
    );
  });

  it('refuses a busy direct Thread before creating artifacts or dispatching effects', async () => {
    const fixture = createFixture();
    fixture.store.createTurn(
      fixture.workspace.id,
      fixture.thread.id,
      'Existing administration work',
      { kind: 'user', id: actor.userId }
    );

    await expect(
      fixture
        .createService()
        .prepare({ actor }, prepareRequest(fixture.thread.id, fixture.configuration))
    ).rejects.toMatchObject({ code: 'thread_busy' });
    expect(fixture.store.listArtifacts(fixture.workspace.id)).toEqual([]);
    expect(fixture.runtimeEffects.prepareImage).not.toHaveBeenCalled();
  });

  it('refuses B publication when administrator or private-home authority is revoked', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.runtimeEffects.prepareImage).mockImplementationOnce(async (input) => {
      expect(input.authorize()).toBe(true);
      fixture.state.administrator = false;
      return {
        imageDigest,
        layout: {
          family: 'openkit-worker',
          gid: 1000,
          platform: { architecture: 'arm64', os: 'linux' },
          targets: [{ target: '/workspace' }],
          uid: 1000,
          version: '1',
          workingDirectory: '/workspace',
        },
        layoutDigest,
      };
    });
    await expect(
      fixture
        .createService()
        .prepare({ actor }, prepareRequest(fixture.thread.id, fixture.configuration))
    ).rejects.toThrow('administrator authority');
    expect(fixture.store.listArtifacts(fixture.workspace.id)).toHaveLength(1);

    fixture.state.administrator = true;
    fixture.state.privateHome = false;
    const authored = fixture.store.listArtifacts(fixture.workspace.id)[0]!;
    expect(() =>
      fixture
        .createService()
        .readResolved(
          { actor },
          { artifactId: authored.id, artifactVersion: 1, contentDigest: authored.contentDigest }
        )
    ).toThrow();
  });

  it('rechecks the exact affected storage revisions after image preparation', async () => {
    const fixture = createFixture();
    const request = {
      ...prepareRequest(fixture.thread.id, fixture.configuration),
      replaceNow: {
        prompt: 'Continue with the prepared environment',
        threadId: 'thread_product',
        workspaceId: 'workspace_product',
      },
    };
    vi.mocked(fixture.runtimeEffects.prepareImage).mockImplementationOnce(async (input) => {
      expect(input.authorize()).toBe(true);
      fixture.state.affectedRevision = 8;
      return {
        imageDigest,
        layout: {
          family: 'openkit-worker',
          gid: 1000,
          platform: { architecture: 'arm64', os: 'linux' },
          targets: [{ target: '/workspace' }],
          uid: 1000,
          version: '1',
          workingDirectory: '/workspace',
        },
        layoutDigest,
      };
    });

    await expect(fixture.createService().prepare({ actor }, request)).rejects.toMatchObject({
      code: 'revision_conflict',
    });
    expect(fixture.store.listArtifacts(fixture.workspace.id)).toHaveLength(1);
  });

  it('publishes on the actual private Assistant Turn without terminalizing it', async () => {
    const fixture = createFixture();
    const turn = fixture.store.createTurn(
      fixture.workspace.id,
      fixture.thread.id,
      'Internal administration request',
      { kind: 'user', id: actor.userId }
    );
    const response = await fixture
      .createService()
      .prepare(
        { actor, administrationTurnId: turn.id },
        prepareRequest(fixture.thread.id, fixture.configuration)
      );
    const resolved = fixture.store.getArtifact(
      fixture.workspace.id,
      response.resolvedCandidate.artifactId
    );

    expect(resolved.origin).toMatchObject({ threadId: fixture.thread.id, turnId: turn.id });
    expect(fixture.store.getTurn(fixture.workspace.id, fixture.thread.id, turn.id).status).toBe(
      'running'
    );
  });

  it('rejects a mismatched Dockerfile digest before durable or external effects', async () => {
    const fixture = createFixture();
    const declaration = buildDeclaration();
    if (declaration.kind !== 'build') throw new Error('unexpected declaration');

    await expect(
      fixture.createService().prepare(
        { actor },
        prepareRequest(fixture.thread.id, fixture.configuration, {
          ...declaration,
          input: { ...declaration.input, digest: `sha256:${'d'.repeat(64)}` },
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fixture.store.listThreadTurns(fixture.workspace.id, fixture.thread.id)).toEqual([]);
    expect(fixture.store.listArtifacts(fixture.workspace.id)).toEqual([]);
    expect(fixture.runtimeEffects.prepareImage).not.toHaveBeenCalled();
  });

  it('preserves a runtime recovery-required result and terminalizes its direct Turn', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.runtimeEffects.prepareImage).mockRejectedValueOnce(
      new WorkerEnvironmentOperationError('recovery_required', 'settlement persistence deferred')
    );

    await expect(
      fixture
        .createService()
        .prepare({ actor }, prepareRequest(fixture.thread.id, fixture.configuration))
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(fixture.store.listThreadTurns(fixture.workspace.id, fixture.thread.id)).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
  });

  it('rejects a stale manifest revision before Artifact or image effects', async () => {
    const fixture = createFixture();
    fixture.state.configRevision = `sha256:${'d'.repeat(64)}`;
    expect(() =>
      readWorkerEnvironmentTargetManifest(
        {
          readFile: () => ({
            content: JSON.stringify(manifest()),
            file: {
              exists: true,
              id: fixture.configuration.fileId,
              kind: 'agent',
              path: fixture.configuration.fileId,
              revision: fixture.state.configRevision,
              updatedAt: timestamp,
            },
          }),
        },
        {
          configuration: fixture.configuration,
          target: { agentId: 'agent_worker', kind: 'agent' },
        }
      )
    ).toThrow();
    await expect(
      fixture
        .createService()
        .prepare({ actor }, prepareRequest(fixture.thread.id, fixture.configuration))
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(fixture.store.listArtifacts(fixture.workspace.id)).toEqual([]);
    expect(fixture.runtimeEffects.prepareImage).not.toHaveBeenCalled();
  });
});
