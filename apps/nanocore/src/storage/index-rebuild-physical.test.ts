// openkit-test-platform: posix
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { disposeTestStore } from '../test-support/store.js';
import { readTestWorkspaceNotebookSelection } from '../test-support/workspace-notebook.js';
import { rebuildWorkspaceDerivedIndexes } from './index-rebuild.js';

const effect = vi.hoisted(() => ({
  root: '',
  removePath: '',
  writePath: '',
  failure: undefined as Error | undefined,
}));

// The NanoCore producer and Storage consumer stay real. Fault only the selected native effect.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync(...args: Parameters<typeof actual.readdirSync>) {
      const entries = actual.readdirSync(...args);
      if (
        String(args[0]) === effect.root &&
        args[1] &&
        typeof args[1] === 'object' &&
        args[1].withFileTypes
      ) {
        return [...entries].sort((left, right) =>
          String(left.name) < String(right.name) ? 1 : -1
        );
      }
      return entries;
    },
    rmSync(...args: Parameters<typeof actual.rmSync>) {
      if (String(args[0]) === effect.removePath) throw effect.failure;
      return actual.rmSync(...args);
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      if (String(args[0]) === effect.writePath) {
        actual.writeFileSync(args[0], Buffer.from('partial native output\0\r\n'));
        throw effect.failure;
      }
      return actual.writeFileSync(...args);
    },
  };
});

const roots: string[] = [];
const rebuiltAt = '2026-07-05T00:00:00.000Z';
const sentinel = Buffer.from([0, 255, 128, 13, 10]);
const outputs = [
  { name: 'knowledge-links.json', collection: 'edges' },
  { name: 'knowledge-validation.json', collection: 'records' },
  { name: 'knowledge-source-refs.json', collection: 'references' },
] as const;

afterEach(async () => {
  vi.restoreAllMocks();
  effect.root = '';
  effect.removePath = '';
  effect.writePath = '';
  effect.failure = undefined;
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

/** Publish a real empty Notebook through the owner before injecting disposable index faults. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'nanocore-derived-index-physical-'));
  roots.push(dataRoot);
  await createDemoStore({ dataRoot, knowledge: [] });
  const revision = readTestWorkspaceNotebookSelection(dataRoot, DEMO_WORKSPACE_ID).head
    .notebookCommit;
  const root = join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'indexes');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'retrieval', 'generation'), { recursive: true });
  writeFileSync(join(root, 'retrieval', 'generation', 'CURRENT'), sentinel);
  for (const name of ['z-stale', 'm-stale', 'a-stale']) writeFileSync(join(root, name), sentinel);
  effect.root = root;
  return { dataRoot, root, revision };
}

/** The authorized Row23 MOVE preserves the existing envelope order, formatting and newline. */
function expectedBytes(revision: string, collection: string): Buffer {
  return Buffer.from(
    [
      '{',
      `  "notebookRevision": "${revision}",`,
      '  "schemaVersion": 1,',
      `  "workspaceId": "${DEMO_WORKSPACE_ID}",`,
      `  "rebuiltAt": "${rebuiltAt}",`,
      `  "${collection}": []`,
      '}',
      '',
    ].join('\n')
  );
}

/** Capture exact native or serialization failure identity at the real public rebuild boundary. */
function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the Workspace derived-index rebuild to fail.');
}

/** Check the entire surviving direct inventory and the independently retained retrieval bytes. */
function expectResidue(root: string, names: readonly string[]) {
  expect(readdirSync(root).sort()).toEqual([...names, 'retrieval'].sort());
  expect(readFileSync(join(root, 'retrieval', 'generation', 'CURRENT'))).toEqual(sentinel);
  expect(readdirSync(join(root, 'retrieval'))).toEqual(['generation']);
  expect(readdirSync(join(root, 'retrieval', 'generation'))).toEqual(['CURRENT']);
}

// L2 composes the real NanoCore index producer and Storage byte consumer in process.
// Core Storage keeps these indexes rebuildable; the Row23 MOVE requires unchanged failure prefixes.
describe('Workspace derived-index physical crossing', () => {
  it('writes exact three-family bytes with one clock read and keeps retrieval intact', async () => {
    const { dataRoot, root, revision } = await fixture();
    const now = vi.fn(() => rebuiltAt);

    const result = rebuildWorkspaceDerivedIndexes({
      dataRoot,
      workspaceId: DEMO_WORKSPACE_ID,
      now,
    });

    expect(result).toEqual({
      workspaceId: DEMO_WORKSPACE_ID,
      indexPath: `workspaces/${DEMO_WORKSPACE_ID}/indexes/knowledge-validation.json`,
      itemCount: 0,
      removedEntries: ['a-stale', 'm-stale', 'z-stale'],
    });
    expect(now).toHaveBeenCalledTimes(1);
    expectResidue(
      root,
      outputs.map(({ name }) => name)
    );
    for (const { name, collection } of outputs)
      expect(readFileSync(join(root, name))).toEqual(expectedBytes(revision, collection));
  });

  it.each(outputs.map((output, index) => ({ ...output, index })))(
    'retains the original write prefix when $name fails after a native partial write',
    async ({ name, index }) => {
      const { dataRoot, root, revision } = await fixture();
      effect.writePath = join(root, name);
      effect.failure = new Error(`injected partial write of ${name}`);

      expect(
        caught(() =>
          rebuildWorkspaceDerivedIndexes({
            dataRoot,
            workspaceId: DEMO_WORKSPACE_ID,
            now: () => rebuiltAt,
          })
        )
      ).toBe(effect.failure);

      expectResidue(
        root,
        outputs.slice(0, index + 1).map((output) => output.name)
      );
      for (const output of outputs.slice(0, index))
        expect(readFileSync(join(root, output.name))).toEqual(
          expectedBytes(revision, output.collection)
        );
      expect(readFileSync(join(root, name))).toEqual(Buffer.from('partial native output\0\r\n'));
    }
  );

  it.each(outputs.map((output, index) => ({ ...output, index })))(
    'clears first and retains earlier writes when serializing $name fails',
    async ({ collection, index }) => {
      const { dataRoot, root, revision } = await fixture();
      const failure = new Error(`injected ${collection} serialization refusal`);
      const stringify = JSON.stringify;
      let intercepted = 0;
      // Install after real publication and recognize only this rebuild's unique domain envelope.
      vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
        if (
          value !== null &&
          typeof value === 'object' &&
          value.workspaceId === DEMO_WORKSPACE_ID &&
          value.rebuiltAt === rebuiltAt &&
          Object.hasOwn(value, collection)
        ) {
          intercepted++;
          throw failure;
        }
        return stringify(value, replacer, space);
      });

      expect(
        caught(() =>
          rebuildWorkspaceDerivedIndexes({
            dataRoot,
            workspaceId: DEMO_WORKSPACE_ID,
            now: () => rebuiltAt,
          })
        )
      ).toBe(failure);

      expect(intercepted).toBe(1);
      expectResidue(
        root,
        outputs.slice(0, index).map((output) => output.name)
      );
      for (const output of outputs.slice(0, index))
        expect(readFileSync(join(root, output.name))).toEqual(
          expectedBytes(revision, output.collection)
        );
    }
  );

  it('does not write any output after a middle sorted deletion fails', async () => {
    const { dataRoot, root } = await fixture();
    effect.removePath = join(root, 'm-stale');
    effect.failure = new Error('injected middle index deletion refusal');

    expect(
      caught(() =>
        rebuildWorkspaceDerivedIndexes({
          dataRoot,
          workspaceId: DEMO_WORKSPACE_ID,
          now: () => rebuiltAt,
        })
      )
    ).toBe(effect.failure);

    expectResidue(root, ['m-stale', 'z-stale']);
    for (const name of ['m-stale', 'z-stale'])
      expect(readFileSync(join(root, name))).toEqual(sentinel);
  });

  it('refuses a direct retrieval link before deleting stale bytes or writing an output', async () => {
    const { dataRoot, root } = await fixture();
    const outside = join(dataRoot, 'outside-index-sentinel');
    writeFileSync(outside, sentinel);
    rmSync(join(root, 'retrieval'), { recursive: true });
    symlinkSync(outside, join(root, 'retrieval'));

    expect(() =>
      rebuildWorkspaceDerivedIndexes({
        dataRoot,
        workspaceId: DEMO_WORKSPACE_ID,
        now: () => rebuiltAt,
      })
    ).toThrow(`Canonical directory must not contain a symbolic link: ${join(root, 'retrieval')}.`);

    expect(readdirSync(root).sort()).toEqual(['a-stale', 'm-stale', 'retrieval', 'z-stale']);
    expect(lstatSync(join(root, 'retrieval')).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside)).toEqual(sentinel);
    for (const name of ['a-stale', 'm-stale', 'z-stale'])
      expect(readFileSync(join(root, name))).toEqual(sentinel);
  });

  it('leaves every existing index byte untouched when the original clock throws', async () => {
    const { dataRoot, root } = await fixture();
    const failure = new Error('injected clock refusal');
    const now = vi.fn(() => {
      throw failure;
    });

    expect(
      caught(() =>
        rebuildWorkspaceDerivedIndexes({ dataRoot, workspaceId: DEMO_WORKSPACE_ID, now })
      )
    ).toBe(failure);

    expect(now).toHaveBeenCalledTimes(1);
    expectResidue(root, ['a-stale', 'm-stale', 'z-stale']);
    for (const name of ['a-stale', 'm-stale', 'z-stale'])
      expect(readFileSync(join(root, name))).toEqual(sentinel);
    for (const { name } of outputs) expect(existsSync(join(root, name))).toBe(false);
  });
});
