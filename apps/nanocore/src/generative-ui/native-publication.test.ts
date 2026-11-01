// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import {
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  GENERATIVE_UI_PROTOCOL_VERSION,
} from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { commandRequestKey, getCommandRequestRecord } from '../storage/command-request-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import {
  CONTROL_WORKER_VERSION,
  isControlWorkerReply,
} from '../storage/control-store-worker-protocol.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { closeTestCoreDb, createTestWorkspaceDb } from '../test-support/store.js';
import {
  type GenerativeUiCommandContext,
  listExportableGenerativePresentations,
  publishGenerativePresentation,
} from './commands.js';

const ACTOR = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };

const interception = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
  workers: [] as NativeWorker[],
}));

// This fixture observes the genuine owner process and delegates every operation outside its two exact crash boundaries.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (interception.gate === undefined) {
          super(filename, options);
        } else {
          const prelude = `
            const {workerData} = require('node:worker_threads');
            const Database = require(workerData.nativePublicationDatabaseModule);
            const gate = new Int32Array(workerData.nativePublicationGate);
            const exec = Database.prototype.exec;
            Database.prototype.exec = function(sql) {
              if (/^COMMIT$/i.test(sql) && Atomics.load(gate, 2) === 1 && Atomics.compareExchange(gate, 0, 0, 1) === 0) {
                Atomics.notify(gate, 0);
                Atomics.wait(gate, 1, 0);
              }
              return exec.call(this, sql);
            };
            const prepare = Database.prototype.prepare;
            Database.prototype.prepare = function(sql) {
              if (Atomics.load(gate, 3) === 1 && String(sql).includes('INSERT INTO generative_presentations') && Atomics.compareExchange(gate, 4, 0, 1) === 0) {
                Atomics.notify(gate, 4);
                process.exit(86);
              }
              return prepare.call(this, sql);
            };
          `;
          const entry = options?.eval
            ? String(filename)
            : `import(${JSON.stringify(String(filename))});`;
          const require = createRequire(import.meta.url);
          super(prelude + entry, {
            ...options,
            eval: true,
            workerData: {
              ...((options?.workerData ?? {}) as object),
              nativePublicationDatabaseModule: require.resolve('better-sqlite3'),
              nativePublicationGate: interception.gate,
            },
          });
        }
        interception.workers.push(this);
      }
    },
  };
});

/** Builds the two producer messages for one native presentation. */
function nativeMessages(surfaceId: string) {
  return [
    {
      version: GENERATIVE_UI_PROTOCOL_VERSION,
      createSurface: {
        surfaceId,
        catalogId: GENERATIVE_UI_NATIVE_CATALOG_ID,
        sendDataModel: false,
      },
    },
    {
      version: GENERATIVE_UI_PROTOCOL_VERSION,
      updateComponents: {
        surfaceId,
        components: [{ id: 'root', component: 'Text', text: { path: '/text' } }],
      },
    },
  ];
}

/** Waits for one genuine worker boundary without a product timing assertion. */
async function waitForGateOrSettlement(gate: Int32Array, index: number, settled: () => boolean) {
  while (Atomics.load(gate, index) === 0 && !settled()) await nextTurn();
}

/** Creates one real retained source Item through the Workspace owner. */
async function createSource(context: GenerativeUiCommandContext, turnId: string, text: string) {
  return context.store.createItem({
    id: allocateEntityId('it'),
    owner: { kind: 'workspace' as const, workspaceId: context.workspaceId },
    threadId: DEMO_THREAD_ID,
    turnId,
    type: 'assistant-message' as const,
    status: 'completed' as const,
    text,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
}

afterEach(async () => {
  if (interception.gate !== undefined) {
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
  }
  await shutdownControlStoreWorkerClient();
  interception.gate = undefined;
  interception.workers.length = 0;
});

describe('native Generative UI publication', () => {
  it('queues the complete tuple behind its real writer and replays without a second effect', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-generative-native-'));
    interception.gate = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
    const gate = new Int32Array(interception.gate);
    const store = await createDemoStore({ dataRoot });
    const workspaceDb = createTestWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    const requestId = randomUUID();
    const context: GenerativeUiCommandContext = {
      store,
      inflightCommands: new WeakMap(),
      dataRoot,
      workspaceId: DEMO_WORKSPACE_ID,
      actor: ACTOR,
      requestId,
      workspaceDb,
    };
    let heldPublication: Promise<unknown> | undefined;
    let attemptedPublication:
      | Promise<
          | {
              readonly kind: 'acknowledged';
              readonly value: Awaited<ReturnType<typeof publishGenerativePresentation>>;
            }
          | { readonly kind: 'refused'; readonly error: unknown }
        >
      | undefined;
    try {
      const recoveryReply = {
        version: CONTROL_WORKER_VERSION,
        id: 0,
        status: 'error',
        code: 'precondition',
        commit: 'not-committed',
        domain: {
          operation: 'generative-presentation',
          code: 'recovery_required',
          message: 'Interrupted presentation publication requires recovery.',
          status: 409,
        },
      } as const;
      expect(isControlWorkerReply(recoveryReply)).toBe(true);
      expect(
        isControlWorkerReply({
          ...recoveryReply,
          domain: {
            operation: 'generative-presentation',
            code: 'unknown_future_failure',
            message: 'Arbitrary native failure.',
            status: 418,
          },
        })
      ).toBe(false);

      const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Publish once', ACTOR);
      const text = 'The retained source is exact.';
      const source = await createSource(context, turn.id, text);
      const input = {
        threadId: DEMO_THREAD_ID,
        turnId: turn.id,
        title: 'Native publication',
        fallbackText: text,
        messages: nativeMessages('native-publication'),
        source: {
          kind: 'item' as const,
          itemId: source.id,
          contentDigest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        },
        actions: [],
      };

      Atomics.store(gate, 2, 1);
      heldPublication = createSource(context, turn.id, 'Hold the real native commit.');
      while (Atomics.load(gate, 0) === 0) await nextTurn();

      let settled = false;
      attemptedPublication = publishGenerativePresentation(context, input)
        .then(
          (value) => ({ kind: 'acknowledged' as const, value }),
          (error: unknown) => ({ kind: 'refused' as const, error })
        )
        .finally(() => {
          settled = true;
        });
      await nextTurn();
      expect(settled).toBe(false);

      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      await heldPublication;
      const firstOutcome = await attemptedPublication;
      expect(firstOutcome).toMatchObject({ kind: 'acknowledged' });
      if (firstOutcome.kind !== 'acknowledged') throw firstOutcome.error;
      const first = firstOutcome.value;
      const receiptScope = { workspaceId: DEMO_WORKSPACE_ID, actorId: ACTOR.id };
      const receipt = getCommandRequestRecord(
        dataRoot,
        receiptScope,
        commandRequestKey('generative-ui.publish', requestId, receiptScope),
        new Date().toISOString()
      );
      expect(receipt?.response).toMatchObject({
        kind: 'generative_presentation',
        id: first.id,
      });
      const itemReferences = store
        .listWorkspaceItemRevisions(DEMO_WORKSPACE_ID)
        .filter((item) => item.type === 'generative-ui-reference');
      const audit = listWorkspaceAuditEvents(workspaceDb, DEMO_WORKSPACE_ID).filter(
        (event) => event.action === 'generative-ui.publish' && event.requestId === requestId
      );
      expect(itemReferences).toHaveLength(1);
      expect(audit).toHaveLength(1);

      await expect(publishGenerativePresentation(context, input)).resolves.toEqual(first);
      expect(
        store
          .listWorkspaceItemRevisions(DEMO_WORKSPACE_ID)
          .filter((item) => item.type === 'generative-ui-reference')
      ).toEqual(itemReferences);
      expect(
        listWorkspaceAuditEvents(workspaceDb, DEMO_WORKSPACE_ID).filter(
          (event) => event.action === 'generative-ui.publish' && event.requestId === requestId
        )
      ).toEqual(audit);
      expect(
        getCommandRequestRecord(
          dataRoot,
          receiptScope,
          commandRequestKey('generative-ui.publish', requestId, receiptScope),
          new Date().toISOString()
        )
      ).toEqual(receipt);
    } finally {
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      await Promise.allSettled([heldPublication, attemptedPublication].filter(Boolean));
      await shutdownControlStoreWorkerClient();
      closeTestCoreDb(workspaceDb);
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('carries an accepted body above 1 MiB and exposes no tuple when the worker stops before SQL', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-generative-native-crash-'));
    interception.gate = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
    const gate = new Int32Array(interception.gate);
    const store = await createDemoStore({ dataRoot });
    const workspaceDb = createTestWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    const requestId = randomUUID();
    const context: GenerativeUiCommandContext = {
      store,
      inflightCommands: new WeakMap(),
      dataRoot,
      workspaceId: DEMO_WORKSPACE_ID,
      actor: ACTOR,
      requestId,
      workspaceDb,
    };
    let publication:
      | Promise<
          | {
              readonly kind: 'acknowledged';
              readonly value: Awaited<ReturnType<typeof publishGenerativePresentation>>;
            }
          | { readonly kind: 'refused'; readonly error: unknown }
        >
      | undefined;
    try {
      const turn = await store.createTurn(
        DEMO_WORKSPACE_ID,
        DEMO_THREAD_ID,
        'Crash publication',
        ACTOR
      );
      Atomics.store(gate, 3, 1);
      const answerText = 'D'.repeat(512 * 1024 + 64);
      let settled = false;
      publication = publishGenerativePresentation(context, {
        threadId: DEMO_THREAD_ID,
        turnId: turn.id,
        title: 'Interrupted native publication',
        fallbackText: 'Durable answer bytes.',
        messages: nativeMessages('native-publication-crash'),
        source: { kind: 'answer', text: answerText },
        actions: [],
      }).then(
        (value) => ({ kind: 'acknowledged' as const, value }),
        (error: unknown) => ({ kind: 'refused' as const, error })
      );
      publication.finally(() => {
        settled = true;
      });
      await waitForGateOrSettlement(gate, 4, () => settled);
      expect(Atomics.load(gate, 4)).toBe(1);
      await expect(publication).resolves.toMatchObject({ kind: 'refused' });
      expect(listExportableGenerativePresentations(workspaceDb)).toEqual([]);
      expect(
        store
          .listWorkspaceItemRevisions(DEMO_WORKSPACE_ID)
          .filter((item) => item.type === 'generative-ui-reference')
      ).toEqual([]);
      expect(
        listWorkspaceAuditEvents(workspaceDb, DEMO_WORKSPACE_ID).filter(
          (event) => event.action === 'generative-ui.publish' && event.requestId === requestId
        )
      ).toEqual([]);
      const receiptScope = { workspaceId: DEMO_WORKSPACE_ID, actorId: ACTOR.id };
      expect(
        getCommandRequestRecord(
          dataRoot,
          receiptScope,
          commandRequestKey('generative-ui.publish', requestId, receiptScope),
          new Date().toISOString()
        )
      ).toBeNull();
    } finally {
      await publication;
      await shutdownControlStoreWorkerClient();
      closeTestCoreDb(workspaceDb);
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
