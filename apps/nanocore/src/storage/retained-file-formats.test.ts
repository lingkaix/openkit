// openkit-test-platform: posix
// The refusal helper preserves raw symbolic-link targets under the POSIX contract.
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { FsStore } from '../lib/store.js';
import { createTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { publishImmutableProductJson, readImmutableProductJson } from './immutable-content.js';
import {
  loadWorkspaceFileRecords,
  type NativeProductScope,
  nativeProductScope,
  readNativeProduct,
  readNativeProductEntries,
} from './workspace-file-records.js';

const families = ['Workspace', 'Turn', 'Artifact', 'AgentSession', 'Item', 'stream event'] as const;
const nativeFamilies = families.filter((family) => family !== 'Artifact');

type RetainedFamily = (typeof families)[number];
type RetainedSurface =
  | { kind: 'file'; path: string }
  | { kind: 'metadata'; database: string; table: string; id: string }
  | { kind: 'entry'; scope: NativeProductScope; turnId: string; entryKind: 'item' | 'event' };

/** Reads exact retained authority without using the Store cache or a readable projection. */
function readRetainedSurface(surface: RetainedSurface) {
  if (surface.kind === 'file') {
    const bytes = readFileSync(surface.path, 'utf8');
    return { record: JSON.parse(bytes) as Record<string, unknown>, bytes, path: surface.path };
  }
  const database = surface.kind === 'metadata' ? surface.database : surface.scope.path;
  const db = new Database(database, { readonly: true, fileMustExist: true });
  let bytes: string;
  try {
    if (surface.kind === 'metadata') {
      const row = db
        .prepare(`SELECT record_json FROM ${surface.table} WHERE id=?`)
        .get(surface.id) as { record_json: string };
      bytes = row.record_json;
    } else {
      const row = db
        .prepare(
          'SELECT content_json FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence=1'
        )
        .get(surface.entryKind, surface.turnId) as { content_json: string };
      const content = JSON.parse(row.content_json);
      readImmutableProductJson(surface.scope.contentMount, surface.scope.owner, content);
      const path = join(surface.scope.contentMount.root, content.reference.locator.path);
      bytes = readFileSync(path, 'utf8');
      return { record: JSON.parse(bytes) as Record<string, unknown>, bytes, path };
    }
  } finally {
    db.close();
  }
  return { record: JSON.parse(bytes) as Record<string, unknown>, bytes, path: undefined };
}

/** Uses the actual family reader, including immutable payload verification, without scope-cache repair. */
function readNativeSurface(scope: NativeProductScope, surface: RetainedSurface) {
  if (surface.kind === 'file') throw new Error('This check requires native retained authority.');
  if (surface.kind === 'entry')
    return readNativeProductEntries(scope, surface.turnId, surface.entryKind);
  const kind =
    surface.table === 'control_workspaces'
      ? 'workspace'
      : surface.table === 'control_turns'
        ? 'turn'
        : 'agent-session';
  return readNativeProduct(scope, kind, surface.id);
}

/** Injects one retained-format fixture only while the actual native writer is stopped. */
async function replaceRetainedSurface(surface: RetainedSurface, record: Record<string, unknown>) {
  await shutdownControlStoreWorkerClient();
  if (surface.kind === 'file') {
    writeFileSync(surface.path, `${JSON.stringify(record)}\n`);
    return;
  }
  const content =
    surface.kind === 'entry'
      ? await publishImmutableProductJson(
          surface.scope.contentMount,
          surface.scope.owner,
          join(dirname(dirname(surface.scope.path)), 'runtime', 'staging'),
          record
        )
      : undefined;
  const db = new Database(surface.kind === 'metadata' ? surface.database : surface.scope.path, {
    fileMustExist: true,
  });
  try {
    const result =
      surface.kind === 'metadata'
        ? db
            .prepare(`UPDATE ${surface.table} SET record_json=? WHERE id=?`)
            .run(JSON.stringify(record), surface.id)
        : db
            .prepare(
              'UPDATE control_product_entries SET content_json=? WHERE kind=? AND turn_id=? AND sequence=1'
            )
            .run(JSON.stringify(content), surface.entryKind, surface.turnId);
    if (result.changes !== 1)
      throw new Error('Retained fixture requires exactly one existing native row.');
  } finally {
    db.close();
  }
}

/** Seeds native metadata, prior file-backed Item/event specimens and the file-owned Artifact. */
async function createRetainedFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-retained-file-formats-'));
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    return rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Retained formats');
  const thread = await store.createThread(workspace.id, 'Retained formats');
  const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
  const internalExecution = {
    roleId: 'assistant',
    logicalModelId: 'Smart',
    profileId: 'assistant',
    limits: { maxModelTurns: 12, maxToolCalls: 24, deadlineMs: 60_000 },
    contextStrategy: 'rolling' as const,
    threshold: 16_000,
  };
  const turn = await store.createTurn(workspace.id, thread.id, 'Retained request', actor, null, {
    internalExecution,
  });
  const now = workspace.createdAt;
  await store.createItem({
    id: 'it_00000000-0000-7107-a6b6-12de9088d8ca',
    owner: { kind: 'workspace', workspaceId: workspace.id },
    threadId: thread.id,
    turnId: turn.id,
    createdAt: now,
    type: 'user-message',
    actor,
    text: 'Retained request',
    status: 'completed',
    completedAt: now,
  });
  const sessionId = 'as_00000000-0000-74db-9692-cadae15b58fb';
  await store.createAgentSession({
    id: sessionId,
    agentId: 'agent_retained_formats',
    workspaceId: workspace.id,
    threadId: thread.id,
    status: 'idle',
    message: null,
    createdAt: now,
    updatedAt: now,
    workspaceRoots: [],
  });
  const artifactId = 'ar_00000000-0000-780c-b09d-92983bad1f5b';
  const body = 'Retained artifact bytes.';
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  store.createArtifact({
    id: artifactId,
    workspaceId: workspace.id,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: 'Retained artifact',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'text', body },
    contentDigest: digest,
    lastMutationRequestId: 'retained-import',
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: 'retained-import',
      sourceDigest: digest,
      actor,
      requestId: 'retained-import',
      recordedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  });
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  await store.persistTurnEvent(turn.id, {
    requestId: null,
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    event: 'workspace.updated',
    data: { type: 'workspace-updated', workspace },
  });
  await shutdownControlStoreWorkerClient();
  const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId: workspace.id });
  const surfaces: Record<RetainedFamily, RetainedSurface> = {
    Workspace: {
      kind: 'metadata',
      database: scope.path,
      table: 'control_workspaces',
      id: workspace.id,
    },
    Turn: { kind: 'metadata', database: scope.path, table: 'control_turns', id: turn.id },
    Artifact: { kind: 'file', path: join(workspaceRoot, 'artifacts', artifactId, 'artifact.json') },
    AgentSession: {
      kind: 'metadata',
      database: scope.path,
      table: 'control_agent_sessions',
      id: sessionId,
    },
    Item: { kind: 'entry', scope, turnId: turn.id, entryKind: 'item' },
    'stream event': { kind: 'entry', scope, turnId: turn.id, entryKind: 'event' },
  };
  // These retained-file cases require prior files to remain unchanged after descriptor replacement.
  // Seed only these stopped specimens through the existing immutable-file publication owner.
  for (const family of ['Item', 'stream event'] as const) {
    const surface = surfaces[family];
    if (surface.kind !== 'entry') throw new Error('Retained file fixture requires an entry.');
    const original = readNativeProductEntries(scope, surface.turnId, surface.entryKind)[0]!;
    await replaceRetainedSurface(surface, original.value as Record<string, unknown>);
  }
  return {
    dataRoot,
    workspaceId: workspace.id,
    scope,
    surfaces,
    expected: {
      workspace: { id: workspace.id, name: 'Retained formats' },
      turns: [{ id: turn.id, internalExecution, items: [{ text: 'Retained request' }] }],
      itemRevisions: [{ text: 'Retained request' }],
      artifacts: [{ id: artifactId, content: { format: 'text', body } }],
      agentSessions: [{ id: sessionId, agentId: 'agent_retained_formats' }],
      streamEvents: [[turn.id, [{ sequence: 1, event: 'workspace.updated' }]]],
    },
  };
}

/**
 * Validates one retained fault in a fresh admission lifetime without resetting process state.
 *
 * Copies exact authority, seeds an independent healthy sibling, and checks refusal and preservation.
 * Each copy has a new root identity, so later faults cannot reuse an earlier refusal.
 *
 * @param dataRoot Source fixture containing the injected fault.
 * @param workspaceId Owning Workspace that must be quarantined.
 * @returns Reopened Store and isolated root for additional native readback checks.
 */
async function expectLocalWorkspaceRefusal(dataRoot: string, workspaceId: string) {
  const restartRoot = mkdtempSync(join(tmpdir(), 'openkit-local-refusal-'));
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    return rmSync(restartRoot, { recursive: true, force: true });
  });
  const seed = createTestStore({ dataRoot: restartRoot });
  const sibling = await seed.createWorkspace('Healthy refusal control');
  const siblingThread = await seed.createThread(sibling.id, 'Retained sibling thread');
  const siblingBefore = seed.getWorkspace(sibling.id);
  await shutdownControlStoreWorkerClient();
  cpSync(dataRoot, restartRoot, { recursive: true, verbatimSymlinks: true });

  /** Preserves all retained file bytes and logical SQL rows, excluding disposable WAL/SHM bookkeeping. */
  function snapshot(root: string): Record<string, Buffer | string> {
    const entries: Record<string, Buffer | string> = {};
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const key = join(prefix, entry.name);
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          entries[key] = `link:${readlinkSync(path)}`;
        } else if (entry.isDirectory()) {
          entries[key] = 'directory';
          visit(path, key);
        } else if (entry.isFile()) {
          if (/\.sqlite-(wal|shm)$/.test(entry.name)) continue;
          if (entry.name.endsWith('.sqlite')) {
            const db = new Database(path, { readonly: true, fileMustExist: true });
            try {
              const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .all() as { name: string }[];
              entries[key] = Buffer.from(
                JSON.stringify(
                  tables.map(({ name }) => [
                    name,
                    db
                      .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
                      .all()
                      .map((row) => JSON.stringify(row))
                      .sort(),
                  ])
                )
              );
            } finally {
              db.close();
            }
          } else entries[key] = readFileSync(path);
        } else {
          throw new Error('Retained snapshot requires a directory, regular file or symbolic link.');
        }
      }
    };
    visit(root);
    return entries;
  }

  const refusedRoot = join(restartRoot, 'workspaces', workspaceId);
  const before = snapshot(refusedRoot);
  const reopened = new FsStore({ dataRoot: restartRoot });
  expect(scopeAdmissionFailures(restartRoot)).toContainEqual(
    expect.objectContaining({ scope: 'workspace', id: workspaceId })
  );
  expect(() => reopened.getWorkspace(workspaceId)).toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  await expect(reopened.createThread(workspaceId, 'Must remain refused')).rejects.toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  expect(reopened.getWorkspace(sibling.id)).toEqual(siblingBefore);
  expect(reopened.getThread(sibling.id, siblingThread.id)).toEqual(siblingThread);
  const progress = await reopened.createThread(sibling.id, 'Healthy sibling progress');
  expect(new FsStore({ dataRoot: restartRoot }).getThread(sibling.id, progress.id)).toEqual(
    progress
  );
  expect(snapshot(refusedRoot)).toEqual(before);
  expect(snapshot(join(dataRoot, 'workspaces', workspaceId))).toEqual(before);
  return { store: reopened, dataRoot: restartRoot };
}

describe('native retained file formats', () => {
  it.each(
    families
  )('writes %s v1 and reopens descriptive additions without changing bytes', async (family) => {
    const { dataRoot, expected, surfaces } = await createRetainedFixture();
    const surface = surfaces[family];
    const originalSource = readRetainedSurface(surface);
    const record = originalSource.record;
    expect(record.schemaVersion).toBe(1);
    const original = loadWorkspaceFileRecords(dataRoot);
    expect(original).toMatchObject([expected]);
    record.futureNote = 'Retained descriptive annotation.';
    await replaceRetainedSurface(surface, record);
    const annotatedBytes = readRetainedSurface(surface).bytes;

    expect(loadWorkspaceFileRecords(dataRoot)).toEqual(original);
    expect(readRetainedSurface(surface).bytes).toBe(annotatedBytes);
    const reopened = new FsStore({ dataRoot });
    expect(reopened.getWorkspace(expected.workspace.id)).toMatchObject(expected.workspace);
    expect(reopened.getTurnById(expected.turns[0]!.id)).not.toHaveProperty('futureNote');
    expect(reopened.getTurnById(expected.turns[0]!.id).items[0]).not.toHaveProperty('futureNote');
    if (surface.kind === 'entry') {
      expect(readFileSync(originalSource.path!, 'utf8')).toBe(originalSource.bytes);
    }
  });

  it.each(families)('refuses %s with a missing or unknown retained version', async (family) => {
    const { dataRoot, surfaces, workspaceId } = await createRetainedFixture();
    const surface = surfaces[family];
    const originalRecord = readRetainedSurface(surface).record;
    expect(loadWorkspaceFileRecords(dataRoot)).toHaveLength(1);

    for (const version of [undefined, 2]) {
      const record = structuredClone(originalRecord);
      if (version === undefined) delete record.schemaVersion;
      else record.schemaVersion = version;
      await replaceRetainedSurface(surface, record);
      const invalidBytes = readRetainedSurface(surface).bytes;

      const restarted = await expectLocalWorkspaceRefusal(dataRoot, workspaceId);
      expect(
        loadWorkspaceFileRecords(restarted.dataRoot).map(({ workspace }) => workspace.id)
      ).not.toContain(workspaceId);
      expect(readRetainedSurface(surface).bytes).toBe(invalidBytes);
      await replaceRetainedSurface(surface, originalRecord);
      expect(loadWorkspaceFileRecords(dataRoot)).toHaveLength(1);
    }
  });

  it.each(nativeFamilies)('refuses %s invalid native version discriminators', async (family) => {
    const { scope, surfaces } = await createRetainedFixture();
    const surface = surfaces[family];
    const original = readRetainedSurface(surface).record;
    for (const schemaVersion of [null, '1', 0, -1]) {
      await replaceRetainedSurface(surface, { ...original, schemaVersion });
      const invalidBytes = readRetainedSurface(surface).bytes;
      expect(() => readNativeSurface(scope, surface)).toThrow(
        'Unsupported retained record format.'
      );
      expect(readRetainedSurface(surface).bytes).toBe(invalidBytes);
      await replaceRetainedSurface(surface, original);
      expect(() => readNativeSurface(scope, surface)).not.toThrow();
    }
  });

  it.each(
    nativeFamilies
  )('refuses %s unsupported required semantics and unknown core values', async (family) => {
    const { scope, surfaces } = await createRetainedFixture();
    const surface = surfaces[family];
    const original = readRetainedSurface(surface).record;
    const required = {
      ...original,
      requiredFeatures: [
        ...((original.requiredFeatures as string[] | undefined) ?? []),
        'openkit.test-unsupported-retained.v1',
      ],
    };
    const core = structuredClone(original);
    if (family === 'Item') core.type = 'future-item';
    else if (family === 'stream event') {
      core.event = 'future.event';
      core.data = { type: 'future-event' };
    } else core.status = 'future-status';
    for (const record of [required, core]) {
      await replaceRetainedSurface(surface, record);
      const invalidBytes = readRetainedSurface(surface).bytes;
      expect(() => readNativeSurface(scope, surface)).toThrow();
      expect(readRetainedSurface(surface).bytes).toBe(invalidBytes);
      await replaceRetainedSurface(surface, original);
      expect(() => readNativeSurface(scope, surface)).not.toThrow();
    }
  });

  it.each(
    nativeFamilies
  )('checks %s native SQL version before decoding retained JSON', async (family) => {
    const { scope, surfaces } = await createRetainedFixture();
    const surface = surfaces[family];
    if (surface.kind === 'file') throw new Error('This check requires native retained authority.');
    const reader = new Database(scope.path, { readonly: true, fileMustExist: true });
    let row: { schema_version: number; json: string };
    try {
      row =
        surface.kind === 'metadata'
          ? (reader
              .prepare(`SELECT schema_version,record_json AS json FROM ${surface.table} WHERE id=?`)
              .get(surface.id) as typeof row)
          : (reader
              .prepare(
                'SELECT schema_version,content_json AS json FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence=1'
              )
              .get(surface.entryKind, surface.turnId) as typeof row);
    } finally {
      reader.close();
    }
    expect(row.schema_version).toBe(1);
    // Only this stopped fixture mutator admits corruption; the real reader keeps every guard.
    const replace = (version: number, json: string) => {
      const mutator = new Database(scope.path, { fileMustExist: true });
      try {
        mutator.pragma('ignore_check_constraints = ON');
        if (surface.kind === 'metadata')
          mutator
            .prepare(`UPDATE ${surface.table} SET schema_version=?,record_json=? WHERE id=?`)
            .run(version, json, surface.id);
        else
          mutator
            .prepare(
              'UPDATE control_product_entries SET schema_version=?,content_json=? WHERE kind=? AND turn_id=? AND sequence=1'
            )
            .run(version, json, surface.entryKind, surface.turnId);
      } finally {
        try {
          mutator.pragma('ignore_check_constraints = OFF');
        } finally {
          mutator.close();
        }
      }
    };
    for (const json of [row.json, '{invalid-json']) {
      replace(2, json);
      expect(() => readNativeSurface(scope, surface)).toThrow();
      expect(() => readNativeSurface(scope, surface)).not.toThrow(SyntaxError);
    }
    replace(row.schema_version, row.json);
    expect(() => readNativeSurface(scope, surface)).not.toThrow();
  });
});
