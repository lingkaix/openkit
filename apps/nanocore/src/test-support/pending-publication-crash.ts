import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import {
  raiseRecordedPendingRequest,
  recoverPendingRequestsAtBoot,
} from '../runtime/pending-request-flow.js';
import { readPendingRequest, validateCanonicalLoad } from '../runtime/pending-requests.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createDemoStore } from './demo-store.js';
import { operationRequest } from './operation-request.js';

// Separate processes cross the actual retained-file/SQLite boundary, not an in-memory restart.
const [mode, phase, retainedRoot] = process.argv.slice(2);
const dataRoot = retainedRoot ?? mkdtempSync(join(tmpdir(), 'pending-publication-crash-'));
const coreDb = openCoreDb(dataRoot);
applyMigrations(coreDb);
ensureLocalUser(coreDb);
const store = retainedRoot ? new FsStore({ dataRoot }) : createDemoStore({ dataRoot });
const db = openWorkspaceDb(dataRoot, 'ws_demo');
applyScopedMigrations(db);
if (retainedRoot) {
  recoverPendingRequestsAtBoot(store, {
    coreDb,
    openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
  });
} else {
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  const app = createApp({ coreDb, store, dataRoot });
  const now = new Date().toISOString();
  const turn = store.createTurn(
    'ws_demo',
    'th_demo',
    'Crash publication',
    { kind: 'user', id: 'user_local' },
    null
  );
  for (let index = 0; index < 2; index++) {
    const requestId = `ap_crash_${index}`;
    store.createItem({
      id: `it_${requestId}`,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
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
      requestItemId: `it_${requestId}`,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      raisingTurnId: turn.id,
      kind: 'approval',
      requesterKind: 'person',
      responsibleUserId: 'user_local',
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
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
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
  const original = store.createItem.bind(store);
  let writes = 0;
  store.createItem = (item, ...args) => {
    if (item.causationId?.startsWith('it_ap_crash_')) {
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
      : await app.request('/api/workspaces/ws_demo/threads/th_demo/archive', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            requestId: randomUUID(),
          }),
        });
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
      .listThreadItems('ws_demo', 'th_demo')
      .filter((item) => item.causationId === record.requestItemId)
      .map((item) => item.type),
    validation: validateCanonicalLoad(record, store.listThreadTurns('ws_demo', 'th_demo')),
  }));
console.log(JSON.stringify({ dataRoot, records }));
db.sqlite.close();
coreDb.sqlite.close();
