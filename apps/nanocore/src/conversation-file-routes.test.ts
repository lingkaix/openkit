import { createHash, randomUUID } from 'node:crypto';
import fs, {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_FILE_MEDIA_TYPE } from './conversation-file-body.js';
import * as assistantCommandOwners from './internal-agents/assistant-command-run.js';
import * as knowledgeOwners from './knowledge-operations.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore } from './lib/store.js';
import { getSchedulerPreparationClaims } from './runtime/scheduler-dispatch-loop.js';
import { WorkerGovernanceCapacityUnavailableError } from './runtime/worker-governance-backend.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { turnFilePayloadPath } from './storage/workspace-file-records.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Uses the real public operation, local authority, command receipts, and canonical Turn tree. */
function fixture(availableBytes?: () => bigint) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'conversation-files-'));
  cleanups.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanups.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  const workspaceId = DEMO_WORKSPACE_ID;
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: LOCAL_USER_ID, workspaceId });
  const thread = store.createThread(workspaceId, 'File input', undefined, 'conversation', {
    visibility: 'workspace',
  });
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    ...(availableBytes
      ? { fileAdmission: new FileStorageAdmission(dataRoot, () => 1_000_000n, availableBytes) }
      : {}),
  });
  return { dataRoot, coreDb, store, workspaceId, thread, app };
}

/** Describes exact bytes without decoding them or deriving path identity from the name. */
function metadata(bytes: Uint8Array, name = '../arbitrary.bin') {
  return {
    name,
    mediaType: 'application/octet-stream',
    sizeBytes: bytes.byteLength,
    contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

/** Builds the active framing from bounded JSON and raw parts, including empty parts. */
function frame(input: unknown, bytes: readonly Uint8Array[]): Blob {
  const json = Buffer.from(JSON.stringify(input));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.byteLength);
  return new Blob([prefix, json, ...(bytes as Uint8Array<ArrayBuffer>[])]);
}

describe('Turn-owned conversation originals', () => {
  it('requires exact file handoff confirmation before exposing a private brief or bytes to shared Worker work', async () => {
    const state = fixture();
    const source = state.store.createThread(
      state.workspaceId,
      'Private files',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: LOCAL_USER_ID }
    );
    const setup = createTestAgentSetup();
    const executor = new SimulatedTurnExecutor({ coreDb: state.coreDb });
    const prepare = vi
      .spyOn(executor, 'prepareAgentSessionForTurn')
      .mockRejectedValue(new WorkerGovernanceCapacityUnavailableError());
    const app = createApp({
      coreDb: state.coreDb,
      dataRoot: state.dataRoot,
      store: state.store,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    });
    const before = state.store.listThreads(state.workspaceId).map((thread) => thread.id);
    const bytes = Buffer.from('Private original');
    const input = {
      workspaceId: state.workspaceId,
      threadId: source.id,
      requestId: randomUUID(),
      input: 'Private brief must not become shared',
      targetRef: 'new-task-worker',
      artifactRefs: [],
      fileInputs: [metadata(bytes)],
    };
    const response = await app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, [bytes]),
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect((await response.json()).code).toBe('file_handoff_confirmation_required');
    expect(state.store.listThreads(state.workspaceId).map((thread) => thread.id)).toEqual(before);
    expect(state.store.listThreadTurns(state.workspaceId, source.id)).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not disclose a private Artifact through confirmed file handoff', async () => {
    const state = fixture();
    const source = state.store.createThread(
      state.workspaceId,
      'Private output',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: LOCAL_USER_ID }
    );
    const prior = state.store.createTurn(state.workspaceId, source.id, 'Private output', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    const at = new Date().toISOString();
    const body = 'PRIVATE_ARTIFACT_MUST_NOT_BE_SHARED';
    const artifactRequestId = randomUUID();
    const artifact = state.store.createArtifact({
      id: testEntityId('ar', 'private-file-handoff-output'),
      workspaceId: state.workspaceId,
      threadId: source.id,
      turnId: prior.id,
      kind: 'report',
      title: 'Private report',
      status: 'ready',
      summary: 'Private output',
      version: 1,
      content: { format: 'markdown', body },
      contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      lastMutationRequestId: artifactRequestId,
      origin: {
        kind: 'turn-output',
        threadId: source.id,
        turnId: prior.id,
        requestId: artifactRequestId,
      },
      createdAt: at,
      updatedAt: at,
    });
    state.store.updateTurn(prior.id, { status: 'completed', completedAt: at });
    const setup = createTestAgentSetup();
    const executor = new SimulatedTurnExecutor({ coreDb: state.coreDb });
    const prepare = vi.spyOn(executor, 'prepareAgentSessionForTurn');
    const app = createApp({
      coreDb: state.coreDb,
      dataRoot: state.dataRoot,
      store: state.store,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    });
    const before = state.store.listThreads(state.workspaceId).map((thread) => thread.id);
    const bytes = new Uint8Array();
    const input = {
      workspaceId: state.workspaceId,
      threadId: source.id,
      requestId: randomUUID(),
      input: 'Use this report.',
      targetRef: 'new-task-worker',
      fileHandoffConfirmed: true,
      artifactRefs: [{ artifactId: artifact.id, artifactVersion: artifact.version }],
      fileInputs: [metadata(bytes)],
    };
    const response = await app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, [bytes]),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'refused', handoff: null });
    expect(state.store.listThreads(state.workspaceId).map((thread) => thread.id)).toEqual(before);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('refuses file Turn publication when the request aborts during awaited Worker preparation', async () => {
    const state = fixture();
    const setup = createTestAgentSetup();
    const executor = new SimulatedTurnExecutor({ coreDb: state.coreDb });
    const start = vi
      .spyOn(executor, 'prepareAgentSessionForTurn')
      .mockRejectedValue(new WorkerGovernanceCapacityUnavailableError());
    const app = createApp({
      coreDb: state.coreDb,
      dataRoot: state.dataRoot,
      store: state.store,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    });
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = knowledgeOwners.createTaskKnowledgePreparation;
    vi.spyOn(knowledgeOwners, 'createTaskKnowledgePreparation').mockImplementation(
      (dependencies) => {
        const prepare = original(dependencies);
        return async (...arguments_) => {
          const prepared = await prepare(...arguments_);
          reached();
          await held;
          return prepared;
        };
      }
    );
    const controller = new AbortController();
    const bytes = new Uint8Array([0xff, 0]);
    const input = {
      workspaceId: state.workspaceId,
      threadId: state.thread.id,
      requestId: randomUUID(),
      input: 'Implement a focused correction.',
      targetRef: 'new-task-worker',
      fileHandoffConfirmed: true as const,
      artifactRefs: [],
      fileInputs: [metadata(bytes)],
    };
    const result = app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, [bytes]),
      signal: controller.signal,
    });
    await ready;
    controller.abort();
    release();
    const response = await result;
    expect(response.status, await response.clone().text()).toBe(499);
    expect(
      state.store
        .listThreads(state.workspaceId)
        .flatMap((thread) => state.store.listThreadTurns(state.workspaceId, thread.id))
    ).not.toContainEqual(expect.objectContaining({ fileInputs: input.fileInputs }));
    expect(start).not.toHaveBeenCalled();
    expect(
      state.store.listCommandRequests().some((receipt) => receipt.requestId === input.requestId)
    ).toBe(false);
  });

  it('refuses a retained Thread rewrite that exceeds shared publication capacity before Assistant execution', async () => {
    const state = fixture(() => 7_000_000n);
    const threadPath = join(
      state.dataRoot,
      'workspaces',
      state.workspaceId,
      'threads',
      state.thread.id,
      'thread.json'
    );
    const retained = JSON.parse(readFileSync(threadPath, 'utf8'));
    retained.futureMetadata = 'x'.repeat(8_000_000);
    writeFileSync(threadPath, JSON.stringify(retained));
    const before = readFileSync(threadPath);
    const bytes = new Uint8Array([1]);
    const input = {
      workspaceId: state.workspaceId,
      threadId: state.thread.id,
      requestId: randomUUID(),
      input: 'Explain why the sky appears blue.',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: [metadata(bytes)],
    };
    const run = vi
      .spyOn(assistantCommandOwners, 'runAssistantCommand')
      .mockResolvedValue({ id: 'answer', content: 'Must not execute.', providerId: 'fixture' });
    const response = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, [bytes]),
    });
    expect(response.status, await response.clone().text()).toBe(507);
    expect(readFileSync(threadPath)).toEqual(before);
    expect(run).not.toHaveBeenCalled();
    expect(
      state.store.listCommandRequests().some((receipt) => receipt.requestId === input.requestId)
    ).toBe(false);
  });

  it('admits the submitted user-message append through the same shared file-capacity owner', async () => {
    let available = 2_000_000_000n;
    const state = fixture(() => available);
    const bytes = new Uint8Array();
    const input = {
      workspaceId: state.workspaceId,
      threadId: state.thread.id,
      requestId: randomUUID(),
      input: 'x'.repeat(300_000),
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: [metadata(bytes)],
    };
    const create = state.store.createItem.bind(state.store);
    const append = vi.spyOn(state.store, 'createItem').mockImplementation((item, ...rest) => {
      if (item.type === 'user-message' && item.text === input.input) available = 1_250_000n;
      return create(item, ...rest);
    });
    const run = vi.spyOn(assistantCommandOwners, 'runAssistantCommand').mockResolvedValue({
      id: 'answer',
      content: 'Must not execute.',
      providerId: 'fixture',
    });
    const response = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, [bytes]),
    });
    expect(append).toHaveBeenCalled();
    expect(response.status).toBe(507);
    expect(run).not.toHaveBeenCalled();
    expect(
      state.store.listCommandRequests().some((receipt) => receipt.requestId === input.requestId)
    ).toBe(false);
  });

  it('exposes no input inventory after a proved unpublished Turn failure and permits the exact retry', async () => {
    const state = fixture();
    const before = state.store.getThread(state.workspaceId, state.thread.id);
    const bytes = new Uint8Array([0xff, 0]);
    const input = {
      workspaceId: state.workspaceId,
      threadId: state.thread.id,
      requestId: randomUUID(),
      input: 'help',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: [metadata(bytes)],
    };
    const rename = fs.renameSync;
    const fault = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (
        String(target).includes(`/threads/${state.thread.id}/turns/`) &&
        /\/turns\/[^/]+$/.test(String(target))
      )
        throw new Error('Injected Turn publication failure.');
      rename(source, target);
    });
    syncBuiltinESMExports();
    const submit = () =>
      state.app.request('/api/app/operations/conversation.submit', {
        method: 'POST',
        headers: {
          'content-type': CONVERSATION_FILE_MEDIA_TYPE,
          'x-openkit-request-id': input.requestId,
        },
        body: frame(input, [bytes]),
      });
    const failed = await submit();
    expect(failed.status).toBe(500);
    expect(state.store.listThreadTurns(state.workspaceId, state.thread.id)).toHaveLength(0);
    expect(state.store.getThread(state.workspaceId, state.thread.id)).toEqual(before);
    expect(
      state.store.listCommandRequests().some((receipt) => receipt.requestId === input.requestId)
    ).toBe(false);
    fault.mockRestore();
    syncBuiltinESMExports();
    const retried = await submit();
    expect(retried.status, await retried.clone().text()).toBe(202);
    expect((await retried.json()).turn.fileInputs).toEqual(input.fileInputs);
  });

  it('publishes originals before Assistant execution and sends no original bytes into its assembly', async () => {
    const state = fixture();
    const bytes = Buffer.from('UNIQUE_ORIGINAL_CONTENT_MUST_STAY_OUT_OF_MODEL_CONTEXT');
    const input = {
      workspaceId: state.workspaceId,
      threadId: state.thread.id,
      requestId: randomUUID(),
      input: 'Explain why the sky appears blue.',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: [metadata(bytes)],
    };
    const run = vi
      .spyOn(assistantCommandOwners, 'runAssistantCommand')
      .mockImplementation(async (execution) => {
        expect(execution.turn.fileInputs).toEqual(input.fileInputs);
        expect(
          readFileSync(
            turnFilePayloadPath(
              join(state.dataRoot, 'workspaces', state.workspaceId),
              state.thread.id,
              execution.turn.id,
              0
            )
          )
        ).toEqual(bytes);
        expect(JSON.stringify(execution.assembly.messages)).not.toContain(bytes.toString());
        return { id: 'answer', content: 'A bounded answer.', providerId: 'fixture' };
      });
    const response = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, [bytes]),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    { targetRef: 'new-task-worker', privateSource: false },
    { targetRef: 'new-task-worker', privateSource: true },
    { targetRef: 'internal-role:assistant', privateSource: false },
  ])('publishes originals on the actual Worker Turn before $targetRef dispatch (private source: $privateSource)', async ({
    targetRef,
    privateSource,
  }) => {
    const state = fixture();
    const source = privateSource
      ? state.store.createThread(state.workspaceId, 'Private files', undefined, 'conversation', {
          visibility: 'private',
          privateOwnerUserId: LOCAL_USER_ID,
        })
      : state.thread;
    const privateMarker = 'PRIVATE_TRANSCRIPT_MUST_STAY_OUT_OF_SHARED_WORK';
    if (privateSource) {
      const prior = state.store.createTurn(state.workspaceId, source.id, privateMarker, {
        kind: 'user',
        id: LOCAL_USER_ID,
      });
      const completedAt = new Date().toISOString();
      for (const type of ['user-message', 'assistant-message'] as const)
        state.store.createItem({
          id: testEntityId('it', `private-file-handoff-${type}`),
          workspaceId: state.workspaceId,
          threadId: source.id,
          turnId: prior.id,
          type,
          status: 'completed',
          text: privateMarker,
          actor: { kind: 'user', id: LOCAL_USER_ID },
          createdAt: completedAt,
          completedAt,
        });
      state.store.updateTurn(prior.id, { status: 'completed', completedAt });
    }
    const setup = createTestAgentSetup();
    const executor = new SimulatedTurnExecutor({ coreDb: state.coreDb });
    const observed: Array<{ inventory: unknown; bytes: Buffer[]; turnInput: string }> = [];
    const prepare = vi
      .spyOn(executor, 'prepareAgentSessionForTurn')
      .mockImplementation(async (_store, preparation) => {
        observed.push({
          inventory: preparation.turn.fileInputs,
          bytes: preparation.turn.fileInputs!.map((_, ordinal) =>
            readFileSync(
              turnFilePayloadPath(
                join(state.dataRoot, 'workspaces', state.workspaceId),
                preparation.turn.threadId,
                preparation.turn.id,
                ordinal
              )
            )
          ),
          turnInput: preparation.turnInput,
        });
        throw new WorkerGovernanceCapacityUnavailableError();
      });
    const app = createApp({
      coreDb: state.coreDb,
      dataRoot: state.dataRoot,
      store: state.store,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    });
    const bytes = [new Uint8Array([0xff, 0, 1]), new Uint8Array()];
    const input = {
      workspaceId: state.workspaceId,
      threadId: source.id,
      requestId: randomUUID(),
      input: 'Implement a focused correction.',
      targetRef,
      ...(targetRef === 'new-task-worker' ? { fileHandoffConfirmed: true as const } : {}),
      artifactRefs: [],
      fileInputs: bytes.map((part) => metadata(part)),
    };
    const response = await app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, bytes),
    });
    expect(response.status, await response.clone().text()).toBe(202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.allSettled([...getSchedulerPreparationClaims(state.coreDb).values()]);
    expect(prepare).toHaveBeenCalled();
    expect(observed.length).toBeGreaterThan(0);
    const accepted = await response.json();
    for (const observation of observed) {
      expect(observation.inventory).toEqual(input.fileInputs);
      expect(observation.bytes).toEqual(bytes.map((part) => Buffer.from(part)));
      if (privateSource) {
        const delegation = JSON.parse(observation.turnInput);
        expect(delegation.objective).toBe(
          `${input.input}\n\n2 conversation file inputs are retained with the receiving Turn. Original bytes are not included in this prompt.`
        );
        expect(delegation.contextRefs).toEqual([
          { kind: 'workspace', id: state.workspaceId },
          { kind: 'thread', id: accepted.turn.threadId },
        ]);
        expect(delegation.resources).toEqual([]);
        expect(observation.turnInput).not.toContain(privateMarker);
      }
    }
    if (privateSource) {
      const receiving = state.store.getThread(state.workspaceId, accepted.turn.threadId);
      expect(receiving.visibility).toBe('workspace');
      expect(receiving.id).not.toBe(source.id);
      expect(state.store.getThread(state.workspaceId, source.id).visibility).toBe('private');
      expect(
        JSON.stringify(state.store.listThreadItems(state.workspaceId, receiving.id))
      ).not.toContain(privateMarker);
    }
    if (targetRef === 'new-task-worker') expect(accepted.turn.fileInputs).toEqual(input.fileInputs);
    else expect(accepted.turn.fileInputs).toBeUndefined();
    const replay = await app.request(
      ...operationRequest('conversation.submit', {}, { body: JSON.stringify(input) })
    );
    expect(replay.status, await replay.clone().text()).toBe(202);
    expect((await replay.json()).turn.id).toBe(accepted.turn.id);
    if (targetRef === 'new-task-worker') {
      const { fileHandoffConfirmed: _consent, ...unconfirmed } = input;
      const changed = await app.request(
        ...operationRequest('conversation.submit', {}, { body: JSON.stringify(unconfirmed) })
      );
      expect(changed.status, await changed.clone().text()).toBe(409);
      expect((await changed.json()).code).toBe('idempotency_key_conflict');
      const changedBrief = await app.request(
        ...operationRequest(
          'conversation.submit',
          {},
          { body: JSON.stringify({ ...input, input: 'Changed disclosure' }) }
        )
      );
      expect(changedBrief.status, await changedBrief.clone().text()).toBe(409);
      expect((await changedBrief.json()).code).toBe('idempotency_key_conflict');
    }
  });

  it('refuses files before an automatic Goal operation with no receiving input Turn', async () => {
    const state = fixture();
    const bytes = new Uint8Array();
    const input = {
      workspaceId: state.workspaceId,
      threadId: state.thread.id,
      requestId: randomUUID(),
      input: 'Plan a multi-step release goal for NanoCore.',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: [metadata(bytes)],
    };
    const response = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, [bytes]),
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect((await response.json()).code).toBe('file_inputs_not_applicable');
    expect(state.store.listThreadTurns(state.workspaceId, state.thread.id)).toHaveLength(0);
    expect(
      state.store.listCommandRequests().some((receipt) => receipt.command === 'goal.create')
    ).toBe(false);
  });

  it('cancels an incomplete file stream without publishing a Turn and removes private stages', async () => {
    const state = fixture();
    const controller = new AbortController();
    const bytes = new Uint8Array(65_536);
    const input = {
      workspaceId: state.workspaceId,
      threadId: state.thread.id,
      requestId: randomUUID(),
      input: 'help',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: [{ ...metadata(bytes), sizeBytes: bytes.length + 1 }],
    };
    let part = 0;
    const framed = new Uint8Array(await frame(input, [bytes]).arrayBuffer());
    const source = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          if (part++ === 0) stream.enqueue(framed);
          else setTimeout(() => controller.abort(), 0);
        },
      },
      { highWaterMark: 0 }
    );
    const response = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: source,
      signal: controller.signal,
      duplex: 'half',
    } as RequestInit);
    expect(response.status, await response.clone().text()).toBe(499);
    expect(state.store.listThreadTurns(state.workspaceId, state.thread.id)).toHaveLength(0);
    expect(
      readdirSync(join(state.dataRoot, 'workspaces', '.staging')).filter((name) =>
        name.startsWith('artifact-')
      )
    ).toEqual([]);
  });

  it('exports, remints, imports, and re-exports exact binary originals under their new Turn owners', async () => {
    const state = fixture();
    const bytes = [new Uint8Array(), new Uint8Array([0xff, 0, 0xc0, 0x80])];
    const input = {
      workspaceId: state.workspaceId,
      threadId: state.thread.id,
      requestId: randomUUID(),
      input: 'search the web',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: bytes.map((part) => metadata(part)),
    };
    const acceptedResponse = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, bytes),
    });
    expect(acceptedResponse.status, await acceptedResponse.clone().text()).toBe(200);
    const accepted = await acceptedResponse.json();
    let workspaceId = state.workspaceId;
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const exported = await state.app.request(
        ...operationRequest('workspace.export', { workspaceId })
      );
      expect(exported.status, await exported.clone().text()).toBe(200);
      const { exportId } = await exported.json();
      const imported = await state.app.request(
        ...operationRequest(
          'workspace.import',
          {},
          {
            body: JSON.stringify({
              sourceWorkspaceId: workspaceId,
              exportId,
              requestId: randomUUID(),
            }),
          }
        )
      );
      expect(imported.status, await imported.clone().text()).toBe(200);
      const { importedWorkspaceId } = await imported.json();
      expect(importedWorkspaceId).not.toBe(workspaceId);
      workspaceId = importedWorkspaceId;
      const turn = state.store
        .listThreads(workspaceId)
        .flatMap((thread) => state.store.listThreadTurns(workspaceId, thread.id))
        .find((candidate) => candidate.fileInputs?.length)!;
      expect(turn.id).not.toBe(accepted.turn.id);
      expect(turn.fileInputs).toEqual(input.fileInputs);
      const root = join(state.dataRoot, 'workspaces', workspaceId);
      for (const [ordinal, part] of bytes.entries())
        expect(readFileSync(turnFilePayloadPath(root, turn.threadId, turn.id, ordinal))).toEqual(
          Buffer.from(part)
        );
    }
  });

  it('retains ordered empty and invalid UTF-8 originals without creating an Artifact, then replays without retry bytes', async () => {
    const state = fixture();
    const bytes = [new Uint8Array(), new Uint8Array([0xff, 0, 0xc0, 0x80, 0x7f])];
    const input = {
      workspaceId: state.workspaceId,
      threadId: state.thread.id,
      requestId: randomUUID(),
      input: 'help',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: bytes.map((part) => metadata(part)),
    };
    const artifactsBefore = state.store.listArtifacts(state.workspaceId).length;
    const response = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, bytes),
    });
    expect(response.status, await response.clone().text()).toBe(202);
    const accepted = await response.json();
    expect(accepted.turn.fileInputs).toEqual(input.fileInputs);
    expect(state.store.listArtifacts(state.workspaceId)).toHaveLength(artifactsBefore);
    const root = join(state.dataRoot, 'workspaces', state.workspaceId);
    for (const [ordinal, part] of bytes.entries())
      expect(
        readFileSync(turnFilePayloadPath(root, state.thread.id, accepted.turn.id, ordinal))
      ).toEqual(Buffer.from(part));
    const replay = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': input.requestId },
      body: JSON.stringify(input),
    });
    expect(replay.status).toBe(202);
    expect((await replay.json()).turn.id).toBe(accepted.turn.id);
    const fileReplay = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, []),
    });
    expect(fileReplay.status).toBe(202);
    expect((await fileReplay.json()).turn.id).toBe(accepted.turn.id);
    const turnPath = join(root, 'threads', state.thread.id, 'turns', accepted.turn.id, 'turn.json');
    const retained = JSON.parse(readFileSync(turnPath, 'utf8'));
    retained.fileInputs[1].futureAnnotation = 'Retained descriptive field';
    writeFileSync(turnPath, JSON.stringify(retained));
    const restarted = new FsStore({ dataRoot: state.dataRoot });
    expect(restarted.getTurnById(accepted.turn.id).fileInputs).toEqual(input.fileInputs);
    restarted.updateThread(state.workspaceId, state.thread.id, { name: 'Retained inputs' });
    expect(JSON.parse(readFileSync(turnPath, 'utf8')).fileInputs[1].futureAnnotation).toBe(
      'Retained descriptive field'
    );
    const changed = { ...input, fileInputs: [input.fileInputs[1], input.fileInputs[0]] };
    const conflict = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': input.requestId },
      body: JSON.stringify(changed),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('idempotency_key_conflict');
    writeFileSync(turnFilePayloadPath(root, state.thread.id, accepted.turn.id, 1), 'other');
    const corrupt = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': input.requestId },
      body: JSON.stringify(input),
    });
    expect(corrupt.status).toBe(409);
    expect((await corrupt.json()).code).toBe('recovery_required');
  });

  it.each([
    'missing',
    'surplus',
    'digest',
  ] as const)('rejects %s bytes before Turn or Artifact publication', async (kind) => {
    const state = fixture();
    const bytes = new Uint8Array([0xff, 0, 1]);
    const input = {
      workspaceId: state.workspaceId,
      threadId: state.thread.id,
      requestId: randomUUID(),
      input: 'help',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: [metadata(bytes)],
    };
    const body =
      kind === 'missing'
        ? bytes.subarray(0, 2)
        : kind === 'surplus'
          ? new Uint8Array([0xff, 0, 1, 9])
          : new Uint8Array([1, 0, 0xff]);
    const response = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: {
        'content-type': CONVERSATION_FILE_MEDIA_TYPE,
        'x-openkit-request-id': input.requestId,
      },
      body: frame(input, [body]),
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(state.store.listThreadTurns(state.workspaceId, state.thread.id)).toHaveLength(0);
    expect(
      existsSync(
        join(
          state.dataRoot,
          'workspaces',
          state.workspaceId,
          'threads',
          state.thread.id,
          'turns',
          'tu_1'
        )
      )
    ).toBe(false);
  });

  it('requires bytes for a new metadata-only command before effects', async () => {
    const state = fixture();
    const requestId = randomUUID();
    const input = {
      workspaceId: state.workspaceId,
      threadId: state.thread.id,
      requestId,
      input: 'help',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: [metadata(new Uint8Array())],
    };
    const response = await state.app.request('/api/app/operations/conversation.submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('file_input_bytes_required');
    expect(state.store.listThreadTurns(state.workspaceId, state.thread.id)).toHaveLength(0);
  });
});
