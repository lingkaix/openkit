import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ServerEvidenceBundleRecord } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it, vi } from 'vitest';
import {
  inspectServerWorkContainmentEvidence,
  publishContainmentEvidenceHandoff,
  publishServerWorkContainmentEvidence,
} from './server-work-evidence.js';

const handoff: ServerEvidenceBundleRecord = {
  id: 'containment-original-evidence',
  owner: { kind: 'server' },
  threadId: allocateEntityId('th'),
  turnId: allocateEntityId('tu'),
  agentSessionId: null,
  goalId: null,
  backendType: null,
  sourceKind: 'security-containment',
  summary: 'An existing authority was withdrawn.',
  rawEvidenceRefs: [],
  redactedEvidenceRefs: [{ kind: 'audit-event', ref: 'original-audit-id' }],
  contentDigests: [],
  retentionClass: 'workspace-audit',
  sensitivityClass: 'restricted',
  importStatus: 'collected',
  requiredFeatures: [],
  createdAt: '2026-11-21T00:15:00.000Z',
};

type PublishInput = Parameters<typeof publishContainmentEvidenceHandoff>[0];
type Store = NonNullable<PublishInput['store']>;

function publicationInput() {
  const publish = vi.fn<Store['publish']>();
  const inspect = vi.fn<Store['inspect']>();
  const readHandoff = vi.fn<NonNullable<PublishInput['readHandoff']>>();
  readHandoff.mockResolvedValue({ state: 'ready', value: handoff });
  return { evidenceId: handoff.id, readHandoff, store: { publish, inspect } };
}

it('keeps publication gated until both admitted bindings exist', async () => {
  const { evidenceId, readHandoff, store } = publicationInput();
  expect(await publishContainmentEvidenceHandoff({ evidenceId, readHandoff })).toEqual({
    state: 'unavailable',
    owner: 'server-work',
    reason: 'disabled',
  });
  expect(await publishContainmentEvidenceHandoff({ evidenceId, store })).toEqual({
    state: 'unavailable',
    owner: 'control-kernel',
    reason: 'disabled',
  });
  expect(readHandoff).not.toHaveBeenCalled();
  expect(store.publish).not.toHaveBeenCalled();
  expect(store.inspect).not.toHaveBeenCalled();
});

it('requires the exact redacted handoff from Core before posting an owner write', async () => {
  const input = publicationInput();
  expect(await publishContainmentEvidenceHandoff({ ...input, evidenceId: 'different' })).toEqual({
    state: 'ready',
    value: { state: 'conflict' },
  });
  input.readHandoff.mockResolvedValue({
    state: 'ready',
    value: { ...handoff, rawEvidenceRefs: [{ kind: 'attachment', ref: 'synthetic-raw-ref' }] },
  });
  expect(await publishContainmentEvidenceHandoff(input)).toEqual({
    state: 'ready',
    value: { state: 'conflict' },
  });
  input.readHandoff.mockResolvedValue({ state: 'ready', value: null });
  expect(await publishContainmentEvidenceHandoff(input)).toEqual({
    state: 'ready',
    value: { state: 'unknown' },
  });
  expect(input.store.publish).not.toHaveBeenCalled();
  expect(input.store.inspect).not.toHaveBeenCalled();
});

it('propagates typed owner refusal and inspects an ambiguous write once', async () => {
  const input = publicationInput();
  input.store.publish
    .mockResolvedValueOnce({ state: 'unavailable', owner: 'server-work', reason: 'missing' })
    .mockImplementationOnce(() => {
      throw new Error('Lost worker ACK');
    });
  expect(await publishContainmentEvidenceHandoff(input)).toEqual({
    state: 'unavailable',
    owner: 'server-work',
    reason: 'missing',
  });
  expect(input.store.inspect).not.toHaveBeenCalled();
  input.store.inspect.mockResolvedValueOnce({ state: 'ready', value: { state: 'absent' } });
  expect(await publishContainmentEvidenceHandoff(input)).toEqual({
    state: 'ready',
    value: { state: 'unknown' },
  });
  expect(input.store.publish).toHaveBeenCalledTimes(2);
  expect(input.store.inspect).toHaveBeenCalledExactlyOnceWith(handoff);
});

it('publishes the same bundle once in the Server journal and inspects the original after reopening', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-server-work-evidence-'));
  const dbPath = join(root, 'state.sqlite');
  const mainDb = new Database(dbPath);
  try {
    migrate(drizzle(mainDb), {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle/services/server-work/', import.meta.url)
      ),
    });
    expect(() =>
      mainDb.transaction(() => publishServerWorkContainmentEvidence(mainDb, handoff))()
    ).toThrow();
  } finally {
    mainDb.close();
  }

  const require = createRequire(import.meta.url);
  const loader = pathToFileURL(require.resolve('tsx/esm/api')).href;
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { tsImport } = await import(workerData.loader);
      const Database = (await import(workerData.sqliteUrl)).default;
      const { publishServerWorkContainmentEvidence } =
        await tsImport(workerData.evidenceUrl, workerData.testUrl);
      const db = new Database(workerData.dbPath, { fileMustExist: true });
      db.pragma('synchronous = FULL');
      const publish = db.transaction((record) => publishServerWorkContainmentEvidence(db, record));
      parentPort.on('message', (record) => {
        try {
          publish.immediate(record);
          parentPort.postMessage('committed');
        } catch {
          parentPort.postMessage('refused');
        }
      });
    })().catch((error) => { throw error; });
  `,
    {
      eval: true,
      workerData: {
        loader,
        dbPath,
        testUrl: import.meta.url,
        evidenceUrl: new URL('./server-work-evidence.ts', import.meta.url).href,
        sqliteUrl: pathToFileURL(require.resolve('better-sqlite3')).href,
      },
    }
  );

  const write = (record: ServerEvidenceBundleRecord) =>
    new Promise<void>((resolve, reject) => {
      worker.once('message', (ack: unknown) =>
        ack === 'committed' ? resolve() : reject(new Error('Publication refused.'))
      );
      worker.postMessage(record);
    });
  // Keep a startup failure visible to the test even if a rejected operation would be caught.
  const stopped = new Promise<never>((_resolve, reject) => worker.once('error', reject));
  const input = publicationInput();
  input.store.publish.mockImplementation(async (record) => {
    await write(record);
    throw new Error('Original write acknowledgement was lost.');
  });
  input.store.inspect.mockImplementation(async (record) => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return { state: 'ready', value: inspectServerWorkContainmentEvidence(db, record) };
    } finally {
      db.close();
    }
  });

  try {
    expect(await Promise.race([stopped, publishContainmentEvidenceHandoff(input)])).toEqual({
      state: 'ready',
      value: { state: 'published' },
    });
    expect(input.store.publish).toHaveBeenCalledExactlyOnceWith(handoff);
    expect(input.store.inspect).toHaveBeenCalledExactlyOnceWith(handoff);

    await Promise.race([stopped, write(handoff)]);
    const conflicting = { ...handoff, summary: 'A different summary for the same ID.' };
    input.readHandoff.mockResolvedValue({ state: 'ready', value: conflicting });
    expect(await Promise.race([stopped, publishContainmentEvidenceHandoff(input)])).toEqual({
      state: 'ready',
      value: { state: 'conflict' },
    });

    const retained = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(retained.prepare('SELECT count(*) FROM evidence_bundles').pluck().get()).toBe(1);
      expect(inspectServerWorkContainmentEvidence(retained, handoff)).toEqual({
        state: 'published',
      });
    } finally {
      retained.close();
    }
  } finally {
    await worker.terminate();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
