import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerOptions } from 'node:worker_threads';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lightAppDbPath, lightAppRoot } from '../storage/app-db.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { commandRequestKey, getCommandRequestRecord } from '../storage/command-request-records.js';
import { CONTROL_STORE_BUDGET } from '../storage/control-store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { observeTestAppRecordCount } from '../test-support/store.js';
import type { KernelCommandContext } from './commands.js';
import {
  batchRecords,
  createLightApp,
  createRecord,
  getLightApp,
  getRecord,
  listLightAppSnapshots,
  listLightApps,
  listRecords,
  updateLightAppSchema,
  updateRecord,
} from './commands.js';
import { KernelCommandError } from './errors.js';
import { allocateAppId } from './uuid.js';

const commitBoundary = vi.hoisted(() => ({
  gate: new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
  forecastPath: undefined as string | undefined,
  forecastCount: 0,
  forecastDecisions: [] as string[],
  failForecastDecision: false,
  forecastDecisionFailed: false,
  holdTermination: false,
  terminationRequested: false,
  releaseTermination: undefined as (() => void) | undefined,
  termination: undefined as Promise<number> | undefined,
}));

// Hold only an armed real native COMMIT; SQL, its result and the worker reply stay genuine.
vi.mock('node:worker_threads', async (load) => {
  const native = await load<typeof import('node:worker_threads')>();
  return {
    ...native,
    Worker: class extends native.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        const prelude = `
          const {workerData}=require('node:worker_threads');
          const Database=require(workerData.databaseModule);
          const gate=new Int32Array(workerData.appCommitGate);
          const exec=Database.prototype.exec;
          Database.prototype.exec=function(sql) {
            const held=/^COMMIT$/i.test(sql) && Atomics.compareExchange(gate,0,1,0)===1;
            if(!held) return exec.call(this,sql);
            Atomics.store(gate,1,1);
            Atomics.notify(gate,1);
            if(Atomics.wait(gate,2,0,10000)==='timed-out') throw new Error('Timed out releasing the App COMMIT fixture.');
            const result=exec.call(this,sql);
            Atomics.store(gate,3,1);
            Atomics.notify(gate,3);
            return result;
          };
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...((options?.workerData ?? {}) as object),
            databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
            appCommitGate: commitBoundary.gate,
          },
        });
        // Corrupt only the real producer's transient forecast at the client boundary.
        // Native SQL, immutable publication and acknowledgements stay genuine.
        this.on('message', (value: unknown) => {
          if (
            value !== null &&
            typeof value === 'object' &&
            'status' in value &&
            value.status === 'physical-forecast' &&
            'files' in value &&
            Array.isArray(value.files) &&
            commitBoundary.forecastPath !== undefined
          ) {
            commitBoundary.forecastCount += 1;
            value.files[0].path = commitBoundary.forecastPath;
          }
        });
        const postMessage = this.postMessage.bind(this);
        this.postMessage = ((...args: Parameters<native.Worker['postMessage']>) => {
          const value = args[0];
          if (
            value !== null &&
            typeof value === 'object' &&
            'operation' in value &&
            value.operation === 'physical-forecast' &&
            'decision' in value &&
            typeof value.decision === 'string'
          )
            commitBoundary.forecastDecisions.push(value.decision);
          if (
            commitBoundary.failForecastDecision &&
            value !== null &&
            typeof value === 'object' &&
            'operation' in value &&
            value.operation === 'physical-forecast'
          ) {
            commitBoundary.forecastDecisionFailed = true;
            throw new Error('Injected physical forecast channel failure.');
          }
          return postMessage(...args);
        }) as native.Worker['postMessage'];
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          commitBoundary.terminationRequested = true;
          if (commitBoundary.termination) return commitBoundary.termination;
          if (!commitBoundary.holdTermination) return terminate();
          commitBoundary.termination = new Promise<number>((resolve, reject) => {
            commitBoundary.releaseTermination = () => {
              if (!commitBoundary.holdTermination) return;
              commitBoundary.holdTermination = false;
              terminate().then(resolve, reject);
            };
          });
          return commitBoundary.termination;
        };
      }
    },
  };
});

const temporaryRoots: string[] = [];
afterEach(async () => {
  const gate = new Int32Array(commitBoundary.gate);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
  commitBoundary.releaseTermination?.();
  await shutdownControlStoreWorkerClient();
  gate.fill(0);
  commitBoundary.forecastPath = undefined;
  commitBoundary.forecastCount = 0;
  commitBoundary.forecastDecisions = [];
  commitBoundary.failForecastDecision = false;
  commitBoundary.forecastDecisionFailed = false;
  commitBoundary.holdTermination = false;
  commitBoundary.terminationRequested = false;
  commitBoundary.releaseTermination = undefined;
  commitBoundary.termination = undefined;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MAPPING_SCHEMA: LightAppSchemaInput = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Membership CRM map',
  purpose: 'Map membership ids to CRM customer ids with a local annotation.',
  collections: [
    {
      name: 'mappings',
      type: 'base',
      description: 'One membership-to-CRM mapping.',
      fields: [
        {
          name: 'membership_id',
          type: 'text',
          required: true,
          description: 'Membership platform user id.',
          namespace: 'membership.prod',
        },
        {
          name: 'crm_id',
          type: 'text',
          required: true,
          description: 'CRM customer id.',
          namespace: 'crm.prod',
        },
        {
          name: 'annotation',
          type: 'text',
          required: false,
          description: 'Local note that the CRM cannot store.',
        },
        {
          name: 'active',
          type: 'bool',
          required: true,
          description: 'False when the mapping is voided.',
        },
      ],
      indexes: [{ fields: ['membership_id', 'crm_id'], unique: true }],
    },
  ],
};

/**
 * Builds a Kernel command context against an isolated data root.
 *
 * @param requestId Caller request id.
 * @returns Context and owning Workspace id.
 */
async function createContext(
  requestId = randomUUID()
): Promise<KernelCommandContext & { workspaceId: string }> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-kernel-'));
  temporaryRoots.push(dataRoot);
  const store = await createDemoStore({ dataRoot });
  return {
    store,
    inflightCommands: new WeakMap(),
    dataRoot,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    requestId,
  };
}

describe('Generative Kernel commands', () => {
  it('reads count and selected records from one snapshot across a concurrent commit', async () => {
    const context = await createContext();
    const app = await createLightApp(context, MAPPING_SCHEMA);
    const record = await createRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'mappings',
      app.schemaRevision,
      { membership_id: 'mem_snapshot', crm_id: 'crm_snapshot', annotation: null, active: true }
    );
    let injected = false;
    let committedBeforeRows = false;
    const gate = new Int32Array(commitBoundary.gate);
    Atomics.store(gate, 0, 1);
    const write = updateRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'mappings',
      record.id,
      {
        schemaRevision: app.schemaRevision,
        expectedRecordRevision: record.revision,
        data: { active: false },
      }
    );
    let restoreCount: (() => void) | undefined;
    try {
      const commitDeadline = Date.now() + 10_000;
      while (Atomics.load(gate, 1) === 0 && Date.now() < commitDeadline) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(Atomics.load(gate, 1), 'the real App writer must reach COMMIT').toBe(1);
      restoreCount = observeTestAppRecordCount(
        {
          dataRoot: context.dataRoot,
          workspaceId: context.workspaceId,
          appId: app.appId,
          collectionId: app.schema!.collections[0]!.id,
        },
        () => {
          injected = true;
          Atomics.store(gate, 2, 1);
          Atomics.notify(gate, 2);
          expect(Atomics.wait(gate, 3, 0, 10_000), 'the real App COMMIT must finish').not.toBe(
            'timed-out'
          );
          committedBeforeRows =
            getRecord(
              context.dataRoot,
              context.workspaceId,
              app.appId,
              'mappings',
              record.id,
              app.schemaRevision
            ).data.active === false;
        }
      );
      const result = listRecords(context.dataRoot, context.workspaceId, app.appId, 'mappings', {
        schemaRevision: app.schemaRevision,
        filter: 'active = true',
        perPage: 100,
      });
      expect(injected).toBe(true);
      expect(committedBeforeRows).toBe(true);
      expect(result).toMatchObject({ totalItems: 1, totalPages: 1, completeResult: true });
      expect(result.items).toEqual([record]);
      expect(await write).toMatchObject({ revision: record.revision + 1, data: { active: false } });
      expect(
        getRecord(
          context.dataRoot,
          context.workspaceId,
          app.appId,
          'mappings',
          record.id,
          app.schemaRevision
        ).data.active
      ).toBe(false);
    } finally {
      Atomics.store(gate, 2, 1);
      Atomics.notify(gate, 2);
      await Promise.allSettled([write]);
      restoreCount?.();
    }
  });

  it.each([
    ['create', 'collection'],
    ['create', 'field'],
    ['update', 'collection'],
    ['update', 'field'],
  ] as const)(
    'refuses caller-assigned new %s %s IDs without publishing changes',
    async (operation, entity) => {
      const context = await createContext();
      if (operation === 'create') {
        const proposed = structuredClone(MAPPING_SCHEMA);
        if (entity === 'collection') proposed.collections[0]!.id = allocateEntityId('col');
        else proposed.collections[0]!.fields[0]!.id = allocateEntityId('fld');
        await expect.soft(createLightApp(context, proposed)).rejects.toMatchObject({
          code: 'validation_failed',
        });
        expect(listLightApps(context.dataRoot, context.workspaceId).items).toEqual([]);
        return;
      }
      const app = await createLightApp(context, MAPPING_SCHEMA);
      const {
        appId: _appId,
        schemaRevision: _schemaRevision,
        ...proposed
      } = structuredClone(app.schema!);
      if (entity === 'collection') {
        proposed.collections.push({
          ...structuredClone(MAPPING_SCHEMA.collections[0]!),
          id: allocateEntityId('col'),
          name: 'extra_mappings',
        });
      } else {
        proposed.collections[0]!.fields.push({
          id: allocateEntityId('fld'),
          name: 'source_note',
          type: 'text',
          required: false,
          description: 'Where this mapping was observed.',
        });
      }
      await expect
        .soft(
          updateLightAppSchema(
            { ...context, requestId: randomUUID() },
            app.appId,
            app.appRevision,
            app.schemaRevision,
            proposed
          )
        )
        .rejects.toMatchObject({ code: 'validation_failed' });
      expect(getLightApp(context.dataRoot, context.workspaceId, app.appId)).toEqual(app);
    }
  );

  it('creates an app and record, then rereads them after reopen', async () => {
    const context = await createContext();
    const created = await createLightApp(context, MAPPING_SCHEMA);
    expect(created.lifecycle).toBe('active');
    expect(created.schema?.collections).toHaveLength(1);
    const record = await createRecord(
      { ...context, requestId: randomUUID() },
      created.appId,
      'mappings',
      created.schemaRevision,
      {
        membership_id: 'mem_1',
        crm_id: 'crm_1',
        annotation: 'needs review',
        active: true,
      }
    );
    expect(record.data.membership_id).toBe('mem_1');
    expect(record.data.active).toBe(true);
    const listed = listLightApps(context.dataRoot, context.workspaceId);
    expect(listed.items.map((item) => item.appId)).toContain(created.appId);
    const reread = getLightApp(context.dataRoot, context.workspaceId, created.appId);
    expect(reread.schemaRevision).toBe(1);
    const fetched = getRecord(
      context.dataRoot,
      context.workspaceId,
      created.appId,
      'mappings',
      record.id,
      reread.schemaRevision
    );
    expect(fetched.data.annotation).toBe('needs review');
  });

  it('replays the same create request and rejects changed arguments', async () => {
    const requestId = randomUUID();
    const context = await createContext(requestId);
    const appId = allocateAppId(context.workspaceId, requestId);
    const path = lightAppDbPath(context.dataRoot, context.workspaceId, appId);
    const resume = await getControlStoreWorkerClient().pauseForDataRootBackup(`app:${path}`);
    let settled = false;
    const creating = createLightApp(context, MAPPING_SCHEMA).then((result) => {
      settled = true;
      return result;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect.soft(settled).toBe(false);
      expect.soft(existsSync(path)).toBe(false);
    } finally {
      resume();
    }
    const first = await creating;
    const second = await createLightApp(context, MAPPING_SCHEMA);
    expect(second.appId).toBe(first.appId);
    await expect(
      createLightApp(context, { ...MAPPING_SCHEMA, title: 'Other title' })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
  });

  it('rejects stale record revisions and unique collisions', async () => {
    const context = await createContext();
    const app = await createLightApp(context, MAPPING_SCHEMA);
    const first = await createRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'mappings',
      app.schemaRevision,
      { membership_id: 'mem_1', crm_id: 'crm_1', annotation: null, active: true }
    );
    await expect(
      createRecord(
        { ...context, requestId: randomUUID() },
        app.appId,
        'mappings',
        app.schemaRevision,
        { membership_id: 'mem_1', crm_id: 'crm_1', annotation: 'dup', active: true }
      )
    ).rejects.toBeInstanceOf(KernelCommandError);
    await expect(
      updateRecord({ ...context, requestId: randomUUID() }, app.appId, 'mappings', first.id, {
        schemaRevision: app.schemaRevision,
        expectedRecordRevision: 99,
        data: { annotation: 'stale' },
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    const updated = await updateRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'mappings',
      first.id,
      {
        schemaRevision: app.schemaRevision,
        expectedRecordRevision: first.revision,
        data: { annotation: 'corrected', active: false },
      }
    );
    expect(updated.data.active).toBe(false);
    expect(updated.revision).toBe(2);
    const active = listRecords(context.dataRoot, context.workspaceId, app.appId, 'mappings', {
      schemaRevision: app.schemaRevision,
      filter: 'active = true',
    });
    expect(active.completeResult).toBe(true);
    expect(active.items).toHaveLength(0);
  });

  it('adds a nullable field without dropping existing rows', async () => {
    const context = await createContext();
    const app = await createLightApp(context, MAPPING_SCHEMA);
    const record = await createRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'mappings',
      app.schemaRevision,
      { membership_id: 'mem_1', crm_id: 'crm_1', annotation: 'keep', active: true }
    );
    const collection = app.schema!.collections[0]!;
    const nextSchema: LightAppSchemaInput = {
      ...MAPPING_SCHEMA,
      collections: [
        {
          ...MAPPING_SCHEMA.collections[0]!,
          id: collection.id,
          fields: [
            ...MAPPING_SCHEMA.collections[0]!.fields.map((field, index) => ({
              ...field,
              id: collection.fields[index]!.id,
            })),
            {
              name: 'source_note',
              type: 'text',
              required: false,
              description: 'Where this mapping was observed.',
            },
          ],
        },
      ],
    };
    const updated = await updateLightAppSchema(
      { ...context, requestId: randomUUID() },
      app.appId,
      app.appRevision,
      app.schemaRevision,
      nextSchema
    );
    expect(updated.schemaRevision).toBe(2);
    const preserved = getRecord(
      context.dataRoot,
      context.workspaceId,
      app.appId,
      'mappings',
      record.id,
      updated.schemaRevision
    );
    expect(preserved.data.annotation).toBe('keep');
    expect(preserved.data.source_note).toBeNull();
    const {
      appId: _appId,
      schemaRevision: _schemaRevision,
      ...renamedSchema
    } = structuredClone(updated.schema!);
    renamedSchema.collections[0]!.name = 'membership_links';
    const renamed = await updateLightAppSchema(
      { ...context, requestId: randomUUID() },
      app.appId,
      updated.appRevision,
      updated.schemaRevision,
      renamedSchema
    );
    expect(renamed.schema!.collections[0]!.id).toBe(collection.id);
    expect(renamed.schema!.collections[0]!.fields.map((field) => field.id)).toEqual(
      updated.schema!.collections[0]!.fields.map((field) => field.id)
    );
    expect(
      getRecord(
        context.dataRoot,
        context.workspaceId,
        app.appId,
        'membership_links',
        record.id,
        renamed.schemaRevision
      ).data.annotation
    ).toBe('keep');
  });

  it('admits the exact post-predecessor snapshot forecast before changing an App family', async () => {
    const context = await createContext();
    const target = await createLightApp(context, MAPPING_SCHEMA);
    const sibling = await createLightApp(
      { ...context, requestId: randomUUID() },
      { ...MAPPING_SCHEMA, title: 'Independent sibling App' }
    );
    const path = lightAppDbPath(context.dataRoot, context.workspaceId, target.appId);
    const database = `app:${path}`;
    const bytesBeforePredecessor = BigInt(statSync(path).size);
    const snapshotsBefore = listLightAppSnapshots(
      context.dataRoot,
      context.workspaceId,
      target.appId
    );
    let predecessorAcknowledged = false;
    const admission = new FileStorageAdmission(
      context.dataRoot,
      () => 0n,
      () =>
        predecessorAcknowledged
          ? BigInt(CONTROL_STORE_BUDGET.maxWalBytes) + bytesBeforePredecessor + 64n * 1_024n
          : 1_000_000_000n
    );
    const client = getControlStoreWorkerClient();
    client.setFileStorageAdmission(context.dataRoot, admission);
    const resume = await client.pauseForDataRootBackup(database);
    const predecessor = batchRecords({ ...context, requestId: randomUUID() }, target.appId, {
      schemaRevision: target.schemaRevision,
      requests: Array.from({ length: 50 }, (_, index) => ({
        method: 'POST' as const,
        url: '/api/collections/mappings/records',
        body: {
          data: {
            membership_id: `mem_forecast_${index}`,
            crm_id: `crm_forecast_${index}`,
            annotation: 'x'.repeat(4_000),
            active: true,
          },
        },
      })),
    }).then((result) => {
      predecessorAcknowledged = true;
      return result;
    });
    const collection = target.schema!.collections[0]!;
    const schemaRequestId = randomUUID();
    const schema = updateLightAppSchema(
      { ...context, requestId: schemaRequestId },
      target.appId,
      target.appRevision,
      target.schemaRevision,
      {
        ...MAPPING_SCHEMA,
        collections: [
          {
            ...MAPPING_SCHEMA.collections[0]!,
            id: collection.id,
            fields: [
              ...MAPPING_SCHEMA.collections[0]!.fields.map((field, index) => ({
                ...field,
                id: collection.fields[index]!.id,
              })),
              {
                name: 'forecast_note',
                type: 'text',
                required: false,
                description: 'Added only when the physical snapshot is admitted.',
              },
            ],
          },
        ],
      }
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      resume();
    }
    const committedPredecessor = await predecessor;
    await expect(schema).rejects.toMatchObject({ code: 'no-space', commit: 'not-committed' });
    expect(committedPredecessor.items).toHaveLength(50);
    expect(
      committedPredecessor.items.every(
        (item) => typeof item.data.annotation === 'string' && item.data.annotation.length === 4_000
      )
    ).toBe(true);
    expect(getLightApp(context.dataRoot, context.workspaceId, target.appId)).toEqual(target);
    expect(listLightAppSnapshots(context.dataRoot, context.workspaceId, target.appId)).toEqual(
      snapshotsBefore
    );
    const scope = { workspaceId: context.workspaceId, appId: target.appId };
    expect(
      getCommandRequestRecord(
        context.dataRoot,
        scope,
        commandRequestKey('kernel.schema.update', schemaRequestId, scope),
        new Date().toISOString()
      )
    ).toBeNull();
    await expect(
      createRecord(
        { ...context, requestId: randomUUID() },
        sibling.appId,
        'mappings',
        sibling.schemaRevision,
        {
          membership_id: 'mem_sibling',
          crm_id: 'crm_sibling',
          annotation: null,
          active: true,
        }
      )
    ).resolves.toMatchObject({ data: { membership_id: 'mem_sibling' } });
  });

  it.each(['data-root', 'other-workspace-history'] as const)(
    'refuses a real native forecast redirected to %s before any App publication',
    async (destination) => {
      const context = await createContext();
      const app = await createLightApp(context, MAPPING_SCHEMA);
      const peer = await context.store.createWorkspace('Unrelated schema history owner');
      const before = listLightAppSnapshots(context.dataRoot, context.workspaceId, app.appId);
      const requestId = randomUUID();
      const target =
        destination === 'data-root'
          ? join(context.dataRoot, 'outside-both-roots.yaml')
          : join(
              context.dataRoot,
              'workspaces',
              peer.id,
              'knowledge',
              'schema',
              'history',
              'foreign.yaml'
            );
      const admission = new FileStorageAdmission(
        context.dataRoot,
        () => 0n,
        () => 1_000_000_000n
      );
      const selected: string[] = [];
      const forPath = admission.forPath.bind(admission);
      const observe = vi.spyOn(admission, 'forPath').mockImplementation((path) => {
        selected.push(path);
        return forPath(path);
      });
      getControlStoreWorkerClient().setFileStorageAdmission(context.dataRoot, admission);
      const {
        appId: _appId,
        schemaRevision: _schemaRevision,
        ...schema
      } = structuredClone(app.schema!);
      schema.collections[0]!.fields.push({
        name: 'scope_forecast_note',
        type: 'text',
        required: false,
        description: 'Published only with an admitted physical forecast.',
      });
      commitBoundary.forecastDecisions = [];
      commitBoundary.forecastPath = target;
      try {
        await expect(
          updateLightAppSchema(
            { ...context, requestId },
            app.appId,
            app.appRevision,
            app.schemaRevision,
            schema
          )
        ).rejects.toMatchObject({ code: 'precondition', commit: 'not-committed' });
        expect(commitBoundary.forecastCount).toBe(1);
        expect(commitBoundary.forecastDecisions).toEqual(['unavailable']);
        expect(selected).not.toContain(target);
        expect(existsSync(target)).toBe(false);
        expect(getLightApp(context.dataRoot, context.workspaceId, app.appId)).toEqual(app);
        expect(listLightAppSnapshots(context.dataRoot, context.workspaceId, app.appId)).toEqual(
          before
        );
        const scope = { workspaceId: context.workspaceId, appId: app.appId };
        expect(
          getCommandRequestRecord(
            context.dataRoot,
            scope,
            commandRequestKey('kernel.schema.update', requestId, scope),
            new Date().toISOString()
          )
        ).toBeNull();
      } finally {
        commitBoundary.forecastPath = undefined;
        observe.mockRestore();
      }
    }
  );

  it('retains exact snapshot reservations until a failed native channel exits', async () => {
    const context = await createContext();
    const app = await createLightApp(context, MAPPING_SCHEMA);
    const appRoot = lightAppRoot(context.dataRoot, context.workspaceId, app.appId);
    const snapshotRoot = join(appRoot, 'snapshots');
    const reservations: Array<{
      path: string;
      publicationBytes: bigint;
      releaseCalls: number;
    }> = [];
    const admission = new FileStorageAdmission(
      context.dataRoot,
      () => 0n,
      () => 1_000_000_000n
    );
    const forPath = admission.forPath.bind(admission);
    const observeReservations = vi.spyOn(admission, 'forPath').mockImplementation((path) => {
      const selected = forPath(path);
      if (path !== snapshotRoot && !path.startsWith(`${snapshotRoot}/`)) return selected;
      const reserve = selected.reserve.bind(selected);
      vi.spyOn(selected, 'reserve').mockImplementation((writes, priority) => {
        const reservation = reserve(writes, priority);
        const observed = {
          path,
          publicationBytes: writes.publicationBytes,
          releaseCalls: 0,
        };
        reservations.push(observed);
        return {
          ...reservation,
          release: () => {
            observed.releaseCalls += 1;
            reservation.release();
          },
        };
      });
      return selected;
    });
    const client = getControlStoreWorkerClient();
    client.setFileStorageAdmission(context.dataRoot, admission);
    commitBoundary.failForecastDecision = true;
    commitBoundary.holdTermination = true;
    const collection = app.schema!.collections[0]!;
    const changedSchema: LightAppSchemaInput = {
      ...MAPPING_SCHEMA,
      collections: [
        {
          ...MAPPING_SCHEMA.collections[0]!,
          id: collection.id,
          fields: [
            ...MAPPING_SCHEMA.collections[0]!.fields.map((field, index) => ({
              ...field,
              id: collection.fields[index]!.id,
            })),
            {
              name: 'channel_failure_note',
              type: 'text',
              required: false,
              description: 'Added only after snapshot capacity remains owned through worker exit.',
            },
          ],
        },
      ],
    };
    try {
      const failure = await updateLightAppSchema(
        { ...context, requestId: randomUUID() },
        app.appId,
        app.appRevision,
        app.schemaRevision,
        changedSchema
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'unavailable', commit: 'unknown' });
      expect(commitBoundary.forecastDecisionFailed).toBe(true);
      expect(commitBoundary.terminationRequested).toBe(true);
      expect(reservations).toHaveLength(2);
      expect(reservations.every((entry) => entry.publicationBytes > 0n)).toBe(true);
      expect(reservations.every((entry) => entry.releaseCalls === 0)).toBe(true);
      commitBoundary.releaseTermination?.();
      await shutdownControlStoreWorkerClient();
      expect(reservations.every((entry) => entry.releaseCalls === 1)).toBe(true);
    } finally {
      commitBoundary.releaseTermination?.();
      await shutdownControlStoreWorkerClient();
      observeReservations.mockRestore();
    }
  });

  it('rechecks source-query membership before a lineage-bound record update', async () => {
    const context = await createContext();
    const app = await createLightApp(context, MAPPING_SCHEMA);
    const record = await createRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'mappings',
      app.schemaRevision,
      { membership_id: 'mem_1', crm_id: 'crm_1', annotation: 'keep', active: true }
    );
    await expect(
      updateRecord(
        { ...context, requestId: randomUUID() },
        app.appId,
        'mappings',
        record.id,
        {
          schemaRevision: app.schemaRevision,
          expectedRecordRevision: record.revision,
          data: { annotation: 'stale binding' },
        },
        {
          presentationId: randomUUID(),
          actionName: 'saveAnnotation',
          itemId: randomUUID(),
          sourceFilter: `id = "${record.id}" && active = false`,
        }
      )
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const unchanged = getRecord(
      context.dataRoot,
      context.workspaceId,
      app.appId,
      'mappings',
      record.id,
      app.schemaRevision
    );
    expect(unchanged.data.annotation).toBe('keep');
  });
});
