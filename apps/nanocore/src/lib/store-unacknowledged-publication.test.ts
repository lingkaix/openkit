// openkit-test-platform: posix
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestStore } from '../test-support/store.js';
import { FsStore } from './store.js';

const fault = vi.hoisted(() => ({
  canonicalPath: '',
  directoryPath: '',
  descriptors: new Map<number, string>(),
  renamed: false,
  injections: 0,
  armed: false,
}));

// Intercept only the acknowledgement syscall after the real canonical rename succeeds.
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
      if (fault.armed && String(args[1]) === fault.canonicalPath) fault.renamed = true;
    }) as typeof fs.renameSync,
    fsyncSync: ((descriptor: number) => {
      if (
        fault.armed &&
        fault.renamed &&
        fault.descriptors.get(descriptor) === fault.directoryPath &&
        fs.fstatSync(descriptor).isDirectory()
      ) {
        fault.injections++;
        throw new Error('Injected Thread parent synchronization failure');
      }
      fs.fsyncSync(descriptor);
    }) as typeof fs.fsyncSync,
  };
});

let dataRoot: string | undefined;
afterEach(() => {
  fault.armed = false;
  fault.canonicalPath = '';
  fault.directoryPath = '';
  fault.renamed = false;
  fault.injections = 0;
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  dataRoot = undefined;
});

describe('unacknowledged canonical Thread publication', () => {
  it('preserves the visible candidate during later unrelated Workspace persistence', () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'store-unacknowledged-publication-'));
    const store = createTestStore({ dataRoot });
    const workspace = store.createWorkspace('Initial Workspace');
    const previousThread = store.createThread(workspace.id, 'Previous Thread');
    const path = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      previousThread.id,
      'thread.json'
    );
    const previousBytes = readFileSync(path, 'utf8');
    fault.canonicalPath = path;
    fault.directoryPath = dirname(path);
    fault.armed = true;

    expect(() =>
      store.updateThread(workspace.id, previousThread.id, { name: 'Visible unacknowledged Thread' })
    ).toThrow('Injected Thread parent synchronization failure');
    expect(fault.renamed).toBe(true);
    expect(fault.injections).toBe(1);
    const candidateBytes = readFileSync(path, 'utf8');
    expect(candidateBytes).not.toBe(previousBytes);
    expect(JSON.parse(candidateBytes).name).toBe('Visible unacknowledged Thread');
    const cachedThreads = (store as unknown as { threads: Map<string, typeof previousThread> })
      .threads;
    expect(cachedThreads.get(previousThread.id)).toEqual(previousThread);
    let readFailure: unknown;
    try {
      store.getThread(workspace.id, previousThread.id);
    } catch (error) {
      readFailure = error;
    }
    expect(readFailure).toMatchObject({ code: 'recovery_required' });
    for (const diagnostic of [
      /FsStore/,
      /directory sync(?:hroni[sz]ation)?/i,
      /after rename/i,
      /publication[ -]acknowledg(?:e)?ment/i,
    ]) {
      expect(readFailure).toHaveProperty('message', expect.stringMatching(diagnostic));
    }
    fault.armed = false;

    // Core Storage and Fault Tolerance require preservation of the uncertain publication.
    // Availability is a separate decision: either success or a surfaced refusal is permitted here.
    try {
      store.updateWorkspace(workspace.id, { name: 'Unrelated Workspace update' });
    } catch {
      // A refusal must still preserve the complete canonical candidate for inspection and reopen.
    }

    expect.soft(readFileSync(path, 'utf8')).toBe(candidateBytes);
    const reopened = new FsStore({ dataRoot });
    expect
      .soft(reopened.getThread(workspace.id, previousThread.id).name)
      .toBe('Visible unacknowledged Thread');
    expect(readFileSync(path, 'utf8')).toBe(candidateBytes);
  });
});
