// openkit-test-platform: posix
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { WorkspaceSnapshotReportSchema } from '@openkit/app-api-schemas';
import { ApiErrorSchema, allocateEntityId } from '@openkit/protocol';
import * as durableBytes from '@openkit/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import * as captureProtection from './storage/workspace-capture-protection.js';
import { type CreateAppOptions, createAppWithLocalIdentity } from './test-support/app.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb } from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const roots: string[] = [];
const workspaceId = DEMO_WORKSPACE_ID;

/** Calls the frozen App API wire contract without deriving a path from candidate composition. */
async function request(
  app: ReturnType<typeof createAppWithLocalIdentity>,
  operation: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
) {
  const { requestId, ...body } = input;
  return app.request(`/api/app/operations/${operation}`, {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers: {
      'content-type': 'application/json',
      ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Builds real local authority and a native Workspace; no credential or durable row is fabricated. */
async function fixture(
  mode: 'local' | 'server' = 'local',
  releaseIdentity: CreateAppOptions['releaseIdentity'] = {
    releaseTag: 'v0.1.0-rc.11',
    sourceCommit: '1'.repeat(40),
  }
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'c-a-operations-'));
  roots.push(dataRoot);
  const store = await createDemoStore({ dataRoot });
  const coreDb = createTestCoreDb(dataRoot);
  const ownerId = ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: ownerId });
  const admission = new WorkspaceMutationAdmission();
  const fileAdmission = new FileStorageAdmission(dataRoot, () => 0n);
  const appOptions = {
    mode,
    dataRoot,
    store,
    coreDb,
    workspaceMutationAdmission: admission,
    turnExecutor: new SimulatedTurnExecutor(),
    fileAdmission,
    releaseIdentity,
  };
  const app = createAppWithLocalIdentity(appOptions);
  return { dataRoot, store, coreDb, ownerId, admission, fileAdmission, appOptions, app };
}

/** Reads standard USTAR entries independently; only exact payload bytes decide the bundle oracle. */
function archiveFiles(compressed: Buffer): Map<string, Buffer> {
  const tar = zstdDecompressSync(compressed);
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(text(124, 12).trim(), 8);
    expect(Number.isSafeInteger(size)).toBe(true);
    expect(size).toBeGreaterThanOrEqual(0);
    const kind = text(156, 1);
    if (kind === '5') {
      expect(size).toBe(0);
      offset += 512;
      continue;
    }
    expect(files.has(name)).toBe(false);
    expect(['', '0']).toContain(kind);
    files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('C-a composed snapshot App API', () => {
  it('refuses unknown installed identity before capture or source admission without changing retained facts', async () => {
    const f = await fixture();
    try {
      const backupId = allocateEntityId('wsbak');
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      expect(captured.status, await captured.clone().text()).toBe(200);
      const original = WorkspaceSnapshotReportSchema.parse(await captured.json());
      const unknown = createAppWithLocalIdentity({
        ...f.appOptions,
        releaseIdentity: { releaseTag: null, sourceCommit: null },
      });
      const freeze = vi.spyOn(f.admission, 'tryFreeze');
      const pin = vi.spyOn(captureProtection, 'protectCapture');
      const reserve = vi.spyOn(f.fileAdmission, 'reserve');
      const retainedState = () =>
        Object.fromEntries(
          readdirSync(f.dataRoot, { recursive: true, withFileTypes: true })
            // SQLite's shared read marks are not independent durable authority.
            .filter((entry) => !entry.name.endsWith('-shm'))
            .map((entry) => {
              const path = join(entry.parentPath, entry.name);
              return [
                path.slice(f.dataRoot.length + 1),
                entry.isFile()
                  ? createHash('sha256').update(readFileSync(path)).digest('hex')
                  : entry.isDirectory()
                    ? 'directory'
                    : 'nonregular',
              ];
            })
        );
      const before = retainedState();
      for (const operation of [
        'workspace.backup-capture',
        'workspace.backup-verify',
        'workspace.backup-download',
      ]) {
        const response = await request(unknown, operation, {
          workspaceId,
          backupId: operation === 'workspace.backup-capture' ? allocateEntityId('wsbak') : backupId,
          ...(operation === 'workspace.backup-capture' ? { purpose: 'backup' } : {}),
        });
        expect(response.status, await response.clone().text()).toBe(503);
        expect(response.headers.get('content-type')).toContain('application/json');
        const error = ApiErrorSchema.parse(await response.json());
        expect(error.code).toBe('operation_storage_unavailable');
        expect(error.message).toBe(
          'The server build identity is unknown; install a build with its source commit.'
        );
        expect(JSON.stringify(error)).not.toContain(f.dataRoot);
        expect(freeze).not.toHaveBeenCalled();
        expect(pin).not.toHaveBeenCalled();
        expect(reserve).not.toHaveBeenCalled();
        expect(f.admission.isClosed(workspaceId)).toBe(false);
        expect(retainedState()).toEqual(before);
      }
      const verified = await request(f.app, 'workspace.backup-verify', { workspaceId, backupId });
      expect(verified.status, await verified.clone().text()).toBe(200);
      expect(
        WorkspaceSnapshotReportSchema.parse(await verified.json()).capture!.manifestDigest
      ).toBe(original.capture!.manifestDigest);
    } finally {
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it('captures and verifies an untagged installed build using its exact admitted source commit', async () => {
    const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
    const f = await fixture('local', { releaseTag: null, sourceCommit });
    try {
      const backupId = allocateEntityId('wsbak');
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      expect(captured.status, await captured.clone().text()).toBe(200);
      const report = WorkspaceSnapshotReportSchema.parse(await captured.json());
      const verified = await request(f.app, 'workspace.backup-verify', { workspaceId, backupId });
      expect(verified.status, await verified.clone().text()).toBe(200);
      expect(
        WorkspaceSnapshotReportSchema.parse(await verified.json()).capture!.manifestDigest
      ).toBe(report.capture!.manifestDigest);
      const download = await request(f.app, 'workspace.backup-download', { workspaceId, backupId });
      expect(download.status, await download.clone().text()).toBe(200);
      const files = archiveFiles(Buffer.from(await download.arrayBuffer()));
      const manifest = files.get('manifest.json')!;
      expect(JSON.parse(manifest.toString()).release).toEqual({
        version: 'source',
        buildId: sourceCommit,
      });
      expect(`sha256:${createHash('sha256').update(manifest).digest('hex')}`).toBe(
        report.capture!.manifestDigest
      );
    } finally {
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it('projects binary and JSON snapshot refusals as safe typed HTTP envelopes', async () => {
    const f = await fixture();
    try {
      const refusal = async (response: Response, status: number, code: string) => {
        expect(response.status, await response.clone().text()).toBe(status);
        expect(response.headers.get('content-type')).toContain('application/json');
        const error = ApiErrorSchema.parse(await response.json());
        expect(error.code).toBe(code);
        expect(JSON.stringify(error)).not.toContain(f.dataRoot);
      };
      await refusal(
        await request(f.app, 'workspace.backup-download', {
          workspaceId,
          backupId: '../server-path-is-not-a-selector',
        }),
        400,
        'invalid_request'
      );
      const missingId = allocateEntityId('wsbak');
      for (const operation of ['workspace.backup-verify', 'workspace.backup-download']) {
        await refusal(
          await request(f.app, operation, { workspaceId, backupId: missingId }),
          409,
          'invalid-bundle'
        );
      }

      const backupId = allocateEntityId('wsbak');
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      expect(captured.status, await captured.clone().text()).toBe(200);
      const original = WorkspaceSnapshotReportSchema.parse(await captured.json());
      const sealPath = join(
        f.dataRoot,
        'server',
        'backups',
        'workspaces',
        workspaceId,
        backupId,
        'seal.json'
      );
      const sealBefore = readFileSync(sealPath);
      await refusal(
        await request(f.app, 'workspace.backup-capture', {
          workspaceId,
          backupId,
          purpose: 'move',
        }),
        409,
        'request-conflict'
      );
      expect(readFileSync(sealPath)).toEqual(sealBefore);
      const verified = await request(f.app, 'workspace.backup-verify', { workspaceId, backupId });
      expect(verified.status, await verified.clone().text()).toBe(200);
      expect(
        WorkspaceSnapshotReportSchema.parse(await verified.json()).capture!.manifestDigest
      ).toBe(original.capture!.manifestDigest);

      // Corrupt a second real sealed generation, preserving the first as a control.
      const corruptId = allocateEntityId('wsbak');
      const corruptCapture = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId: corruptId,
        purpose: 'backup',
      });
      expect(corruptCapture.status, await corruptCapture.clone().text()).toBe(200);
      const corruptSeal = join(
        f.dataRoot,
        'server',
        'backups',
        'workspaces',
        workspaceId,
        corruptId,
        'seal.json'
      );
      chmodSync(corruptSeal, 0o600);
      writeFileSync(corruptSeal, '{');
      for (const operation of ['workspace.backup-verify', 'workspace.backup-download']) {
        await refusal(
          await request(f.app, operation, { workspaceId, backupId: corruptId }),
          409,
          'invalid-bundle'
        );
      }
      expect(readFileSync(sealPath)).toEqual(sealBefore);
      const control = await request(f.app, 'workspace.backup-verify', { workspaceId, backupId });
      expect(control.status, await control.clone().text()).toBe(200);
      expect(
        WorkspaceSnapshotReportSchema.parse(await control.json()).capture!.manifestDigest
      ).toBe(original.capture!.manifestDigest);
    } finally {
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it('captures, verifies and streams the same sealed complete operational inventory', async () => {
    const f = await fixture();
    try {
      const backupId = allocateEntityId('wsbak');
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      // Baseline 404 is activation absence, not a passing behavioral refusal.
      expect(captured.status, await captured.clone().text()).toBe(200);
      const report = WorkspaceSnapshotReportSchema.parse(await captured.json());
      expect(report).toMatchObject({
        command: 'capture',
        disposition: 'sealed',
        workspaceId,
        capture: { workspaceId, backupId, source: { kind: 'live-workspace' } },
        nextAction: 'none',
      });
      expect(JSON.stringify(report)).not.toContain(f.dataRoot);
      const verified = await request(f.app, 'workspace.backup-verify', { workspaceId, backupId });
      expect(verified.status, await verified.clone().text()).toBe(200);
      expect(WorkspaceSnapshotReportSchema.parse(await verified.json())).toMatchObject({
        command: 'verify',
        disposition: 'verified',
        capture: {
          manifestDigest: report.capture!.manifestDigest,
          fileCount: report.capture!.fileCount,
          totalBytes: report.capture!.totalBytes,
        },
      });
      const download = await request(f.app, 'workspace.backup-download', { workspaceId, backupId });
      expect(download.status, await download.clone().text()).toBe(200);
      expect(download.headers.get('content-type')).toBe('application/octet-stream');
      const files = archiveFiles(Buffer.from(await download.arrayBuffer()));
      const manifestBytes = files.get('manifest.json')!;
      expect(manifestBytes).toBeDefined();
      const manifest = JSON.parse(manifestBytes.toString());
      expect(manifest).toMatchObject({
        format: 'openkit-workspace-backup',
        version: 1,
        workspaceId,
        backupId,
      });
      expect(files.has('openkit-workspace-export.json')).toBe(false);
      expect([...files.keys()].sort()).toEqual(
        [
          'manifest.json',
          'seal.json',
          ...manifest.inventory.map((entry: { path: string }) => entry.path),
        ].sort()
      );
      for (const entry of manifest.inventory) {
        const actual = files.get(entry.path)!;
        expect(actual.length).toBe(entry.bytes);
        expect(`sha256:${createHash('sha256').update(actual).digest('hex')}`).toBe(entry.sha256);
      }
      expect(JSON.parse(files.get('seal.json')!.toString())).toMatchObject({
        backupId,
        purpose: 'backup',
        manifestDigest: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
      });
      const replay = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      expect(replay.status).toBe(200);
      expect(WorkspaceSnapshotReportSchema.parse(await replay.json())).toEqual(report);
    } finally {
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it('releases verifier copies and capacity when only the unconsumed download request is aborted', async () => {
    const f = await fixture();
    const abort = new AbortController();
    try {
      const files = join(f.dataRoot, 'workspaces', workspaceId, 'files');
      mkdirSync(files, { recursive: true });
      // Incompressible bytes exceed bounded stream buffers, keeping the acquired
      // verifier callback alive while this caller leaves its body unconsumed.
      const original = randomBytes(2 * 1024 * 1024);
      writeFileSync(join(files, 'abort-backpressure.bin'), original);
      const backupId = allocateEntityId('wsbak');
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      expect(captured.status, await captured.clone().text()).toBe(200);
      const report = WorkspaceSnapshotReportSchema.parse(await captured.json());
      expect(report.capture!.totalBytes).toBeGreaterThanOrEqual(original.length);
      const reserve = vi.spyOn(f.fileAdmission, 'reserve');
      const beforeDirectories = new Set(
        readdirSync(f.dataRoot, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(entry.parentPath, entry.name))
      );
      const download = await request(
        f.app,
        'workspace.backup-download',
        { workspaceId, backupId },
        abort.signal
      );
      // Do not clone/read/cancel this body: request abortion is the sole disposal trigger.
      expect(download.status).toBe(200);
      expect(download.body).not.toBeNull();
      const reservations = reserve.mock.results
        .filter((result) => result.type === 'return')
        .map((result) => result.value);
      expect(reservations.length).toBeGreaterThan(0);
      // Locate actual new verifier copies by their mandatory operational database
      // inventory, without assuming a private staging prefix or deleting shared parents.
      const directories = readdirSync(f.dataRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(entry.parentPath, entry.name))
        .filter(
          (path) => !beforeDirectories.has(path) && existsSync(join(path, 'db', 'workspace.sqlite'))
        );
      expect(directories.length).toBeGreaterThan(0);
      for (const directory of directories) expect(existsSync(directory)).toBe(true);
      const releases: ReturnType<typeof vi.spyOn>[] = [];
      const cleanup = reservations.map((reservation) => {
        expect(() => reservation.assertAvailable()).not.toThrow();
        return new Promise<void>((resolve) => {
          const originalRelease = reservation.release.bind(reservation);
          const release = vi.spyOn(reservation, 'release').mockImplementation(() => {
            originalRelease();
            resolve();
          });
          releases.push(release);
        });
      });
      abort.abort();
      await Promise.all(cleanup);
      for (const release of releases) expect(release).toHaveBeenCalledOnce();
      for (const directory of directories) expect(existsSync(directory)).toBe(false);
      const verified = await request(f.app, 'workspace.backup-verify', { workspaceId, backupId });
      expect(verified.status, await verified.clone().text()).toBe(200);
      expect(WorkspaceSnapshotReportSchema.parse(await verified.json())).toMatchObject({
        command: 'verify',
        disposition: 'verified',
        capture: { manifestDigest: report.capture!.manifestDigest },
      });
    } finally {
      abort.abort();
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it('returns all live blockers in 409 and never interrupts their execution', async () => {
    const f = await fixture();
    try {
      const turn = await f.store.createTurn(
        workspaceId,
        DEMO_THREAD_ID,
        'Keep running during refused backup',
        { kind: 'user', id: f.ownerId }
      );
      const response = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId: allocateEntityId('wsbak'),
        purpose: 'backup',
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'workspace_blocked',
        details: {
          workspaceId,
          operation: 'capture',
          retryable: false,
          blockers: expect.arrayContaining([
            expect.objectContaining({
              kind: 'turn',
              reason: 'active-work',
              reference: { threadId: DEMO_THREAD_ID, turnId: turn.id },
            }),
          ]),
        },
      });
      expect(f.store.getTurnById(turn.id)).toEqual(turn);
      expect(f.admission.isClosed(workspaceId)).toBe(false);
    } finally {
      closeTestCoreDb(f.coreDb);
    }
  });

  it('fences racing target publishers while sibling native acknowledgements continue', async () => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Sibling remains live');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mutablePath = join(f.dataRoot, 'workspaces', workspaceId, 'files', 'capture-cut.txt');
    mkdirSync(join(f.dataRoot, 'workspaces', workspaceId, 'files'), { recursive: true });
    writeFileSync(mutablePath, 'A real target mutable file copied inside the capture fence.');
    const original = durableBytes.copyVerifiedFile;
    let first = true;
    const intercept = vi
      .spyOn(durableBytes, 'copyVerifiedFile')
      .mockImplementation(async (input) => {
        if (first && input.sourcePath === mutablePath) {
          first = false;
          expect(f.admission.isClosed(workspaceId)).toBe(true);
          entered();
          await barrier;
        }
        return original(input);
      });
    const capturing = request(f.app, 'workspace.backup-capture', {
      workspaceId,
      backupId: allocateEntityId('wsbak'),
      purpose: 'backup',
    });
    try {
      await Promise.race([
        observed,
        capturing.then((response) => {
          throw new Error(`Capture did not reach target mutable copy: ${response.status}`);
        }),
      ]);
      const target = await request(f.app, 'thread.create', {
        workspaceId,
        name: 'Must not enter frozen target',
        visibility: 'workspace',
        requestId: randomUUID(),
      });
      expect(target.status).toBe(409);
      expect(await target.json()).toMatchObject({
        code: 'workspace_frozen',
        details: { workspaceId, retryable: true },
      });
      const siblingResponse = await request(f.app, 'thread.create', {
        workspaceId: sibling.id,
        name: 'Sibling native ACK',
        visibility: 'workspace',
        requestId: randomUUID(),
      });
      expect(siblingResponse.status, await siblingResponse.clone().text()).toBe(200);
      const thread = (await siblingResponse.json()) as { id: string };
      expect(f.store.getThread(sibling.id, thread.id).name).toBe('Sibling native ACK');
    } finally {
      release();
      intercept.mockRestore();
      const captured = await capturing;
      closeTestCoreDb(f.coreDb);
      expect(captured.status, await captured.clone().text()).toBe(200);
      expect(WorkspaceSnapshotReportSchema.parse(await captured.json())).toMatchObject({
        command: 'capture',
        disposition: 'sealed',
        workspaceId,
      });
    }
    expect(f.admission.isClosed(workspaceId)).toBe(false);
  }, 120_000);

  it.each([
    'workspace.backup-capture',
    'workspace.backup-verify',
    'workspace.backup-download',
  ])('requires current administrator authentication for %s', async (operation) => {
    const f = await fixture('server');
    try {
      const backupId = allocateEntityId('wsbak');
      const response = await request(f.app, operation, {
        workspaceId,
        backupId,
        ...(operation === 'workspace.backup-capture' ? { purpose: 'backup' } : {}),
      });
      expect([401, 403]).toContain(response.status);
      expect(
        existsSync(join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId, backupId))
      ).toBe(false);
    } finally {
      closeTestCoreDb(f.coreDb);
    }
  });
});
