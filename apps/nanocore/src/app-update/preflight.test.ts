import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import type { FsStore } from '../lib/store.js';
import {
  createSchedulerExecutionAttempt,
  markSchedulerExecutionAttemptClosing,
} from '../runtime/execution-attempt-records.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import {
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { observeAppUpdatePreflight } from './preflight.js';

describe('content-free deployment maintenance preflight', () => {
  it('counts pending, queued, open, closing and in-flight owners independently, excluding denied work', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-preflight-owners-'));
    const coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot: root });
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
    const thread = store.createThread(
      'ws_demo',
      'Private pending work',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: 'user_local',
      }
    );
    store.createTurn(
      'ws_demo',
      thread.id,
      'Private pending prompt',
      { kind: 'user', id: 'user_local' },
      null,
      { status: 'pending' }
    );
    const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
    inflightCommands.set(
      store,
      new Map([['private-key', { inputHash: 'private-hash', promise: new Promise(() => {}) }]])
    );
    try {
      for (const phase of ['queued', 'open', 'closing', 'denied'] as const) {
        const executionThread = store.createThread('ws_demo', `Private queue ${phase}`);
        const entry = createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: `queue_${phase}`,
          requestId: `req_${phase}`,
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceId: 'ws_demo',
          threadId: executionThread.id,
          turnId: `turn_${phase}`,
          turnInput: 'Private admitted input',
          requestedAgentId: 'agent_codex_host',
          profileRef: 'agent_codex_host',
        });
        if (phase === 'denied')
          denySchedulerAdmissionEntry(coreDb, {
            queueEntryId: entry.queueEntryId,
            denialReason: 'authority-denied',
          });
        if (phase === 'open' || phase === 'closing') {
          const attempt = createSchedulerExecutionAttempt(coreDb, {
            entry,
            preparationInput: { private: 'preparation' },
          });
          if (phase === 'closing')
            markSchedulerExecutionAttemptClosing(coreDb, {
              attemptId: attempt.attemptId,
              cause: 'test-closing',
            });
        }
      }
      const result = observeAppUpdatePreflight({ coreDb, store, inflightCommands });
      expect(result.counts).toEqual({
        runningTurns: 0,
        pendingTurns: 1,
        queuedAdmissions: 1,
        openAttempts: 1,
        closingAttempts: 1,
        inFlightCommands: 1,
      });
      expect(result.state).toBe('busy');
      expect(JSON.stringify(result)).not.toMatch(/Private|private|queue_|req_|turn_/);
    } finally {
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts active private work and emits only the exact aggregate shape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-preflight-'));
    const coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot: root });
    const thread = store.createThread(
      'ws_demo',
      'Private title must stay private',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: 'user_local',
      }
    );
    store.createTurn('ws_demo', thread.id, 'Private prompt must stay private', {
      kind: 'user',
      id: 'user_local',
    });
    const app = createApp({ store, coreDb, dataRoot: root });
    try {
      const response = await app.request('/api/app/operations/app-update.preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual({
        observedAt: expect.any(String),
        workspaceCount: store.listWorkspaces().length,
        state: 'busy',
        counts: {
          runningTurns: 1,
          pendingTurns: 0,
          queuedAdmissions: 0,
          openAttempts: 0,
          closingAttempts: 0,
          inFlightCommands: 0,
        },
      });
      expect(JSON.stringify(body)).not.toMatch(/Private|ws_demo|user_local/);
    } finally {
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports unavailable storage rather than inventing an idle queue', async () => {
    const app = createApp();
    const response = await app.request('/api/app/operations/app-update.preflight', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'app_update_unavailable' });
  });
});
