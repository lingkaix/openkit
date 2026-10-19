// openkit-test-platform: posix
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import {
  importAgentEnvironmentPackageSnapshots,
  recordAgentEnvironmentPackageSnapshot,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';

const fault = vi.hoisted(() => ({
  canonical: '',
  mode: '' as '' | 'partial' | 'file-sync' | 'directory-sync' | 'publish',
  race: '' as '' | 'same' | 'different',
  descriptors: new Map<number, string>(),
  events: [] as string[],
  injections: 0,
}));

// Only syscalls are intercepted. Publication and retained-record reads use their real owners.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const relevant = (path: string) =>
    fault.canonical !== '' &&
    path.slice(0, path.lastIndexOf('/')) ===
      fault.canonical.slice(0, fault.canonical.lastIndexOf('/'));
  return {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      fault.descriptors.set(fd, String(args[0]));
      return fd;
    }) as typeof fs.openSync,
    closeSync: ((fd: number) => {
      try {
        return fs.closeSync(fd);
      } finally {
        fault.descriptors.delete(fd);
      }
    }) as typeof fs.closeSync,
    writeFileSync: ((
      path: Parameters<typeof fs.writeFileSync>[0],
      bytes: Parameters<typeof fs.writeFileSync>[1],
      options: Parameters<typeof fs.writeFileSync>[2]
    ) => {
      const name = typeof path === 'number' ? (fault.descriptors.get(path) ?? '') : String(path);
      if (name === fault.canonical && fault.mode === 'publish') {
        fault.injections++;
        throw new Error('injected publication');
      }
      if (name === fault.canonical && fault.race) {
        fs.writeFileSync(
          path,
          fault.race === 'same' ? bytes : Buffer.from('a conflicting racing winner'),
          { flag: 'wx' }
        );
        fault.race = '';
      }
      if (fault.mode === 'partial' && relevant(name)) {
        fault.injections++;
        fs.writeFileSync(path, Buffer.from(bytes as string).subarray(0, 7), options);
        throw new Error('injected partial write');
      }
      return fs.writeFileSync(path, bytes, options);
    }) as typeof fs.writeFileSync,
    fsyncSync: ((fd: number) => {
      const name = fault.descriptors.get(fd) ?? '';
      if (relevant(name) && !fs.fstatSync(fd).isDirectory()) {
        fault.events.push('file-sync');
        if (fault.mode === 'file-sync') {
          fault.injections++;
          throw new Error('injected file sync');
        }
      } else if (
        name === fault.canonical.slice(0, fault.canonical.lastIndexOf('/')) &&
        fs.existsSync(fault.canonical)
      ) {
        fault.events.push('directory-sync');
        if (fault.mode === 'directory-sync') {
          fault.injections++;
          throw new Error('injected directory sync');
        }
      }
      return fs.fsyncSync(fd);
    }) as typeof fs.fsyncSync,
    linkSync: ((
      source: Parameters<typeof fs.linkSync>[0],
      target: Parameters<typeof fs.linkSync>[1]
    ) => {
      if (String(target) === fault.canonical) {
        fault.events.push('publish');
        if (fault.mode === 'publish') {
          fault.injections++;
          throw new Error('injected publication');
        }
        if (fault.race) {
          const bytes = fs.readFileSync(source);
          fs.writeFileSync(
            target,
            fault.race === 'same' ? bytes : Buffer.from('a conflicting racing winner'),
            { flag: 'wx' }
          );
          fault.race = '';
        }
      }
      return fs.linkSync(source, target);
    }) as typeof fs.linkSync,
    renameSync: ((
      source: Parameters<typeof fs.renameSync>[0],
      target: Parameters<typeof fs.renameSync>[1]
    ) => {
      if (String(target) === fault.canonical) {
        fault.events.push('publish');
        if (fault.mode === 'publish') {
          fault.injections++;
          throw new Error('injected publication');
        }
        if (fault.race) {
          const bytes = fs.readFileSync(source);
          fs.writeFileSync(
            target,
            fault.race === 'same' ? bytes : Buffer.from('a conflicting racing winner'),
            { flag: 'wx' }
          );
          fault.race = '';
        }
      }
      return fs.renameSync(source, target);
    }) as typeof fs.renameSync,
  };
});

/** Creates a safe redacted package with fixed, exact ownership. */
function createEnvironmentPackage(): AgentEnvironmentPackage {
  return AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agent: {
        id: 'agent_codex_host',
        name: 'Codex Agent',
        kind: 'coder',
        status: 'enabled',
        modelId: null,
        skillIds: [],
        profiles: [
          {
            id: 'default',
            displayName: 'Default',
            instructionsRef: null,
            modelId: null,
            skillIds: [],
            capabilityIds: [],
          },
        ],
        defaultProfileId: 'default',
        capabilities: [],
        sandboxSummary: null,
        config: {
          adapterType: 'codex',
          command: null,
          baseUrl: null,
          workspaceRoot: '/workspace',
          environment: {},
          capabilities: [],
        },
      },
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'as_00000000-0000-7b98-8803-ea4242ad797b',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      backend: {
        kind: 'openshell',
      },
      requestId: 'req_1',
      turn: {
        id: 'tu_00000000-0000-7b5c-9add-c4bfc5a04575',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201' },
        threadId: 'th_00000000-0000-7267-800d-a65e1b6a22d7',
        items: [],
        status: 'running',
        error: null,
        configVersion: null,
        startedAt: '2026-07-06T00:00:00.000Z',
        completedAt: null,
        durationMs: null,
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      },
      turnInput: 'Run tests',
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    })
  );
}

const roots: string[] = [];
afterEach(() => {
  fault.canonical = '';
  fault.mode = '';
  fault.race = '';
  fault.events = [];
  fault.injections = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Opens a real Workspace ledger and selects only its snapshot publication syscalls. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aep-publication-'));
  roots.push(root);
  const environmentPackage = createEnvironmentPackage();
  const db = openWorkspaceDb(root, environmentPackage.scope.workspaceId);
  applyScopedMigrations(db);
  fault.canonical = join(
    root,
    'workspaces',
    db.workspaceId,
    'runtime',
    'agent-sessions',
    environmentPackage.scope.agentSessionId,
    'aep-snapshots',
    `${environmentPackage.snapshotId}.json`
  );
  const input = { environmentPackage, createdAt: '2026-07-06T00:00:01.000Z' };
  return {
    db,
    input,
    path: fault.canonical,
    write: () => recordAgentEnvironmentPackageSnapshot(db, input),
  };
}

describe('durable AEP snapshot publication', () => {
  it('synchronizes complete bytes before publication and the directory before success', () => {
    const f = fixture();
    try {
      const record = f.write();
      expect(
        requireAgentEnvironmentPackageSnapshot(f.db, f.db.workspaceId, record.snapshotId)
      ).toMatchObject(record);
      expect(fault.events.indexOf('file-sync')).toBeGreaterThanOrEqual(0);
      expect(fault.events.indexOf('file-sync')).toBeLessThan(fault.events.indexOf('publish'));
      expect(fault.events.lastIndexOf('directory-sync')).toBeGreaterThan(
        fault.events.indexOf('publish')
      );
      const accepted = readFileSync(f.path);
      expect(f.write()).toMatchObject(record);
      expect(readFileSync(f.path)).toEqual(accepted);
      expect(() =>
        recordAgentEnvironmentPackageSnapshot(f.db, {
          ...f.input,
          environmentPackage: AgentEnvironmentPackageSchema.parse({
            ...f.input.environmentPackage,
            scope: { ...f.input.environmentPackage.scope, requestId: 'conflicting-request' },
          }),
        })
      ).toThrow();
      expect(readFileSync(f.path)).toEqual(accepted);
    } finally {
      f.db.sqlite.close();
    }
  });

  it('replays exact retained bytes and refuses a changed immutable record', () => {
    const f = fixture();
    try {
      const record = f.write();
      const bytes = readFileSync(f.path);
      expect(f.write()).toMatchObject(record);
      expect(() =>
        recordAgentEnvironmentPackageSnapshot(f.db, {
          ...f.input,
          environmentPackage: AgentEnvironmentPackageSchema.parse({
            ...f.input.environmentPackage,
            scope: { ...f.input.environmentPackage.scope, requestId: 'conflicting-request' },
          }),
        })
      ).toThrow();
      expect(readFileSync(f.path)).toEqual(bytes);
      expect(
        requireAgentEnvironmentPackageSnapshot(f.db, f.db.workspaceId, record.snapshotId)
      ).toMatchObject(record);
    } finally {
      f.db.sqlite.close();
    }
  });

  it.each([
    'partial',
    'file-sync',
    'publish',
  ] as const)('propagates %s failure without a canonical snapshot', (mode) => {
    const f = fixture();
    try {
      fault.mode = mode;
      expect(() => f.write()).toThrow(/injected/);
      expect(fault.injections).toBe(1);
      expect(existsSync(f.path)).toBe(false);
      expect(() =>
        requireAgentEnvironmentPackageSnapshot(
          f.db,
          f.db.workspaceId,
          f.input.environmentPackage.snapshotId
        )
      ).toThrow(/not found/);
      fault.mode = '';
      expect(f.write().snapshotId).toBe(f.input.environmentPackage.snapshotId);
    } finally {
      f.db.sqlite.close();
    }
  });

  it('refuses directory-sync failure and retries synchronization for identical complete bytes', () => {
    const f = fixture();
    try {
      fault.mode = 'directory-sync';
      expect(() => f.write()).toThrow('injected directory sync');
      const complete = readFileSync(f.path);
      expect(() => f.write()).toThrow('injected directory sync');
      expect(readFileSync(f.path)).toEqual(complete);
      fault.mode = '';
      expect(f.write().snapshotId).toBe(f.input.environmentPackage.snapshotId);
      expect(readFileSync(f.path)).toEqual(complete);
    } finally {
      f.db.sqlite.close();
    }
  });

  it.each(['same', 'different'] as const)('preserves a %s racing immutable winner', (race) => {
    const f = fixture();
    try {
      fault.race = race;
      if (race === 'same') {
        const record = f.write();
        expect(fault.race).toBe('');
        expect(
          requireAgentEnvironmentPackageSnapshot(f.db, f.db.workspaceId, record.snapshotId)
        ).toMatchObject(record);
        expect(fault.events.indexOf('file-sync')).toBeGreaterThanOrEqual(0);
        expect(fault.events.indexOf('file-sync')).toBeLessThan(fault.events.indexOf('publish'));
        expect(fault.events.lastIndexOf('directory-sync')).toBeGreaterThan(
          fault.events.indexOf('publish')
        );
      } else {
        expect(() => f.write()).toThrow();
        expect(readFileSync(f.path, 'utf8')).toBe('a conflicting racing winner');
      }
    } finally {
      f.db.sqlite.close();
    }
  });

  it('uses the same durable publication boundary for imported snapshots', () => {
    const f = fixture();
    try {
      const record = f.write();
      rmSync(f.path);
      fault.events = [];
      fault.mode = 'file-sync';
      expect(() => importAgentEnvironmentPackageSnapshots(f.db, [record])).toThrow(
        'injected file sync'
      );
      expect(existsSync(f.path)).toBe(false);
      fault.mode = '';
      importAgentEnvironmentPackageSnapshots(f.db, [record]);
      expect(
        requireAgentEnvironmentPackageSnapshot(f.db, f.db.workspaceId, record.snapshotId)
      ).toMatchObject(record);
    } finally {
      f.db.sqlite.close();
    }
  });
});
