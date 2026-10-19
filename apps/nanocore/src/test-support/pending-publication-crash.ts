import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type Database from 'better-sqlite3';
import { createApp } from '../app.js';
import { importArtifactFile } from '../artifact-file-commands.js';
import { FsStore } from '../lib/store.js';
import {
  raiseRecordedPendingRequest,
  recoverPendingRequestsAtBoot,
} from '../runtime/pending-request-flow.js';
import {
  pendingRequestItemId,
  readPendingRequest,
  validateCanonicalLoad,
} from '../runtime/pending-requests.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { artifactFilePayloadPath } from '../storage/artifacts/file-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createDemoStore } from './demo-store.js';
import { ensureLocalUser } from './local-user.js';
import { operationRequest } from './operation-request.js';

// Separate processes cross the actual retained-file/SQLite boundary, not an in-memory restart.
const [mode, phase, retainedRoot] = process.argv.slice(2);
const dataRoot = retainedRoot ?? mkdtempSync(join(tmpdir(), 'pending-publication-crash-'));
const coreDb = openCoreDb(dataRoot);
applyMigrations(coreDb);
ensureLocalUser(coreDb);
const store = retainedRoot ? new FsStore({ dataRoot }) : createDemoStore({ dataRoot });
const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
applyScopedMigrations(db);
if (mode === 'command-commit' || mode === 'artifact-commit') {
  if (mode === 'command-commit') await probeCommandCommit();
  else await probeArtifactCommit();
  db.sqlite.close();
  coreDb.sqlite.close();
  process.exit(0);
}
if (retainedRoot) {
  if (mode === 'local-outcome') {
    await probePendingOutcome(readPendingRequest(db.sqlite, 'ap_crash_0')!.raisingTurnId);
    db.sqlite.close();
    coreDb.sqlite.close();
    process.exit(0);
  }
  if (phase === 'before-association' || phase === 'missing-turn') {
    if (phase === 'missing-turn') {
      db.sqlite
        .prepare(
          'UPDATE pending_requests SET publication_turn_id = ? WHERE publication_turn_id IS NOT NULL'
        )
        .run('tu_01890f3e-0000-7000-8000-000000000099');
    }
    const observe = () => ({
      turns: store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      ),
      requests: db.sqlite.prepare('SELECT * FROM pending_requests ORDER BY request_id').all(),
      items: store.listThreadItems(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      ),
    });
    const before = observe();
    let recoveryCode: string | null = null;
    try {
      recoverPendingRequestsAtBoot(store, {
        coreDb,
        openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
      });
    } catch (error) {
      recoveryCode =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unexpected';
    }
    console.log(JSON.stringify({ recoveryCode, before, after: observe() }));
    db.sqlite.close();
    coreDb.sqlite.close();
    process.exit(0);
  }
  recoverPendingRequestsAtBoot(store, {
    coreDb,
    openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
  });
} else {
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const app = createApp({ coreDb, store, dataRoot });
  const now = new Date().toISOString();
  const turn = store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Crash publication',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    null
  );
  for (let index = 0; index < 2; index++) {
    const requestId = `ap_crash_${index}`;
    store.createItem({
      id: pendingRequestItemId(requestId, 'request'),
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: turn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: requestId,
      title: 'Exact command',
      description: 'One command.',
      kind: 'permission',
      createdAt: now,
      completedAt: now,
    });
    raiseRecordedPendingRequest(store, db.sqlite, {
      requestId,
      requestItemId: pendingRequestItemId(requestId, 'request'),
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      raisingTurnId: turn.id,
      kind: 'approval',
      requesterKind: 'person',
      responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      approval: { kind: 'permission', title: 'Exact command', description: 'One command.' },
      governedIntent: { operation: 'fixture', index },
      now,
    });
  }
  const respond = (index: number) =>
    app.request(
      ...operationRequest(
        'approval.respond',
        { approvalRequestId: `ap_crash_${index}` },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: turn.id,
            requestId: randomUUID(),
            decision: 'granted',
          }),
        }
      )
    );
  if (
    mode === 'invalidation' ||
    mode === 'shared-closeout' ||
    (mode === 'delivery' && phase === 'between')
  ) {
    for (let index = 0; index < 2; index++) {
      const response = await respond(index);
      if (response.status !== 200) throw new Error(await response.text());
    }
  }
  // Explicitly interrupted barrier is the reviewer's F4 entry point.
  if (mode !== 'invalidation') store.setTurnAdmissionHooks(null);
  if (!(mode === 'delivery' && phase === 'between'))
    store.updateTurn(turn.id, { status: 'completed', completedAt: now });
  if (mode === 'delivery' || mode === 'throw' || mode === 'local-outcome') {
    // Restore the ordinary owner hook before the deciding response command.
    const { installPendingRequestAdmission } = await import('../runtime/pending-request-flow.js');
    installPendingRequestAdmission(store, {
      coreDb,
      openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
    });
  }
  if (mode === 'local-outcome') {
    await probePendingOutcome(turn.id, app);
    db.sqlite.close();
    coreDb.sqlite.close();
    process.exit(0);
  }
  if (phase === 'before-association') {
    const originalCreateTurn = store.createTurn.bind(store);
    store.createTurn = (...args) => {
      // The real canonical write completes, then the process dies before the freeze hook can run.
      store.setTurnAdmissionHooks(null);
      originalCreateTurn(...args);
      console.log(JSON.stringify({ dataRoot }));
      process.exit(23);
    };
  }
  const original = store.createItem.bind(store);
  let writes = 0;
  store.createItem = (item, ...args) => {
    if (
      [0, 1].some(
        (index) => item.causationId === pendingRequestItemId(`ap_crash_${index}`, 'request')
      )
    ) {
      if (writes++ === (phase === 'between' ? 1 : 0) && mode !== 'shared-closeout') {
        if (mode === 'throw')
          throw new Error('review injected publication crash before first outcome Item');
        console.log(JSON.stringify({ dataRoot }));
        process.exit(23);
      }
    }
    return original(item, ...args);
  };
  if (mode === 'delivery' && phase === 'between')
    store.updateTurn(turn.id, { status: 'completed', completedAt: now });
  const response =
    mode === 'delivery' || mode === 'throw'
      ? await respond(0)
      : await app.request(
          ...operationRequest(
            'thread.archive',
            {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
            },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                threadId: 'th_00000000-0000-7000-8000-000000000001',
                requestId: randomUUID(),
              }),
            }
          )
        );
  console.log(JSON.stringify({ responseStatus: response.status, dataRoot }));
}
const records = [0, 1]
  .map((index) => readPendingRequest(db.sqlite, `ap_crash_${index}`)!)
  .map((record) => ({
    requestId: record.requestId,
    delivery: record.delivery,
    state: record.state,
    resolution: record.resolution,
    publicationTurnId: record.publicationTurnId,
    invalidationTurnId: record.invalidationTurnId,
    status: (mode === 'invalidation' ? record.invalidationTurnId : record.publicationTurnId)
      ? store.getTurnById(
          (mode === 'invalidation' ? record.invalidationTurnId : record.publicationTurnId)!
        ).status
      : null,
    items: store
      .listThreadItems(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
      .filter((item) => item.causationId === record.requestItemId)
      .map((item) => item.type),
    validation: validateCanonicalLoad(
      record,
      store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ),
  }));
console.log(JSON.stringify({ dataRoot, records }));
db.sqlite.close();
coreDb.sqlite.close();

/** Crosses the real product/receipt seam; cold inspection never calls a recovery owner. */
async function probeCommandCommit(): Promise<void> {
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const requestId = '10000000-0000-4000-8000-000000000101';
  const snapshot = (reader: FsStore) => ({
    threads: reader
      .listThreads(workspaceId)
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    receipts: db.sqlite
      .prepare(
        'SELECT request_id, response_kind, response_id FROM idempotency_requests WHERE request_id = ?'
      )
      .all(requestId),
  });
  if (phase === 'inspect') {
    console.log(JSON.stringify({ dataRoot, state: snapshot(store) }));
    return;
  }
  if (!retainedRoot) {
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId,
    });
  }
  const app = createApp({ coreDb, store, dataRoot });
  console.log(JSON.stringify({ dataRoot, before: snapshot(store) }));
  let checkpoint = false;
  const restore = interceptReceiptWrite(requestId, () => {
    if (phase !== 'before-receipt' && phase !== 'receipt-failure') return;
    checkpoint = true;
    if (phase === 'before-receipt') {
      console.log(JSON.stringify({ dataRoot, checkpoint: 'before-receipt' }));
      process.exit(23);
    }
    throw new Error('Injected local receipt write failure.');
  });
  let response: Response;
  try {
    response = await app.request(
      ...operationRequest(
        'thread.create',
        { workspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            requestId,
            name:
              phase === 'conflict'
                ? 'Different input under the same request'
                : 'One committed Thread',
          }),
        }
      )
    );
  } finally {
    restore();
  }
  const responseBody: unknown = response.ok ? await response.json() : await response.text();
  if (phase === 'after-commit') {
    console.log(
      JSON.stringify({
        dataRoot,
        checkpoint: 'response-ready',
        responseStatus: response.status,
        responseBody,
      })
    );
    process.exit(23);
  }
  console.log(
    JSON.stringify({
      dataRoot,
      checkpoint,
      responseStatus: response.status,
      responseBody,
      commandFailed: !response.ok,
      live: snapshot(store),
      cold: snapshot(new FsStore({ dataRoot })),
    })
  );
}

/** Observes the native receipt statement on real connections without replacing either owner. */
function interceptReceiptWrite(requestId: string, crossing: () => void): () => void {
  const prototype = Object.getPrototypeOf(db.sqlite.prepare('SELECT 1')) as Database.Statement;
  const run = prototype.run;
  prototype.run = function (...parameters) {
    if (
      /^\s*INSERT\b/i.test(this.source) &&
      this.source.includes('idempotency_requests') &&
      parameters.includes(requestId)
    )
      crossing();
    return run.apply(this, parameters);
  };
  return () => {
    prototype.run = run;
  };
}

/** Keeps decision, delivery, Items, Turn events and receipts under one independently observed cut. */
async function probePendingOutcome(
  raisingTurnId: string,
  existingApp?: ReturnType<typeof createApp>
): Promise<void> {
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const threadId = 'th_00000000-0000-7000-8000-000000000001';
  const requestId = '10000000-0000-4000-8000-000000000102';
  const snapshot = (reader: FsStore) => {
    const turns = reader.listThreadTurns(workspaceId, threadId);
    return {
      turns,
      items: reader.listThreadItems(workspaceId, threadId),
      events: turns.flatMap((turn) => reader.getTurnEvents(turn.id)),
      requests: [0, 1].map((index) => readPendingRequest(db.sqlite, `ap_crash_${index}`)),
      receipts: db.sqlite
        .prepare(
          'SELECT request_id, command_name, response_kind, response_id FROM idempotency_requests ORDER BY request_key'
        )
        .all(),
    };
  };
  if (phase === 'inspect') {
    console.log(JSON.stringify({ dataRoot, state: snapshot(store) }));
    return;
  }
  const app = existingApp ?? createApp({ coreDb, store, dataRoot });
  console.log(JSON.stringify({ dataRoot, before: snapshot(store) }));
  const notifications: unknown[] = [];
  const unsubscribe = store.addTurnListener(raisingTurnId, (event) => notifications.push(event));
  let checkpoint = false;
  const restore = interceptReceiptWrite(requestId, () => {
    if (phase !== 'before-receipt' && phase !== 'receipt-failure') return;
    checkpoint = true;
    if (phase === 'before-receipt') {
      console.log(JSON.stringify({ dataRoot, checkpoint: 'before-receipt' }));
      process.exit(23);
    }
    throw new Error('Injected Pending Request receipt write failure.');
  });
  let response: Response;
  try {
    response = await app.request(
      ...operationRequest(
        'approval.respond',
        { approvalRequestId: 'ap_crash_0' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            threadId,
            turnId: raisingTurnId,
            requestId,
            decision: phase === 'conflict' ? 'denied' : 'granted',
          }),
        }
      )
    );
  } finally {
    restore();
    unsubscribe();
  }
  const responseBody: unknown = response.ok ? await response.json() : await response.text();
  if (phase === 'after-commit') {
    console.log(
      JSON.stringify({
        dataRoot,
        checkpoint: 'response-ready',
        responseStatus: response.status,
        responseBody,
      })
    );
    process.exit(23);
  }
  console.log(
    JSON.stringify({
      dataRoot,
      checkpoint,
      responseStatus: response.status,
      responseBody,
      notifications,
      live: snapshot(store),
      cold: snapshot(new FsStore({ dataRoot })),
    })
  );
}

/** Composes the real streamed Storage producer and Artifact/receipt consumer across native faults. */
async function probeArtifactCommit(): Promise<void> {
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const userId = 'usr_00000000-0000-7000-8000-000000000001';
  const requestId = '10000000-0000-4000-8000-000000000103';
  const bytes = Buffer.from('00ff800d0a', 'hex');
  const title = 'Immutable handoff original';
  const snapshot = (reader: FsStore) => {
    const artifacts = reader.listArtifacts(workspaceId);
    const target = artifacts.find((artifact) => artifact.title === title);
    return {
      artifacts: artifacts
        .map(({ id, version, contentDigest }) => ({ id, version, contentDigest }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      receipts: db.sqlite
        .prepare(
          'SELECT request_id, response_kind, response_id FROM idempotency_requests WHERE request_id = ?'
        )
        .all(requestId),
      payload: target
        ? {
            content: reader.getArtifact(workspaceId, target.id).content,
            hex: readFileSync(
              artifactFilePayloadPath(
                join(dataRoot, 'workspaces', workspaceId),
                target.id,
                target.version
              )
            ).toString('hex'),
          }
        : null,
    };
  };
  if (phase === 'inspect') {
    console.log(JSON.stringify({ dataRoot, state: snapshot(store) }));
    return;
  }
  console.log(JSON.stringify({ dataRoot, before: snapshot(store) }));
  const probePath = join(dataRoot, '.sync-probe');
  const handle = await open(probePath, 'wx');
  const handlePrototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  rmSync(probePath);
  const sync = handlePrototype.sync;
  let contentSynchronized = false;
  let checkpoint: string | null = null;
  // Directory synchronization remains real. The fixture has one five-byte content file.
  handlePrototype.sync = async function () {
    const stat = await this.stat();
    if (stat.isFile() && stat.size === bytes.length) {
      if (phase === 'before-sync') {
        console.log(
          JSON.stringify({ dataRoot, checkpoint: 'before-content-sync', contentSynchronized })
        );
        process.exit(23);
      }
      if (phase === 'sync-failure') {
        checkpoint = 'content-sync-failure';
        throw new Error('Injected content synchronization failure.');
      }
      await sync.call(this);
      contentSynchronized = true;
      return;
    }
    await sync.call(this);
  };
  const restore = interceptReceiptWrite(requestId, () => {
    if (phase !== 'before-receipt' && phase !== 'receipt-failure') return;
    checkpoint = 'before-receipt';
    if (phase === 'before-receipt') {
      console.log(JSON.stringify({ dataRoot, checkpoint, contentSynchronized }));
      process.exit(23);
    }
    throw new Error('Injected Artifact receipt write failure.');
  });
  let result: Awaited<ReturnType<typeof importArtifactFile>> | undefined;
  let failure: string | undefined;
  try {
    result = await importArtifactFile({
      store,
      workspaceDb: db,
      admission: new FileStorageAdmission(dataRoot, () => 0n),
      inflightCommands: new WeakMap(),
      metadata: {
        workspaceId,
        requestId,
        title,
        mediaType: 'application/octet-stream',
        byteLength: bytes.length,
        contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
      source: Readable.from([bytes]),
      // Authorization is outside this storage fault; both data owners remain real.
      assertAuthorized: () => {},
      context: {
        kind: 'public',
        actor: { kind: 'session', userId },
        actorRef: { kind: 'user', id: userId },
        scope: { kind: 'workspace', workspaceId },
      },
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    restore();
    handlePrototype.sync = sync;
  }
  if (phase === 'after-commit') {
    console.log(
      JSON.stringify({ dataRoot, checkpoint: 'result-ready', contentSynchronized, result, failure })
    );
    process.exit(23);
  }
  console.log(
    JSON.stringify({
      dataRoot,
      checkpoint,
      contentSynchronized,
      result,
      failure,
      live: snapshot(store),
      cold: snapshot(new FsStore({ dataRoot })),
    })
  );
}
