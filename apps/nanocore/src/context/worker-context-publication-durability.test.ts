// openkit-test-platform: posix
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import {
  buildWorkerContextPackageWorkspaceInput,
  createWorkerContextPackageFiles,
  createWorkerContextPackagePolicyDigest,
  createWorkerContextPackageTrace,
  readWorkerContextPackageTrace,
  type WorkerContextPackageAuthorityReader,
  writeWorkerContextPackageFiles,
  writeWorkerContextPackageTrace,
} from './worker-context-package.js';

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
    writeSync: ((
      fd: number,
      bytes: Uint8Array,
      offset?: number,
      length?: number,
      position?: number
    ) => {
      const name = fault.descriptors.get(fd) ?? '';
      if (fault.mode === 'partial' && relevant(name)) {
        fault.injections++;
        fs.writeSync(fd, bytes, offset ?? 0, Math.min(length ?? bytes.byteLength, 7), position);
        throw new Error('injected partial write');
      }
      return fs.writeSync(fd, bytes, offset, length, position);
    }) as typeof fs.writeSync,
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

const roots: string[] = [];
afterEach(() => {
  fault.canonical = '';
  fault.mode = '';
  fault.race = '';
  fault.events = [];
  fault.injections = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const threadId = 'th_00000000-0000-7000-8000-000000000001';
const turnId = 'tu_00000000-0000-7000-8000-000000000001';
const itemId = 'it_00000000-0000-7000-8000-000000000001';
const agentSessionId = 'as_00000000-0000-7000-8000-000000000001';
const startedAt = '2026-07-18T00:00:00.000Z';
const requestId = 'publication-request';

/** Supplies a complete bounded request without unrelated Material or Knowledge owners. */
function packageInput() {
  const workerRequestBytes = serializeStructuredWorkerDelegationRequest(
    createStructuredWorkerDelegationRequest({
      objective: 'Verify durable publication.',
      acceptanceCriteria: ['Retain exact bytes.'],
      constraints: { maxContextTokens: 4096, maxWorkerIterations: 1 },
      contextRefs: [{ kind: 'workspace', id: workspaceId }],
      escalationConditions: [],
      expectedArtifacts: [],
      resources: [],
      reviewContext: null,
      reviewPolicy: {
        required: false,
        reviewers: ['human'],
        instructions: 'Check retained bytes.',
      },
      verification: [{ kind: 'command', command: 'test', description: 'Check the result.' }],
    })
  );
  return {
    workspaceId,
    threadId,
    turnId,
    workerRequestItemId: itemId,
    workerRequestBytes,
    includedItemIds: [itemId],
    contextBudgetTokens: 4096,
    materialSelections: [],
  };
}

/** Creates the real package and the exact fixed authorities required by its public trace verifier. */
async function fixture() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'context-publication-'));
  roots.push(workspaceRoot);
  const input = packageInput();
  const packageFiles = createWorkerContextPackageFiles(input);
  await writeWorkerContextPackageFiles(workspaceRoot, packageFiles, {
    admission: new FileStorageAdmission(workspaceRoot, () => 0n),
  });
  const turn = {
    id: turnId,
    owner: { kind: 'workspace' as const, workspaceId },
    threadId,
    agentSessionId,
    items: [],
    status: 'running',
    error: null,
    configVersion: null,
    startedAt,
    completedAt: null,
    durationMs: null,
    triggerActor: actor,
  };
  const unresolved = resolveAgentEnvironmentPackage({
    captureCoverage: { scope: 'server', value: 'off' },
    agentSessionId,
    agentSetup: createTestAgentSetup(),
    triggerActor: actor,
    backend: { kind: 'openshell' },
    requestId,
    turn,
    turnInput: input.workerRequestBytes,
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });
  const contextInput = buildWorkerContextPackageWorkspaceInput({
    agentSessionId,
    packageRootDigest: packageFiles.packageRootDigest,
    threadId,
    turnId,
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse({
    ...unresolved,
    scope: { ...unresolved.scope, itemId },
    workspace: { ...unresolved.workspace, inputs: [contextInput] },
  });
  const trace = createWorkerContextPackageTrace({
    agentSessionId,
    excludedItems: [],
    goalId: 'goal_publication',
    taskId: 'task_publication',
    packageFiles,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId,
    materialExclusions: [],
    knowledgeExclusions: [],
    knowledgeSelectionInput: null,
  });
  const readinessEvidence = [
    { kind: 'backend.ready', ref: 'version:0.0.80' },
    { kind: 'sandbox.created', ref: 'sandbox_publication' },
  ];
  const snapshot = {
    backend: {
      capabilitySummary: [...environmentPackage.backend.requiredCapabilities],
      kind: 'openshell',
      label: 'openshell worker backend',
    },
    base: { commit: null, contentDigest: packageFiles.packageRootDigest },
    createdAt: startedAt,
    generatedFiles: [],
    id: trace.workspaceInputSnapshotId,
    ignoredPaths: [],
    pathScope: [`context_${turnId}`],
    resourceId: `context_${turnId}`,
    resourceKind: 'filesystem',
    strategy: 'filesystem',
    workspaceId,
    writableRoots: [],
  };
  const materialization = {
    backendKind: 'openshell',
    base: snapshot.base,
    createdAt: startedAt,
    id: trace.workspaceMaterializationRecordId,
    inputSnapshotId: snapshot.id,
    materializedRootRef: contextInput.target,
    packageSnapshotId: environmentPackage.snapshotId,
    policyDigest: createWorkerContextPackagePolicyDigest({
      backendKind: 'openshell',
      packageSnapshotId: environmentPackage.snapshotId,
      requiredCapabilities: environmentPackage.backend.requiredCapabilities,
    }),
    readinessEvidence,
    strategy: 'filesystem',
    workerSessionId: 'sandbox_publication',
    workspaceId,
  };
  const authorities: WorkerContextPackageAuthorityReader = {
    readAdmission: () => ({ workspaceId, threadId, turnId, requestId, status: 'admitted' }),
    readAgentEnvironmentPackage: () => environmentPackage,
    readAgentSession: () => ({
      id: agentSessionId,
      workspaceId,
      threadId,
      environmentPackageSnapshotId: environmentPackage.snapshotId,
      stale: false,
    }),
    readBackendHandoff: () => ({
      workspaceId,
      threadId,
      turnId,
      agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      backendKind: 'openshell',
      backendSessionId: 'sandbox_publication',
      workspaceHandoffState: 'complete',
      readinessEvidence,
    }),
    readMaterialRevision: () => null,
    readThreadItems: () => [
      {
        id: itemId,
        owner: { kind: 'workspace', workspaceId },
        threadId,
        turnId,
        type: 'user-message',
        status: 'completed',
        text: input.workerRequestBytes,
      },
    ],
    readThreadParent: () => null,
    readTurn: () => turn,
    readWorkspaceInputSnapshot: () => snapshot,
    readWorkspaceImportedFrom: () => null,
    readWorkspaceMaterializationRecord: () => materialization,
  };
  fault.canonical = join(
    workspaceRoot,
    'threads',
    threadId,
    'turns',
    turnId,
    'context-package.json'
  );
  return {
    workspaceRoot,
    packageFiles,
    trace,
    authorities,
    path: fault.canonical,
    write: () => writeWorkerContextPackageTrace({ workspaceRoot, trace, authorities }),
    read: () =>
      readWorkerContextPackageTrace({ workspaceRoot, workspaceId, threadId, turnId, authorities }),
  };
}

describe('durable Context Package trace publication', () => {
  it('synchronizes complete trace bytes before publication and the directory before success', async () => {
    const f = await fixture();
    expect(f.write()).toEqual(f.trace);
    expect(f.read()).toEqual(f.trace);
    expect(fault.events.indexOf('file-sync')).toBeGreaterThanOrEqual(0);
    expect(fault.events.indexOf('file-sync')).toBeLessThan(fault.events.indexOf('publish'));
    expect(fault.events.lastIndexOf('directory-sync')).toBeGreaterThan(
      fault.events.indexOf('publish')
    );
    const bytes = readFileSync(f.path);
    expect(f.write()).toEqual(f.trace);
    expect(readFileSync(f.path)).toEqual(bytes);
  });

  it('replays an accepted trace with identical bytes and the real retained reader', async () => {
    const f = await fixture();
    const accepted = f.write();
    const bytes = readFileSync(f.path);
    expect(f.write()).toEqual(accepted);
    expect(f.read()).toEqual(accepted);
    expect(readFileSync(f.path)).toEqual(bytes);
  });

  it.each([
    'partial',
    'file-sync',
    'publish',
  ] as const)('propagates %s failure without a canonical trace', async (mode) => {
    const f = await fixture();
    fault.mode = mode;
    expect(() => f.write()).toThrow(/injected/);
    expect(fault.injections).toBe(1);
    expect(existsSync(f.path)).toBe(false);
    expect(() => f.read()).toThrow(/unavailable/);
    fault.mode = '';
    expect(f.write()).toEqual(f.trace);
    expect(f.read()).toEqual(f.trace);
  });

  it('refuses directory-sync failure and retries synchronization for complete identical bytes', async () => {
    const f = await fixture();
    fault.mode = 'directory-sync';
    expect(() => f.write()).toThrow('injected directory sync');
    const complete = readFileSync(f.path);
    expect(() => f.write()).toThrow('injected directory sync');
    expect(readFileSync(f.path)).toEqual(complete);
    fault.mode = '';
    expect(f.write()).toEqual(f.trace);
    expect(f.read()).toEqual(f.trace);
  });

  it.each([
    'same',
    'different',
  ] as const)('preserves a %s racing immutable winner', async (race) => {
    const f = await fixture();
    fault.race = race;
    if (race === 'same') {
      expect(f.write()).toEqual(f.trace);
      expect(fault.race).toBe('');
      expect(f.read()).toEqual(f.trace);
      expect(fault.events.indexOf('file-sync')).toBeGreaterThanOrEqual(0);
      expect(fault.events.indexOf('file-sync')).toBeLessThan(fault.events.indexOf('publish'));
      expect(fault.events.lastIndexOf('directory-sync')).toBeGreaterThan(
        fault.events.indexOf('publish')
      );
    } else {
      expect(() => f.write()).toThrow();
      expect(readFileSync(f.path, 'utf8')).toBe('a conflicting racing winner');
    }
  });

  it('rejects conflicting retained bytes without replacing their immutable identity', async () => {
    const f = await fixture();
    writeFileSync(f.path, 'conflicting retained bytes', { flag: 'wx' });
    expect(() => f.write()).toThrow(/conflict/);
    expect(readFileSync(f.path, 'utf8')).toBe('conflicting retained bytes');
  });
});

describe('uncommitted native Context Package files', () => {
  it('can retry after abrupt death during a partial file write before package.json exists', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'context-abrupt-publication-'));
    roots.push(workspaceRoot);
    const input = packageInput();
    // End the child inside the real syscall boundary. Catch/finally cleanup cannot run.
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const { workspaceRoot, input } = JSON.parse(fs.readFileSync(0, 'utf8'));
      const descriptors = new Map();
      const open = fs.openSync;
      const write = fs.writeSync;
      const writeFile = fs.writeFileSync;
      fs.openSync = (...args) => { const fd = open(...args); descriptors.set(fd, String(args[0])); return fd; };
      fs.writeSync = (fd, bytes, offset, length, position) => {
        if ((descriptors.get(fd) ?? '').includes('instructions.md')) {
          write(fd, bytes, offset ?? 0, Math.min(length ?? bytes.byteLength, 7), position);
          process.exit(77);
        }
        return write(fd, bytes, offset, length, position);
      };
      fs.writeFileSync = (file, bytes, options) => {
        const path = typeof file === 'number' ? descriptors.get(file) ?? '' : String(file);
        if (path.includes('instructions.md')) { writeFile(file, Buffer.from(bytes).subarray(0, 7), options); process.exit(77); }
        return writeFile(file, bytes, options);
      };
      syncBuiltinESMExports();
      const { createWorkerContextPackageFiles, writeWorkerContextPackageFiles } = await import(${JSON.stringify(new URL('./worker-context-package.ts', import.meta.url).href)});
      const { FileStorageAdmission } = await import(${JSON.stringify(new URL('../storage/artifacts/file-admission.ts', import.meta.url).href)});
      await writeWorkerContextPackageFiles(workspaceRoot, createWorkerContextPackageFiles(input), { admission: new FileStorageAdmission(workspaceRoot, () => 0n) });
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { input: JSON.stringify({ workspaceRoot, input }), encoding: 'utf8', timeout: 20_000 }
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(77);
    const turnRoot = join(workspaceRoot, 'threads', threadId, 'turns', turnId);
    expect(existsSync(join(turnRoot, 'context-package.json'))).toBe(false);
    expect(existsSync(join(turnRoot, 'context-package', 'package.json'))).toBe(false);
    const files = createWorkerContextPackageFiles(input);
    await expect(
      writeWorkerContextPackageFiles(workspaceRoot, files, {
        admission: new FileStorageAdmission(workspaceRoot, () => 0n),
      })
    ).resolves.toBeUndefined();
    for (const file of files.files)
      expect(readFileSync(join(turnRoot, 'context-package', file.path))).toEqual(
        Buffer.from(file.bytes)
      );
  });
});
