import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
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
if (retainedRoot) {
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
  if (mode === 'delivery' || mode === 'throw') {
    // Restore the ordinary owner hook before the deciding response command.
    const { installPendingRequestAdmission } = await import('../runtime/pending-request-flow.js');
    installPendingRequestAdmission(store, {
      coreDb,
      openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
    });
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
