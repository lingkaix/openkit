// openkit-test-platform: posix
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsStore } from './store.js';

const fault = vi.hoisted(() => ({
  targetPath: '',
  targetDirectory: '',
  siblingPath: '',
  siblingDirectory: '',
  descriptors: new Map<number, string>(),
  events: [] as string[],
  committed: false,
  siblingRenames: 0,
  injections: 0,
  armed: false,
}));

// Fail ordinary sibling preparation only after the target's real durable publication succeeds.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      const descriptor = fs.openSync(...args);
      fault.descriptors.set(descriptor, String(args[0]));
      return descriptor;
    }) as typeof fs.openSync,
    closeSync: ((descriptor: number) => {
      try {
        return fs.closeSync(descriptor);
      } finally {
        fault.descriptors.delete(descriptor);
      }
    }) as typeof fs.closeSync,
    renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
      fs.renameSync(...args);
      if (fault.armed && String(args[1]) === fault.targetPath) fault.events.push('target renamed');
      if (fault.armed && String(args[1]) === fault.siblingPath) fault.siblingRenames++;
    }) as typeof fs.renameSync,
    fsyncSync: ((descriptor: number) => {
      const path = fault.descriptors.get(descriptor) ?? '';
      const directory = fs.fstatSync(descriptor).isDirectory();
      if (fault.armed && fault.committed && directory && path === fault.siblingDirectory) {
        fault.injections++;
        fault.events.push('sibling preparation refused');
        throw new Error('Injected later sibling directory preparation failure');
      }
      fs.fsyncSync(descriptor);
      if (!fault.armed) return;
      if (!directory && dirname(path) === fault.targetDirectory && path !== fault.targetPath)
        fault.events.push('target file synchronized');
      if (directory && path === fault.targetDirectory && fault.events.includes('target renamed')) {
        fault.committed = true;
        fault.events.push('target directory synchronized');
      }
    }) as typeof fs.fsyncSync,
  };
});

let dataRoot: string | undefined;
afterEach(() => {
  fault.armed = false;
  fault.targetPath = '';
  fault.targetDirectory = '';
  fault.siblingPath = '';
  fault.siblingDirectory = '';
  fault.events = [];
  fault.committed = false;
  fault.siblingRenames = 0;
  fault.injections = 0;
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  dataRoot = undefined;
});

describe('record publication before a later aggregate failure', () => {
  it('preserves an already committed Thread when a later sibling preparation fails', () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'store-late-publication-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Publication boundaries');
    const first = store.createThread(workspace.id, 'Original first Thread');
    const second = store.createThread(workspace.id, 'Second Thread');
    const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
    store.createTurn(workspace.id, first.id, 'First request', actor);
    store.createTurn(workspace.id, second.id, 'Second request', actor);
    const threadsRoot = join(dataRoot, 'workspaces', workspace.id, 'threads');
    fault.targetPath = join(threadsRoot, first.id, 'thread.json');
    fault.targetDirectory = dirname(fault.targetPath);
    fault.siblingPath = join(threadsRoot, second.id, 'thread.json');
    fault.siblingDirectory = dirname(fault.siblingPath);
    fault.armed = true;

    expect(() =>
      store.updateThread(workspace.id, first.id, { name: 'Durably committed first Thread' })
    ).toThrow();
    expect(fault.injections).toBe(1);
    expect(fault.siblingRenames).toBe(0);
    expect(fault.events.indexOf('target file synchronized')).toBeGreaterThanOrEqual(0);
    expect(fault.events.indexOf('target file synchronized')).toBeLessThan(
      fault.events.indexOf('target renamed')
    );
    expect(fault.events.indexOf('target renamed')).toBeLessThan(
      fault.events.indexOf('target directory synchronized')
    );
    expect(fault.events.indexOf('target directory synchronized')).toBeLessThan(
      fault.events.indexOf('sibling preparation refused')
    );
    const committedBytes = readFileSync(fault.targetPath, 'utf8');
    expect(JSON.parse(committedBytes).name).toBe('Durably committed first Thread');
    fault.armed = false;
    const committed = new FsStore({ dataRoot }).getThread(workspace.id, first.id);
    expect(committed.name).toBe('Durably committed first Thread');

    let current: ReturnType<FsStore['getThread']> | undefined;
    let readError: unknown;
    try {
      current = store.getThread(workspace.id, first.id);
    } catch (error) {
      readError = error;
    }
    // A truthful current record or an explicit refusal is permitted; stale successful reads are not.
    if (readError === undefined) expect.soft(current).toEqual(committed);
    else expect(readError).toBeInstanceOf(Error);

    try {
      store.updateWorkspace(workspace.id, { name: 'Unrelated Workspace update' });
    } catch {
      // Availability is not this oracle's decision. Refusal must preserve the committed target too.
    }
    expect.soft(readFileSync(fault.targetPath, 'utf8')).toBe(committedBytes);
    expect.soft(new FsStore({ dataRoot }).getThread(workspace.id, first.id)).toEqual(committed);
    expect(readFileSync(fault.targetPath, 'utf8')).toBe(committedBytes);
  });
});
