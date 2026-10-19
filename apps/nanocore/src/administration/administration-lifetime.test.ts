import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { SubmitAdministrationConversationResponse } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { quickChatWorkspaceIdForUser } from '../lib/store.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { createConversationService } from '../mode-entry-routes.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import type { AdministrationEnvironmentTools } from './administration-tools.js';

type ModelResponse = Awaited<ReturnType<LLMGatewayProviderDispatcher['createResponses']>>;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

/** Lets each fault occur only after the real operation reaches model transport. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Rejects a fixture that settles before the intended inference seam is reached. */
async function admittedInference(entered: Promise<AbortSignal>, pending: Promise<Response>) {
  return Promise.race([
    entered,
    pending.then(async (response) => {
      throw new Error(
        `Submission settled before inference: ${response.status} ${await response.clone().text()}`
      );
    }),
  ]);
}

/** A synthetic response, not a replacement for the context, loop or configuration owner. */
function answer(): ModelResponse {
  return {
    id: 'synthetic_administration_answer',
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'The Policy candidate is ready for human review.' }],
      },
    ],
  };
}

/** Real private admission, authored configuration, candidate publication and public interruption. */
function fixture(options: { blockedCall?: 1 | 2; deadlineMs?: number } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'administration-lifetime-'));
  const coreDb = openCoreDb(dataRoot);
  cleanup.push(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const userId = 'usr_00000000-0000-7000-8000-000000000001';
  const workspaceId = quickChatWorkspaceIdForUser(userId);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId });
  const token = createOpenKitAccessTokenRecord(coreDb, {
    tokenId: allocateEntityId('tok'),
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const actor: Actor = {
    kind: 'token',
    userId,
    tokenId: token.tokenId,
    tokenScope: 'server-admin',
    tokenWorkspaceIds: [],
  };
  const store = createDemoStore({ dataRoot });
  const thread = store.createThread(workspaceId, 'Administration', undefined, 'administration', {
    visibility: 'private',
    privateOwnerUserId: userId,
  });
  const provider = {
    id: 'synthetic',
    kind: 'custom',
    displayName: 'Synthetic transport',
    baseUrl: 'https://provider.invalid/v1',
    models: ['model'],
    modelMetadata: {
      model: {
        family: 'test',
        limit: { context: 500_000, output: 30_000 },
        modalities: { input: ['text'], output: ['text'] },
        tool_call: true,
      },
    },
  };
  mkdirSync(join(dataRoot, 'config/providers'), { recursive: true });
  const serverPath = join(dataRoot, 'config/server.jsonc');
  writeFileSync(serverPath, JSON.stringify({ schemaVersion: 1 }));
  writeFileSync(
    join(dataRoot, 'config/providers/synthetic.provider.jsonc'),
    JSON.stringify({ schemaVersion: 1, ...provider })
  );
  writeFileSync(
    join(dataRoot, 'config/gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      defaultLogicalModelId: 'administration',
      logicalModels: [
        {
          id: 'administration',
          displayName: 'Administration',
          contextManagement: [{ type: 'compaction', compactThreshold: 100_000 }],
          routes: [{ id: 'primary', providerProfileId: provider.id, providerModel: 'model' }],
        },
      ],
    })
  );
  // Only the stalled-answer case selects an explicitly authored short profile.
  writeFileSync(
    join(dataRoot, 'config/internal-role-profiles.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      defaultLogicalModelId: 'administration',
      profiles:
        options.deadlineMs === undefined
          ? []
          : [
              {
                id: 'short-answer-test',
                roleId: 'assistant',
                preferredLogicalModelId: 'administration',
                limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: options.deadlineMs },
              },
            ],
    })
  );
  const manager = createRuntimeConfigManager({ dataRoot });
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId,
    workspaceIds: [workspaceId],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const original = readFileSync(serverPath, 'utf8');
  const principal = { kind: 'human', id: userId };
  // An existing inactive native Policy form needs no external MCP schema or new Policy capability.
  const proposed = {
    schemaVersion: 1,
    statements: [
      {
        id: 'review-only-tool-rule',
        kind: 'permission',
        effect: 'require_approval',
        grant: { kind: 'ordinary' },
        author: principal,
        authority: { kind: 'human', userId },
        authoredAt: '2026-10-18T00:00:00Z',
        state: 'inactive',
        scope: {
          subjects: [principal],
          actions: ['tool.use'],
          resources: [{ kind: 'mcp-tool', workspaceId, serverId: 'issues', toolName: 'read' }],
        },
        lifetime: {
          anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'workspace', id: workspaceId },
          uses: 1,
        },
      },
    ],
  };
  const proposal = {
    targetFamily: 'policy',
    targetId: 'server',
    expectedRevision: files.readFile('server.jsonc').file.revision!,
    changes: { proposed, rationale: 'Prepare an inactive rule for exact human review.' },
  };
  const toolResponse: ModelResponse = {
    id: 'synthetic_administration_proposal',
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'function_call',
        call_id: 'policy_candidate',
        name: 'administration_configuration_propose',
        arguments: JSON.stringify(proposal),
      },
    ],
  };
  const entered = deferred<AbortSignal>();
  const release = deferred<ModelResponse>();
  const blockedCall = options.blockedCall ?? 1;
  const createResponses = vi.fn<LLMGatewayProviderDispatcher['createResponses']>(
    async (_provider, request, context) => {
      const call = createResponses.mock.calls.length;
      if (call === 1) {
        const serialized = JSON.stringify(request);
        process.stdout.write(
          `${JSON.stringify({
            event: 'administration-lifetime-first-request',
            serializedBytes: Buffer.byteLength(serialized, 'utf8'),
            toolCount: request.tools?.length ?? 0,
            summaryTask: serialized.includes('<openkit_context_summary_task>'),
          })}\n`
        );
      }
      if (call === blockedCall) {
        const signal = context?.transport?.signal;
        if (!signal) throw new Error('Admitted inference has no cancellation signal.');
        entered.resolve(signal);
        // Deliberately ignore cancellation so the real owners must fence late results.
        return release.promise;
      }
      return call === 1 ? toolResponse : answer();
    }
  );
  const resolveGatewayProvider = (): ResolvedLLMProviderConfig => ({
    ...provider,
    adapterId: 'synthetic',
    apiKey: 'unused-synthetic-fixture',
    requiresApiKey: false,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
  });
  const inflightCommands = new WeakMap();
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const runtimeConfig = () => manager.current();
  const repositoryWorkspaceDb = (id: string) => {
    const db = openWorkspaceDb(dataRoot, id);
    applyScopedMigrations(db);
    return db;
  };
  const unexpectedWorker = () => {
    throw new Error('Administration lifetime tests must not enter a Worker effect domain.');
  };
  const conversationService = createConversationService({
    coreDb,
    inflightCommands,
    workspaceMutationAdmission,
    llmGatewayDispatcher: { createResponses, createChatCompletion: unexpectedWorker },
    repositoryWorkspaceDb,
    resolveGatewayProvider,
    runtimeConfig,
    runtimeConfigManager: manager,
    startModeWorkerTurn: unexpectedWorker,
    workerCoordinatorCandidates: unexpectedWorker,
  });
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (context, next) => {
    context.set('actor', actor);
    await next();
  });
  registerOperationJsonRoutes({
    app,
    coreDb,
    store,
    requestStore: () => store,
    inflightCommands,
    workspaceMutationAdmission,
    repositoryWorkspaceDb,
    conversationService,
    administrationServices: {
      coreDb,
      environmentToolsForTurn: () =>
        ['list', 'status', 'prepare', 'recover'].map((operation) => ({
          name: `worker-environment.${operation}`,
          description: 'Unavailable Worker environment effect domain.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          execute: unexpectedWorker,
        })) as unknown as AdministrationEnvironmentTools,
      inflightCommands,
      llmGatewayDispatcher: { createResponses },
      mode: 'server',
      quickChatWorkspaceIdForUser,
      runtimeConfigFiles: () => files,
      reloadRuntimeConfig: unexpectedWorker,
      resolveGatewayProvider,
      runtimeConfig,
    },
  });
  const request = {
    requestId: randomUUID(),
    threadId: thread.id,
    input: 'Prepare the inactive Policy candidate. Do not apply it.',
  };
  const submit = (signal?: AbortSignal, input = request.input) => {
    const [path, init] = operationRequest(
      'administration.conversation-submit',
      {},
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, input }),
        ...(signal ? { signal } : {}),
      }
    );
    // This is the real Request.signal consumed by the public operation projection.
    return app.request(new Request(new URL(path, 'http://localhost'), init));
  };
  const retained = () => ({
    turns: store.listThreadTurns(workspaceId, thread.id),
    items: store.listThreadItems(workspaceId, thread.id),
    artifacts: store.listArtifacts(workspaceId),
    receipts: store.listCommandRequests(),
  });
  return {
    app,
    store,
    workspaceId,
    thread,
    request,
    submit,
    retained,
    entered,
    release,
    createResponses,
    toolResponse,
    original,
    serverPath,
    proposal,
  };
}

describe('Administration admitted Turn lifetime', () => {
  it.each([
    false,
    true,
  ])('publishes exactly one review-only Policy candidate after client disconnect %s', async (disconnect) => {
    const f = fixture();
    const channel = new AbortController();
    const first = f.submit(channel.signal);
    const inferenceSignal = await admittedInference(f.entered.promise, first);
    expect(f.retained().turns).toHaveLength(1);
    expect(f.retained().turns[0]?.status).toBe('running');
    const duplicate = f.submit();
    if (disconnect) channel.abort(new Error('Synthetic submitting connection closed.'));
    f.release.resolve(f.toolResponse);
    const [response, duplicateResponse] = await Promise.all([first, duplicate]);
    const body = (await response.json()) as SubmitAdministrationConversationResponse;
    const duplicateBody = await duplicateResponse.json();

    expect(response.status).toBe(200);
    expect(body, JSON.stringify(body)).toMatchObject({
      outcome: 'answered',
      turn: { status: 'completed', error: null },
    });
    expect(duplicateResponse.status).toBe(200);
    expect(duplicateBody).toEqual(body);
    expect(inferenceSignal.aborted).toBe(false);
    const artifacts = f.retained().artifacts;
    expect(artifacts).toHaveLength(1);
    const artifact = f.store.getArtifact(f.workspaceId, artifacts[0]!.id);
    expect(artifact).toMatchObject({
      version: 1,
      threadId: f.thread.id,
      turnId: body.turn.id,
      origin: {
        kind: 'turn-output',
        threadId: f.thread.id,
        turnId: body.turn.id,
        requestId: f.request.requestId,
      },
    });
    expect(artifact.content.format).toBe('json');
    if (artifact.content.format !== 'json') throw new Error('Expected immutable JSON candidate.');
    expect(artifact.contentDigest).toBe(
      `sha256:${createHash('sha256').update(artifact.content.body).digest('hex')}`
    );
    expect(JSON.parse(artifact.content.body)).toMatchObject({
      kind: 'administration-configuration-candidate',
      targetFamily: 'policy',
      targetId: 'server',
      expectedRevision: f.proposal.expectedRevision,
      before: { schemaVersion: 1, statements: [] },
      after: { schemaVersion: 1, statements: [{ id: 'review-only-tool-rule', state: 'inactive' }] },
      policyProposal: {
        proposer: { kind: 'human', id: 'usr_00000000-0000-7000-8000-000000000001' },
        validation: 'valid',
      },
    });
    expect(readFileSync(f.serverPath, 'utf8')).toBe(f.original);
    expect(f.createResponses).toHaveBeenCalledTimes(2);
    expect(f.retained().items.filter((item) => item.type === 'assistant-message')).toHaveLength(1);
    expect(
      f
        .retained()
        .receipts.filter((receipt) => receipt.command === 'administration.configuration.apply')
    ).toHaveLength(0);
    const settled = f.retained();
    const replay = await f.submit();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
    const conflict = await f.submit(undefined, 'Different semantic input under the same request.');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(f.retained()).toEqual(settled);
    expect(f.createResponses).toHaveBeenCalledTimes(2);
  });

  it.each([
    1, 2,
  ] as const)('turn.interrupt stops admitted inference %s and fences its late result', async (blockedCall) => {
    const f = fixture({ blockedCall });
    const pending = f.submit();
    const inferenceSignal = await admittedInference(f.entered.promise, pending);
    const turn = f.retained().turns[0]!;
    expect(turn.status).toBe('running');
    expect(f.retained().artifacts).toHaveLength(blockedCall - 1);
    const interruptRequest = {
      workspaceId: f.workspaceId,
      threadId: f.thread.id,
      turnId: turn.id,
      requestId: randomUUID(),
    };
    const interrupt = () =>
      f.app.request(
        ...operationRequest('turn.interrupt', interruptRequest, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(interruptRequest),
        })
      );
    const stopped = await interrupt();
    const stoppedBody = await stopped.json();
    const statusAtStop = f.store.getTurnById(turn.id).status;
    const abortedAtStop = inferenceSignal.aborted;
    f.release.resolve(blockedCall === 1 ? f.toolResponse : answer());
    await pending;
    await setImmediate();

    expect(stopped.status, JSON.stringify(stoppedBody)).toBe(200);
    expect(stoppedBody).toMatchObject({ id: turn.id, status: 'interrupted' });
    expect(statusAtStop).toBe('interrupted');
    expect(abortedAtStop).toBe(true);
    expect(f.store.getTurnById(turn.id).status).toBe('interrupted');
    expect(f.retained().artifacts).toHaveLength(blockedCall - 1);
    expect(f.retained().items.filter((item) => item.type === 'assistant-message')).toHaveLength(0);
    expect(f.createResponses).toHaveBeenCalledTimes(blockedCall);
    expect(readFileSync(f.serverPath, 'utf8')).toBe(f.original);
    const settled = f.retained();
    const replay = await interrupt();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(stoppedBody);
    expect((await f.submit()).status).toBe(200);
    expect(f.retained()).toEqual(settled);
    expect(f.createResponses).toHaveBeenCalledTimes(blockedCall);
  });

  it('reports a stalled ordinary answer as an answer deadline, not continuation summary failure', async () => {
    // Retained local timing showed preparation can take over 1 second before model admission.
    const f = fixture({ deadlineMs: 4_000 });
    const pending = f.submit();
    await admittedInference(f.entered.promise, pending);
    const response = await pending;
    const body = (await response.json()) as SubmitAdministrationConversationResponse;
    const beforeLateResult = f.retained();
    f.release.resolve(f.toolResponse);
    await setImmediate();

    expect(response.status).toBe(200);
    expect(body, JSON.stringify(body)).toMatchObject({
      outcome: 'refused',
      turn: { status: 'failed', error: { code: 'internal_agent_deadline_limit' } },
    });
    expect(body.explanation).not.toMatch(/summary|continuation/i);
    expect(body.turn.error?.message).not.toMatch(/summary|continuation/i);
    expect(body.item).toMatchObject({ type: 'status', summary: body.explanation });
    expect(body.turn.internalExecution).toMatchObject({
      profileId: 'short-answer-test',
      limits: { deadlineMs: 4_000 },
    });
    expect(
      f
        .retained()
        .items.filter(
          (item) => item.type === 'context-summary' || item.type === 'assistant-message'
        )
    ).toHaveLength(0);
    expect(f.retained().artifacts).toHaveLength(0);
    expect(f.retained()).toEqual(beforeLateResult);
    expect(readFileSync(f.serverPath, 'utf8')).toBe(f.original);
    const replay = await f.submit();
    expect(await replay.json()).toEqual(body);
    expect(f.createResponses).toHaveBeenCalledOnce();
  });
});
