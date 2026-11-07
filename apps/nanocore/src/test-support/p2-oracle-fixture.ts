import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GatewayConfig } from '@openkit/config-schema';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from '../capability/usage-ledger.js';
import { createRuntimeConfigManager, type RuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import type { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { TITLE_SYSTEM_PROMPT } from '../llm/title-generation.js';
import { LOCAL_LLM_DEFAULT_MODEL_ID, LOCAL_LLM_PROFILE_ID } from '../local-ai/profiles.js';
import {
  activeLocalAiSupervisor,
  attachLocalBackendLoopbackFixture,
  closeActiveLocalAiSupervisor,
} from '../local-ai/supervisor.js';
import { forgetLoopbackFixture } from '../local-ai/supply.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { createApp } from '../test-support/app.js';
import {
  createLocalAiOracleDataRoot,
  removeLocalAiOracleDataRoot,
} from '../test-support/local-ai-temp-root.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb, createTestWorkspaceDb } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

const TOKEN_EXPIRY = '2999-01-01T00:00:00.000Z';
const AGENT_TEMPLATE = fileURLToPath(
  new URL('../../data-templates/config/agents/codex.agent.jsonc', import.meta.url)
);

/** One title completion the peer writes when a held request is released. */
export interface TitleAnswer {
  readonly content: string;
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

/** What a title-shaped chat request does after the body is stored. */
export type TitleDecision =
  | { readonly kind: 'sse'; readonly answer: TitleAnswer }
  | { readonly kind: 'status'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'hold' };

export interface TitleHit {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/** A title request that has the body and has not been answered. */
export interface HeldTitle {
  readonly body: unknown;
  /** Resolves when the client aborts or closes the socket before an answer. */
  readonly aborted: Promise<void>;
  release(answer: TitleAnswer): void;
  fail(status: number, body: unknown): void;
}

export interface TitlePeer {
  readonly baseUrl: string;
  readonly port: number;
  readonly hits: TitleHit[];
  /** Resolves with the first held title request. */
  readonly held: Promise<HeldTitle>;
  close(): Promise<void>;
}

export interface TitleInstallation {
  readonly app: ReturnType<typeof createApp>;
  readonly manager: RuntimeConfigManager;
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly peer: TitlePeer;
  readonly ownerAuthorization: string;
  readonly adminAuthorization: string;
  readonly memberAuthorization: string;
  supervisor(): ReturnType<typeof activeLocalAiSupervisor>;
  ledger(): {
    calls: ReturnType<typeof listWorkspaceCapabilityCalls>;
    usage: ReturnType<typeof listWorkspaceUsageRecords>;
    audits: ReturnType<typeof listWorkspaceAuditEvents>;
  };
  close(): Promise<void>;
}

/** Gateway whose title route is the built-in local model. `smart` is the default Codex agent model. */
export function titleGateway(
  titleLogicalModelId: string | null,
  assistant?: { readonly profileId: string; readonly modelId: string }
): GatewayConfig {
  const model = {
    displayName: 'Titles',
    routing: { autoFailover: false },
    contextManagement: [{ type: 'compaction' as const, compactThreshold: 1000 }],
  };
  const localRoute = {
    id: 'local',
    providerProfileId: LOCAL_LLM_PROFILE_ID,
    providerModel: LOCAL_LLM_DEFAULT_MODEL_ID,
  };
  return {
    schemaVersion: 1,
    enabled: true,
    ...(titleLogicalModelId ? { titleLogicalModelId } : {}),
    logicalModels: [
      { ...model, id: 'titles', displayName: 'Titles', routes: [localRoute] },
      {
        ...model,
        id: 'smart',
        displayName: 'Smart',
        routes: [
          assistant
            ? {
                id: 'local',
                providerProfileId: assistant.profileId,
                providerModel: assistant.modelId,
              }
            : localRoute,
        ],
      },
    ],
    requiredFeatures: [],
  };
}

/** Title calls carry the fixed system prompt or the `Title:` cue. Other chats are answered immediately. */
export function isTitleRequest(body: unknown): boolean {
  const text = messageText(body);
  return text.includes(TITLE_SYSTEM_PROMPT) || text.includes('\nTitle:');
}

/**
 * OpenAI-compatible loopback. Health is always 200. Only title-shaped chats use `decide`.
 *
 * @param decide Decision for one title request. Non-title chats receive a short SSE answer.
 */
export async function startTitlePeer(
  decide: (body: unknown, url: string) => TitleDecision
): Promise<TitlePeer> {
  const hits: TitleHit[] = [];
  let markHeld: (held: HeldTitle) => void = () => undefined;
  const held = new Promise<HeldTitle>((resolve) => {
    markHeld = resolve;
  });
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void handlePeer(request, response, hits, decide, markHeld);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    hits,
    held,
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * Boots the real app with the title gateway and publishes the llama loopback.
 * The peer is closed with the installation.
 */
export async function openTitleInstallation(input: {
  readonly decide: (body: unknown, url: string) => TitleDecision;
  readonly titleLogicalModelId?: string | null;
  readonly mode?: 'local' | 'server';
  readonly withDefaultAgent?: boolean;
  readonly attachLlama?: boolean;
  readonly wideAssistant?: boolean;
  readonly llmPiAiClient?: PiAiGatewayClient;
}): Promise<TitleInstallation> {
  const peer = await startTitlePeer(input.decide);
  try {
    return await bootTitle(peer, input);
  } catch (error) {
    await peer.close();
    throw error;
  }
}

/** Ledger rows for title generation. */
export function titleCalls(
  installation: TitleInstallation
): ReturnType<TitleInstallation['ledger']>['calls'] {
  return installation.ledger().calls.filter((call) => call.operation === 'llm.title_generation');
}

/** Waits until goal coordinator turns created by a public command have left the running state. */
export async function settleInstallation(installation: TitleInstallation): Promise<void> {
  for (;;) {
    const running = installation.store
      .listThreads(installation.workspaceId)
      .flatMap((thread) => installation.store.listThreadTurns(installation.workspaceId, thread.id))
      .some(
        (turn) =>
          turn.agentId === 'goal-coordinator' &&
          (turn.status === 'running' || turn.status === 'pending')
      );
    if (!running) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Drains coordinator turns, then closes every installation. */
export async function closeInstallations(open: TitleInstallation[]): Promise<void> {
  const installations = open.splice(0);
  for (const installation of installations) await settleInstallation(installation);
  await Promise.all(installations.map((installation) => installation.close()));
}

/** Resolves when every started title call has left `running`. */
export async function awaitTerminalTitles(
  installation: TitleInstallation,
  count = 1
): Promise<ReturnType<TitleInstallation['ledger']>['calls']> {
  for (;;) {
    const calls = titleCalls(installation);
    if (
      calls.length >= count &&
      calls.every((call) => call.status !== 'running' && call.status !== 'queued')
    ) {
      return calls;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function messageText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return '';
  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return '';
      const content = (message as { content?: unknown }).content;
      return typeof content === 'string' ? content : JSON.stringify(content ?? '');
    })
    .join('\n');
}

async function handlePeer(
  request: IncomingMessage,
  response: ServerResponse,
  hits: TitleHit[],
  decide: (body: unknown, url: string) => TitleDecision,
  markHeld: (held: HeldTitle) => void
): Promise<void> {
  const url = request.url ?? '';
  if (request.method === 'GET') {
    const body = url.startsWith('/health') ? { ok: true } : { data: [] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
    return;
  }
  const raw = await readBody(request);
  const parsed = parseJson(raw);
  hits.push({ method: request.method ?? 'POST', url, body: parsed });
  if (!isTitleRequest(parsed)) {
    writeSse(response, { content: 'ok' });
    return;
  }
  const decision = decide(parsed, url);
  if (decision.kind === 'hold') {
    markHeld(holdTitle(request, response, parsed));
    return;
  }
  if (decision.kind === 'status') {
    response.writeHead(decision.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(decision.body));
    return;
  }
  writeSse(response, decision.answer);
}

function holdTitle(request: IncomingMessage, response: ServerResponse, body: unknown): HeldTitle {
  let answered = false;
  let markAborted: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const finishAborted = () => {
    if (answered) return;
    answered = true;
    markAborted();
  };
  request.on('aborted', finishAborted);
  request.on('close', () => {
    if (!answered) finishAborted();
  });
  // The body is already consumed, so the client abort is visible on the socket.
  request.socket?.on('close', finishAborted);
  const answer = (status: number, payload: string, contentType: string) => {
    if (answered || response.writableEnded) return;
    answered = true;
    response.writeHead(status, { 'content-type': contentType });
    response.end(payload);
  };
  return {
    body,
    aborted,
    release: (next) => answer(200, sse(next), 'text/event-stream'),
    fail: (status, payload) => answer(status, JSON.stringify(payload), 'application/json'),
  };
}

function writeSse(response: ServerResponse, answer: TitleAnswer): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(sse(answer));
}

function sse(answer: TitleAnswer): string {
  const chunk = {
    id: 'chat_title',
    object: 'chat.completion.chunk',
    created: 1,
    model: LOCAL_LLM_DEFAULT_MODEL_ID,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: answer.content },
        finish_reason: 'stop',
      },
    ],
    ...(answer.usage ? { usage: answer.usage } : {}),
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseJson(raw: Buffer): unknown {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return raw.toString('utf8');
  }
}

async function bootTitle(
  peer: TitlePeer,
  input: {
    readonly titleLogicalModelId?: string | null;
    readonly mode?: 'local' | 'server';
    readonly withDefaultAgent?: boolean;
    readonly attachLlama?: boolean;
    readonly wideAssistant?: boolean;
    readonly llmPiAiClient?: PiAiGatewayClient;
  }
): Promise<TitleInstallation> {
  await closeActiveLocalAiSupervisor();
  forgetLoopbackFixture('sherpa-onnx-asr');
  forgetLoopbackFixture('llama-cpp');
  const mode = input.mode ?? 'local';
  const titleLogicalModelId =
    input.titleLogicalModelId === undefined ? 'titles' : input.titleLogicalModelId;
  const assistant = input.wideAssistant
    ? { profileId: 'openkit-assistant', modelId: 'assistant-fixture' }
    : undefined;
  const dataRoot = createLocalAiOracleDataRoot({
    mode,
    gateway: titleGateway(titleLogicalModelId, assistant),
    providers: assistant
      ? [{ name: 'assistant.provider.jsonc', profile: assistantProfile(peer.baseUrl, assistant) }]
      : [],
  });
  if (input.withDefaultAgent) installDefaultAgent(dataRoot, mode);
  const coreDb = createTestCoreDb(dataRoot);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Local AI');
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    workspaceId: workspace.id,
  });
  const thread = await store.createThread(workspace.id, 'Voice note');
  const manager = createRuntimeConfigManager({ dataRoot });
  const app = createApp({
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 }),
    },
    coreDb,
    dataRoot,
    mode,
    ...(mode === 'local' ? { localUserId: FIXTURE_LOCAL_USER_ID } : {}),
    providerCredentialResolver: () => 'fixture-credential',
    runtimeConfigManager: manager,
    store,
    ...(input.llmPiAiClient ? { llmPiAiClient: input.llmPiAiClient } : {}),
  });
  if (input.attachLlama !== false) {
    attachLocalBackendLoopbackFixture({
      backendId: 'llama-cpp',
      baseUrl: peer.baseUrl,
      modelId: LOCAL_LLM_DEFAULT_MODEL_ID,
    });
  }
  const owner = createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: TOKEN_EXPIRY,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'workspace',
    workspaceIds: [workspace.id],
  });
  const member = createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: TOKEN_EXPIRY,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'workspace',
    workspaceIds: [workspace.id],
  });
  const admin = createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: TOKEN_EXPIRY,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'server-admin',
    workspaceIds: [],
  });
  return {
    app,
    manager,
    dataRoot,
    workspaceId: workspace.id,
    threadId: thread.id,
    store,
    coreDb,
    peer,
    ownerAuthorization: `Bearer ${owner.secret}`,
    memberAuthorization: `Bearer ${member.secret}`,
    adminAuthorization: `Bearer ${admin.secret}`,
    supervisor: () => activeLocalAiSupervisor(),
    ledger: () => {
      const db = createTestWorkspaceDb(dataRoot, workspace.id);
      try {
        return {
          calls: listWorkspaceCapabilityCalls(db, workspace.id),
          usage: listWorkspaceUsageRecords(db, workspace.id),
          audits: listWorkspaceAuditEvents(db, workspace.id),
        };
      } finally {
        closeTestCoreDb(db);
      }
    },
    close: async () => {
      forgetLoopbackFixture('llama-cpp');
      forgetLoopbackFixture('sherpa-onnx-asr');
      await closeActiveLocalAiSupervisor();
      await shutdownControlStoreWorkerClient();
      await peer.close();
      closeTestCoreDb(coreDb);
      removeLocalAiOracleDataRoot(dataRoot);
    },
  };
}

function assistantProfile(
  baseUrl: string,
  assistant: { readonly profileId: string; readonly modelId: string }
): unknown {
  return {
    schemaVersion: 1,
    id: assistant.profileId,
    vendor: 'openkit',
    kind: 'custom',
    displayName: 'Assistant fixture',
    baseUrl,
    models: [assistant.modelId],
    modelMetadata: {
      [assistant.modelId]: {
        limit: { context: 262_144, output: 8_192 },
        modalities: { input: ['text'], output: ['text'] },
        temperature: true,
        tool_call: true,
      },
    },
  };
}

function installDefaultAgent(dataRoot: string, mode: 'local' | 'server'): void {
  mkdirSync(join(dataRoot, 'config', 'agents'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config', 'agents', 'codex.agent.jsonc'),
    readFileSync(AGENT_TEMPLATE)
  );
  writeFileSync(
    join(dataRoot, 'config', 'server.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      mode,
      defaults: { defaultAgentId: 'agent_codex_host' },
    })
  );
}
