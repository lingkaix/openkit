// openkit-test-platform: posix
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { FsStore, type KnowledgeSourceRecord } from '../lib/store.js';
import { feedbackFilePath, readTurnFeedback, updateTurnFeedback } from '../runtime/feedback.js';
import {
  readEncryptedFileVaultText,
  writeEncryptedFileVaultJsonAtomically,
} from '../vault/vault-encrypted-file-store.js';
import { writeStorageJsonAtomically } from './data-root-backup.js';

const durability = vi.hoisted(() => ({
  paths: new Map<number, string>(),
  events: [] as Array<{
    op: 'sync' | 'rename';
    path: string;
    from?: string;
    directory?: boolean;
    mode?: number;
  }>,
  fail: undefined as ((path: string, directory: boolean) => boolean) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      durability.paths.set(descriptor, String(args[0]));
      return descriptor;
    }) as typeof actual.openSync,
    closeSync: ((descriptor: number) => {
      durability.paths.delete(descriptor);
      return actual.closeSync(descriptor);
    }) as typeof actual.closeSync,
    fsyncSync: ((descriptor: number) => {
      const path = durability.paths.get(descriptor) ?? '<untracked>';
      const directory = actual.fstatSync(descriptor).isDirectory();
      durability.events.push({
        op: 'sync',
        path,
        directory,
        mode: actual.fstatSync(descriptor).mode & 0o777,
      });
      if (durability.fail?.(path, directory)) throw new Error('Injected publication sync failure');
      return actual.fsyncSync(descriptor);
    }) as typeof actual.fsyncSync,
    renameSync: ((
      from: Parameters<typeof actual.renameSync>[0],
      to: Parameters<typeof actual.renameSync>[1]
    ) => {
      durability.events.push({ op: 'rename', from: String(from), path: String(to) });
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
});

const timestamp = '2026-07-12T00:00:00.000Z';

/**
 * Creates one file-backed workspace for direct canonical write boundary tests.
 *
 * @param prefix Temporary directory prefix.
 * @returns Store plus its workspace and canonical root.
 */
function createFixture(prefix: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), prefix));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Direct canonical write boundary');

  return {
    dataRoot,
    store,
    workspace,
    workspaceRoot: join(dataRoot, 'workspaces', workspace.id),
  };
}

/**
 * Replaces one canonical parent with a directory symlink to an outside root.
 *
 * @param parentPath Canonical parent path to replace.
 * @param prefix Outside temporary directory prefix.
 * @returns Outside directory targeted by the symlink.
 */
function installOutsideParent(parentPath: string, prefix: string): string {
  const outsideRoot = mkdtempSync(join(tmpdir(), prefix));

  rmSync(parentPath, { force: true, recursive: true });
  mkdirSync(dirname(parentPath), { recursive: true });
  symlinkSync(outsideRoot, parentPath, 'dir');
  return outsideRoot;
}

/**
 * Builds one valid source identity for direct material writes.
 *
 * @param workspaceId Owning workspace id.
 * @param sourceId Source id.
 * @returns Source record fixture.
 */
function knowledgeSource(workspaceId: string, sourceId: string): KnowledgeSourceRecord {
  return {
    id: sourceId,
    workspaceId,
    kind: 'upload',
    title: 'Symlink boundary source',
    uri: null,
    contentDigest: 'sha256:symlink-boundary-source',
    originatingThreadId: null,
    originatingTurnId: null,
    originatingFileId: null,
    capturedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Builds the smallest valid imported workspace snapshot.
 *
 * @param workspaceId Imported workspace id.
 * @returns Import payload accepted by the store.
 */
function workspaceImportPayload(
  workspaceId: string
): Parameters<FsStore['importWorkspaceSnapshot']>[0] {
  return {
    workspace: {
      id: workspaceId,
      name: 'Imported symlink boundary workspace',
      kind: 'general',
      status: 'active',
      counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    threads: [],
    knowledge: [],
    turns: [],
    itemRevisions: [],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
  };
}

describe('direct canonical write boundaries', () => {
  it('rejects a symlinked import staging parent before staging or publication', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-import-staging-symlink-'));
    const store = new FsStore({ dataRoot });
    const workspaceId = 'ws_import_staging_symlink';
    const workspacesRoot = join(dataRoot, 'workspaces');
    const outsideRoot = installOutsideParent(
      join(workspacesRoot, '.staging'),
      'openkit-import-staging-outside-'
    );
    const sentinelPath = join(outsideRoot, 'sentinel.txt');
    const stageWorkspace = vi.fn();

    writeFileSync(sentinelPath, 'untouched');

    expect
      .soft(() =>
        store.importWorkspaceSnapshot({
          ...workspaceImportPayload(workspaceId),
          stageWorkspace,
        })
      )
      .toThrow();
    expect.soft(stageWorkspace).not.toHaveBeenCalled();
    expect.soft(readdirSync(outsideRoot).sort()).toEqual(['sentinel.txt']);
    expect.soft(readFileSync(sentinelPath, 'utf8')).toBe('untouched');
    expect(existsSync(join(workspacesRoot, workspaceId))).toBe(false);
  });

  it('rejects a symlinked source material parent without writing outside the workspace', () => {
    const { store, workspace, workspaceRoot } = createFixture('openkit-source-material-symlink-');
    const sourceId = 'ks_source_material_symlink';
    const outsideRoot = installOutsideParent(
      join(workspaceRoot, 'sources', 'materials', sourceId),
      'openkit-source-material-outside-'
    );

    expect
      .soft(() =>
        store.createKnowledgeSource(
          knowledgeSource(workspace.id, sourceId),
          'This content must stay inside the workspace.'
        )
      )
      .toThrow();
    expect(existsSync(join(outsideRoot, 'content.txt'))).toBe(false);
  });

  it.each([
    'materials',
    'derived',
  ] as const)('rejects a symlinked staged source %s parent without writing outside', (family) => {
    const { store, workspace } = createFixture(`openkit-staged-source-${family}-`);
    const workspaceRoot = mkdtempSync(join(tmpdir(), `openkit-staged-source-root-${family}-`));
    const sourceId = `ks_staged_${family}_symlink`;
    const source = knowledgeSource(workspace.id, sourceId);
    const outsideRoot = installOutsideParent(
      join(workspaceRoot, 'sources', family, sourceId),
      `openkit-staged-source-outside-${family}-`
    );
    const outsideFile = family === 'materials' ? 'content.txt' : 'text.json';

    expect
      .soft(() => {
        if (family === 'materials') {
          Reflect.apply(Reflect.get(store, 'writeKnowledgeSourceMaterialsToRoot'), store, [
            workspaceRoot,
            [{ sourceId, content: 'Staged source material.' }],
            [source],
          ]);
          return;
        }

        Reflect.apply(Reflect.get(store, 'writeKnowledgeSourceDerivedRepresentation'), store, [
          workspaceRoot,
          source,
        ]);
      })
      .toThrow();
    expect(existsSync(join(outsideRoot, outsideFile))).toBe(false);
  });

  it.each([
    ['observation', 'observations'],
    ['claim', 'claims'],
    ['conflict', 'conflicts'],
  ] as const)('rejects a symlinked %s write parent without writing outside', (family, directory) => {
    const { store, workspace, workspaceRoot } = createFixture(`openkit-direct-${family}-symlink-`);
    const outsideRoot = installOutsideParent(
      join(workspaceRoot, 'knowledge', directory),
      `openkit-direct-${family}-outside-`
    );

    expect
      .soft(() => {
        switch (family) {
          case 'observation':
            store.recordKnowledgeObservation({
              id: 'ko_direct_write_symlink',
              workspaceId: workspace.id,
              kind: 'maintenance',
              summary: 'Canonical writes must reject symlinked parents.',
              sourceReferences: [],
              scope: 'workspace',
              producer: 'boundary-test',
              confidence: 1,
              freshness: 'current',
              status: 'retained',
              observedAt: timestamp,
              createdAt: timestamp,
            });
            break;
          case 'claim':
            store.recordKnowledgeClaim({
              id: 'kc_direct_write_symlink',
              workspaceId: workspace.id,
              statement: 'Canonical writes reject symlinked parents.',
              sourceReferences: [],
              scope: 'workspace',
              producer: 'boundary-test',
              confidence: 1,
              freshness: 'current',
              reviewState: 'accepted',
              conflictStatus: 'none',
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            break;
          case 'conflict':
            store.recordKnowledgeConflict({
              id: 'kf_direct_write_symlink',
              workspaceId: workspace.id,
              subjectReferences: ['knowledge:boundary'],
              sourceReferences: [],
              status: 'needs_review',
              summary: 'A symlinked parent crosses the workspace boundary.',
              suggestedActions: ['Reject the write.'],
              producer: 'boundary-test',
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            break;
        }
      })
      .toThrow();

    expect(existsSync(join(outsideRoot, '202607.jsonl'))).toBe(false);
  });

  it.each([
    ['starts after sequence 1', [1, 2]],
    ['skips an intermediate sequence', [0, 2]],
  ] as const)('rejects a canonical event log that %s', (_case, retainedIndexes) => {
    const { dataRoot, store, workspace, workspaceRoot } = createFixture(
      'openkit-event-continuity-'
    );
    const thread = store.createThread(workspace.id, 'Event continuity thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Validate event continuity', {
      kind: 'user',
      id: 'user_local',
    });
    const item = store.createItem({
      id: `it_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: '',
      createdAt: turn.startedAt ?? timestamp,
      completedAt: null,
    });

    store.emitTurnEvent(turn.id, {
      event: 'turn.started',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'turn-started', turnId: turn.id, status: 'running' },
    });
    store.emitTurnEvent(turn.id, {
      event: 'item.created',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'item-created', item },
    });
    store.emitTurnEvent(turn.id, {
      event: 'item.delta',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: {
        type: 'item-delta',
        itemId: item.id,
        itemType: item.type,
        deltaKind: 'text-delta',
        delta: 'Event continuity.',
      },
    });

    const eventsPath = join(
      workspaceRoot,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'runtime',
      'events.jsonl'
    );
    const events = readFileSync(eventsPath, 'utf8').trim().split('\n');
    writeFileSync(eventsPath, `${retainedIndexes.map((index) => events[index]).join('\n')}\n`);

    expect(() => new FsStore({ dataRoot })).toThrow(/sequence/i);
  });
});

describe('canonical file durability failures', () => {
  it('preserves the prior backup manifest when file synchronization fails before publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-manifest-pre-sync-'));
    const path = join(root, 'manifest.json');
    writeStorageJsonAtomically(path, { revision: 1 });
    durability.events.length = 0;
    durability.fail = (candidate, directory) => !directory && dirname(candidate) === root;
    try {
      expect(() => writeStorageJsonAtomically(path, { revision: 2 })).toThrow();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ revision: 1 });
      expect(durability.events.some((event) => event.op === 'rename' && event.path === path)).toBe(
        false
      );
    } finally {
      durability.fail = undefined;
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('does not acknowledge a backup manifest when directory synchronization fails after rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-manifest-post-sync-'));
    const path = join(root, 'manifest.json');
    durability.events.length = 0;
    durability.fail = (candidate, directory) =>
      directory &&
      candidate === root &&
      durability.events.some((event) => event.op === 'rename' && event.path === path);
    try {
      expect(() => writeStorageJsonAtomically(path, { revision: 2 })).toThrow();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ revision: 2 });
    } finally {
      durability.fail = undefined;
      rmSync(root, { force: true, recursive: true });
    }
  });
});

/** Composes each single-file producer with its real disk reader after replacement. */
function durableFileFixture(kind: 'backup' | 'vault' | 'feedback') {
  const root = mkdtempSync(join(tmpdir(), `openkit-${kind}-durability-`));
  if (kind === 'feedback') {
    const store = new FsStore({ dataRoot: root });
    const workspace = store.createWorkspace('Feedback durability');
    const thread = store.createThread(workspace.id, 'Feedback');
    const turn = store.createTurn(workspace.id, thread.id, 'Durable feedback', {
      kind: 'user',
      id: 'user_local',
    });
    store.updateTurn(turn.id, { status: 'completed', completedAt: timestamp });
    const path = feedbackFilePath(store, store.getTurnById(turn.id));
    return {
      root,
      path,
      write: () => updateTurnFeedback(store, turn.id, { rating: 'good', note: 'retained' }),
      read: () => readTurnFeedback(new FsStore({ dataRoot: root }), turn.id).note,
      expected: 'retained',
    };
  }
  const path = join(root, 'manifest.json');
  const write = () =>
    kind === 'vault'
      ? writeEncryptedFileVaultJsonAtomically(path, { revision: 2 })
      : writeStorageJsonAtomically(path, { revision: 2 });
  if (kind === 'vault') writeEncryptedFileVaultJsonAtomically(path, { revision: 1 });
  else writeStorageJsonAtomically(path, { revision: 1 });
  return {
    root,
    path,
    write,
    read: () =>
      JSON.parse(kind === 'vault' ? readEncryptedFileVaultText(path) : readFileSync(path, 'utf8'))
        .revision,
    expected: 2,
  };
}

describe('single-file publication seam', () => {
  it.each([
    'backup',
    'vault',
    'feedback',
  ] as const)('syncs the %s bytes before rename and its exact parent afterward', (kind) => {
    const f = durableFileFixture(kind);
    durability.events.length = 0;
    try {
      f.write();
      const renameAt = durability.events.findIndex(
        (event) => event.op === 'rename' && event.path === f.path
      );
      expect(renameAt).toBeGreaterThan(0);
      const temporaryPath = durability.events[renameAt].from;
      expect(
        durability.events
          .slice(0, renameAt)
          .some((event) => event.op === 'sync' && !event.directory && event.path === temporaryPath)
      ).toBe(true);
      expect(
        durability.events
          .slice(renameAt + 1)
          .some((event) => event.op === 'sync' && event.directory && event.path === dirname(f.path))
      ).toBe(true);
      expect(f.read()).toBe(f.expected);
      if (kind === 'vault') expect(statSync(f.path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  });

  it.each([
    'vault',
    'feedback',
  ] as const)('preserves prior %s authority when its staged file sync fails', (kind) => {
    const f = durableFileFixture(kind);
    const before = readFileSync(f.path);
    durability.events.length = 0;
    durability.fail = (candidate, directory) =>
      !directory && dirname(candidate) === dirname(f.path);
    try {
      expect(f.write).toThrow(
        kind === 'vault' ? 'Encrypted-file vault file could not be written securely.' : undefined
      );
      expect(readFileSync(f.path)).toEqual(before);
      expect(
        durability.events.some((event) => event.op === 'rename' && event.path === f.path)
      ).toBe(false);
    } finally {
      durability.fail = undefined;
      rmSync(f.root, { force: true, recursive: true });
    }
  });

  it.each([
    'vault',
    'feedback',
  ] as const)('rejects %s success after its renamed parent sync fails and retains readable bytes', (kind) => {
    const f = durableFileFixture(kind);
    durability.events.length = 0;
    durability.fail = (candidate, directory) =>
      directory &&
      candidate === dirname(f.path) &&
      durability.events.some((event) => event.op === 'rename' && event.path === f.path);
    try {
      expect(f.write).toThrow(
        kind === 'vault' ? 'Encrypted-file vault file could not be written securely.' : undefined
      );
      durability.fail = undefined;
      expect(f.read()).toBe(f.expected);
    } finally {
      durability.fail = undefined;
      rmSync(f.root, { force: true, recursive: true });
    }
  });
});

describe('uncommitted ancestor recovery', () => {
  it.each([
    'flat',
    'nested',
  ] as const)('retries the failed ancestor synchronization for a %s manifest directory', (shape) => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-manifest-ancestor-retry-'));
    const directory = shape === 'flat' ? join(root, 'new') : join(root, 'new', 'nested');
    const path = join(directory, 'manifest.json');
    durability.events.length = 0;
    durability.fail = (candidate, isDirectory) => isDirectory && candidate === root;
    try {
      expect(() => writeStorageJsonAtomically(path, { revision: 1 })).toThrow(
        'Injected publication sync failure'
      );
      expect(existsSync(join(root, 'new'))).toBe(true);
      expect(existsSync(path)).toBe(false);
      // The nested case still lacks its immediate parent after the failed outer mkdir commit.
      if (shape === 'nested') expect(existsSync(directory)).toBe(false);
      durability.events.length = 0;
      expect(() => writeStorageJsonAtomically(path, { revision: 1 })).toThrow(
        'Injected publication sync failure'
      );
      expect(existsSync(path)).toBe(false);
      durability.events.length = 0;
      durability.fail = undefined;
      writeStorageJsonAtomically(path, { revision: 1 });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ revision: 1 });
      expect(
        durability.events.some(
          (event) => event.op === 'sync' && event.directory && event.path === root
        )
      ).toBe(true);
    } finally {
      durability.fail = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
