import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GatewayConfig } from '@openkit/config-schema';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from '../capability/usage-ledger.js';
import { createRuntimeConfigManager, type RuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import {
  createLocalAiOracleDataRoot,
  removeLocalAiOracleDataRoot,
} from '../test-support/local-ai-temp-root.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb, createTestWorkspaceDb } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { activeLocalAiSupervisor, closeActiveLocalAiSupervisor } from './supervisor.js';
import { forgetLoopbackFixture } from './supply.js';

const TOKEN_EXPIRY = '2999-01-01T00:00:00.000Z';

/** What the loopback peer does after it has the request body. */
export type PeerDecision =
  | { readonly status: number; readonly body: unknown; readonly retryAfter?: string }
  | 'reset'
  | 'hold';

export interface PeerHit {
  readonly url: string;
  readonly bytes: number;
}

export interface LoopbackPeer {
  readonly baseUrl: string;
  readonly port: number;
  readonly hits: PeerHit[];
  /** Resolves when a `hold` decision has the request body and has not answered. */
  readonly held: Promise<void>;
  close(): Promise<void>;
}

export interface OracleInstallation {
  readonly app: ReturnType<typeof createApp>;
  readonly manager: RuntimeConfigManager;
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly threadId: string;
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

/**
 * Serves one OpenAI-compatible base URL. The responder sees the hit index after the body is stored.
 *
 * @param respond Decision for each completed request.
 * @returns Loopback peer bound to an ephemeral port.
 */
export async function startPeer(
  respond: (index: number, url: string) => PeerDecision
): Promise<LoopbackPeer> {
  const hits: PeerHit[] = [];
  let markHeld: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  const server = createServer((request, response) => {
    void readPeer(request, response, hits, respond, markHeld);
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    hits,
    held,
    close: () => closeServer(server),
  };
}

/**
 * Reserves an ephemeral loopback port and then closes it.
 * A later connect is refused by the kernel. Port 1 is not used: fetch rejects that before any socket.
 */
export async function refusedPeer(): Promise<LoopbackPeer> {
  const server = createServer();
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  await closeServer(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    hits: [],
    held: new Promise(() => undefined),
    close: async () => undefined,
  };
}

/**
 * Boots a data root through the real runtime loader and app. Built-in profiles come from that loader.
 *
 * @param input Gateway file and process mode. Provider files are written before the manager starts.
 * @returns Installation whose caller closes the supervisor, databases, and temp root.
 */
export async function bootInstallation(input: {
  readonly gateway: GatewayConfig;
  readonly providers?: readonly { readonly name: string; readonly profile: unknown }[];
  readonly mode?: 'local' | 'server';
  readonly credential?: string | null;
}): Promise<OracleInstallation> {
  await closeActiveLocalAiSupervisor();
  forgetLoopbackFixture('sherpa-onnx-asr');
  const dataRoot = createLocalAiOracleDataRoot({
    mode: input.mode ?? 'local',
    gateway: input.gateway,
    providers: input.providers ?? [],
  });
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
  const mode = input.mode ?? 'local';
  const app = createApp({
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 }),
    },
    coreDb,
    dataRoot,
    mode,
    ...(mode === 'local' ? { localUserId: FIXTURE_LOCAL_USER_ID } : {}),
    providerCredentialResolver: () => input.credential ?? 'fixture-credential',
    runtimeConfigManager: manager,
    store,
  });
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
      forgetLoopbackFixture('sherpa-onnx-asr');
      await closeActiveLocalAiSupervisor();
      closeTestCoreDb(coreDb);
      removeLocalAiOracleDataRoot(dataRoot);
    },
  };
}

/** Resolves when a server is listening on an ephemeral loopback port. */
export function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

/** Closes one server after its connections drain. */
export function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readPeer(
  request: IncomingMessage,
  response: ServerResponse,
  hits: PeerHit[],
  respond: (index: number, url: string) => PeerDecision,
  markHeld: () => void
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const index = hits.length;
  hits.push({ url: request.url ?? '', bytes: Buffer.concat(chunks).length });
  const decision = respond(index, request.url ?? '');
  if (decision === 'reset') {
    request.socket.destroy();
    return;
  }
  if (decision === 'hold') {
    markHeld();
    return;
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (decision.retryAfter !== undefined) headers['retry-after'] = decision.retryAfter;
  response.writeHead(decision.status, headers);
  response.end(JSON.stringify(decision.body));
}
