import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPOSER_TRANSCRIBE_MAX_AUDIO_BYTES,
  COMPOSER_TRANSCRIBE_MAX_BODY_BYTES,
} from '@openkit/app-api-schemas';
import type { GatewayConfig, ProviderProfile } from '@openkit/config-schema';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { listWorkspaceAuditEvents } from './audit-events.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from './capability/usage-ledger.js';
import { FsStore } from './lib/store.js';
import { TRANSCRIPTION_PROMPT } from './llm/audio-transcription.js';
import { ProviderRegistry } from './providers/registry.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { recordActiveHumanWorkspaceMember } from './test-support/active-human-member.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { closeTestCoreDb, createTestCoreDb, createTestWorkspaceDb } from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const OTHER_USER_ID = 'usr_00000000-0000-73d4-904a-d4c4b905df7c';
const STAMP = '2026-09-14T00:00:00.000Z';
const TOKEN_EXPIRY = '2999-01-01T00:00:00.000Z';
const TRANSCRIPT = 'spoken words';
const CLIP_MARKER = 'VOICE-CLIP-MARKER';

interface UpstreamHit {
  readonly url: string;
  readonly method: string;
  readonly contentType: string;
  readonly authorization: string;
  readonly body: Buffer;
}

interface SpeechFixture {
  readonly app: ReturnType<typeof createApp>;
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly ownThreadId: string;
  readonly deniedThreadId: string;
  readonly foreignThreadId: string;
  readonly gateway: GatewayConfig;
  readonly hits: UpstreamHit[];
  readonly resolverCalls: Array<{ secretRef: string; hasContext: boolean }>;
  releaseSecret: boolean;
  /** Runs once inside the next credential resolution, then clears. */
  beforeCredentialRelease: (() => void) | null;
  /** HTTP status for the next upstream response. Restored to 200 after that response. */
  upstreamStatus: number;
  readonly fixtureSecret: string;
  readonly ownerAuthorization: string;
  readonly readonlyAuthorization: string;
  close: () => Promise<void>;
}

/**
 * One server-mode app, a loopback transcription peer, and two audience threads.
 *
 * @returns Fixture closed by the suite.
 */
async function createSpeechFixture(): Promise<SpeechFixture> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-composer-transcribe-'));
  const coreDb = createTestCoreDb(dataRoot);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Voice');
  const foreignWorkspace = await store.createWorkspace('Foreign');
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    workspaceId: workspace.id,
  });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    workspaceId: foreignWorkspace.id,
  });
  recordActiveHumanWorkspaceMember(coreDb, {
    userId: OTHER_USER_ID,
    email: ['voice-other', 'example.invalid'].join('@'),
    workspaceId: workspace.id,
    joinedAt: STAMP,
    nowMs: Date.now(),
  });
  const own = await store.createThread(workspace.id, 'own', undefined, 'conversation', {
    visibility: 'private',
    privateOwnerUserId: FIXTURE_LOCAL_USER_ID,
  });
  const denied = await store.createThread(
    workspace.id,
    'other private',
    undefined,
    'conversation',
    {
      visibility: 'private',
      privateOwnerUserId: OTHER_USER_ID,
    }
  );
  const foreign = await store.createThread(
    foreignWorkspace.id,
    'foreign',
    undefined,
    'conversation',
    { visibility: 'workspace' }
  );
  const hits: UpstreamHit[] = [];
  const upstream = { status: 200 };
  const server = createServer((request, response) => {
    void collectHit(request, response, hits, upstream);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const fixtureSecret = `fixture-${randomUUID()}`;
  const resolverCalls: SpeechFixture['resolverCalls'] = [];
  const gateway: GatewayConfig = {
    schemaVersion: 1,
    enabled: true,
    defaultLogicalModelId: 'reasoning',
    logicalModels: [
      {
        id: 'reasoning',
        displayName: 'Reasoning',
        contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
        routes: [
          {
            id: 'chat',
            providerProfileId: 'speech',
            providerModel: 'openai/gpt-5.1',
          },
        ],
      },
    ],
    transcription: {
      routes: [
        {
          id: 'voice',
          providerProfileId: 'speech',
          providerModel: 'whisper-1',
        },
      ],
    },
    requiredFeatures: [],
  };
  const profile: ProviderProfile = {
    id: 'speech',
    displayName: 'Speech',
    kind: 'custom',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: ['openai/gpt-5.1', 'whisper-1'],
    secretRef: 'env:OPENKIT_FIXTURE_SPEECH',
  };
  const release = { current: true };
  let beforeCredentialRelease: (() => void) | null = null;
  const app = createApp({
    agentManifests: [],
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 }),
    },
    coreDb,
    dataRoot,
    gatewayConfig: gateway,
    mode: 'server',
    providerCredentialResolver: (secretRef, context) => {
      resolverCalls.push({ secretRef, hasContext: context !== undefined });
      const hook = beforeCredentialRelease;
      beforeCredentialRelease = null;
      hook?.();
      return release.current ? fixtureSecret : null;
    },
    providerRegistry: new ProviderRegistry([profile]),
    store,
  });
  const owner = createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: TOKEN_EXPIRY,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'workspace',
    workspaceIds: [workspace.id],
  });
  const readonly = createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: TOKEN_EXPIRY,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'workspace-readonly',
    workspaceIds: [workspace.id],
  });
  return {
    app,
    dataRoot,
    workspaceId: workspace.id,
    ownThreadId: own.id,
    deniedThreadId: denied.id,
    foreignThreadId: foreign.id,
    gateway,
    hits,
    resolverCalls,
    get releaseSecret() {
      return release.current;
    },
    set releaseSecret(value: boolean) {
      release.current = value;
    },
    get beforeCredentialRelease() {
      return beforeCredentialRelease;
    },
    set beforeCredentialRelease(value: (() => void) | null) {
      beforeCredentialRelease = value;
    },
    get upstreamStatus() {
      return upstream.status;
    },
    set upstreamStatus(value: number) {
      upstream.status = value;
    },
    fixtureSecret,
    ownerAuthorization: `Bearer ${owner.secret}`,
    readonlyAuthorization: `Bearer ${readonly.secret}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      closeTestCoreDb(coreDb);
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { force: true, recursive: true });
    },
  };
}

async function collectHit(
  request: IncomingMessage,
  response: ServerResponse,
  hits: UpstreamHit[],
  upstream: { status: number }
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  hits.push({
    url: request.url ?? '',
    method: request.method ?? '',
    contentType: String(request.headers['content-type'] ?? ''),
    authorization: String(request.headers.authorization ?? ''),
    body: Buffer.concat(chunks),
  });
  const status = upstream.status;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ text: TRANSCRIPT, usage: { seconds: 1.25 }, duration: 9 }));
}

function clipAudio(): string {
  return Buffer.from(CLIP_MARKER).toString('base64');
}

async function postJson(
  fixture: SpeechFixture,
  body: Record<string, unknown>,
  authorization = fixture.ownerAuthorization
): Promise<Response> {
  return fixture.app.request(
    ...operationRequest('composer.transcribe', body, {
      headers: { authorization },
    })
  );
}

function ledger(fixture: SpeechFixture, workspaceId = fixture.workspaceId) {
  const db = createTestWorkspaceDb(fixture.dataRoot, workspaceId);
  try {
    return {
      calls: listWorkspaceCapabilityCalls(db, workspaceId),
      usage: listWorkspaceUsageRecords(db, workspaceId),
      audits: listWorkspaceAuditEvents(db, workspaceId),
    };
  } finally {
    closeTestCoreDb(db);
  }
}

function formParts(
  contentType: string,
  body: Buffer
): Map<string, { filename: string | null; text: string }> {
  const boundary = /boundary="?([^";]+)"?/.exec(contentType)?.[1];
  if (!boundary) throw new Error('Multipart boundary missing.');
  const parts = new Map<string, { filename: string | null; text: string }>();
  for (const chunk of body.toString('latin1').split(`--${boundary}`)) {
    const trimmed = chunk.replace(/^\r\n/, '');
    if (trimmed.startsWith('--') || trimmed.trim() === '') continue;
    const [header, ...rest] = trimmed.split('\r\n\r\n');
    if (!header) continue;
    const name = /name="([^"]+)"/.exec(header)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/.exec(header)?.[1] ?? null;
    let text = rest.join('\r\n\r\n');
    if (text.endsWith('\r\n')) text = text.slice(0, -2);
    parts.set(name, { filename, text });
  }
  return parts;
}

function treeHas(root: string, needle: string): boolean {
  const encoded = Buffer.from(needle);
  const walk = (directory: string): boolean => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (walk(path)) return true;
      } else if (entry.isFile() && readFileSync(path).includes(encoded)) return true;
    }
    return false;
  };
  return walk(root);
}

function audioFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(webm|mp4|wav|tmp)$/i.test(entry.name)) found.push(entry.name);
    }
  };
  walk(root);
  return found;
}

let fixture: SpeechFixture;

beforeAll(async () => {
  fixture = await createSpeechFixture();
}, 30_000);

afterAll(async () => {
  await fixture?.close();
});

it('transcribes one clip through the generic JSON route and records measured usage', async () => {
  const audio = clipAudio();
  const before = snapshot();
  const withThread = await postJson(fixture, {
    workspaceId: fixture.workspaceId,
    threadId: fixture.ownThreadId,
    audio,
    mimeType: 'audio/webm;codecs=opus',
  });
  const withThreadBody = await withThread.json();
  expect(withThread.status, JSON.stringify(withThreadBody)).toBe(200);
  expect(withThreadBody).toEqual({ text: TRANSCRIPT });
  expect(fixture.hits).toHaveLength(before.hits + 1);
  const hit = fixture.hits[0]!;
  expect(hit.method).toBe('POST');
  expect(hit.url.endsWith('/audio/transcriptions')).toBe(true);
  expect(hit.contentType.startsWith('multipart/form-data; boundary=')).toBe(true);
  expect(hit.authorization).toBe(`Bearer ${fixture.fixtureSecret}`);
  const parts = formParts(hit.contentType, hit.body);
  expect(parts.get('file')?.filename).toBe('clip.webm');
  expect(parts.get('model')?.text).toBe('whisper-1');
  expect(parts.get('prompt')?.text).toBe(TRANSCRIPTION_PROMPT);
  expect(parts.has('language')).toBe(false);
  const raw = hit.body.toString('latin1');
  expect(raw).not.toContain('gpt-5.1');
  expect(raw).not.toContain('reasoningEffort');
  expect(raw).not.toContain('reasoning');
  const stored = ledger(fixture);
  expect(stored.calls).toHaveLength(1);
  expect(stored.calls[0]).toMatchObject({
    capabilityId: 'llm.audio_transcriptions',
    operation: 'llm.audio_transcriptions',
    family: 'llm',
    status: 'succeeded',
    threadId: fixture.ownThreadId,
    turnId: null,
    providerRef: 'speech',
    summary: 'Audio transcription.',
  });
  expect(stored.calls[0]?.systemPromptDigest).toBeUndefined();
  expect(stored.usage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        unit: 'requests',
        quantity: 1,
        category: 'llm',
        modelId: 'whisper-1',
        providerModel: 'whisper-1',
        source: 'measured',
      }),
      expect.objectContaining({
        unit: 'seconds',
        quantity: 1.25,
        category: 'llm',
        modelId: 'whisper-1',
      }),
    ])
  );
  expect(JSON.stringify(stored)).not.toContain(TRANSCRIPT);
  expect(JSON.stringify(stored)).not.toContain(CLIP_MARKER);
  expect(JSON.stringify(stored)).not.toContain(audio);
  expect(fixture.resolverCalls.length).toBe(before.resolver + 1);
  expect(fixture.resolverCalls.at(-1)).toMatchObject({
    secretRef: 'env:OPENKIT_FIXTURE_SPEECH',
    hasContext: true,
  });

  const starter = await postJson(fixture, {
    workspaceId: fixture.workspaceId,
    audio,
    mimeType: 'audio/webm',
    language: 'en',
  });
  expect(starter.status, await starter.clone().text()).toBe(200);
  const starterParts = formParts(fixture.hits[1]!.contentType, fixture.hits[1]!.body);
  expect(starterParts.get('language')?.text).toBe('en');
  expect(starterParts.get('model')?.text).toBe('whisper-1');
  const afterStarter = ledger(fixture);
  expect(afterStarter.calls).toHaveLength(2);
  expect(afterStarter.calls[1]).toMatchObject({
    threadId: null,
    turnId: null,
    status: 'succeeded',
  });

  await expectRefused(
    async () => {
      const oversized = 'x'.repeat(COMPOSER_TRANSCRIBE_MAX_BODY_BYTES + 1);
      return fixture.app.request('/api/app/operations/composer.transcribe', {
        method: 'POST',
        headers: {
          authorization: fixture.ownerAuthorization,
          'content-type': 'application/json',
        },
        body: oversized,
      });
    },
    413,
    'payload_too_large'
  );

  await expectRefused(
    async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(COMPOSER_TRANSCRIBE_MAX_BODY_BYTES + 1));
          controller.close();
        },
      });
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        headers: {
          authorization: fixture.ownerAuthorization,
          'content-type': 'application/json',
        },
        body: stream,
        duplex: 'half',
      };
      const request = new Request('http://127.0.0.1/api/app/operations/composer.transcribe', init);
      request.headers.delete('content-length');
      expect(request.headers.has('content-length')).toBe(false);
      return fixture.app.request(request);
    },
    413,
    'payload_too_large'
  );

  const decoded = Buffer.alloc(COMPOSER_TRANSCRIBE_MAX_AUDIO_BYTES + 1, 1).toString('base64');
  expect(Buffer.byteLength(JSON.stringify({ audio: decoded }))).toBeLessThan(
    COMPOSER_TRANSCRIBE_MAX_BODY_BYTES
  );
  await expectRefused(
    () =>
      postJson(fixture, {
        workspaceId: fixture.workspaceId,
        audio: decoded,
        mimeType: 'audio/webm',
      }),
    413,
    'payload_too_large'
  );

  await expectRefused(
    () =>
      postJson(
        fixture,
        {
          workspaceId: fixture.workspaceId,
          audio,
          mimeType: 'audio/webm',
        },
        fixture.readonlyAuthorization
      ),
    403,
    'workspace_access_denied'
  );

  await expectRefused(
    () =>
      postJson(fixture, {
        workspaceId: fixture.workspaceId,
        threadId: fixture.deniedThreadId,
        audio,
        mimeType: 'audio/webm',
      }),
    404,
    'not_found'
  );

  await expectRefused(
    () =>
      postJson(fixture, {
        workspaceId: fixture.workspaceId,
        threadId: fixture.foreignThreadId,
        audio,
        mimeType: 'audio/webm',
      }),
    404,
    'not_found'
  );

  fixture.gateway.enabled = false;
  try {
    await expectRefused(
      () =>
        postJson(fixture, {
          workspaceId: fixture.workspaceId,
          audio,
          mimeType: 'audio/webm',
        }),
      403,
      'gateway_disabled'
    );
  } finally {
    fixture.gateway.enabled = true;
  }

  const member = fixture.gateway.transcription;
  fixture.gateway.transcription = undefined;
  try {
    await expectRefused(
      () =>
        postJson(fixture, {
          workspaceId: fixture.workspaceId,
          audio,
          mimeType: 'audio/webm',
        }),
      409,
      'transcription_route_missing'
    );
  } finally {
    fixture.gateway.transcription = member;
  }

  fixture.releaseSecret = false;
  try {
    const failed = snapshot();
    const response = await postJson(fixture, {
      workspaceId: fixture.workspaceId,
      audio,
      mimeType: 'audio/webm',
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(409);
    expect(body).toMatchObject({ code: 'provider_api_key_missing' });
    expect(fixture.hits).toHaveLength(failed.hits);
    expect(fixture.resolverCalls.length).toBeGreaterThan(failed.resolver);
    const rows = ledger(fixture);
    const call = rows.calls.at(-1);
    expect(call).toMatchObject({ status: 'failed', errorCode: 'provider_api_key_missing' });
    expect(rows.usage.filter((row) => row.capabilityCallId === call?.id)).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(TRANSCRIPT);
  } finally {
    fixture.releaseSecret = true;
  }

  const duringResolution = snapshot();
  fixture.beforeCredentialRelease = () => {
    fixture.gateway.enabled = false;
  };
  try {
    const response = await postJson(fixture, {
      workspaceId: fixture.workspaceId,
      audio,
      mimeType: 'audio/webm',
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(403);
    expect(body).toMatchObject({ code: 'gateway_disabled' });
    expect(fixture.hits).toHaveLength(duringResolution.hits);
    expect(fixture.resolverCalls).toHaveLength(duringResolution.resolver + 1);
    const rows = ledger(fixture);
    expect(rows.calls).toHaveLength(duringResolution.calls + 1);
    const call = rows.calls.at(-1);
    expect(call).toMatchObject({ status: 'failed', errorCode: 'gateway_disabled' });
    expect(rows.usage.filter((row) => row.capabilityCallId === call?.id)).toEqual([]);
    const disclosed = JSON.stringify({ body, rows });
    expect(disclosed).not.toContain(TRANSCRIPT);
    expect(disclosed).not.toContain(CLIP_MARKER);
    expect(disclosed).not.toContain(audio);
  } finally {
    fixture.gateway.enabled = true;
    fixture.beforeCredentialRelease = null;
  }

  fixture.upstreamStatus = 429;
  try {
    const rejected = snapshot();
    const response = await postJson(fixture, {
      workspaceId: fixture.workspaceId,
      audio,
      mimeType: 'audio/webm',
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(502);
    expect(body).toMatchObject({ code: 'transcription_failed' });
    expect(fixture.hits).toHaveLength(rejected.hits + 4);
    const rows = ledger(fixture);
    expect(rows.calls).toHaveLength(rejected.calls + 1);
    const call = rows.calls.at(-1);
    expect(call).toMatchObject({ status: 'failed', errorCode: 'transcription_failed' });
    const usage = rows.usage.filter((row) => row.capabilityCallId === call?.id);
    expect(usage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: 'requests', quantity: 1, source: 'measured' }),
        expect.objectContaining({ unit: 'seconds', quantity: 1.25, source: 'measured' }),
      ])
    );
    const disclosed = JSON.stringify({ body, rows });
    expect(disclosed).not.toContain(TRANSCRIPT);
    expect(disclosed).not.toContain(CLIP_MARKER);
    expect(disclosed).not.toContain(audio);
  } finally {
    fixture.upstreamStatus = 200;
  }

  expect(treeHas(fixture.dataRoot, TRANSCRIPT)).toBe(false);
  expect(treeHas(fixture.dataRoot, CLIP_MARKER)).toBe(false);
  expect(audioFiles(fixture.dataRoot)).toEqual([]);
}, 60_000);

function snapshot(): { hits: number; resolver: number; calls: number } {
  return {
    hits: fixture.hits.length,
    resolver: fixture.resolverCalls.length,
    calls: ledger(fixture).calls.length,
  };
}

async function expectRefused(
  send: () => Promise<Response>,
  status: number,
  code: string
): Promise<void> {
  const before = snapshot();
  const response = await send();
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body).toMatchObject({ code });
  expect(fixture.hits).toHaveLength(before.hits);
  expect(fixture.resolverCalls).toHaveLength(before.resolver);
  expect(ledger(fixture).calls).toHaveLength(before.calls);
  expect(JSON.stringify(body)).not.toContain(TRANSCRIPT);
  expect(JSON.stringify(body)).not.toContain(CLIP_MARKER);
}
