// openkit-test-platform: posix
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import nodeFs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { zstdDecompressSync } from 'node:zlib';
import { WorkspaceSnapshotReportSchema } from '@openkit/app-api-schemas';
import * as policyKernel from '@openkit/policy-kernel';
import { ApiErrorSchema, allocateEntityId } from '@openkit/protocol';
import * as durableBytes from '@openkit/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents, listWorkspaceAuditEvents } from './audit-events.js';
import * as accessTokens from './auth/access-token-store.js';
import { isScopeAdmitted } from './bootstrap/readiness.js';
import { restoreWorkspaceRecoveryAdmission } from './bootstrap/workspace-recovery.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore } from './lib/store.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import { openWorkspaceReadDb } from './storage/db.js';
import { coreDbPath } from './storage/fs-layout.js';
import * as captureProtection from './storage/workspace-capture-protection.js';
import { nativeProductScope, readNativeProduct } from './storage/workspace-file-records.js';
import { readRecoveryAdmission } from './storage/workspace-recovery-admissions.js';
import { type CreateAppOptions, createAppWithLocalIdentity } from './test-support/app.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestSqliteError,
  setTestWorkspaceRevision,
} from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { getWorkspaceRegistryLifecycleFact, listWorkspaceMembers } from './workspace-sharing.js';

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

/** Observes retained snapshot bytes and canonical authority, allowing only bearer-use metadata to advance. */
function snapshotAuthorityState(f: Awaited<ReturnType<typeof fixture>>, includeCoreBytes = false) {
  const corePath = coreDbPath(f.dataRoot);
  return {
    registry: getWorkspaceRegistryLifecycleFact(f.coreDb, workspaceId),
    members: listWorkspaceMembers(f.coreDb, workspaceId),
    audit: listServerAuditEvents(f.coreDb),
    files: Object.fromEntries(
      readdirSync(f.dataRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => {
          const path = join(entry.parentPath, entry.name);
          return (
            !entry.name.endsWith('-shm') &&
            (includeCoreBytes || (path !== corePath && !path.startsWith(`${corePath}-`)))
          );
        })
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
    ),
  };
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
  syncBuiltinESMExports();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('C-a composed snapshot App API', () => {
  it('requires Core authority for every snapshot route before any lifecycle or source effects', async () => {
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
      // Local initial Server admission is real; the snapshot owner still needs Core facts.
      const missingCore = createAppWithLocalIdentity({ ...f.appOptions, coreDb: undefined });
      const effects = [
        vi.spyOn(f.admission, 'tryFreeze'),
        vi.spyOn(captureProtection, 'protectCapture'),
        vi.spyOn(f.fileAdmission, 'reserve'),
        vi.spyOn(durableBytes, 'copyVerifiedFile'),
      ];
      const before = snapshotAuthorityState(f, true);
      for (const operation of [
        'workspace.backup-capture',
        'workspace.backup-verify',
        'workspace.backup-download',
      ]) {
        const response = await request(missingCore, operation, {
          workspaceId,
          backupId: operation === 'workspace.backup-capture' ? allocateEntityId('wsbak') : backupId,
          ...(operation === 'workspace.backup-capture' ? { purpose: 'backup' } : {}),
        });
        expect(response.status, await response.clone().text()).toBe(503);
        expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
          code: 'recovery_required',
        });
        for (const effect of effects) expect(effect).not.toHaveBeenCalled();
        expect(f.admission.isClosed(workspaceId)).toBe(false);
        expect(snapshotAuthorityState(f, true)).toEqual(before);
      }
      const verified = await request(f.app, 'workspace.backup-verify', { workspaceId, backupId });
      expect(verified.status, await verified.clone().text()).toBe(200);
      expect(
        WorkspaceSnapshotReportSchema.parse(await verified.json()).capture!.manifestDigest
      ).toBe(original.capture!.manifestDigest);
    } finally {
      vi.restoreAllMocks();
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it.each([
    'SQLITE_BUSY',
    'SQLITE_LOCKED',
    'unexpected',
  ] as const)('preserves a current-administrator %s facts failure at each snapshot owner before effects', async (fault) => {
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
      const issued = accessTokens.createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: f.ownerId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const server = createAppWithLocalIdentity({ ...f.appOptions, mode: 'server' });
      const authenticated = (operation: string, input: Record<string, unknown>) =>
        server.request(`/api/app/operations/${operation}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${issued.secret}`,
          },
          body: JSON.stringify(input),
        });
      const admitted = await authenticated('workspace.backup-verify', { workspaceId, backupId });
      expect(admitted.status, await admitted.clone().text()).toBe(200);
      expect(
        WorkspaceSnapshotReportSchema.parse(await admitted.json()).capture!.manifestDigest
      ).toBe(original.capture!.manifestDigest);

      const privateMarker = `private-current-admin-facts:${f.dataRoot}`;
      const failure =
        fault === 'unexpected'
          ? new Error(privateMarker)
          : createTestSqliteError(privateMarker, fault);
      const actualRead = accessTokens.getOpenKitAccessTokenRecord;
      const actualEvaluate = policyKernel.evaluateAccess;
      let armed = false;
      const phases: string[] = [];
      const read = vi
        .spyOn(accessTokens, 'getOpenKitAccessTokenRecord')
        .mockImplementation((coreDb, tokenId) => {
          if (armed && tokenId === issued.tokenId) {
            phases.push('facts-fault');
            throw failure;
          }
          return actualRead(coreDb, tokenId);
        });
      const evaluate = vi
        .spyOn(policyKernel, 'evaluateAccess')
        .mockImplementation((policy, call) => {
          const decision = actualEvaluate(policy, call);
          if (
            call.target === 'object:server:administration' &&
            call.operation === 'api.call' &&
            decision.effect === 'allow'
          ) {
            phases.push('server-allow');
            armed = true;
          }
          return decision;
        });
      const effects = [
        vi.spyOn(f.admission, 'tryFreeze'),
        vi.spyOn(captureProtection, 'protectCapture'),
        vi.spyOn(f.fileAdmission, 'reserve'),
        vi.spyOn(durableBytes, 'copyVerifiedFile'),
      ];
      const before = snapshotAuthorityState(f);
      for (const operation of [
        'workspace.backup-capture',
        'workspace.backup-verify',
        'workspace.backup-download',
      ]) {
        phases.length = 0;
        armed = operation === 'workspace.backup-download';
        const response = await authenticated(operation, {
          workspaceId,
          backupId: operation === 'workspace.backup-capture' ? allocateEntityId('wsbak') : backupId,
          ...(operation === 'workspace.backup-capture' ? { purpose: 'backup' } : {}),
        });
        expect(phases).toContain('facts-fault');
        if (operation !== 'workspace.backup-download') {
          expect(phases.indexOf('server-allow')).toBeGreaterThanOrEqual(0);
          expect(phases.indexOf('facts-fault')).toBeGreaterThan(phases.indexOf('server-allow'));
        }
        const text = await response.text();
        expect(response.status, text).toBe(fault === 'unexpected' ? 500 : 503);
        if (fault !== 'unexpected') {
          expect(ApiErrorSchema.parse(JSON.parse(text))).toMatchObject({
            code: 'operation_storage_unavailable',
          });
        }
        expect(text).not.toContain(privateMarker);
        expect(text).not.toContain(f.dataRoot);
        expect(text).not.toMatch(
          /SQLITE|workspace_access_denied|deployment_admin_required|\bat .+\(/
        );
        for (const effect of effects) expect(effect).not.toHaveBeenCalled();
        expect(f.admission.isClosed(workspaceId)).toBe(false);
        expect(snapshotAuthorityState(f)).toEqual(before);
      }
      read.mockRestore();
      evaluate.mockRestore();
      const verified = await authenticated('workspace.backup-verify', { workspaceId, backupId });
      expect(verified.status, await verified.clone().text()).toBe(200);
      expect(
        WorkspaceSnapshotReportSchema.parse(await verified.json()).capture!.manifestDigest
      ).toBe(original.capture!.manifestDigest);
    } finally {
      vi.restoreAllMocks();
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it('shares the real fixture owner across views and starts a fresh owner only after native shutdown', async () => {
    const f = await fixture();
    const { workspaceMutationAdmission: originalOwner, ...defaultOptions } = f.appOptions;
    const firstClient = getControlStoreWorkerClient();
    let frozen: ReturnType<WorkspaceMutationAdmission['tryFreeze']> | undefined;
    let reopenedCore: ReturnType<typeof createTestCoreDb> | undefined;
    try {
      const view = createAppWithLocalIdentity(defaultOptions);
      frozen = originalOwner.tryFreeze(workspaceId, () => []);
      expect(frozen.status).toBe('frozen');
      if (frozen.status !== 'frozen') throw new Error('Expected the original fixture freeze.');
      const beforeThreads = f.store.listThreads(workspaceId);
      for (const app of [f.app, view]) {
        const response = await request(app, 'thread.create', {
          workspaceId,
          name: 'No second-view admission through the original freeze',
          visibility: 'workspace',
          requestId: randomUUID(),
        });
        expect(response.status, await response.clone().text()).toBe(409);
        expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
          code: 'workspace_frozen',
          details: { workspaceId, retryable: true },
        });
      }

      const differentOwner = new WorkspaceMutationAdmission();
      expect(() =>
        createAppWithLocalIdentity({ ...f.appOptions, workspaceMutationAdmission: differentOwner })
      ).toThrow();
      expect(getControlStoreWorkerClient()).toBe(firstClient);
      expect(originalOwner.isClosed(workspaceId)).toBe(true);
      await expect(
        f.store.createThread(workspaceId, 'The rejected App cannot replace the Store owner')
      ).rejects.toMatchObject({ code: 'workspace_frozen' });
      const post = vi.spyOn(Worker.prototype, 'postMessage');
      const database = `workspace:${join(f.dataRoot, 'workspaces', workspaceId, 'db', 'workspace.sqlite')}`;
      await expect(firstClient.checkpoint(database)).rejects.toMatchObject({
        code: 'workspace_frozen',
      });
      expect(
        post.mock.calls.filter(
          ([message]) =>
            message !== null && typeof message === 'object' && message.database === database
        )
      ).toHaveLength(0);
      expect(f.store.listThreads(workspaceId)).toEqual(beforeThreads);

      // End the old process lifetime explicitly; no old App is invoked afterwards.
      // There is no durable capture/deletion fact, so its transient freeze must not
      // become the new process's default owner or be silently reopened by the helper.
      await shutdownControlStoreWorkerClient();
      closeTestCoreDb(f.coreDb);
      reopenedCore = createTestCoreDb(f.dataRoot);
      const reopenedStore = new FsStore({ dataRoot: f.dataRoot });
      const restarted = createAppWithLocalIdentity({
        ...defaultOptions,
        coreDb: reopenedCore,
        store: reopenedStore,
      });
      expect(getControlStoreWorkerClient()).not.toBe(firstClient);
      expect(originalOwner.isClosed(workspaceId)).toBe(true);
      const accepted = await request(restarted, 'thread.create', {
        workspaceId,
        name: 'Fresh owner after completed native shutdown',
        visibility: 'workspace',
        requestId: randomUUID(),
      });
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      const thread = (await accepted.json()) as { id: string };
      expect(reopenedStore.getThread(workspaceId, thread.id).name).toBe(
        'Fresh owner after completed native shutdown'
      );
      expect(originalOwner.isClosed(workspaceId)).toBe(true);
    } finally {
      await shutdownControlStoreWorkerClient();
      if (frozen?.status === 'frozen') frozen.release();
      if (reopenedCore) closeTestCoreDb(reopenedCore);
      closeTestCoreDb(f.coreDb);
    }
  }, 60_000);

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
    const emit = Worker.prototype.emit;
    let first = true;
    const intercept = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
      this: Worker,
      event,
      ...args
    ) {
      const message = args[0];
      if (
        first &&
        event === 'message' &&
        message !== null &&
        typeof message === 'object' &&
        message.kind === 'phase' &&
        message.phase === 'db-backup'
      ) {
        first = false;
        expect(f.admission.isClosed(workspaceId)).toBe(true);
        entered();
        // Withhold the real acknowledged cut frame; native replies continue through unchanged.
        void barrier.then(() => Reflect.apply(emit, this, [event, ...args]));
        return true;
      }
      return Reflect.apply(emit, this, [event, ...args]);
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
          throw new Error(`Capture did not reach the target database cut: ${response.status}`);
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

  it('inspects one sealed capture through its exact owner and keeps administrator and identity refusals', async () => {
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
      const expectedCapture = { ...original.capture! };
      delete expectedCapture.source; // Optional source provenance is not a retained manifest fact.
      const selection = { kind: 'capture', backupId };
      const response = await request(f.app, 'workspace.recovery-inspect', {
        workspaceId,
        selection,
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(text).not.toContain(f.dataRoot);
      expect(WorkspaceSnapshotReportSchema.parse(JSON.parse(text))).toMatchObject({
        command: 'inspect',
        disposition: 'sealed',
        workspaceId,
        selection,
        capture: expectedCapture,
        nextAction: 'none',
      });
      const db = openWorkspaceReadDb(f.dataRoot, workspaceId);
      try {
        expect(captureProtection.inspectCapture(db, workspaceId, backupId)?.state).toBe('finished');
      } finally {
        closeTestCoreDb(db);
      }
      for (const input of [
        { workspaceId: allocateEntityId('ws'), selection },
        { workspaceId, selection: { kind: 'capture', backupId: allocateEntityId('wsbak') } },
      ]) {
        const refused = await request(f.app, 'workspace.recovery-inspect', input);
        const body = await refused.text();
        expect(refused.status, body).toBe(409);
        expect(ApiErrorSchema.parse(JSON.parse(body))).toMatchObject({ code: 'recovery-required' });
        expect(body).not.toContain(f.dataRoot);
      }
      const server = createAppWithLocalIdentity({ ...f.appOptions, mode: 'server' });
      const denied = await request(server, 'workspace.recovery-inspect', {
        workspaceId,
        selection,
      });
      expect([401, 403]).toContain(denied.status);
      ApiErrorSchema.parse(await denied.json());
    } finally {
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it('inspects a real crashed SQL-only capture and abandons it without inventing finish authority', async () => {
    const f = await fixture();
    const backupId = allocateEntityId('wsbak');
    const configPath = join(f.dataRoot, 'workspaces', workspaceId, 'config/workspace.jsonc');
    const configBefore = readFileSync(configPath);
    const historyBefore = f.store.listThreads(workspaceId);
    const emit = Worker.prototype.emit;
    let stopping: Promise<number> | undefined;
    const intercept = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
      this: Worker,
      event,
      ...args
    ) {
      const message = args[0];
      if (
        !stopping &&
        event === 'message' &&
        message !== null &&
        typeof message === 'object' &&
        message.kind === 'phase' &&
        message.phase === 'pin-end'
      ) {
        // Stop after the real SQL pin commits, before any complete generation metadata exists.
        stopping = this.terminate();
        return true;
      }
      return Reflect.apply(emit, this, [event, ...args]);
    });
    try {
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      expect(stopping).toBeDefined();
      await stopping;
      expect(captured.ok).toBe(false);
      intercept.mockRestore();
      expect(readRecoveryAdmission(f.coreDb, backupId)).toBeUndefined();
      const generation = join(f.dataRoot, 'server/backups/workspaces', workspaceId, backupId);
      expect(existsSync(join(generation, 'manifest.json'))).toBe(false);
      expect(existsSync(join(generation, 'seal.json'))).toBe(false);
      const db = openWorkspaceReadDb(f.dataRoot, workspaceId);
      try {
        expect(captureProtection.inspectCapture(db, workspaceId, backupId)).toMatchObject({
          captureId: backupId,
          workspaceId,
          state: 'active',
          origin: 'manual',
        });
      } finally {
        closeTestCoreDb(db);
      }
      restoreWorkspaceRecoveryAdmission(f.coreDb, f.admission);
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
      const selection = { kind: 'capture', backupId };
      const response = await request(f.app, 'workspace.recovery-inspect', {
        workspaceId,
        selection,
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(text).not.toContain(f.dataRoot);
      const report = WorkspaceSnapshotReportSchema.parse(JSON.parse(text));
      expect(report).toMatchObject({
        command: 'inspect',
        disposition: 'pending',
        workspaceId,
        selection,
      });
      expect(report.capture).toBeUndefined();
      const after = openWorkspaceReadDb(f.dataRoot, workspaceId);
      try {
        expect(captureProtection.inspectCapture(after, workspaceId, backupId)).toMatchObject({
          captureId: backupId,
          workspaceId,
          state: 'active',
          origin: 'manual',
        });
      } finally {
        closeTestCoreDb(after);
      }
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
      expect(f.admission.isClosed(workspaceId)).toBe(true);
      const finish = await request(f.app, 'workspace.recovery-finish', { workspaceId, selection });
      expect(finish.status, await finish.clone().text()).toBe(409);
      expect(ApiErrorSchema.parse(await finish.json())).toMatchObject({
        code: 'recovery-required',
      });
      expect(existsSync(join(generation, 'seal.json'))).toBe(false);
      // Readmission must validate current authored config even after publication is abandoned.
      writeFileSync(configPath, '{');
      const invalid = await request(f.app, 'workspace.recovery-abandon', {
        workspaceId,
        selection,
      });
      expect(invalid.status, await invalid.clone().text()).toBe(409);
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
      expect(f.admission.isClosed(workspaceId)).toBe(true);
      writeFileSync(configPath, configBefore);
      // Local Hot Capture permits abandonment without inventing absent bundle facts.
      const abandoned = await request(f.app, 'workspace.recovery-abandon', {
        workspaceId,
        selection,
      });
      expect(abandoned.status, await abandoned.clone().text()).toBe(200);
      expect(WorkspaceSnapshotReportSchema.parse(await abandoned.json())).toMatchObject({
        command: 'abandon',
        disposition: 'abandoned',
        workspaceId,
        selection,
        nextAction: 'none',
      });
      const terminal = openWorkspaceReadDb(f.dataRoot, workspaceId);
      try {
        expect(captureProtection.inspectCapture(terminal, workspaceId, backupId)?.state).toBe(
          'abandoned'
        );
      } finally {
        closeTestCoreDb(terminal);
      }
      expect(f.store.listThreads(workspaceId)).toEqual(historyBefore);
      expect(readFileSync(configPath)).toEqual(configBefore);
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(true);
      expect(f.admission.isClosed(workspaceId)).toBe(false);
      const opposite = await request(f.app, 'workspace.recovery-finish', {
        workspaceId,
        selection,
      });
      expect(opposite.status, await opposite.clone().text()).toBe(409);
      const fresh = await request(f.app, 'thread.create', {
        workspaceId,
        name: 'Canonical Store admitted after capture abandonment',
        visibility: 'workspace',
        requestId: randomUUID(),
      });
      expect(fresh.status, await fresh.clone().text()).toBe(200);
    } finally {
      intercept.mockRestore();
      await stopping;
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it('finishes one real prepared MOVE once and keeps its sealed source read-only', async () => {
    const f = await fixture();
    try {
      const backupId = allocateEntityId('wsbak');
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'move',
      });
      expect(captured.status, await captured.clone().text()).toBe(200);
      const prepared = WorkspaceSnapshotReportSchema.parse(await captured.json());
      expect(prepared.disposition).toBe('prepared');
      const generation = join(f.dataRoot, 'server/backups/workspaces', workspaceId, backupId);
      expect(existsSync(join(generation, 'seal.json'))).toBe(false);
      const selection = { kind: 'capture', backupId };
      const scope = nativeProductScope(f.dataRoot, { kind: 'workspace', workspaceId });
      const before = readNativeProduct(scope, 'workspace', workspaceId)!;
      const response = await request(f.app, 'workspace.recovery-finish', {
        workspaceId,
        selection,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const report = WorkspaceSnapshotReportSchema.parse(await response.json());
      expect(report).toMatchObject({
        command: 'finish',
        disposition: 'moved-out',
        workspaceId,
        selection,
        capture: { manifestDigest: prepared.capture!.manifestDigest },
      });
      // Source Seal 3–5 requires raw moved-out authority, one Audit and a durable marker.
      const moved = readNativeProduct(scope, 'workspace', workspaceId)!;
      expect(moved.revision).toBe(before.revision + 1);
      expect(moved.record).toMatchObject({
        movedOut: { backupId, manifestDigest: prepared.capture!.manifestDigest },
      });
      const db = openWorkspaceReadDb(f.dataRoot, workspaceId);
      try {
        expect(captureProtection.inspectCapture(db, workspaceId, backupId)?.state).toBe('finished');
        expect(
          listWorkspaceAuditEvents(db, workspaceId).filter(
            (event) => event.action === 'workspace.move-out'
          )
        ).toHaveLength(1);
      } finally {
        closeTestCoreDb(db);
      }
      const seal = readFileSync(join(generation, 'seal.json'));
      expect(JSON.parse(seal.toString())).toMatchObject({
        backupId,
        purpose: 'move',
        manifestDigest: prepared.capture!.manifestDigest,
      });
      const replay = await request(f.app, 'workspace.recovery-finish', { workspaceId, selection });
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(WorkspaceSnapshotReportSchema.parse(await replay.json())).toEqual(report);
      expect(readNativeProduct(scope, 'workspace', workspaceId)).toEqual(moved);
      expect(readFileSync(join(generation, 'seal.json'))).toEqual(seal);
      const replayDb = openWorkspaceReadDb(f.dataRoot, workspaceId);
      try {
        expect(
          listWorkspaceAuditEvents(replayDb, workspaceId).filter(
            (event) => event.action === 'workspace.move-out'
          )
        ).toHaveLength(1);
      } finally {
        closeTestCoreDb(replayDb);
      }
      // Source Seal 4 requires the current moved-out revision, not only a matching historical seal.
      try {
        setTestWorkspaceRevision(f.dataRoot, workspaceId, moved.revision + 1);
        const stale = await request(f.app, 'workspace.backup-download', { workspaceId, backupId });
        await stale.arrayBuffer();
        expect
          .soft(stale.status, 'Download must refuse a stale current moved-out revision.')
          .toBe(409);
      } finally {
        setTestWorkspaceRevision(f.dataRoot, workspaceId, moved.revision);
      }
      const manifestPath = join(generation, 'manifest.json');
      const sealPath = join(generation, 'seal.json');
      const manifestBytes = readFileSync(manifestPath);
      const manifestMode = nodeFs.statSync(manifestPath).mode & 0o777;
      const sealMode = nodeFs.statSync(sealPath).mode & 0o777;
      try {
        // Deliberate physical corruption keeps the bundle self-consistent, but cannot change Core or source proof.
        const changed = Buffer.from(
          JSON.stringify({
            ...JSON.parse(manifestBytes.toString()),
            downloadProofProbe: 'changed descriptive bytes',
          })
        );
        const changedDigest = `sha256:${createHash('sha256').update(changed).digest('hex')}`;
        chmodSync(manifestPath, 0o600);
        chmodSync(sealPath, 0o600);
        writeFileSync(manifestPath, changed);
        writeFileSync(
          sealPath,
          JSON.stringify({ ...JSON.parse(seal.toString()), manifestDigest: changedDigest })
        );
        const rebound = await request(f.app, 'workspace.backup-download', {
          workspaceId,
          backupId,
        });
        await rebound.arrayBuffer();
        expect
          .soft(
            rebound.status,
            'Download must bind materialized bytes to the original Core and source digest.'
          )
          .toBe(409);
      } finally {
        writeFileSync(manifestPath, manifestBytes);
        writeFileSync(sealPath, seal);
        chmodSync(manifestPath, manifestMode);
        chmodSync(sealPath, sealMode);
      }
      // Source Seal 5 returns the verified bundle while the moved-out source stays excluded.
      const download = await request(f.app, 'workspace.backup-download', { workspaceId, backupId });
      expect(download.status, await download.clone().text()).toBe(200);
      const files = archiveFiles(Buffer.from(await download.arrayBuffer()));
      expect(
        `sha256:${createHash('sha256').update(files.get('manifest.json')!).digest('hex')}`
      ).toBe(prepared.capture!.manifestDigest);
      expect(f.admission.isClosed(workspaceId)).toBe(true);
      const opposite = await request(f.app, 'workspace.recovery-abandon', {
        workspaceId,
        selection,
      });
      expect(opposite.status, await opposite.clone().text()).toBe(409);
      const write = await request(f.app, 'thread.create', {
        workspaceId,
        name: 'Moved source must remain read-only',
        visibility: 'workspace',
        requestId: randomUUID(),
      });
      expect(write.status, await write.clone().text()).toBe(409);
      expect(f.admission.isClosed(workspaceId)).toBe(true);
    } finally {
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it.each([
    'finish',
    'abandon',
  ] as const)('explicitly %s a real interrupted restore through its original selected admission', async (decision) => {
    const f = await fixture();
    const final = join(f.dataRoot, 'workspaces', workspaceId);
    const configPath = join(final, 'config/workspace.jsonc');
    const rename = nodeFs.renameSync;
    let reachedPlacement = false;
    let newer: { backupId: string; manifestDigest: string } | undefined;
    try {
      const sibling = await f.store.createWorkspace('Healthy sibling of selected recovery');
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        workspaceId: sibling.id,
        ownerUserId: f.ownerId,
      });
      await f.store.updateThread(workspaceId, DEMO_THREAD_ID, { name: 'Captured target history' });
      const backupId = allocateEntityId('wsbak');
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      expect(captured.status, await captured.clone().text()).toBe(200);
      if (decision === 'finish') {
        const newerId = allocateEntityId('wsbak');
        const later = await request(f.app, 'workspace.backup-capture', {
          workspaceId,
          backupId: newerId,
          purpose: 'backup',
        });
        expect(later.status, await later.clone().text()).toBe(200);
        newer = {
          backupId: newerId,
          manifestDigest: WorkspaceSnapshotReportSchema.parse(await later.json()).capture!
            .manifestDigest,
        };
      }
      await f.store.updateThread(workspaceId, DEMO_THREAD_ID, {
        name: 'Preserved predecessor history',
      });
      const configBefore = readFileSync(configPath);
      const requestId = randomUUID();
      roots.push(`${f.dataRoot}.workspace-recovery-${requestId}`);
      const intercept = vi.spyOn(nodeFs, 'renameSync').mockImplementation((source, destination) => {
        if (String(destination) === final && String(source) !== final) {
          reachedPlacement = true;
          throw new Error('Interrupt the real prepared candidate after predecessor preservation.');
        }
        return rename(source, destination);
      });
      syncBuiltinESMExports();
      const interrupted = await request(f.app, 'workspace.backup-restore', {
        workspaceId,
        backupId,
        requestId,
        acknowledgeLostSafety: false,
      });
      expect(reachedPlacement).toBe(true);
      expect(interrupted.ok).toBe(false);
      intercept.mockRestore();
      syncBuiltinESMExports();
      const owned = readRecoveryAdmission(f.coreDb, requestId)!;
      expect(owned).toMatchObject({
        admission_id: requestId,
        workspace_id: workspaceId,
        state: 'prepared',
      });
      expect(owned.proof.candidateDigest).toBeDefined();
      expect(existsSync(owned.candidate_ref)).toBe(true);
      restoreWorkspaceRecoveryAdmission(f.coreDb, f.admission);
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
      const selection = { kind: 'admission', requestId };
      const operation = `workspace.recovery-${decision}`;
      // A sibling, unknown request and wrong selector cannot acquire this prepared candidate.
      for (const input of [
        { workspaceId: sibling.id, selection },
        { workspaceId, selection: { kind: 'admission', requestId: randomUUID() } },
        { workspaceId, selection: { kind: 'capture', backupId } },
      ]) {
        const refused = await request(f.app, operation, input);
        expect(refused.status, await refused.clone().text()).toBe(409);
        ApiErrorSchema.parse(await refused.json());
        expect(readRecoveryAdmission(f.coreDb, requestId)).toEqual(owned);
      }
      const issued = accessTokens.createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: f.ownerId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const server = createAppWithLocalIdentity({ ...f.appOptions, mode: 'server' });
      expect(accessTokens.revokeOpenKitAccessTokenRecord(f.coreDb, issued.tokenId)?.status).toBe(
        'revoked'
      );
      const denied = await server.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.secret}` },
        body: JSON.stringify({ workspaceId, selection }),
      });
      expect([401, 403]).toContain(denied.status);
      expect(readRecoveryAdmission(f.coreDb, requestId)).toEqual(owned);
      if (decision === 'abandon') {
        const candidateConfig = join(owned.candidate_ref, 'config/workspace.jsonc');
        const retainedConfig = readFileSync(candidateConfig);
        let reachedRetirement = false;
        const retirement = vi
          .spyOn(nodeFs, 'renameSync')
          .mockImplementation((source, destination) => {
            if (String(source) === owned.candidate_ref) {
              reachedRetirement = true;
              throw new Error(
                'Interrupt candidate retirement after closing its publication right.'
              );
            }
            return rename(source, destination);
          });
        syncBuiltinESMExports();
        const incomplete = await request(f.app, operation, { workspaceId, selection });
        expect(reachedRetirement).toBe(true);
        expect(incomplete.ok).toBe(false);
        retirement.mockRestore();
        syncBuiltinESMExports();
        // Target Admission closes finish rights before retirement; restart must permit the same decision.
        expect(readRecoveryAdmission(f.coreDb, requestId)).toMatchObject({
          state: 'abandoned',
          proof: { result: { disposition: 'quarantined' } },
        });
        expect(readFileSync(candidateConfig)).toEqual(retainedConfig);
        expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
        expect(f.admission.isClosed(workspaceId)).toBe(true);
        await shutdownControlStoreWorkerClient();
        f.admission = new WorkspaceMutationAdmission();
        restoreWorkspaceRecoveryAdmission(f.coreDb, f.admission);
        f.store = new FsStore({ dataRoot: f.dataRoot });
        f.appOptions = { ...f.appOptions, store: f.store, workspaceMutationAdmission: f.admission };
        f.app = createAppWithLocalIdentity(f.appOptions);
        expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
        expect(f.admission.isClosed(workspaceId)).toBe(true);
      }
      const response = await request(f.app, operation, { workspaceId, selection });
      expect(response.status, await response.clone().text()).toBe(200);
      const report = WorkspaceSnapshotReportSchema.parse(await response.json());
      expect(report).toMatchObject({
        command: decision,
        disposition: decision === 'finish' ? 'restored' : 'abandoned',
        workspaceId,
        selection,
        nextAction: 'none',
      });
      const terminal = readRecoveryAdmission(f.coreDb, requestId)!;
      expect(terminal.state).toBe(decision === 'finish' ? 'finished' : 'abandoned');
      expect(f.store.getThread(workspaceId, DEMO_THREAD_ID).name).toBe(
        decision === 'finish' ? 'Captured target history' : 'Preserved predecessor history'
      );
      expect(readFileSync(configPath)).toEqual(configBefore);
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(true);
      expect(f.admission.isClosed(workspaceId)).toBe(false);
      expect(f.admission.isClosed(sibling.id)).toBe(false);
      if (newer) {
        // Online Snapshot Policy makes a sealed generation independent of the restored source cut.
        const verified = await request(f.app, 'workspace.backup-verify', {
          workspaceId,
          backupId: newer.backupId,
        });
        expect(verified.status, await verified.clone().text()).toBe(200);
        expect(
          WorkspaceSnapshotReportSchema.parse(await verified.json()).capture!.manifestDigest
        ).toBe(newer.manifestDigest);
      }
      const opposite = await request(
        f.app,
        `workspace.recovery-${decision === 'finish' ? 'abandon' : 'finish'}`,
        { workspaceId, selection }
      );
      expect(opposite.status, await opposite.clone().text()).toBe(409);
      expect(readRecoveryAdmission(f.coreDb, requestId)).toEqual(terminal);
      const fresh = await request(f.app, 'thread.create', {
        workspaceId,
        name: 'Fresh admission after explicit recovery',
        visibility: 'workspace',
        requestId: randomUUID(),
      });
      expect(fresh.status, await fresh.clone().text()).toBe(200);
      const freshId = ((await fresh.json()) as { id: string }).id;
      const replay = await request(f.app, operation, { workspaceId, selection });
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(WorkspaceSnapshotReportSchema.parse(await replay.json())).toEqual(report);
      expect(f.store.getThread(workspaceId, freshId).name).toBe(
        'Fresh admission after explicit recovery'
      );
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it('inspects the original target admission created by real public restore and refuses an unknown request', async () => {
    const f = await fixture();
    try {
      const backupId = allocateEntityId('wsbak');
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      expect(captured.status, await captured.clone().text()).toBe(200);
      const requestId = randomUUID();
      const restored = await request(f.app, 'workspace.backup-restore', {
        workspaceId,
        backupId,
        requestId,
        acknowledgeLostSafety: false,
      });
      expect(restored.status, await restored.clone().text()).toBe(200);
      const original = WorkspaceSnapshotReportSchema.parse(await restored.json());
      const owned = readRecoveryAdmission(f.coreDb, requestId);
      expect(owned).toMatchObject({
        admission_id: requestId,
        workspace_id: workspaceId,
        state: 'finished',
      });
      const selection = { kind: 'admission', requestId };
      const response = await request(f.app, 'workspace.recovery-inspect', {
        workspaceId,
        selection,
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(text).not.toContain(f.dataRoot);
      expect(WorkspaceSnapshotReportSchema.parse(JSON.parse(text))).toMatchObject({
        ...original,
        command: 'inspect',
        selection,
        nextAction: 'none',
      });
      expect(readRecoveryAdmission(f.coreDb, requestId)).toEqual(owned);
      const refused = await request(f.app, 'workspace.recovery-inspect', {
        workspaceId,
        selection: { kind: 'admission', requestId: randomUUID() },
      });
      expect(refused.status, await refused.clone().text()).toBe(409);
      expect(ApiErrorSchema.parse(await refused.json())).toMatchObject({
        code: 'recovery-required',
      });
    } finally {
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it('restores complete retained history and authored configuration under the original identity, then replays without replacement', async () => {
    const f = await fixture();
    try {
      // Same-Deployment Restore and Workspace Bundle And Authority preserve complete local history.
      await f.store.updateWorkspace(workspaceId, { name: 'Captured authored name' });
      const turn = await f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'Retained history', {
        kind: 'user',
        id: f.ownerId,
      });
      const item = await f.store.createItem({
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'in_progress',
        text: 'Earlier retained revision',
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      const completedItem = await f.store.updateItem(item.id, {
        status: 'completed',
        text: 'Retained reply: é😀; second sentence.',
        completedAt: new Date().toISOString(),
      });
      await f.store.persistTurnEvent(turn.id, {
        event: 'item.completed',
        workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        requestId: null,
        data: { type: 'item-completed', itemId: item.id, item: completedItem },
      });
      await f.store.completeTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      const configPath = join(f.dataRoot, 'workspaces', workspaceId, 'config', 'workspace.jsonc');
      const expected = {
        thread: f.store.getThread(workspaceId, DEMO_THREAD_ID),
        turns: f.store.listThreadTurns(workspaceId, DEMO_THREAD_ID),
        revisions: f.store.listWorkspaceItemRevisions(workspaceId),
        events: f.store.getTurnEventsForExport(turn.id),
        knowledge: f.store.getWorkspaceResources(workspaceId).knowledge,
        config: readFileSync(configPath),
      };
      const backupId = allocateEntityId('wsbak');
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      expect(captured.status, await captured.clone().text()).toBe(200);
      WorkspaceSnapshotReportSchema.parse(await captured.json());
      await f.store.updateThread(workspaceId, DEMO_THREAD_ID, { name: 'Post-capture Thread' });
      const later = await f.store.createThread(workspaceId, 'Outside the captured cut');
      const members = listWorkspaceMembers(f.coreDb, workspaceId);
      const registry = getWorkspaceRegistryLifecycleFact(f.coreDb, workspaceId);
      const input = {
        workspaceId,
        backupId,
        requestId: randomUUID(),
        acknowledgeLostSafety: false,
      };
      const restored = await request(f.app, 'workspace.backup-restore', input);
      // The current uncomposed operation must fail here, rather than count as a valid refusal.
      expect(restored.status, await restored.clone().text()).toBe(200);
      const report = WorkspaceSnapshotReportSchema.parse(await restored.json());
      expect(report).toMatchObject({
        command: 'restore',
        disposition: 'restored',
        workspaceId,
        restrictedRecovery: false,
        nextAction: 'none',
      });
      expect(f.store.getWorkspace(workspaceId)).toMatchObject({
        id: workspaceId,
        name: 'Captured authored name',
      });
      expect(f.store.listThreads(workspaceId).map((thread) => thread.id)).not.toContain(later.id);
      expect(f.store.getThread(workspaceId, DEMO_THREAD_ID)).toEqual(expected.thread);
      expect(f.store.listThreadTurns(workspaceId, DEMO_THREAD_ID)).toEqual(expected.turns);
      expect(f.store.listWorkspaceItemRevisions(workspaceId)).toEqual(expected.revisions);
      expect(f.store.getTurnEventsForExport(turn.id)).toEqual(expected.events);
      expect(f.store.getWorkspaceResources(workspaceId).knowledge).toEqual(expected.knowledge);
      expect(readFileSync(configPath)).toEqual(expected.config);
      expect(listWorkspaceMembers(f.coreDb, workspaceId)).toEqual(members);
      expect(getWorkspaceRegistryLifecycleFact(f.coreDb, workspaceId)).toMatchObject({
        workspaceId,
        ownerUserId: registry!.ownerUserId,
        status: registry!.status,
      });
      expect(f.admission.isClosed(workspaceId)).toBe(false);
      const after = await request(f.app, 'thread.create', {
        workspaceId,
        name: 'Fresh admission after restore',
        visibility: 'workspace',
        requestId: randomUUID(),
      });
      expect(after.status, await after.clone().text()).toBe(200);
      const fresh = (await after.json()) as { id: string };
      const replay = await request(f.app, 'workspace.backup-restore', input);
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(WorkspaceSnapshotReportSchema.parse(await replay.json())).toEqual(report);
      expect(f.store.getThread(workspaceId, fresh.id).name).toBe('Fresh admission after restore');
      const conflict = await request(f.app, 'workspace.backup-restore', {
        ...input,
        acknowledgeLostSafety: true,
      });
      expect(conflict.status, await conflict.clone().text()).toBe(409);
      expect(ApiErrorSchema.parse(await conflict.json())).toMatchObject({
        code: 'request-conflict',
      });
      expect(f.store.getThread(workspaceId, fresh.id).name).toBe('Fresh admission after restore');
    } finally {
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it.each([
    'admitted publisher',
    'current freeze',
    'running Turn',
  ] as const)('refuses restore before the %s is released and preserves its current work', async (blocker) => {
    const f = await fixture();
    let release = () => {};
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let restoring: Promise<Response> | undefined;
    try {
      const backupId = allocateEntityId('wsbak');
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      expect(captured.status, await captured.clone().text()).toBe(200);
      let turn: Awaited<ReturnType<FsStore['createTurn']>> | undefined;
      if (blocker === 'admitted publisher') {
        const admitted = f.admission.enter(workspaceId);
        expect(admitted).not.toBeNull();
        release = admitted!;
      } else if (blocker === 'current freeze') {
        const frozen = f.admission.tryFreeze(workspaceId, () => []);
        expect(frozen.status).toBe('frozen');
        if (frozen.status !== 'frozen') throw new Error('Expected the existing target freeze.');
        release = frozen.release;
      } else {
        turn = await f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'Must remain running', {
          kind: 'user',
          id: f.ownerId,
        });
      }
      const before = f.store.listThreads(workspaceId);
      restoring = request(f.app, 'workspace.backup-restore', {
        workspaceId,
        backupId,
        requestId: randomUUID(),
        acknowledgeLostSafety: false,
      });
      // Scoped Freeze And Blockers forbids waiting for either admitted or durable work.
      const response = await Promise.race([
        restoring,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Restore waited for an unreleased blocker.')),
            5_000
          );
        }),
      ]);
      expect(response.status, await response.clone().text()).toBe(409);
      const frozen = blocker === 'current freeze';
      const error = ApiErrorSchema.parse(await response.json());
      expect(error).toMatchObject({
        code: frozen ? 'workspace_frozen' : 'workspace_blocked',
        details: { workspaceId, operation: 'restore', retryable: frozen },
      });
      expect(error.details).toMatchObject({ blockers: expect.any(Array) });
      expect((error.details as { blockers: unknown[] }).blockers.length).toBeGreaterThan(0);
      if (turn) {
        expect(error.details).toMatchObject({
          blockers: expect.arrayContaining([
            expect.objectContaining({
              kind: 'turn',
              reason: 'active-work',
              reference: { threadId: DEMO_THREAD_ID, turnId: turn.id },
            }),
          ]),
        });
        expect(f.store.getTurnById(turn.id)).toEqual(turn);
      }
      expect(f.store.listThreads(workspaceId)).toEqual(before);
      expect(f.admission.isClosed(workspaceId)).toBe(frozen);
    } finally {
      if (deadline) clearTimeout(deadline);
      release();
      if (restoring) await restoring;
      closeTestCoreDb(f.coreDb);
    }
  }, 120_000);

  it('keeps a healthy sibling writable and refuses authority revoked during verified-byte acquisition', async () => {
    const f = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let restoring: Promise<Response> | undefined;
    try {
      const sibling = await f.store.createWorkspace('Healthy sibling during restore');
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        workspaceId: sibling.id,
        ownerUserId: f.ownerId,
      });
      const backupId = allocateEntityId('wsbak');
      const captured = await request(f.app, 'workspace.backup-capture', {
        workspaceId,
        backupId,
        purpose: 'backup',
      });
      expect(captured.status, await captured.clone().text()).toBe(200);
      await f.store.createThread(workspaceId, 'Current history must survive refusal');
      const before = f.store.listThreads(workspaceId);
      const configPath = join(f.dataRoot, 'workspaces', workspaceId, 'config', 'workspace.jsonc');
      const configBefore = readFileSync(configPath);
      const issued = accessTokens.createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: f.ownerId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const server = createAppWithLocalIdentity({ ...f.appOptions, mode: 'server' });
      const copy = durableBytes.copyVerifiedFile;
      let first = true;
      vi.spyOn(durableBytes, 'copyVerifiedFile').mockImplementation(async (...args) => {
        const result = await copy(...args);
        if (first) {
          first = false;
          entered();
          // The actual producer completed; withhold only its acknowledged result at the await.
          await barrier;
        }
        return result;
      });
      restoring = server.request('/api/app/operations/workspace.backup-restore', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + issued.secret,
          'x-openkit-request-id': randomUUID(),
        },
        body: JSON.stringify({ workspaceId, backupId, acknowledgeLostSafety: false }),
      });
      await Promise.race([
        observed,
        restoring.then((response) => {
          throw new Error('Restore did not reach verified-byte acquisition: ' + response.status);
        }),
      ]);
      const siblingWrite = await request(f.app, 'thread.create', {
        workspaceId: sibling.id,
        name: 'Sibling native acknowledgement during restore',
        visibility: 'workspace',
        requestId: randomUUID(),
      });
      expect(siblingWrite.status, await siblingWrite.clone().text()).toBe(200);
      const siblingThread = (await siblingWrite.json()) as { id: string };
      expect(f.store.getThread(sibling.id, siblingThread.id).name).toBe(
        'Sibling native acknowledgement during restore'
      );
      expect(accessTokens.revokeOpenKitAccessTokenRecord(f.coreDb, issued.tokenId)?.status).toBe(
        'revoked'
      );
      release();
      const response = await restoring;
      // Operator Contract requires current administrator authority again after awaits.
      expect([401, 403]).toContain(response.status);
      ApiErrorSchema.parse(await response.json());
      expect(f.store.listThreads(workspaceId)).toEqual(before);
      expect(readFileSync(configPath)).toEqual(configBefore);
      expect(accessTokens.getOpenKitAccessTokenRecord(f.coreDb, issued.tokenId)?.status).toBe(
        'revoked'
      );
      expect(f.admission.isClosed(workspaceId)).toBe(false);
      expect(f.admission.isClosed(sibling.id)).toBe(false);
    } finally {
      release();
      if (restoring) await restoring;
      vi.restoreAllMocks();
      closeTestCoreDb(f.coreDb);
    }
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
