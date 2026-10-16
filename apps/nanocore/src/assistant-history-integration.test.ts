// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubmitConversationResponseSchema } from '@openkit/app-api-schemas';
import { parseReferenceScope } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import type {
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './llm/openai-compatible-client.js';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { ProviderRegistry } from './providers/registry.js';
import {
  closeRetrievalServices,
  getRetrievalService,
  RetrievalService,
} from './retrieval-service.js';
import { openCoreDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const PAST_QUERY = 'cedarneedle';
const CURRENT_QUERY = 'timelinebeacon';
const PRIVATE_DETAIL = 'ELIGIBLE_PRIVATE_HISTORY_DETAIL';
const SHARED_DETAIL = 'ELIGIBLE_SHARED_HISTORY_DETAIL';
const CURRENT_DETAIL = 'CURRENT_PRIVATE_TIMELINE_DETAIL';
const FOREIGN_DETAIL = 'OTHER_USER_PRIVATE_HISTORY_DETAIL';
const CROSS_WORKSPACE_DETAIL = 'OTHER_WORKSPACE_HISTORY_DETAIL';
const REASONING_DETAIL = 'HIDDEN_REASONING_HISTORY_DETAIL';
const stamp = '2026-10-15T00:00:00.000Z';

/** Model-selected query content contains no actor or destination authority. */
interface HistoryQuery {
  query: string;
  mode: 'exact';
  limit: number;
  [key: string]: unknown;
}

/** Logical result facts belong to the history owner, not the kernel's physical scope partitions. */
interface HistoryResult {
  hits: Array<{
    reference: { workspaceId: string; threadId: string; turnId: string; itemId: string };
    revision: string;
    digest: string;
    snippet: string;
  }>;
  complete: boolean;
  retrievalTraceRef: { scopeId: string; objectId: string };
}

/** Retains a completed canonical message so indexing consumes the actual Item owner. */
function retainMessage(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  text: string,
  completeTurn = true
) {
  const turn = store.createTurn(workspaceId, threadId, text, { kind: 'user', id: LOCAL_USER_ID });
  const item = store.createItem({
    id: randomUUID(),
    workspaceId,
    threadId,
    turnId: turn.id,
    type: 'user-message',
    actor: { kind: 'user', id: LOCAL_USER_ID },
    text,
    status: 'completed',
    createdAt: stamp,
    completedAt: stamp,
  });
  if (completeTurn) store.updateTurn(turn.id, { status: 'completed', completedAt: stamp });
  return item;
}

/** Composes the public conversation owner with canonical sources and the real supervised R2 service. */
async function fixture(queries: HistoryQuery[], privateSourceTurnOpen = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'assistant-history-integration-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(async () => {
    await closeRetrievalServices();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('History integration');
  const otherWorkspace = store.createWorkspace('Other history ownership');
  for (const entry of [workspace, otherWorkspace]) {
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: entry.id, ownerUserId: LOCAL_USER_ID });
  }
  const otherUserId = randomUUID();
  const localUser = coreDb.sqlite
    .prepare('SELECT email FROM users WHERE id = ?')
    .get(LOCAL_USER_ID) as { email: string };
  const email = `${randomUUID()}${localUser.email.slice(localUser.email.indexOf('@'))}`;
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind)
     VALUES (?, ?, ?, false, ?, ?, 'human')`
    )
    .run(otherUserId, 'Other history owner', email, Date.now(), Date.now());
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, access_level, joined_at, revision, created_at, updated_at)
     VALUES (?, ?, 'active', 'editor', ?, 1, ?, ?)`
    )
    .run(workspace.id, otherUserId, stamp, stamp, stamp);

  const requests: OpenAICompatibleResponsesRequest[] = [];
  const scriptErrors: unknown[] = [];
  let beforeAnswer: (() => void) | undefined;
  let answerText = 'The history query is complete.';
  const app = createApp({
    coreDb,
    store,
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      defaultLogicalModelId: 'history-test',
      requiredFeatures: [],
      logicalModels: [
        {
          id: 'history-test',
          displayName: 'History test',
          contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
          routes: [
            {
              id: 'primary',
              providerProfileId: 'history-provider',
              providerModel: 'openai/gpt-5.2',
            },
          ],
        },
      ],
    },
    internalRoleProfiles: { schemaVersion: 1, defaultLogicalModelId: 'history-test', profiles: [] },
    providerRegistry: new ProviderRegistry([
      {
        id: 'history-provider',
        displayName: 'History fixture',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]),
    llmPiAiClient: {
      createResponses: async (_provider, request): Promise<OpenAICompatibleResponsesResponse> => {
        requests.push(structuredClone(request));
        if (requests.length > 1) {
          try {
            beforeAnswer?.();
          } catch (error) {
            // Public failure handling must not turn a failed fixture assertion into a passing refusal.
            scriptErrors.push(error);
            throw error;
          }
        }
        return requests.length === 1
          ? {
              id: 'history-query-response',
              object: 'response',
              status: 'completed',
              output: queries.map((query, index) => ({
                type: 'function_call',
                name: 'thread_history_read',
                call_id: `history-query-${index}`,
                arguments: JSON.stringify(query),
              })),
            }
          : {
              id: 'history-answer-response',
              object: 'response',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: answerText }],
                },
              ],
            };
      },
    } as unknown as PiAiGatewayClient,
  });
  const opened = await app.request(
    ...operationRequest(
      'thread.create',
      { workspaceId: workspace.id },
      {
        body: JSON.stringify({ name: 'Assistant', requestId: randomUUID() }),
      }
    )
  );
  expect(opened.status).toBe(200);
  const timeline = await opened.json();
  expect(timeline).toMatchObject({ visibility: 'private', privateOwnerUserId: LOCAL_USER_ID });
  const current = retainMessage(
    store,
    workspace.id,
    timeline.id,
    `${CURRENT_QUERY} ${CURRENT_DETAIL}`
  );
  // Retained earlier conversations remain independent canonical history after the Timeline cutover.
  const past = store.createThread(workspace.id, 'Past private history', undefined, 'conversation', {
    visibility: 'private',
    privateOwnerUserId: LOCAL_USER_ID,
  });
  const privateItem = retainMessage(
    store,
    workspace.id,
    past.id,
    `${PAST_QUERY} ${PRIVATE_DETAIL} ${'繁'.repeat(30_000)}`,
    !privateSourceTurnOpen
  );
  const shared = store.createThread(workspace.id, 'Past Task history', undefined, 'conversation', {
    visibility: 'workspace',
  });
  const sharedItem = retainMessage(
    store,
    workspace.id,
    shared.id,
    `${PAST_QUERY} ${SHARED_DETAIL}`
  );
  const foreign = store.createThread(
    workspace.id,
    'Other private Timeline',
    undefined,
    'conversation',
    {
      visibility: 'private',
      privateOwnerUserId: otherUserId,
    }
  );
  const foreignItem = retainMessage(
    store,
    workspace.id,
    foreign.id,
    `${PAST_QUERY} ${FOREIGN_DETAIL}`
  );
  const otherThread = store.createThread(
    otherWorkspace.id,
    'Other Workspace history',
    undefined,
    'conversation',
    {
      visibility: 'private',
      privateOwnerUserId: LOCAL_USER_ID,
    }
  );
  const crossWorkspaceItem = retainMessage(
    store,
    otherWorkspace.id,
    otherThread.id,
    `${PAST_QUERY} ${CROSS_WORKSPACE_DETAIL}`
  );
  const hiddenTurn = store.createTurn(workspace.id, shared.id, 'Unpublished reasoning', {
    kind: 'user',
    id: LOCAL_USER_ID,
  });
  const reasoning = store.createItem({
    id: randomUUID(),
    workspaceId: workspace.id,
    threadId: shared.id,
    turnId: hiddenTurn.id,
    type: 'reasoning',
    summary: [],
    content: [`${PAST_QUERY} ${REASONING_DETAIL}`],
    status: 'completed',
    createdAt: stamp,
    completedAt: stamp,
  });
  store.updateTurn(hiddenTurn.id, { status: 'completed', completedAt: stamp });
  const selectors = { workspaceId: workspace.id, threadId: timeline.id as string };
  const requestId = randomUUID();
  const submit = () =>
    app.request(
      ...operationRequest('conversation.submit', selectors, {
        body: JSON.stringify({
          input: 'Find earlier notes through conversation history.',
          requestId,
          targetRef: 'internal-role:assistant',
          artifactRefs: [],
        }),
      })
    );
  // A kernel startup failure is a prerequisite failure, never evidence about Tool admission.
  await getRetrievalService(dataRoot, join(dataRoot, 'server')).health();
  return {
    app,
    coreDb,
    dataRoot,
    store,
    requests,
    scriptErrors,
    selectors,
    submit,
    current,
    privateItem,
    sharedItem,
    foreignItem,
    crossWorkspaceItem,
    reasoning,
    otherUserId,
    beforeAnswer: (callback: () => void, text: string) => {
      beforeAnswer = callback;
      answerText = text;
    },
  };
}

/** Extracts only history observations, including the shared loop's plain argument refusal. */
function toolOutputs(requests: OpenAICompatibleResponsesRequest[]): string[] {
  const input = requests.at(-1)?.input;
  expect(Array.isArray(input)).toBe(true);
  return (input as Array<Record<string, unknown>>)
    .filter(
      (item) =>
        item.type === 'function_call_output' && String(item.call_id).startsWith('history-query-')
    )
    .map((item) => String(item.output));
}

/** Decodes successful logical results without changing the shared loop's error contract. */
function toolResults(
  requests: OpenAICompatibleResponsesRequest[]
): Array<{ bytes: string; result: HistoryResult }> {
  return toolOutputs(requests).map((bytes) => ({
    bytes,
    result: JSON.parse(bytes) as HistoryResult,
  }));
}

/** Gives the missing-admission regression a direct oracle before interpreting any Tool result. */
function expectHistoryTool(requests: OpenAICompatibleResponsesRequest[]) {
  const tools = requests[0]?.tools as Array<{ name: string }> | undefined;
  expect(tools?.map((tool) => tool.name)).toContain('thread_history_read');
}

/** Reads the accepted querying-Turn trace path without introducing a second observation store. */
function traces(f: Awaited<ReturnType<typeof fixture>>, turnId: string) {
  const root = join(
    f.dataRoot,
    'workspaces',
    f.selectors.workspaceId,
    'threads',
    f.selectors.threadId,
    'turns',
    turnId,
    'retrieval-traces'
  );
  return existsSync(root)
    ? readdirSync(root)
        .sort()
        .map((name) => ({ name, bytes: readFileSync(join(root, name), 'utf8') }))
    : [];
}

describe('Assistant history Tool through canonical Items and real R2', () => {
  it('retrieves private and past shared history with bounded qualified hits and one immutable content-free trace per query', async () => {
    const f = await fixture([
      { query: PAST_QUERY, mode: 'exact', limit: 2 },
      { query: CURRENT_QUERY, mode: 'exact', limit: 2 },
    ]);
    // Local administrator access exists, but does not widen this Tool's private-history boundary.
    const adminRead = await f.app.request(
      ...operationRequest('thread.read', {
        workspaceId: f.selectors.workspaceId,
        threadId: f.foreignItem.threadId,
      })
    );
    expect(adminRead.status).toBe(200);
    const response = await f.submit();
    expectHistoryTool(f.requests);
    expect(response.status, await response.clone().text()).toBe(200);
    const submitted = SubmitConversationResponseSchema.parse(await response.json());
    expect(submitted.turn.threadId).toBe(f.selectors.threadId);
    expect(f.requests).toHaveLength(2);
    const outputs = toolResults(f.requests);
    expect(outputs).toHaveLength(2);
    const expected = [[f.privateItem, f.sharedItem], [f.current]];
    for (const [index, output] of outputs.entries()) {
      expect(Buffer.byteLength(output.bytes)).toBeLessThanOrEqual(64 * 1024);
      expect(
        Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: output.bytes }] }))
      ).toBeLessThanOrEqual(64 * 1024);
      expect(output.result.complete).toBe(true);
      expect(output.result.hits).toHaveLength(expected[index]!.length);
      expect(output.result.hits.length).toBeLessThanOrEqual(2);
      for (const hit of output.result.hits) {
        const source = expected[index]!.find((item) => item.id === hit.reference.itemId)!;
        expect(source).toBeDefined();
        expect(hit.reference).toEqual({
          workspaceId: source.workspaceId,
          threadId: source.threadId,
          turnId: source.turnId,
          itemId: source.id,
        });
        expect(hit.revision).toEqual(expect.any(String));
        expect(hit.revision.length).toBeGreaterThan(0);
        expect(hit.digest.replace(/^sha256:/, '')).toBe(
          createHash('sha256').update(source.text).digest('hex')
        );
        expect(Buffer.byteLength(hit.snippet)).toBeLessThanOrEqual(4096);
      }
      expect(parseReferenceScope(output.result.retrievalTraceRef.scopeId)).toEqual({
        family: 'retrieval-trace',
        kind: 'turn',
        workspaceId: f.selectors.workspaceId,
        threadId: f.selectors.threadId,
        turnId: submitted.turn.id,
      });
    }
    const firstRequest = JSON.stringify(f.requests[0]);
    expect(firstRequest).not.toContain(PRIVATE_DETAIL);
    expect(firstRequest).not.toContain(SHARED_DETAIL);
    const outputBytes = outputs.map((output) => output.bytes).join('');
    for (const forbidden of [
      FOREIGN_DETAIL,
      CROSS_WORKSPACE_DETAIL,
      REASONING_DETAIL,
      f.foreignItem.id,
      f.crossWorkspaceItem.id,
      f.reasoning.id,
    ])
      expect(outputBytes).not.toContain(forbidden);
    const files = traces(f, submitted.turn.id);
    expect(files).toHaveLength(2);
    expect(new Set(outputs.map(({ result }) => result.retrievalTraceRef.objectId)).size).toBe(2);
    for (const output of outputs) {
      const file = files.find(
        ({ name }) => name === `${output.result.retrievalTraceRef.objectId}.json`
      )!;
      expect(file).toBeDefined();
      const trace = JSON.parse(file.bytes);
      expect(trace).toMatchObject({
        sourceKind: 'conversation',
        queryContext: {
          workspaceId: f.selectors.workspaceId,
          threadId: f.selectors.threadId,
          turnId: submitted.turn.id,
        },
      });
      expect(trace.selected).toEqual(
        output.result.hits.map(({ reference, revision, digest }) => ({
          reference,
          revision,
          digest,
        }))
      );
      for (const forbidden of [
        PAST_QUERY,
        CURRENT_QUERY,
        PRIVATE_DETAIL,
        SHARED_DETAIL,
        CURRENT_DETAIL,
        FOREIGN_DETAIL,
        CROSS_WORKSPACE_DETAIL,
        REASONING_DETAIL,
        'snippet',
      ])
        expect(file.bytes).not.toContain(forbidden);
    }
    const replay = await f.submit();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(submitted);
    expect(f.requests).toHaveLength(2);
    expect(traces(f, submitted.turn.id)).toEqual(files);
    expect(new FsStore({ dataRoot: f.dataRoot }).getTurnById(submitted.turn.id).status).toBe(
      'completed'
    );
    expect(traces(f, submitted.turn.id)).toEqual(files);
  });

  it('rejects model-supplied identity and cross-Workspace bindings before retrieval or trace publication', async () => {
    const f = await fixture([
      {
        query: PAST_QUERY,
        mode: 'exact',
        limit: 2,
        actorId: 'untrusted-actor',
        workspaceId: 'untrusted-workspace',
        threadId: 'untrusted-thread',
        turnId: 'untrusted-turn',
      },
    ]);
    const response = await f.submit();
    expectHistoryTool(f.requests);
    expect(response.status).toBe(200);
    const submitted = SubmitConversationResponseSchema.parse(await response.json());
    const outputs = toolOutputs(f.requests);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe('The Tool arguments do not match the required schema.');
    for (const marker of [PRIVATE_DETAIL, SHARED_DETAIL, FOREIGN_DETAIL, CROSS_WORKSPACE_DETAIL]) {
      expect(outputs[0]!).not.toContain(marker);
    }
    expect(traces(f, submitted.turn.id)).toEqual([]);
  });

  it('withholds changed canonical source content after the real kernel returns and reports incomplete results', async () => {
    // An ongoing source Turn can legitimately revise its retained visible Item before publication.
    const f = await fixture([{ query: PAST_QUERY, mode: 'exact', limit: 2 }], true);
    const search = RetrievalService.prototype.search;
    let changed = false;
    const crossing = vi
      .spyOn(RetrievalService.prototype, 'search')
      .mockImplementation(async function (query) {
        const result = await search.call(this, query);
        if (!changed && result.hits.some((hit) => hit.key.id === f.privateItem.id)) {
          changed = true;
          f.store.updateItem(f.privateItem.id, {
            text: 'Current source no longer contains the old content.',
          });
        }
        return result;
      });
    onTestFinished(() => crossing.mockRestore());
    const response = await f.submit();
    expectHistoryTool(f.requests);
    expect(f.scriptErrors).toEqual([]);
    expect(changed).toBe(true);
    expect(response.status).toBe(200);
    const outputs = toolResults(f.requests);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.result.complete).toBe(false);
    expect(outputs[0]!.result.hits.every((hit) => hit.reference.itemId !== f.privateItem.id)).toBe(
      true
    );
    expect(outputs[0]!.bytes).not.toContain(PRIVATE_DETAIL);
  });

  it.each([
    'source revision',
    'destination membership',
  ] as const)('withholds an old private answer when %s changes after Tool observation and before publication', async (fault) => {
    const { assertConversationRetrievalTraceReadable } = await import(
      './internal-agents/assistant-history.js'
    );
    const f = await fixture([{ query: PAST_QUERY, mode: 'exact', limit: 2 }], true);
    if (fault === 'destination membership') {
      const transferred = await f.app.request(
        ...operationRequest(
          'workspace.ownership-transfer',
          {
            workspaceId: f.selectors.workspaceId,
          },
          {
            body: JSON.stringify({
              requestId: randomUUID(),
              targetUserId: f.otherUserId,
              expectedRegistryRevision: 1,
            }),
          }
        )
      );
      expect(transferred.status, await transferred.clone().text()).toBe(200);
    }
    let changed = false;
    let queryTurnId = '';
    let retainedTraceFiles: ReturnType<typeof traces> = [];
    f.beforeAnswer(() => {
      // The fault follows a real, authorized kernel result already observed by the model.
      const observed = toolResults(f.requests)[0]!.result;
      expect(observed.hits.some((hit) => hit.reference.itemId === f.privateItem.id)).toBe(true);
      const scope = parseReferenceScope(observed.retrievalTraceRef.scopeId);
      expect(scope?.family).toBe('retrieval-trace');
      if (scope?.family !== 'retrieval-trace' || scope.kind !== 'turn')
        throw new Error('Missing querying Turn reference.');
      queryTurnId = scope.turnId;
      retainedTraceFiles = traces(f, queryTurnId);
      const readContext = {
        store: f.store,
        coreDb: f.coreDb,
        actor: { kind: 'local' as const, userId: LOCAL_USER_ID },
        workspaceId: f.selectors.workspaceId,
        retrievalTraceRef: observed.retrievalTraceRef,
      };
      expect(() => assertConversationRetrievalTraceReadable(readContext)).not.toThrow();
      if (fault === 'source revision') {
        f.store.updateItem(f.privateItem.id, {
          text: 'Source content was revised before publication.',
        });
      } else {
        f.coreDb.sqlite
          .prepare(
            `UPDATE workspace_members SET status = 'removed', removed_at = ?, revision = revision + 1
             WHERE workspace_id = ? AND user_id = ?`
          )
          .run(new Date().toISOString(), f.selectors.workspaceId, LOCAL_USER_ID);
      }
      changed = true;
      expect(() => assertConversationRetrievalTraceReadable(readContext)).toThrow();
    }, `${PRIVATE_DETAIL} ${f.privateItem.id}`);
    const response = await f.submit();
    expectHistoryTool(f.requests);
    expect(f.scriptErrors).toEqual([]);
    expect(changed).toBe(true);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json();
    expect(body.code).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(body)).not.toContain(f.privateItem.id);
    expect(
      f.store
        .listThreadItems(f.selectors.workspaceId, f.selectors.threadId)
        .filter(
          (item) =>
            item.type === 'assistant-message' &&
            (item.text.includes(PRIVATE_DETAIL) || item.text.includes(f.privateItem.id))
        )
    ).toEqual([]);
    expect(traces(f, queryTurnId)).toEqual(retainedTraceFiles);
  });
});
