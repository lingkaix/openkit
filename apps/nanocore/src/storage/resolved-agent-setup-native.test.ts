import { createHash } from 'node:crypto';
import fs, {
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AuthoredAgentConfigSchema } from '@openkit/config-schema';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listExportableResolvedAgentSetups,
  requireResolvedAgentSetup,
} from '../agents/setup-ledger.js';
import type { ResolvedAgentSetup } from '../agents/setup-resolver.js';
import { ProviderRegistry } from '../providers/registry.js';
import { startTurn } from '../runtime/orchestrator.js';
import type { TurnExecutor } from '../runtime/types.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { armCommit, heldCommit, releaseCommit } from '../test-support/control-native-transport.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { controlWorkerInputBytes } from './control-store-worker-protocol.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';

// Keep the actual Worker entry, SQLite implementation, savepoint and covering FULL commit.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  return { ...actual, Worker: nativeCommitWorker(actual.Worker) };
});

const roots: string[] = [];
const databases: WorkspaceDb[] = [];
const workspaceId = DEMO_WORKSPACE_ID;
const createdAt = '2026-07-06T00:00:00.000Z';

/** Reuse the original ledger fixture's migrated Workspace, with its Main handle read-only. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'setup-ledger-native-owner-'));
  roots.push(root);
  const workspaceDb = openWorkspaceDb(root, workspaceId);
  databases.push(workspaceDb);
  applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
  workspaceDb.sqlite.pragma('query_only = ON');
  return { root, workspaceDb };
}

/** Observe this owner's complete retained row without decoding or regenerating its JSON bytes. */
function row(workspaceDb: WorkspaceDb, recordId: string) {
  return workspaceDb.sqlite
    .prepare('SELECT * FROM resolved_agent_setups WHERE setup_record_id = ?')
    .get(recordId);
}

/** Select this owner's actual prepared transport; file bytes remain outside its wire envelope. */
function preparedSetupRequest(value: unknown, workspaceDb: WorkspaceDb) {
  const request = value as {
    operation?: string;
    database?: string;
    input: {
      scopeWorkspaceId: string;
      file: { name: string; byteLength: number; digest: string; identity: string };
    };
  };
  if (
    request?.operation !== 'resolved-agent-setup' ||
    request.database !== `workspace:${workspaceDb.sqlite.name}`
  )
    return undefined;
  expect(typeof request.input?.file?.name).toBe('string');
  return {
    request,
    path: join(
      dirname(dirname(workspaceDb.sqlite.name)),
      'runtime',
      'staging',
      request.input.file.name
    ),
  };
}

/** Define expected evidence from the original whitelist and fixture values before native source exists. */
function setupInput(recordId: string) {
  const secret = 'fixture-resolved-setup-secret-do-not-forward';
  const declaration = {
    id: 'runtime_api_key',
    requirementId: 'runtime-api-key',
    targetEnvVarName: 'RUNTIME_API_KEY',
    vaultGrantId: 'grant_00000000-0000-7960-b949-4bf702bf6168',
    visibility: 'runtime-env' as const,
  };
  const base = createTestAgentSetup({ credentialDeclarations: [declaration] });
  const setup: ResolvedAgentSetup = {
    ...base,
    manifest: {
      ...base.manifest,
      requiredFeatures: ['workspace.mount.fuse'],
      workspace: { root: '/workspace', env: { PRIVATE_TOKEN: secret } },
    },
  } as ResolvedAgentSetup;
  const expectedSetup = {
    manifest: {
      id: 'agent_codex_host',
      requiredFeatures: ['workspace.mount.fuse'],
      runtime: base.manifest.runtime,
      sandbox: { credentialDeclarations: [declaration], network: [] },
    },
    logicalModels: {
      preferredLogicalModelId: 'openai/gpt-5.2',
      allowed: [
        {
          id: 'openai/gpt-5.2',
          capabilities: base.logicalModels.allowed[0]!.capabilities,
          modelFamilyId: 'gpt',
        },
      ],
    },
  };
  return {
    secret,
    declaration,
    expectedSetup,
    input: {
      recordId,
      workspaceId,
      turnId: testEntityId('tu', recordId),
      requestId: `request_${recordId}`,
      setup,
      createdAt,
    },
  };
}

afterEach(async () => {
  releaseCommit();
  try {
    await shutdownControlStoreWorkerClient();
  } finally {
    vi.restoreAllMocks();
    for (const db of databases.splice(0)) {
      if (db.sqlite.open) db.sqlite.close();
    }
    for (const root of roots.splice(0)) {
      closeWorkspaceProductReadHandles(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// Core Storage owns the physical writer and covering ACK. Contract Evolution and Schema Evolution
// require marker refusal before payload interpretation. Agent Supply and Vault require redacted evidence.
describe('resolved setup through the native Workspace owner', () => {
  it('writes the exact redacted tuple with Main query-only, excludes raw input on wire and cold-reads it', async () => {
    const f = fixture();
    const data = setupInput('ras_native_exact');
    const observed: Array<{ hasSecret: boolean; hasSafeMetadata: boolean }> = [];
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      const submitted = preparedSetupRequest(args[0], f.workspaceDb);
      if (submitted) {
        const serialized = JSON.stringify(submitted.request);
        const evidence = readFileSync(submitted.path, 'utf8');
        // Retain only Boolean observations, so assertion failures do not echo synthetic input.
        observed.push({
          hasSecret: serialized.includes(data.secret) || evidence.includes(data.secret),
          hasSafeMetadata: [
            data.input.recordId,
            data.declaration.vaultGrantId,
            data.declaration.targetEnvVarName,
            'workspace.mount.fuse',
          ].every((value) => evidence.includes(value)),
        });
      }
      return post.apply(this, args);
    });
    const record = await getControlStoreWorkerClient().recordResolvedAgentSetup(
      f.workspaceDb,
      data.input
    );
    expect(record).toEqual({
      id: data.input.recordId,
      workspaceId,
      turnId: data.input.turnId,
      requestId: data.input.requestId,
      agentId: 'agent_codex_host',
      logicalModelId: 'openai/gpt-5.2',
      runtimeKind: 'codex',
      runtimeAdapter: 'codex',
      requiredFeatures: ['workspace.mount.fuse'],
      setup: data.expectedSetup,
      createdAt,
    });
    expect(observed.length > 0).toBe(true);
    expect(observed.every((message) => !message.hasSecret)).toBe(true);
    expect(observed.some((message) => message.hasSafeMetadata)).toBe(true);
    const retained = row(f.workspaceDb, record.id);
    expect(retained).toMatchObject({
      schema_version: 1,
    });
    const stored = retained as { setup_json: string; required_features_json: string };
    expect(JSON.parse(stored.setup_json)).toEqual(data.expectedSetup);
    expect(JSON.parse(stored.required_features_json)).toEqual(['workspace.mount.fuse']);
    expect(f.workspaceDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
    await shutdownControlStoreWorkerClient();
    f.workspaceDb.sqlite.close();
    const cold = openWorkspaceDb(f.root, workspaceId);
    databases.push(cold);
    cold.sqlite.pragma('query_only = ON');
    expect(requireResolvedAgentSetup(cold, workspaceId, record.id)).toEqual(record);
    expect(listExportableResolvedAgentSetups(cold, workspaceId)).toEqual([record]);
    expect(row(cold, record.id)).toEqual(retained);
  });

  it('preserves a complete accepted 65 MiB Dockerfile through prepared transport, SQL and cold read', async () => {
    const f = fixture();
    const base = createTestAgentSetup();
    const prefix = 'FROM scratch\n# harmless resolved setup evidence\n# ';
    const dockerfileBytes = 65 * 1024 * 1024;
    const dockerfile = `${prefix}${'x'.repeat(dockerfileBytes - prefix.length - 1)}\n`;
    const dockerfileDigest = `sha256:${createHash('sha256').update(dockerfile).digest('hex')}`;
    // Validate the whole authored manifest, then use the real typed setup fixture and ledger producer.
    const manifest = AuthoredAgentConfigSchema.parse({
      ...base.manifest,
      runtime: {
        ...base.manifest.runtime,
        image: {
          kind: 'build',
          arguments: {},
          contextRef: 'build-context://empty/v1',
          contextDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          egress: [{ host: 'registry.example.invalid', port: 443 }],
          input: { kind: 'dockerfile', content: dockerfile, digest: dockerfileDigest },
          layerLimit: 1,
          outputLimitBytes: 1024 * 1024,
          timeLimitSeconds: 60,
        },
      },
    });
    const setup: ResolvedAgentSetup = { ...base, manifest };
    const expectedSetup = {
      manifest: {
        id: manifest.id,
        requiredFeatures: [],
        runtime: manifest.runtime,
        sandbox: { credentialDeclarations: [], network: [] },
      },
      logicalModels: {
        preferredLogicalModelId: 'openai/gpt-5.2',
        allowed: [
          {
            id: 'openai/gpt-5.2',
            capabilities: base.logicalModels.allowed[0]!.capabilities,
            modelFamilyId: 'gpt',
          },
        ],
      },
    };
    const expectedJson = JSON.stringify(expectedSetup);
    const expectedBytes = Buffer.byteLength(expectedJson);
    const expectedDigest = createHash('sha256').update(expectedJson).digest('hex');
    expect(Buffer.byteLength(dockerfile)).toBe(68_157_440);
    expect(expectedBytes).toBeGreaterThan(64 * 1024 * 1024);
    const wire: Array<{ jsonBytes: number; backingBytes: number; containsBody: boolean }> = [];
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      const submitted = preparedSetupRequest(args[0], f.workspaceDb);
      if (submitted) {
        const serialized = JSON.stringify(args[0]);
        const file = submitted.request.input.file;
        const metadata = lstatSync(submitted.path);
        expect(Object.keys(submitted.request.input).sort()).toEqual(['file', 'scopeWorkspaceId']);
        expect(Object.keys(file).sort()).toEqual(['byteLength', 'digest', 'identity', 'name']);
        expect(submitted.request.input.scopeWorkspaceId).toBe(f.workspaceDb.workspaceId);
        expect(file.byteLength).toBeGreaterThan(64 * 1024 * 1024);
        expect(metadata.size).toBe(file.byteLength);
        expect(`${metadata.dev}:${metadata.ino}`).toBe(file.identity);
        expect(
          `sha256:${createHash('sha256').update(readFileSync(submitted.path)).digest('hex')}`
        ).toBe(file.digest);
        wire.push({
          jsonBytes: Buffer.byteLength(serialized),
          backingBytes: controlWorkerInputBytes(args[0]),
          containsBody: serialized.includes('x'.repeat(128)),
        });
      }
      return post.apply(this, args);
    });
    const record = await getControlStoreWorkerClient().recordResolvedAgentSetup(f.workspaceDb, {
      recordId: 'ras_native_large_prepared',
      workspaceId,
      turnId: testEntityId('tu', 'ras_native_large_prepared'),
      requestId: 'request_native_large_prepared',
      setup,
      createdAt,
    });
    expect(wire).toHaveLength(1);
    expect(wire[0]!.jsonBytes).toBeLessThan(1024 * 1024);
    expect(wire[0]!.backingBytes).toBe(wire[0]!.jsonBytes);
    expect(wire[0]!.containsBody).toBe(false);
    // Compare only scalar lengths/digests: a failure must not dump a 65 MiB setup or input.
    const returnedJson = JSON.stringify(record.setup);
    expect(Buffer.byteLength(returnedJson)).toBe(expectedBytes);
    expect(createHash('sha256').update(returnedJson).digest('hex')).toBe(expectedDigest);
    const retained = row(f.workspaceDb, record.id) as {
      schema_version: number;
      setup_json: string;
    };
    expect(retained.schema_version).toBe(1);
    expect(Buffer.byteLength(retained.setup_json)).toBe(expectedBytes);
    expect(createHash('sha256').update(retained.setup_json).digest('hex')).toBe(expectedDigest);
    const storedImage = JSON.parse(retained.setup_json).manifest.runtime.image;
    expect(storedImage.kind).toBe('build');
    expect(Buffer.byteLength(storedImage.input.content)).toBe(dockerfileBytes);
    expect(`sha256:${createHash('sha256').update(storedImage.input.content).digest('hex')}`).toBe(
      dockerfileDigest
    );
    expect(storedImage.input.digest).toBe(dockerfileDigest);
    await shutdownControlStoreWorkerClient();
    f.workspaceDb.sqlite.close();
    const cold = openWorkspaceDb(f.root, workspaceId);
    databases.push(cold);
    cold.sqlite.pragma('query_only = ON');
    const coldJson = JSON.stringify(requireResolvedAgentSetup(cold, workspaceId, record.id).setup);
    expect(Buffer.byteLength(coldJson)).toBe(expectedBytes);
    expect(createHash('sha256').update(coldJson).digest('hex')).toBe(expectedDigest);
    const coldRow = row(cold, record.id) as { setup_json: string };
    expect(Buffer.byteLength(coldRow.setup_json)).toBe(expectedBytes);
    expect(createHash('sha256').update(coldRow.setup_json).digest('hex')).toBe(expectedDigest);
  });

  it('refuses a marker changed after posting, before JSON decode or replacement, with exact bytes intact', async () => {
    const f = fixture();
    const data = setupInput('ras_native_future');
    await getControlStoreWorkerClient().recordResolvedAgentSetup(f.workspaceDb, data.input);
    // Hold a genuine prior setup's FULL commit so the replacement can post before its deciding read.
    const held = await heldCommit(2, () =>
      getControlStoreWorkerClient().recordResolvedAgentSetup(f.workspaceDb, {
        ...data.input,
        recordId: 'ras_native_marker_blocker',
      })
    );
    let before: unknown;
    let changed = false;
    const post = Worker.prototype.postMessage;
    const selection = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      const submitted = preparedSetupRequest(args[0], f.workspaceDb);
      const selected =
        submitted &&
        readFileSync(submitted.path, 'utf8').includes(JSON.stringify(data.input.recordId));
      const result = post.apply(this, args);
      if (!changed && selected) {
        changed = true;
        // Corrupt only an existing record after owner setup and after the real request posts.
        const fault = new Database(f.workspaceDb.sqlite.name, { fileMustExist: true });
        try {
          fault
            .prepare(`UPDATE resolved_agent_setups SET schema_version = 2,
            required_features_json = '{', setup_json = '{' WHERE setup_record_id = ?`)
            .run(data.input.recordId);
          fault.exec(`CREATE TRIGGER reject_future_setup_insert BEFORE INSERT ON resolved_agent_setups
            BEGIN SELECT RAISE(FAIL, 'Unsupported setup reached an INSERT'); END`);
        } finally {
          fault.close();
        }
        before = row(f.workspaceDb, data.input.recordId);
        releaseCommit();
      }
      return result;
    });
    const pending = getControlStoreWorkerClient().recordResolvedAgentSetup(f.workspaceDb, {
      ...data.input,
      createdAt: '2026-07-07T00:00:00.000Z',
    });
    void pending.catch(() => undefined);
    try {
      await expect(pending).rejects.toThrow('Unsupported retained record format.');
      expect(changed).toBe(true);
      expect(before).toMatchObject({
        schema_version: 2,
        required_features_json: '{',
        setup_json: '{',
      });
      expect(row(f.workspaceDb, data.input.recordId)).toEqual(before);
      expect(f.workspaceDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
    } finally {
      releaseCommit();
      await Promise.allSettled([held.result, pending]);
      selection.mockRestore();
    }
  });

  it.each([
    'refused',
    'lost-ack',
    'staging-write-pending',
    'lost-ack-cleanup-fails',
    'wrong-scope',
    'wrong-path',
    'same-bytes-new-inode',
    'wrong-length',
    'wrong-digest',
  ] as const)('stops callbacks and executor launch after setup publication is %s, without retry', async (failure) => {
    const root = mkdtempSync(join(tmpdir(), 'setup-ledger-launch-boundary-'));
    roots.push(root);
    const store = await createDemoStore({ dataRoot: root, knowledge: [] });
    const workspaceDb = openWorkspaceDb(root, workspaceId);
    databases.push(workspaceDb);
    workspaceDb.sqlite.pragma('query_only = ON');
    const turnId = testEntityId('tu', `setup_native_${failure}`);
    const recordId = `ras_${turnId}`;
    const setup = createTestAgentSetup();
    const onTurnCreated = vi.fn();
    const onSubmissionSettled = vi.fn();
    const launch = vi.fn<TurnExecutor['startTurn']>(async () => undefined);
    const losesAck = failure === 'lost-ack' || failure === 'lost-ack-cleanup-fails';
    const stagingClose = Promise.withResolvers<void>();
    let stagingCloseReached = false;
    let stagingHandle: FileHandle | undefined;
    if (failure === 'staging-write-pending') {
      // This is the published Storage helper's real FileHandle seam, not a replacement writer.
      const probe = await open(join(root, 'setup-handle-probe'), 'wx', 0o600);
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      await probe.close();
      const writeFile = prototype.writeFile;
      vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
        this: FileHandle,
        ...args: Parameters<FileHandle['writeFile']>
      ) {
        if (typeof args[0] === 'string' && args[0].includes(JSON.stringify(recordId))) {
          stagingHandle = this;
          const close = this.close.bind(this);
          vi.spyOn(this, 'close').mockImplementation(async () => {
            stagingCloseReached = true;
            await stagingClose.promise;
            await close();
          });
        }
        await writeFile.apply(this, args);
      });
      launch.mockImplementation(async (...args) => {
        args[3]?.onSubmissionSettled?.();
      });
    }
    const cleanupFailure = new Error('Selected resolved setup private-tree cleanup failure.');
    let cleanupRoot: string | undefined;
    let cleanupCalls = 0;
    const remove = fs.rmSync;
    const cleanupFault =
      failure === 'lost-ack-cleanup-fails'
        ? vi.spyOn(fs, 'rmSync').mockImplementation((...args: Parameters<typeof fs.rmSync>) => {
            if (cleanupRoot !== undefined && String(args[0]) === cleanupRoot) {
              cleanupCalls++;
              throw cleanupFailure;
            }
            return remove(...args);
          })
        : undefined;
    if (cleanupFault) syncBuiltinESMExports();
    const executor: TurnExecutor = {
      capabilities: {
        approvals: false,
        artifacts: false,
        interrupts: true,
        questions: false,
        workspaceConfig: true,
        workspaceKnowledgeEditing: true,
      },
      eventFamilies: ['turn.started'],
      startTurn: launch,
      interruptTurn: async () => undefined,
    };
    if (failure === 'refused') {
      const fault = new Database(workspaceDb.sqlite.name, { fileMustExist: true });
      try {
        fault.exec(`CREATE TRIGGER refuse_setup_publication BEFORE INSERT ON resolved_agent_setups
            BEGIN SELECT RAISE(ABORT, 'Selected setup publication refusal'); END`);
      } finally {
        fault.close();
      }
    }
    let selectedWorker: Worker | undefined;
    let gate: Int32Array | undefined;
    let posts = 0;
    const post = Worker.prototype.postMessage;
    const selection = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      const submitted = preparedSetupRequest(args[0], workspaceDb);
      if (
        submitted &&
        (failure === 'staging-write-pending' ||
          readFileSync(submitted.path, 'utf8').includes(JSON.stringify(recordId)))
      ) {
        selectedWorker = this;
        posts++;
        // Arm only the exact setup stage, after Turn creation's separate commit has settled.
        if (failure === 'staging-write-pending') {
          expect(stagingCloseReached).toBe(true);
          expect(stagingHandle?.fd).toBe(-1);
        }
        if (failure === 'lost-ack-cleanup-fails') cleanupRoot = dirname(submitted.path);
        if (losesAck) gate = armCommit(2);
        if (failure !== 'refused' && !losesAck && failure !== 'staging-write-pending') {
          const request = submitted.request;
          const file = request.input.file;
          const bytes = readFileSync(submitted.path);
          const metadata = lstatSync(submitted.path);
          // Establish a valid real producer file before introducing one selected transport fault.
          expect(request.input.scopeWorkspaceId).toBe(workspaceDb.workspaceId);
          expect(metadata.isFile()).toBe(true);
          expect(metadata.isSymbolicLink()).toBe(false);
          expect(metadata.size).toBe(file.byteLength);
          expect(`${metadata.dev}:${metadata.ino}`).toBe(file.identity);
          expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(file.digest);
          if (failure === 'wrong-scope') {
            request.input.scopeWorkspaceId = testEntityId('ws', 'wrong_prepared_setup_owner');
          } else if (failure === 'wrong-path') {
            const outside = join(dirname(submitted.path), '..', 'outside-prepared-setup.json');
            writeFileSync(outside, bytes, { flag: 'wx' });
            const outsideMetadata = lstatSync(outside);
            // Valid same bytes and physical identity outside staging isolate path containment.
            request.input.file = {
              ...file,
              name: '../outside-prepared-setup.json',
              identity: `${outsideMetadata.dev}:${outsideMetadata.ino}`,
            };
          } else if (failure === 'same-bytes-new-inode') {
            renameSync(submitted.path, `${submitted.path}.original`);
            writeFileSync(submitted.path, bytes, { flag: 'wx' });
            const replacement = lstatSync(submitted.path);
            expect(`${replacement.dev}:${replacement.ino}`).not.toBe(file.identity);
            expect(replacement.size).toBe(file.byteLength);
            expect(
              `sha256:${createHash('sha256').update(readFileSync(submitted.path)).digest('hex')}`
            ).toBe(file.digest);
          } else if (failure === 'wrong-length') {
            request.input.file = { ...file, byteLength: file.byteLength + 1 };
          } else {
            request.input.file = {
              ...file,
              digest: file.digest.slice(0, -1) + (file.digest.endsWith('0') ? '1' : '0'),
            };
          }
        }
      }
      return post.apply(this, args);
    });
    const pending = startTurn({
      gatewayConfig: createTestGatewayConfig(),
      defaultAgentId: setup.manifest.id,
      triggerActor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      input: 'Run tests',
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          kind: 'local',
          displayName: 'Test inference provider',
          defaultModel: 'openai/gpt-5.2',
          models: ['openai/gpt-5.2'],
        },
      ]),
      store,
      workspaceId,
      threadId: DEMO_THREAD_ID,
      turnId,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
      agentSetupLedger: { workspaceDb, writer: getControlStoreWorkerClient() },
      onTurnCreated,
      onSubmissionSettled,
    });
    void pending.catch(() => undefined);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      if (failure === 'staging-write-pending') {
        // A premature rejection also violates the dependency; it must not masquerade as a gate timeout.
        await vi.waitFor(() => expect(stagingCloseReached || settled).toBe(true), {
          timeout: 5000,
        });
        expect(settled).toBe(false);
        expect(stagingCloseReached).toBe(true);
        expect(posts).toBe(0);
        expect(row(workspaceDb, recordId)).toBeUndefined();
        expect(onTurnCreated).not.toHaveBeenCalled();
        expect(onSubmissionSettled).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
        stagingClose.resolve();
        await pending;
        expect(stagingHandle?.fd).toBe(-1);
        expect(posts).toBe(1);
        expect(row(workspaceDb, recordId)).toMatchObject({
          setup_record_id: recordId,
          workspace_id: workspaceId,
          turn_id: turnId,
          schema_version: 1,
        });
        expect(onTurnCreated).toHaveBeenCalledTimes(1);
        expect(onSubmissionSettled).toHaveBeenCalledTimes(1);
        expect(launch).toHaveBeenCalledTimes(1);
        return;
      }
      if (losesAck) {
        await vi.waitFor(() => expect(gate && Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
        expect(Atomics.load(gate!, 5)).toBe(2);
        expect(row(workspaceDb, recordId)).toMatchObject({
          setup_record_id: recordId,
          workspace_id: workspaceId,
          turn_id: turnId,
        });
        expect(onTurnCreated).not.toHaveBeenCalled();
        expect(onSubmissionSettled).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
        expect(selectedWorker).toBeDefined();
        await selectedWorker!.terminate();
      }
      await expect(pending).rejects.toMatchObject({
        commit: losesAck ? 'unknown' : 'not-committed',
      });
      expect(onTurnCreated).not.toHaveBeenCalled();
      expect(onSubmissionSettled).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      // The accepted owner permits no automatic retry after refusal or unknown acknowledgement.
      expect(posts).toBe(1);
      if (failure === 'lost-ack-cleanup-fails') {
        const original = (await pending.catch(
          (error: unknown) => error
        )) as ControlStoreWorkerError;
        expect(original).toBeInstanceOf(ControlStoreWorkerError);
        expect({ code: original.code, commit: original.commit, domain: original.domain }).toEqual({
          code: 'unavailable',
          commit: 'unknown',
          domain: undefined,
        });
        expect(original.cause).toBe(cleanupFailure);
        expect(cleanupCalls).toBe(1);
        expect(cleanupRoot).toBeDefined();
        expect(fs.existsSync(cleanupRoot!)).toBe(true);
      }
      if (!losesAck) {
        expect(row(workspaceDb, recordId)).toBeUndefined();
      } else {
        const retained = requireResolvedAgentSetup(workspaceDb, workspaceId, recordId);
        releaseCommit();
        selection.mockRestore();
        await shutdownControlStoreWorkerClient();
        workspaceDb.sqlite.close();
        const cold = openWorkspaceDb(root, workspaceId);
        databases.push(cold);
        cold.sqlite.pragma('query_only = ON');
        expect(requireResolvedAgentSetup(cold, workspaceId, recordId)).toEqual(retained);
        expect(launch).not.toHaveBeenCalled();
      }
    } finally {
      stagingClose.resolve();
      releaseCommit();
      await Promise.allSettled([pending]);
      await stagingHandle?.close();
      cleanupFault?.mockRestore();
      if (cleanupFault) syncBuiltinESMExports();
      selection.mockRestore();
    }
  });
});
