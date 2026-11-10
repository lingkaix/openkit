/// <reference lib="es2024.promise" />
// openkit-test-platform: posix
// openkit-test-container-subject
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttp2Server, type ServerHttp2Session } from 'node:http2';
import { createRequire } from 'node:module';
import { connect as connectSocket, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { type Duplex, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import type { OperationId } from '@openkit/app-api-schemas';
import { AuthoredAgentConfigSchema, WorkspaceConfigSchema } from '@openkit/config-schema';
import { isRecord } from '@openkit/protocol';
import {
  canonicalNativeEnvironment,
  NativeEnvironmentValuesSchema,
} from '@openkit/worker-protocol';
import { parse as parseJsonc } from 'jsonc-parser';
import ts from 'typescript6';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createApp, getNanoHostTransportSessionAuthority } from '../src/app.js';
import { listWorkspaceAuditEvents } from '../src/audit-events.js';
import { ensureLocalUser } from '../src/auth/identity.js';
import { readNanoHostPhysicalConnectionContext } from '../src/auth/nanohost-transport-session.js';
import { createRuntimeConfigManager } from '../src/config/runtime-config.js';
import { FsStore } from '../src/lib/store.js';
import { PolicyInterception } from '../src/policy/interception.js';
import { requireAgentEnvironmentPackageSnapshot } from '../src/runtime/aep-snapshot-ledger.js';
import type {
  NanoHostHarnessCommand,
  NanoHostHarnessResult,
} from '../src/runtime/nanohost-harness.js';
import type { NanoHostSessionEffectRequest } from '../src/runtime/nanohost-session-dispatch.js';
import { createNanoHostSessionDispatch } from '../src/runtime/nanohost-session-dispatch.js';
import { parseNanoHostImageInspection } from '../src/runtime/worker-environment-runtime-effects.js';
import { shutdownControlStoreWorkerClient } from '../src/storage/control-store-worker-client.js';
import { nativeProductScope, readNativeProduct } from '../src/storage/workspace-file-records.js';
import { createFixtureWorkspaceCollectPeer } from '../src/test-support/fixture-workspace-collect-peer.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../src/test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../src/test-support/native-task-admission.js';
import { operationRequest } from '../src/test-support/operation-request.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestWorkspaceDb,
} from '../src/test-support/store.js';
import { getVaultGrant } from '../src/vault/vault-grants.js';
import { getVaultReference } from '../src/vault/vault-references.js';
import { createVaultUnlockState } from '../src/vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../src/vault/vault-use-records.js';
import { getVaultInjectionPlan } from '../src/vault-injection-plans.js';
import { listVaultInjectionReceipts } from '../src/vault-injection-receipts.js';
import { WorkspaceMutationAdmission } from '../src/workspace-mutation-admission.js';

/*
 * Conditional component gate: actual Core authority, Worker Harness and pinned
 * native Codex; synthetic provider HTTP and the named external NanoHost peer.
 * The real Codex factory is injected only for loopback transport; the unchanged default registry is not qualified.
 * This does not qualify the canonical Rust collector, physical NanoHost, OpenShell or A1.
 * It does not qualify a published image or a real account.
 * Never import the real-account smoke or inspect an ambient credential file.
 */
const workspaceRoot = resolve(import.meta.dirname, '../../..');
const workerRequire = createRequire(join(workspaceRoot, 'packages/worker-shim/package.json'));

/** Exact non-secret image names accepted after the selected image keys-only observation. */
const PUBLIC_IMAGE_ENV_NAMES = [
  'PATH',
  'NODE_VERSION',
  'YARN_VERSION',
  'DEBIAN_FRONTEND',
  'BASH_ENV',
  'ENV',
  'HOME',
  'NPM_CONFIG_AUDIT',
  'NPM_CONFIG_FUND',
  'NPM_CONFIG_UPDATE_NOTIFIER',
  'OPENKIT_ARTIFACT_DIR',
  'PIP_DISABLE_PIP_VERSION_CHECK',
  'PYTHONDONTWRITEBYTECODE',
  'PYTHONUNBUFFERED',
  'UV_PYTHON_INSTALL_DIR',
  'VIRTUAL_ENV',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'TEMP',
  'TMP',
  'TMPDIR',
];
const IMAGE_IDENTITY_FORMAT =
  '[{{json .Id}},{{json .RepoDigests}},{{json .Architecture}},{{json .Os}},{{json .Config.User}},{{json .Config.WorkingDir}},{{json (index .Config.Labels "org.openkit.storage.family")}},{{json (index .Config.Labels "org.openkit.storage.version")}}]';
const IMAGE_VOLUME_KEYS_FORMAT =
  '{{range $target, $ignored := .Config.Volumes}}{{json $target}}{{println}}{{end}}';
const IMAGE_ENV_KEYS_FORMAT =
  '{{range .Config.Env}}{{json (index (split . "=") 0)}}{{println}}{{end}}';
/** Selects only approved public entries; unknown keys refuse before this projection runs. */
const IMAGE_PUBLIC_ENV_VALUES_FORMAT =
  '{{json .Id}}{{println}}{{range .Config.Env}}{{$name := index (split . "=") 0}}{{if or (eq $name "PATH") (eq $name "NODE_VERSION") (eq $name "YARN_VERSION") (eq $name "DEBIAN_FRONTEND") (eq $name "BASH_ENV") (eq $name "ENV") (eq $name "HOME") (eq $name "NPM_CONFIG_AUDIT") (eq $name "NPM_CONFIG_FUND") (eq $name "NPM_CONFIG_UPDATE_NOTIFIER") (eq $name "OPENKIT_ARTIFACT_DIR") (eq $name "PIP_DISABLE_PIP_VERSION_CHECK") (eq $name "PYTHONDONTWRITEBYTECODE") (eq $name "PYTHONUNBUFFERED") (eq $name "UV_PYTHON_INSTALL_DIR") (eq $name "VIRTUAL_ENV") (eq $name "XDG_CACHE_HOME") (eq $name "XDG_CONFIG_HOME") (eq $name "XDG_DATA_HOME") (eq $name "XDG_STATE_HOME") (eq $name "TEMP") (eq $name "TMP") (eq $name "TMPDIR")}}{{json .}}{{println}}{{end}}{{end}}';

/** Bounds only fixture waits; cancellation does not assert native success or cross-domain rollback. */
function boundedFixtureWait<T>(
  work: T | PromiseLike<T>,
  stage: string,
  milliseconds: number,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (action: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      action();
    };
    const abort = () =>
      finish(() => reject(new Error(`Login component ${stage} deadline or cancellation.`)));
    const timer = setTimeout(abort, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new Error(`Login component ${stage} failed.`)))
    );
    if (signal?.aborted) abort();
  });
}

describe.skipIf(process.env.OPENKIT_E2E_REAL_CODEX !== '1')(
  'Codex Login through the actual Core and Worker component',
  () => {
    it('measures actual nonempty fixture bytes and full permissions without inventing an empty baseline', async () => {
      const root = await mkdtemp(join(tmpdir(), 'openkit-login-scan-measurement-'));
      try {
        const worktreeRoot = join(root, 'worktrees');
        const worktree = join(worktreeRoot, 'measured');
        await mkdir(worktree, { recursive: true });
        await writeFile(join(worktree, 'witness.txt'), 'First measured fixture bytes.');
        await chmod(join(worktree, 'witness.txt'), 0o600);
        const collect = await createFixtureWorkspaceCollectPeer({
          ownedRoot: root,
          worktreeRoot,
          scanRoot: join(root, 'scan'),
        });
        const command = {
          requestId: 'a'.repeat(64),
          storageRef: 'synthetic-fixture-storage',
          scopeDigest: `sha256:${'b'.repeat(64)}`,
          attachmentGeneration: 1,
          sandboxId: 'synthetic-fixture-sandbox',
          workSlot: 'measured',
          collectionId: 'measured',
          mode: 'baseline',
          acceptedBase: null,
          previousHead: null,
          checkValues: { runtimeEnv: [], loopbackDigests: ['c'.repeat(64), 'd'.repeat(64)] },
        };
        const first = await collect(command);
        expect(first.outcome).toBe('baseline');
        if (first.outcome !== 'baseline') return;
        await writeFile(join(worktree, 'witness.txt'), 'Different measured fixture bytes.');
        const second = await collect({ ...command, requestId: 'e'.repeat(64) });
        expect(second.outcome).toBe('baseline');
        if (second.outcome !== 'baseline') return;
        expect(second.head.tree !== first.head.tree).toBe(true);
        expect(second.head.manifest).toBe(first.head.manifest);
        await chmod(join(worktree, 'witness.txt'), 0o644);
        const third = await collect({ ...command, requestId: 'f'.repeat(64) });
        expect(third.outcome).toBe('baseline');
        if (third.outcome !== 'baseline') return;
        expect(third.head.tree).toBe(second.head.tree);
        expect(third.head.manifest !== second.head.manifest).toBe(true);
        expect(
          await collect({
            ...command,
            mode: 'capture',
            previousHead: third.head,
            acceptedBase: first.head,
          })
        ).toEqual({ requestId: command.requestId, outcome: 'no_new_head', unstable: false });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('activates only after reviewed consent and refreshes through actual Core-only access delivery', async () => {
      const image = process.env.OPENKIT_L6_TASK_WORKER_IMAGE_REF;
      if (
        process.platform !== 'linux' ||
        process.arch !== 'x64' ||
        process.getuid?.() !== 1000 ||
        process.getgid?.() !== 1000
      )
        throw new Error(
          'Selected Login component gate needs the declared Linux amd64 uid/gid1000 host.'
        );
      if (!image || !/^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/.test(image)) {
        throw new Error(
          'Selected Login component gate needs an explicit immutable local Worker image.'
        );
      }
      // The image input is an address only. No physical qualification follows from its variable name.
      const invocationRoot = tmpdir();
      const ownedParent = dirname(invocationRoot);
      const invocationOwner = await lstat(invocationRoot);
      const parentOwner = await lstat(ownedParent);
      if (
        !isAbsolute(invocationRoot) ||
        resolve(invocationRoot) !== invocationRoot ||
        !/^openkit-vitest-[A-Za-z0-9]+$/.test(basename(invocationRoot)) ||
        ownedParent === dirname(ownedParent) ||
        !invocationOwner.isDirectory() ||
        !parentOwner.isDirectory() ||
        invocationOwner.uid !== process.getuid?.() ||
        parentOwner.uid !== process.getuid?.()
      )
        throw new Error('Selected Login component requires its owned invocation-temp parent.');
      // A private sibling survives the global setup's unconditional invocation-child teardown.
      const root = await mkdtemp(join(ownedParent, 'openkit-codex-login-component-'));
      const rootOwner = await lstat(root);
      if (
        !rootOwner.isDirectory() ||
        rootOwner.uid !== process.getuid?.() ||
        (rootOwner.mode & 0o777) !== 0o700
      )
        throw new Error('Owned Login component root is not private.');
      const phaseFacts = {
        bootstrapCompleted: false,
        bootstrapRefreshObserved: false,
        zeroUsesBeforeRequest: false,
        referencePresent: false,
        referenceIsUserOwned: false,
        referenceMatchesActualHuman: false,
        canonicalUserLocator: false,
        inventoryMatchesReference: false,
      };
      type Phase =
        | 'allocated'
        | 'workspace-created'
        | 'thread-created'
        | 'bootstrap-complete'
        | 'grant-request-complete'
        | 'approval-complete'
        | 'grant-issued'
        | 'component-prepared'
        | 'task-admitted'
        | 'native-launched'
        | 'native-completed'
        | 'verified';
      let phase: Phase = 'allocated';
      let outcome: 'running' | 'failed' | 'passed' = 'running';
      let refusal: {
        operation: OperationId;
        status: number;
        code: string;
        families?: {
          agent: boolean;
          model: boolean;
          feature: boolean;
          credential: boolean;
          setup: boolean;
          recovery: boolean;
          unsupported: boolean;
          workspace: boolean;
          capture: boolean;
          receipt: boolean;
          lineage: boolean;
          current: boolean;
          actor: boolean;
        };
      } | null = null;
      const publicSetupCodes = new Set([
        'vault_reference_not_active',
        'vault_request_stale',
        'vault_request_failed',
        'vault_recovery_required',
        'thread_busy',
        'idempotency_key_conflict',
        'vault_storage_unavailable',
        'vault_backend_not_available',
        'workspace_access_denied',
        'deployment_admin_required',
        'operation_storage_unavailable',
        'operation_storage_no_space',
        'invalid_request',
        'recovery_required',
        // Exact 409 literals from Task/access admission; source custody lives with this oracle.
        'workspace_frozen',
        'shared_thread_required',
        'task_mode_not_delegated',
        'workspace_data_source_blocked',
        'conflict',
        'agent_not_ready',
      ]);
      /** Persists only fixed phases, eight booleans and a closed public refusal projection. */
      const savePhaseFacts = () =>
        boundedFixtureWait(
          writeFile(
            join(root, 'phase-facts.json'),
            JSON.stringify({ phase, outcome, facts: phaseFacts, refusal }),
            { mode: 0o600 }
          ),
          'owned phase-facts persistence',
          1_000
        );
      const recordPhase = async (observed: Phase) => {
        phase = observed;
        await savePhaseFacts();
      };
      const workController = new AbortController();
      const workTimer = setTimeout(() => workController.abort(), 105_000);
      let bootstrapDb: ReturnType<typeof createTestCoreDb> | undefined;
      let ownerStore: FsStore | undefined;
      let vaultUnlock: ReturnType<typeof createVaultUnlockState> | undefined;
      let oauthPeer: Awaited<ReturnType<typeof syntheticCoreOAuthPeer>> | undefined;
      let native: Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>> | undefined;
      let component: Awaited<ReturnType<typeof actualWorkerComponent>> | undefined;
      let activeTurnId: string | undefined;
      let primaryFailure = false;
      let cleanupPromise: Promise<void> | undefined;
      /** One shared cleanup covers setup refusal, ordinary completion and Vitest timeout. */
      const cleanup = () => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
          clearTimeout(workTimer);
          workController.abort();
          const cleanupFailures: string[] = [];
          const deadline = Date.now() + 25_000;
          const join = async (stage: string, limit: number, action: () => Promise<unknown>) => {
            try {
              await boundedFixtureWait(
                action(),
                stage,
                Math.max(1, Math.min(limit, deadline - Date.now()))
              );
            } catch {
              cleanupFailures.push(stage);
            }
          };
          const stop = native?.runtime.executionReconciler.stop();
          if (stop) void stop.catch(() => undefined);
          await join('Core-reconciler-stop', 2_000, async () => stop);
          await join('actual-turn-interrupt', 3_000, async () => {
            if (!native || !activeTurnId || !ownerStore || native.executor.launches === 0) return;
            const turn = ownerStore.getTurnById(activeTurnId);
            if (turn.status === 'running' || turn.status === 'pending')
              await native.executor.interruptTurn(ownerStore, activeTurnId);
          });
          // Stop new peer dispatch before removing the owned namespace. Pending
          // commands fail through the actual pipe; a killed namespace is no close proof.
          const peer = native?.restore();
          if (peer) void peer.catch(() => undefined);
          await join('owned-container-join', 12_000, async () => component?.close());
          await join('Core-command-peer-join', 2_000, async () => peer);
          await join('Core-reconciler-join', 1_000, async () => stop);
          await join('actual-turn-join', 2_000, async () => {
            if (native && native.executor.launches > 0) await native.executor.finished.promise;
          });
          await join('synthetic-OAuth-peer-join', 1_000, async () => oauthPeer?.close());
          vaultUnlock?.lock();
          await join('Core-native-writer-join', 2_000, () => shutdownControlStoreWorkerClient());
          if (bootstrapDb) closeTestCoreDb(bootstrapDb);
          outcome = primaryFailure || cleanupFailures.length > 0 ? 'failed' : 'passed';
          if (primaryFailure || cleanupFailures.length > 0)
            await savePhaseFacts().catch(() => undefined);
          else await savePhaseFacts();
          if (cleanupFailures.length > 0)
            throw new Error(
              `Login component cleanup is unproved at ${cleanupFailures.join(',')}; prior assertion failed=${primaryFailure}.`
            );
          // Failed or timed-out work retains owned bytes for diagnosis. No failure
          // is changed into a successful native retaining-close observation.
          if (!primaryFailure) await rm(root, { recursive: true, force: true });
        })();
        return cleanupPromise;
      };
      onTestFinished(async () => {
        if (!cleanupPromise) primaryFailure = true;
        await cleanup();
      });
      try {
        await savePhaseFacts();
        const coreDb = createTestCoreDb(join(root, 'core'));
        bootstrapDb = coreDb;
        const userId = await ensureLocalUser(coreDb);
        const store = new FsStore({ dataRoot: coreDb.dataRoot });
        ownerStore = store;
        const unlock = createVaultUnlockState({
          backendKind: 'encrypted-file',
          storeDir: join(coreDb.dataRoot, 'server/vault'),
        });
        vaultUnlock = unlock;
        unlock.unlock({ masterKey: randomBytes(32) });
        await mkdir(join(coreDb.dataRoot, 'config'), { recursive: true });
        await writeFile(join(coreDb.dataRoot, 'config/server.jsonc'), '{"schemaVersion":1}');
        const manager = createRuntimeConfigManager({ dataRoot: coreDb.dataRoot });
        const policy = new PolicyInterception();
        const mutationAdmission = new WorkspaceMutationAdmission();
        let app = createApp({
          coreDb,
          dataRoot: coreDb.dataRoot,
          store,
          vaultUnlockState: unlock,
          runtimeConfigManager: manager,
          policyInterception: policy,
          workspaceMutationAdmission: mutationAdmission,
        });
        const oauth = await syntheticCoreOAuthPeer();
        oauthPeer = oauth;
        /** Keeps public setup failures value-free, including one-time secret responses. */
        const call = async <T>(id: OperationId, input: Record<string, unknown>): Promise<T> => {
          workController.signal.throwIfAborted();
          const response = await boundedFixtureWait(
            app.request(
              ...operationRequest(
                id,
                {},
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  signal: workController.signal,
                  body: JSON.stringify(input),
                }
              )
            ),
            'public setup request',
            15_000,
            workController.signal
          );
          if (response.status >= 400) {
            const value: unknown = await boundedFixtureWait(
              response.clone().json(),
              'closed public error-code observation',
              1_000
            ).catch(() => null);
            const code =
              isRecord(value) && typeof value.code === 'string' && publicSetupCodes.has(value.code)
                ? value.code
                : 'unclassified';
            refusal = { operation: id, status: response.status, code };
            outcome = 'failed';
            throw new Error(`Login component setup ${id}: HTTP ${response.status}, code=${code}.`);
          }
          return response.json() as Promise<T>;
        };

        expect(typeof userId).toBe('string');
        expect(image.startsWith('sha256:') || image.includes('@sha256:')).toBe(true);
        const workspace = await call<{ id: string }>('workspace.create', {
          name: 'Synthetic Codex Login component',
          requestId: randomUUID(),
        });
        await recordPhase('workspace-created');
        const thread = await call<{ id: string }>('thread.create', {
          workspaceId: workspace.id,
          name: 'Reviewed Login activation',
          visibility: 'workspace',
          requestId: randomUUID(),
        });
        await recordPhase('thread-created');
        expect(store.getThread(workspace.id, thread.id).id === thread.id).toBe(true);
        // The real public acquisition performs the trusted stock refresh, encrypted
        // material write and native metadata publication; submitted account hints
        // alone never manufacture a Login or a grant.
        const login = await call<{ referenceId: string; observations: null }>(
          'vault.bootstrap-codex-auth',
          {
            authJsonBase64: Buffer.from(
              JSON.stringify({
                tokens: {
                  access_token: 'synthetic-unverified-access',
                  refresh_token: oauth.initialRefresh,
                  account_id: oauth.accountId,
                },
              })
            ).toString('base64'),
          }
        );
        phaseFacts.bootstrapCompleted = true;
        phaseFacts.bootstrapRefreshObserved = oauth.refreshCount() === 1;
        const reference = getVaultReference(coreDb, login.referenceId);
        const backend = unlock.backend();
        phaseFacts.referencePresent = reference !== null;
        phaseFacts.referenceIsUserOwned = reference?.ownerScope === 'user';
        phaseFacts.referenceMatchesActualHuman = reference?.userId === userId;
        const canonicalUserLocatorMatches =
          reference?.ownerScope === 'user' &&
          reference.userId === userId &&
          reference.backendLocator ===
            `${backend.kind}://user/${userId}/vault/${login.referenceId}`;
        phaseFacts.canonicalUserLocator = canonicalUserLocatorMatches;
        try {
          const inventory = backend
            .listReferences({ ownerScope: 'user', userId })
            .find((entry) => entry.referenceId === login.referenceId);
          phaseFacts.inventoryMatchesReference = !!(
            reference &&
            inventory &&
            reference.status === 'active' &&
            reference.workspaceId === null &&
            reference.login?.provider === 'codex' &&
            inventory.ownerScope === 'user' &&
            inventory.userId === userId &&
            inventory.workspaceId === undefined &&
            inventory.providerSubscriptionAccount === undefined &&
            !inventory.revoked &&
            inventory.currentVersion === reference.currentVersion &&
            inventory.backendKind === reference.backendKind &&
            reference.backendKind === backend.kind
          );
        } catch {
          phaseFacts.inventoryMatchesReference = false;
        }
        await recordPhase('bootstrap-complete');
        expect(canonicalUserLocatorMatches).toBe(true);
        expect(oauth.refreshCount()).toBe(1);
        expect(login.observations).toBeNull();
        const workspaceDb = createTestWorkspaceDb(coreDb.dataRoot, workspace.id);
        try {
          phaseFacts.zeroUsesBeforeRequest = listVaultUseRecords(workspaceDb).length === 0;
          await savePhaseFacts();
          expect(listVaultUseRecords(workspaceDb).length).toBe(0);
          const request = await call<{
            workspaceId: string;
            threadId: string;
            raisingTurnId: string;
            approvalRequestId: string;
          }>('vault.grant-request', {
            workspaceId: workspace.id,
            threadId: thread.id,
            requestId: randomUUID(),
            terms: {
              referenceId: login.referenceId,
              ownerScope: 'workspace',
              lifetime: 'workspace',
              injectionPath: 'runtime-token',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          });
          await recordPhase('grant-request-complete');
          await call('approval.respond', {
            workspaceId: workspace.id,
            threadId: thread.id,
            turnId: request.raisingTurnId,
            approvalRequestId: request.approvalRequestId,
            decision: 'granted',
            requestId: randomUUID(),
          });
          await recordPhase('approval-complete');
          const issued = await call<{ grantId: string }>('vault.grant-issue', {
            workspaceId: workspace.id,
            threadId: thread.id,
            approvalRequestId: request.approvalRequestId,
          });
          await recordPhase('grant-issued');
          const grant = getVaultGrant(coreDb, issued.grantId);
          expect(grant?.vaultReferenceId === login.referenceId).toBe(true);
          expect(grant?.ownerScope === 'workspace' && grant.workspaceId === workspace.id).toBe(
            true
          );
          expect(grant?.issuance).toBe('target');
          expect(grant?.status).toBe('active');
          expect(grant?.allowedInjectionPaths).toEqual(['runtime-token']);
          expect(listVaultUseRecords(workspaceDb).length).toBe(0);
          expect(oauth.refreshCount()).toBe(1);
          // The component's external placement/image evidence is explicit. It
          // does not qualify the canonical Rust collector, physical NanoHost, OpenShell or A1.
          await authorLoginComposition(coreDb.dataRoot, workspace.id, issued.grantId, image);
          const runtimeManager = createRuntimeConfigManager({ dataRoot: coreDb.dataRoot });
          const manifest = runtimeManager
            .current()
            .agentManifests.find((value) => value.id === 'agent_codex_host');
          if (!manifest) throw new Error('Authored Login Agent was not loaded.');
          component = await actualWorkerComponent({
            root,
            image,
            coreDb,
            app: () => app,
            workspaceId: workspace.id,
            threadId: thread.id,
            referenceId: login.referenceId,
            grantId: issued.grantId,
            signal: workController.signal,
          });
          const measuredImage = await component.observeImage();
          admitTestNativeEnvironment(
            coreDb,
            manifest,
            measuredImage.defaults.values,
            measuredImage.image.imageDigest
          );
          await recordPhase('component-prepared');
          oauth.observeAccess(async (token) => {
            // The outside synthetic provider knows tokens it issues. This sideband
            // changes only its expectation, never Harness input or Core authority.
            await component!.providerExpectation(oauth.accountId, token);
          });
          native = await createNativeTaskAdmissionFixture(coreDb, store, {
            readRuntimeConfig: () => runtimeManager.current(),
            vaultBackend: () => unlock.backend(),
            policyInterception: () => policy,
            workspaceMutationAdmission: mutationAdmission,
            actualWorker: component.delegate,
          });
          app = createApp({
            coreDb,
            dataRoot: coreDb.dataRoot,
            store,
            vaultUnlockState: unlock,
            runtimeConfigManager: runtimeManager,
            policyInterception: policy,
            workspaceMutationAdmission: mutationAdmission,
            workerLifecycleRuntime: native.runtime,
            turnExecutor: native.executor,
            workerControlGateway: native.workerControlGateway,
            fileAdmission: native.fileAdmission,
            providerCredentialResolver: () => {
              throw new Error('Codex Login component must not resolve Server Gateway credentials.');
            },
          });
          workController.signal.throwIfAborted();
          const response = await boundedFixtureWait(
            app.request(
              ...operationRequest(
                'task.start',
                {
                  workspaceId: workspace.id,
                  threadId: thread.id,
                },
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  signal: workController.signal,
                  body: JSON.stringify({
                    requestId: randomUUID(),
                    input: 'Reply with Synthetic native Login reply.',
                  }),
                }
              )
            ),
            'Task admission request',
            15_000,
            workController.signal
          );
          if (!response.ok) {
            const value: unknown = await boundedFixtureWait(
              response.clone().json(),
              'closed Task refusal observation',
              1_000
            ).catch(() => null);
            const code =
              isRecord(value) && typeof value.code === 'string' && publicSetupCodes.has(value.code)
                ? value.code
                : 'unclassified';
            const words = isRecord(value)
              ? [value.code, value.message].filter((item) => typeof item === 'string').join(' ')
              : '';
            refusal = {
              operation: 'task.start',
              status: response.status,
              code,
              families: {
                agent: /agent/i.test(words),
                model: /model/i.test(words),
                feature: /feature/i.test(words),
                credential: /credential/i.test(words),
                setup: /setup/i.test(words),
                recovery: /recovery/i.test(words),
                unsupported: /unsupported/i.test(words),
                workspace: /workspace/i.test(words),
                capture: /capture/i.test(words),
                receipt: /receipt/i.test(words),
                lineage: /lineage/i.test(words),
                current: /current/i.test(words),
                actor: /actor/i.test(words),
              },
            };
            outcome = 'failed';
            await savePhaseFacts().catch(() => undefined);
          }
          expect(response.status).toBe(202);
          const result = (await response.json()) as { turn: { id: string } };
          activeTurnId = result.turn.id;
          await recordPhase('task-admitted');
          const launched = await boundedFixtureWait(
            native.executor.launched.promise.then(
              () => true,
              () => false
            ),
            'actual native launch',
            20_000,
            workController.signal
          );
          expect(launched).toBe(true);
          await recordPhase('native-launched');
          await boundedFixtureWait(
            vi.waitFor(
              () => {
                expect(store.getTurnById(result.turn.id).status).toBe('completed');
              },
              { timeout: 60_000 }
            ),
            'actual Task completion',
            60_000,
            workController.signal
          );
          await boundedFixtureWait(
            native.executor.execution,
            'actual Login Task settlement',
            5_000,
            workController.signal
          );
          await recordPhase('native-completed');
          const facts = await component.providerFacts();
          expect(facts.initialTokenRequests).toBeGreaterThan(0);
          expect(facts.refreshedTokenRequests).toBeGreaterThan(0);
          expect(facts.accountMatched).toBe(true);
          expect(facts.unexpectedAuthorization).toBe(false);
          expect(oauth.refreshCount()).toBe(3);
          expect(getVaultReference(coreDb, login.referenceId)?.currentVersion).toBe(3);
          const uses = listVaultUseRecords(workspaceDb).filter(
            (value) => value.vaultReferenceId === login.referenceId && value.outcome === 'succeeded'
          );
          expect(uses.length).toBeGreaterThanOrEqual(2);
          expect(
            uses.every((value) => value.grantId === issued.grantId && value.auditEventId !== null)
          ).toBe(true);
          const receipts = listVaultInjectionReceipts(coreDb).filter(
            (value) => value.grantId === issued.grantId
          );
          expect(receipts.length).toBeGreaterThanOrEqual(1);
          expect(receipts.every((value) => value.agentSessionId !== null)).toBe(true);
          const sessions = store.listThreadAgentSessions(workspace.id, thread.id);
          expect(sessions.some((value) => value.nativeHandleDigest !== null)).toBe(true);
          const packageId = native.executor.nativeLineage?.packageSnapshotId;
          if (!packageId)
            throw new Error('Actual native execution has no original package lineage.');
          const snapshot = requireAgentEnvironmentPackageSnapshot(
            workspaceDb,
            workspace.id,
            packageId
          ).snapshot;
          const packageText = JSON.stringify(snapshot);
          expect(packageText.includes(oauth.accountId)).toBe(false);
          expect(
            [...oauth.access, ...oauth.refreshValues].some((value) => packageText.includes(value))
          ).toBe(false);
          expect(component.releaseEvidence.length).toBeGreaterThanOrEqual(2);
          expect(component.releaseEvidence.every((value) => value.useAndAuditCommitted)).toBe(true);
          // Read the canonical private record with a fresh native read snapshot,
          // not FsStore.getThread, whose public Protocol Thread parser drops private fields.
          const scope = nativeProductScope(coreDb.dataRoot, {
            kind: 'workspace',
            workspaceId: workspace.id,
          });
          const affinity = readNativeProduct(scope, 'thread', thread.id)?.record.login;
          expect(isRecord(affinity)).toBe(true);
          if (!isRecord(affinity))
            throw new Error('Actual activation did not publish private Thread affinity.');
          expect(affinity.referenceId === login.referenceId).toBe(true);
          expect(JSON.stringify(affinity.lastLeftAt) === '{}').toBe(true);
          await call('thread.update', {
            workspaceId: workspace.id,
            threadId: thread.id,
            name: 'Ordinary metadata update after actual Login activation',
            requestId: randomUUID(),
          });
          const afterTitle = readNativeProduct(scope, 'thread', thread.id)?.record.login;
          expect(JSON.stringify(afterTitle) === JSON.stringify(affinity)).toBe(true);
          const publicThread = await call<unknown>('thread.read', {
            workspaceId: workspace.id,
            threadId: thread.id,
          });
          const publicText = JSON.stringify(publicThread);
          expect(isRecord(publicThread) && !Object.hasOwn(publicThread, 'login')).toBe(true);
          expect(publicText.includes('lastLeftAt')).toBe(false);
          expect(publicText.includes(oauth.accountId)).toBe(false);
          const publicEvents = JSON.stringify(store.getTurnEvents(result.turn.id));
          expect(
            [login.referenceId, issued.grantId, ...receipts.map((value) => value.receiptId)].some(
              (value) => publicEvents.includes(value)
            )
          ).toBe(false);
          expect(
            publicEvents.includes('"login"') || publicEvents.includes('"materialGeneration"')
          ).toBe(false);
          const evidence = JSON.stringify({
            uses,
            receipts,
            publicThread,
            publicEvents,
            turn: store.getTurnById(result.turn.id),
            audits: listWorkspaceAuditEvents(workspaceDb, workspace.id, coreDb),
          });
          expect(
            [...oauth.access, ...oauth.refreshValues].some((value) => evidence.includes(value))
          ).toBe(false);
          expect(await component.hasNativeAuthFile(thread.id)).toBe(false);
          await recordPhase('verified');
          // Acquisition left quota unknown and this sole eligible Login still
          // activated. A404 from the HTTP peer alone does not decide the separate
          // native account/rateLimits/read result or prove positive quota coverage.
        } finally {
          closeTestCoreDb(workspaceDb);
        }
      } catch (error) {
        primaryFailure = true;
        outcome = 'failed';
        await savePhaseFacts().catch(() => undefined);
        throw error;
      } finally {
        await cleanup();
      }
    });
  }
);

/** Copies only the explicitly owned current production package projections. */
async function copyCandidateClosure(destination: string) {
  const packages = new Map<string, { root: string; members: string[] }>();
  for (const name of ['worker-shim', 'protocol', 'worker-protocol', 'config-schema']) {
    packages.set(`@openkit/${name}`, {
      root: join(workspaceRoot, 'packages', name),
      members: ['package.json', 'dist'],
    });
  }
  packages.set('@openkit/codex-app-server-schema', {
    root: join(workspaceRoot, 'packages/codex-app-server-schema'),
    members: ['package.json', 'metadata.json', 'generated-schema'],
  });
  packages.set('@agentclientprotocol/sdk', {
    root: resolve(dirname(workerRequire.resolve('@agentclientprotocol/sdk')), '../../..'),
    members: ['package.json', 'dist', 'schema'],
  });
  const zodRoot = dirname(workerRequire.resolve('zod/package.json'));
  packages.set('zod', { root: zodRoot, members: await readdir(zodRoot) });
  for (const [name, source] of packages) {
    const target = join(destination, 'node_modules', name);
    await mkdir(target, { recursive: true });
    for (const member of source.members) {
      if (member === 'node_modules' || member.startsWith('.')) continue;
      await cp(join(source.root, member), join(target, member), {
        recursive: true,
        dereference: true,
      });
    }
  }
  // No source tree, env file, package-manager configuration or host home is mounted.
  await writeFile(join(destination, 'package.json'), '{"type":"module","private":true}');
  return hashTree(destination);
}

/** The only Core provider double: real loopback HTTP behind the unchanged stock refresh owner. */
async function syntheticCoreOAuthPeer() {
  const accountId = `synthetic-login-${randomUUID()}`;
  const initialRefresh = randomBytes(32).toString('base64url');
  let currentRefresh = initialRefresh;
  let count = 0;
  const access: string[] = [];
  const refreshValues = [initialRefresh];
  let observedAccess: ((token: string) => Promise<void>) | undefined;
  const server = createHttpServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 128 * 1024)
          throw new Error('Synthetic OAuth request exceeds its bound.');
      }
      const form = new URLSearchParams(body);
      if (
        request.method !== 'POST' ||
        request.url !== '/oauth/token' ||
        form.get('grant_type') !== 'refresh_token' ||
        form.get('refresh_token') !== currentRefresh ||
        form.has('account_id')
      ) {
        response.writeHead(400);
        response.end('{}');
        return;
      }
      const token = [
        Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
        Buffer.from(
          JSON.stringify({
            sub: 'synthetic-login-user',
            exp: 4_102_444_800,
            'https://api.openai.com/auth': {
              chatgpt_account_id: accountId,
              chatgpt_user_id: 'synthetic-login-user',
              chatgpt_plan_type: 'plus',
            },
            nonce: randomBytes(16).toString('hex'),
          })
        ).toString('base64url'),
        'synthetic-signature',
      ].join('.');
      currentRefresh = randomBytes(32).toString('base64url');
      access.push(token);
      refreshValues.push(currentRefresh);
      count += 1;
      await observedAccess?.(token);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          access_token: token,
          refresh_token: currentRefresh,
          expires_in: 3600,
          token_type: 'Bearer',
        })
      );
    } catch {
      response.writeHead(500);
      response.end('{}');
    }
  });
  try {
    await boundedFixtureWait(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      }),
      'synthetic OAuth listen',
      2_000
    );
  } catch (error) {
    server.closeAllConnections();
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Synthetic OAuth peer did not bind.');
  const originalFetch = globalThis.fetch;
  const redirect = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== 'https://auth.openai.com/oauth/token') {
      throw new Error('Synthetic Login component refused non-test provider fetch.');
    }
    return originalFetch(`http://127.0.0.1:${address.port}/oauth/token`, {
      method: request.method,
      headers: request.headers,
      body: await request.arrayBuffer(),
      signal: request.signal,
    });
  });
  return {
    accountId,
    initialRefresh,
    access,
    refreshValues,
    refreshCount: () => count,
    observeAccess: (observer: (token: string) => Promise<void>) => {
      observedAccess = observer;
    },
    async close() {
      redirect.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

/** Authors only owned fixture configuration, preserving the public grant's exact canonical ID. */
async function authorLoginComposition(
  dataRoot: string,
  workspaceId: string,
  grantId: string,
  image: string
) {
  const base = AuthoredAgentConfigSchema.parse(
    parseJsonc(
      await readFile(
        join(workspaceRoot, 'apps/nanocore/data-templates/config/agents/codex.agent.jsonc'),
        'utf8'
      )
    )
  );
  const manifest = AuthoredAgentConfigSchema.parse({
    ...base,
    runtime: { ...base.runtime, image: { kind: 'reference', ref: image, pullPolicy: 'never' } },
    models: { preferredLogicalModelId: 'reasoning', allowedLogicalModelIds: ['reasoning'] },
    requiredFeatures: ['worker.harness-login.v1'],
    skills: [],
    mcp: [],
    sandbox: {
      ...base.sandbox,
      network: [],
      filesystem: [],
      credentialDeclarations: [
        {
          id: 'codex-subscription',
          requirementId: 'codex-subscription',
          purpose: 'Use the explicitly reviewed synthetic Codex Login.',
          required: true,
          visibility: 'runtime-token',
          consumer: 'codex-login',
        },
      ],
    },
  });
  const agentDirectory = join(dataRoot, 'config/agents');
  const providerDirectory = join(dataRoot, 'config/providers');
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(providerDirectory, { recursive: true });
  await writeFile(join(agentDirectory, 'codex.agent.jsonc'), JSON.stringify(manifest));
  await writeFile(
    join(providerDirectory, 'synthetic-native-metadata.provider.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'codex-native-metadata',
      displayName: 'Synthetic native metadata',
      kind: 'oauth',
      vendor: 'openai-codex',
      extensions: {
        openkit: { subscriptionAccount: { accountSlotId: 'synthetic-unconfigured' } },
      },
      models: ['gpt-5.1-codex'],
      modelMetadata: {
        'gpt-5.1-codex': {
          limit: { context: 128_000, output: 16_000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
          reasoning: true,
          tool_call: true,
        },
      },
    })
  );
  await writeFile(
    join(dataRoot, 'config/gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      defaultLogicalModelId: 'reasoning',
      logicalModels: [
        {
          id: 'reasoning',
          displayName: 'Synthetic Codex',
          contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
          routes: [
            {
              id: 'native',
              providerProfileId: 'codex-native-metadata',
              providerModel: 'gpt-5.1-codex',
            },
          ],
        },
      ],
    })
  );
  const configurationPath = join(dataRoot, 'workspaces', workspaceId, 'config/workspace.jsonc');
  const workspace = WorkspaceConfigSchema.parse(
    parseJsonc(await readFile(configurationPath, 'utf8'))
  );
  workspace.workspace.agents = [
    {
      agentId: manifest.id,
      credentialBindings: [
        {
          requirementId: 'codex-subscription',
          vaultGrantId: grantId,
        },
      ],
      skills: [],
      mcp: [],
    },
  ];
  await writeFile(configurationPath, JSON.stringify(workspace));
  await writeFile(
    join(dataRoot, 'config/server.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      defaults: { defaultAgentId: manifest.id },
    })
  );
}

/**
 * Actual Worker consumer with a conditional external NanoHost component peer.
 * It does not qualify the canonical Rust collector, physical NanoHost, OpenShell or A1.
 */
async function actualWorkerComponent(input: {
  root: string;
  image: string;
  coreDb: ReturnType<typeof createTestCoreDb>;
  app(): ReturnType<typeof createApp>;
  workspaceId: string;
  threadId: string;
  referenceId: string;
  grantId: string;
  signal: AbortSignal;
}) {
  const componentController = new AbortController();
  const signal = AbortSignal.any([input.signal, componentController.signal]);
  const candidate = join(input.root, 'candidate');
  const worker = join(input.root, 'worker');
  const ipc = join(input.root, 'ipc');
  const config = join(input.root, 'empty-docker-config');
  for (const directory of [
    candidate,
    ipc,
    config,
    join(worker, 'openkit/threads'),
    join(worker, 'workspace/worktrees'),
    join(worker, 'sandbox'),
  ])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  let closure = await copyCandidateClosure(candidate);
  // Compile only this fixture's driver function with the already declared TS
  // toolchain. Reading its source avoids Vitest rewriting dynamic imports into
  // a private runtime helper that would not exist inside the container.
  const authoredSource = await readFile(import.meta.filename, 'utf8');
  const source = ts.createSourceFile('component.ts', authoredSource, ts.ScriptTarget.Latest, true);
  const driver = source.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'componentDriver'
  );
  if (!driver) throw new Error('Owned component driver source is absent.');
  const compiled = ts.transpileModule(
    `(${driver.getText(source)})().catch(() => { process.stderr.write('Owned Worker component failed.\\n'); process.exitCode = 1; });`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    }
  );
  if (compiled.diagnostics?.some((value) => value.category === ts.DiagnosticCategory.Error))
    throw new Error('Owned component driver could not be compiled.');
  await writeFile(join(candidate, 'component-driver.mjs'), compiled.outputText);
  const codexPackage = dirname(workerRequire.resolve('@openai/codex/package.json'));
  const binary = join(
    dirname(
      createRequire(join(codexPackage, 'package.json')).resolve(
        '@openai/codex-linux-x64/package.json'
      )
    ),
    'vendor/x86_64-unknown-linux-musl/bin/codex'
  );
  // Some npm releases locate the platform package through the wrapper's optional dependency alias.
  await access(codexPackage);
  await access(binary);
  const binaryHash = createHash('sha256')
    .update(await readFile(binary))
    .digest('hex');
  if (binaryHash !== 'b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8')
    throw new Error(
      'Selected component native binary does not match the independently pinned fixture.'
    );
  const collect = await createFixtureWorkspaceCollectPeer({
    ownedRoot: input.root,
    worktreeRoot: join(worker, 'workspace/worktrees'),
    scanRoot: join(input.root, 'private-scan'),
  });
  const name = `openkit-cred6042b-${randomUUID()}`;
  let child: ChildProcessWithoutNullStreams | undefined;
  let pipe: ReturnType<typeof harnessPipe> | undefined;
  let transport: Awaited<ReturnType<typeof connectCoreH2>> | undefined;
  let exited: Promise<number | null> | undefined;
  let actualConsumer:
    | { turnId: string; agentSessionId: string; packageSnapshotId: string }
    | undefined;
  const releaseEvidence: Array<{ useAndAuditCommitted: boolean }> = [];
  let preparedImage: Awaited<ReturnType<typeof inspectSelectedLocalImage>> | undefined;
  const imageWork = new Set<Promise<unknown>>();
  /** Measures the selected image again; immutable preparation cannot hide changed host facts. */
  const observeImage = () => {
    const work = (async () => {
      const current = await inspectSelectedLocalImage(config, input.image, signal);
      if (
        preparedImage &&
        (current.image.imageDigest !== preparedImage.image.imageDigest ||
          current.image.layoutDigest !== preparedImage.image.layoutDigest ||
          current.defaults.defaultsDigest !== preparedImage.defaults.defaultsDigest)
      )
        throw new Error('Selected local image observations changed after preparation.');
      preparedImage ??= current;
      return current;
    })();
    imageWork.add(work);
    void work.then(
      () => imageWork.delete(work),
      () => imageWork.delete(work)
    );
    return work;
  };

  /** Starts only the recorded owned container; argv is inspectable before any fixture run. */
  const start = async () => {
    signal.throwIfAborted();
    if (child) throw new Error('Component bridge opened twice.');
    const measured = await observeImage();
    signal.throwIfAborted();
    child = spawn(
      'docker',
      workerContainerArguments({
        image: input.image,
        name,
        config,
        candidate,
        worker,
        ipc,
        binary,
      }),
      {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: config, LANG: 'C' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    exited = new Promise((resolve) => child!.once('close', (code) => resolve(code)));
    pipe = harnessPipe(child, signal);
    const installed = await boundedFixtureWait(
      pipe.installed,
      'Worker listener installation',
      10_000,
      signal
    );
    if (installed.nodeVersion !== 'v26.13.0')
      throw new Error('Selected Worker image has a different Node toolchain.');
    transport = await connectCoreH2({
      socketPath: join(ipc, 'integration.sock'),
      app: input.app(),
      coreDb: input.coreDb,
      signal,
      beforePrivateAcquire: () => {
        const consumer = actualConsumer;
        if (!consumer)
          throw new Error('Private acquire has no entered actual Worker Turn command.');
        const beforeDb = createTestWorkspaceDb(input.coreDb.dataRoot, input.workspaceId);
        let beforeUseIds: Set<string>;
        let beforeAuditIds: Set<string>;
        try {
          beforeUseIds = new Set(listVaultUseRecords(beforeDb).map((value) => value.useId));
          beforeAuditIds = new Set(
            listWorkspaceAuditEvents(beforeDb, input.workspaceId, input.coreDb).map(
              (value) => value.id
            )
          );
        } finally {
          closeTestCoreDb(beforeDb);
        }
        return async (response: Response) => {
          // Observe the closed response only in memory before consumer disclosure.
          // Never include its body or identifiers in diagnostics or assertion output.
          const value: unknown = await response.clone().json();
          const db = createTestWorkspaceDb(input.coreDb.dataRoot, input.workspaceId);
          let committed = false;
          try {
            const reference = getVaultReference(input.coreDb, input.referenceId);
            if (
              reference &&
              isRecord(value) &&
              typeof value.receiptId === 'string' &&
              typeof value.materialGeneration === 'number' &&
              Number.isSafeInteger(value.materialGeneration) &&
              value.materialGeneration > 0 &&
              value.materialGeneration === reference?.currentVersion &&
              value.accountId === reference.login?.accountId
            ) {
              const audits = new Map(
                listWorkspaceAuditEvents(db, input.workspaceId, input.coreDb).map((event) => [
                  event.id,
                  event,
                ])
              );
              const receipt = listVaultInjectionReceipts(input.coreDb).find(
                (entry) => entry.receiptId === value.receiptId
              );
              const fresh = listVaultUseRecords(db).filter(
                (use) =>
                  !beforeUseIds.has(use.useId) &&
                  use.outcome === 'succeeded' &&
                  use.vaultReferenceId === input.referenceId &&
                  use.grantId === input.grantId &&
                  use.workspaceId === input.workspaceId &&
                  use.materialVersion === value.materialGeneration &&
                  use.agentSessionId !== null &&
                  use.planId !== null &&
                  (use.receiptId === null || use.receiptId === value.receiptId)
              );
              committed = fresh.some((use) => {
                if (!use.planId) return false;
                const plan = getVaultInjectionPlan(input.coreDb, use.planId);
                if (
                  !plan ||
                  plan.grantId !== input.grantId ||
                  !plan.packageSnapshotId ||
                  !use.auditEventId ||
                  beforeAuditIds.has(use.auditEventId)
                )
                  return false;
                const snapshot = requireAgentEnvironmentPackageSnapshot(
                  db,
                  input.workspaceId,
                  plan.packageSnapshotId
                ).snapshot;
                const audit = audits.get(use.auditEventId);
                return (
                  plan.packageSnapshotId === consumer.packageSnapshotId &&
                  snapshot.scope.turnId === consumer.turnId &&
                  snapshot.scope.agentSessionId === consumer.agentSessionId &&
                  snapshot.scope.workspaceId === input.workspaceId &&
                  snapshot.scope.threadId === input.threadId &&
                  snapshot.scope.agentSessionId === use.agentSessionId &&
                  audit?.outcome === 'succeeded' &&
                  audit.vaultGrantId === input.grantId &&
                  audit.agentSessionId === use.agentSessionId &&
                  (!receipt ||
                    (receipt.grantId === input.grantId &&
                      receipt.planId === use.planId &&
                      receipt.agentSessionId === use.agentSessionId))
                );
              });
            }
          } finally {
            closeTestCoreDb(db);
          }
          releaseEvidence.push({ useAndAuditCommitted: committed });
          if (!committed)
            throw new Error('Own acquire Use/Audit was not committed before private disclosure.');
        };
      },
    });
    await boundedFixtureWait(pipe.ready, 'actual Integration readiness', 10_000, signal);
    console.info(
      'codex_login_component_metadata',
      JSON.stringify({
        imageId: measured.image.imageDigest,
        architecture: measured.image.layout.platform.architecture,
        os: measured.image.layout.platform.os,
        user: `${measured.image.layout.uid}:${measured.image.layout.gid}`,
        imageDefaultsDigest: measured.defaults.defaultsDigest,
        imageDefaultsNameCount: Object.keys(measured.defaults.values).length,
        imageDefaultsByteLength: Buffer.byteLength(
          canonicalNativeEnvironment(measured.defaults.values)
        ),
        nodeVersion: installed.nodeVersion,
        nativeSha256: binaryHash,
        closureSha256: createHash('sha256').update(JSON.stringify(closure)).digest('hex'),
      })
    );
  };
  const fileHelperPath = join(candidate, 'file-effect.mjs');
  await cp(join(workspaceRoot, 'containers/workers/openkit-file-effect'), fileHelperPath);
  closure = await hashTree(candidate);
  const fileHelper = (await import(pathToFileURL(fileHelperPath).href)) as {
    CANONICAL_SLOT_ROOTS: Record<string, string>;
    runFileEffect(input: {
      argv: string[];
      stdin: AsyncIterable<Uint8Array>;
      stdout: Writable;
      stderr: Writable;
      slotRoots: Record<string, string>;
    }): Promise<number>;
  };
  const slotRoots = Object.fromEntries(
    Object.entries(fileHelper.CANONICAL_SLOT_ROOTS)
      .filter(([slot]) => slot !== 'runtime-credential')
      .map(([slot, path]) => [slot, join(worker, path.replace(/^\//, ''))])
  );
  const discard = () =>
    new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
  const effect = async (request: NanoHostSessionEffectRequest): Promise<unknown> => {
    const value = request.input;
    if (request.kind === 'image.acquire' || request.kind === 'image.inspect') {
      if (!preparedImage) throw new Error('Selected image has not been measured and admitted.');
      const requested = request.kind === 'image.acquire' ? value.imageReference : value.imageDigest;
      if (requested !== preparedImage.image.imageDigest)
        throw new Error('Conditional image peer refuses another image selection.');
      const measured = await observeImage();
      // This is a measured local-image component peer, not the canonical Rust importer.
      return request.kind === 'image.acquire'
        ? { digest: measured.image.imageDigest }
        : measured.effectResult;
    }
    if (request.kind === 'bridge.open') {
      await start();
      return { accepted: true, integrationReady: true, state: 'open' };
    }
    if (request.kind === 'sandbox.create') {
      const storage = value.storage as { targets: Array<Record<string, unknown>> };
      // Conditional outside placement model only; no physical capability is claimed.
      return {
        sandboxId: value.sandboxId,
        state: 'created',
        storage: {
          ...storage,
          targets: storage.targets.map((target) => ({ ...target, initialized: true })),
        },
      };
    }
    if (request.kind === 'workspace.collect')
      return collect({ ...value, requestId: request.requestId });
    if (request.kind === 'reference.import') {
      if (typeof value.slot !== 'string' || !Object.hasOwn(slotRoots, value.slot))
        throw new Error('Login component refuses runtime credential file delivery.');
      const output: Buffer[] = [];
      const stdout = new Writable({
        write(chunk, _encoding, done) {
          output.push(Buffer.from(chunk));
          done();
        },
      });
      const args =
        value.entryKind === 'directory'
          ? [
              'reference.import',
              '--slot',
              value.slot,
              '--path',
              String(value.relativePath),
              '--entry-kind',
              'directory',
            ]
          : [
              'reference.import',
              '--slot',
              value.slot,
              '--path',
              String(value.relativePath),
              '--length',
              String(value.byteLength),
              '--sha256',
              String(value.sha256),
              '--entry-kind',
              'file',
              '--executable',
              String(value.executable),
            ];
      const source = value.source as
        | { open(signal: AbortSignal): AsyncIterable<Uint8Array> }
        | undefined;
      const bytes = source
        ? source.open(new AbortController().signal)
        : (async function* () {
            if (!(value.body instanceof Uint8Array))
              throw new Error('Actual import source bytes are absent.');
            yield value.body;
          })();
      const code = await fileHelper.runFileEffect({
        argv: args,
        stdin: bytes,
        stdout,
        stderr: discard(),
        slotRoots,
      });
      if (code !== 0) throw new Error('Actual Worker file import failed.');
      const proof = Buffer.concat(output).toString('utf8');
      if (value.entryKind === 'file' && proof !== `${value.sha256} ${value.byteLength}\n`)
        throw new Error('Actual Worker file import returned inconsistent measured proof.');
      if (value.entryKind === 'directory' && proof !== '')
        throw new Error('Actual Worker directory import returned unexpected proof.');
      return { state: 'imported' };
    }
    if (request.kind === 'file.export') {
      const directory = await mkdtemp(join(input.root, 'capture-'));
      const stagingPath = join(directory, 'capture');
      const output = createWriteStream(stagingPath, { mode: 0o600, flags: 'wx' });
      const digest = createHash('sha256');
      let byteLength = 0;
      const stdout = new Writable({
        write(chunk, _encoding, done) {
          digest.update(chunk);
          byteLength += chunk.length;
          output.write(chunk, done);
        },
      });
      const args = [
        'file.export',
        '--slot',
        String(value.slot),
        '--path',
        String(value.relativePath),
        '--max-length',
        String(value.maxByteLength),
      ];
      if (value.presence === 'optional') args.push('--allow-missing');
      if (value.purpose === 'artifact-submission') args.push('--artifact-submission');
      const code = await fileHelper.runFileEffect({
        argv: args,
        stdin: (async function* () {})(),
        stdout,
        stderr: discard(),
        slotRoots,
      });
      await new Promise<void>((resolve, reject) => {
        output.once('error', reject);
        output.end(resolve);
      });
      if (code === 2 && value.presence === 'optional') return { state: 'absent' };
      if (code !== 0) throw new Error('Actual Worker file export failed.');
      return { stagingPath, byteLength, sha256: `sha256:${digest.digest('hex')}` };
    }
    if (request.kind === 'bridge.close') {
      await transport?.close();
      return { state: 'closed' };
    }
    if (request.kind === 'sandbox.delete') {
      await close();
      return { state: 'deleted' };
    }
    throw new Error(`Unimplemented conditional component effect ${request.kind}.`);
  };
  let closePromise: Promise<void> | undefined;
  /** Joins only this fixture's process/container; forced cleanup proves no native retaining close. */
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    componentController.abort();
    closePromise = (async () => {
      const failures: string[] = [];
      const deadline = Date.now() + 10_000;
      const left = () => Math.max(1, Math.min(2_000, deadline - Date.now()));
      pipe?.close();
      const h2 = transport;
      transport = undefined;
      try {
        await boundedFixtureWait(h2?.close() ?? Promise.resolve(), 'Core H2 cleanup', left());
      } catch {
        failures.push('H2');
      }
      try {
        await boundedFixtureWait(
          Promise.allSettled([...imageWork]),
          'owned image metadata joins',
          left()
        );
      } catch {
        failures.push('image-metadata-join');
      }
      const ownedChild = child;
      const ownedExit = exited;
      if (!ownedChild) {
        if (failures.length) throw new Error('Owned component pre-container cleanup is unproved.');
        return;
      }
      if (!ownedExit) {
        ownedChild.kill('SIGKILL');
        throw new Error('Owned Docker process has no registered close join.');
      }
      ownedChild.stdin.end();
      let containerId: string | undefined;
      const readOwnedId = async () => {
        try {
          const value = (await readFile(join(config, 'container.id'), 'utf8')).trim();
          if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid owned container identity.');
          containerId = value;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push('CID');
        }
      };
      await readOwnedId();
      if (!containerId) {
        // Stop and join a partial creation before locating this exact unique
        // name/owner-label pair. Never remove an unqualified container selector.
        ownedChild.kill('SIGKILL');
        try {
          await boundedFixtureWait(ownedExit, 'partial Docker launch join', left());
        } catch {
          failures.push('partial-launch');
        }
        await readOwnedId();
        if (!containerId) {
          try {
            const value = await dockerMetadata(
              config,
              [
                'container',
                'ls',
                '--all',
                '--quiet',
                '--no-trunc',
                '--filter',
                `name=^/${name}$`,
                '--filter',
                'label=openkit.test.owner=cred6042b',
              ],
              left()
            );
            if (value !== '' && !/^[a-f0-9]{64}$/.test(value))
              throw new Error('Ambiguous owned container identity.');
            containerId = value || undefined;
            if (!containerId) failures.push('creation-identity-unknown');
          } catch {
            failures.push('partial-identity');
          }
        }
      }
      if (containerId) {
        const removal = spawn(
          'docker',
          dockerArguments(config, ['rm', '--force', '--volumes', containerId]),
          {
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: config, LANG: 'C' },
            stdio: 'ignore',
            signal: AbortSignal.timeout(left()),
            killSignal: 'SIGKILL',
          }
        );
        const removalExit = new Promise<number | null>((resolve) => removal.once('close', resolve));
        let failed = false;
        removal.once('error', () => {
          failed = true;
        });
        try {
          const code = await boundedFixtureWait(removalExit, 'owned Docker removal join', left());
          if (code === null || failed) failures.push('removal-process');
        } catch {
          removal.kill('SIGKILL');
          try {
            await boundedFixtureWait(removalExit, 'killed Docker removal join', 1_000);
          } catch {
            failures.push('removal-join');
          }
          failures.push('removal-deadline');
        }
      }
      try {
        const selector = containerId ? `id=${containerId}` : `name=^/${name}$`;
        const surviving = await dockerMetadata(
          config,
          [
            'container',
            'ls',
            '--all',
            '--quiet',
            '--no-trunc',
            '--filter',
            selector,
            '--filter',
            'label=openkit.test.owner=cred6042b',
          ],
          left()
        );
        if (surviving !== '') failures.push('container-survived');
      } catch {
        failures.push('container-absence');
      }
      try {
        await boundedFixtureWait(ownedExit, 'owned Docker process join', left());
      } catch {
        ownedChild.kill('SIGKILL');
        try {
          await boundedFixtureWait(ownedExit, 'killed Docker process join', 1_000);
        } catch {
          failures.push('Docker-process');
        }
      }
      child = undefined;
      if (failures.length)
        throw new Error(`Owned component cleanup is unproved at ${failures.join(',')}.`);
    })();
    return closePromise;
  }

  return {
    closure,
    binaryHash,
    releaseEvidence,
    observeImage,
    delegate: {
      effect,
      route: (...args: Parameters<ReturnType<typeof createNanoHostSessionDispatch>['route']>) => {
        if (!transport) throw new Error('Actual Core H2 transport is not connected.');
        return transport.route(...args);
      },
      handle: async (command: NanoHostHarnessCommand) => {
        if (!pipe) throw new Error('Actual Worker Harness pipe is not connected.');
        if (command.operation === 'turn.start') {
          const { turnId, agentSessionId, packageSnapshotId } = command.body;
          if (
            typeof turnId !== 'string' ||
            typeof agentSessionId !== 'string' ||
            typeof packageSnapshotId !== 'string'
          )
            throw new Error('Actual Worker Turn command lacks canonical lineage.');
          actualConsumer = { turnId, agentSessionId, packageSnapshotId };
        }
        return pipe.handle(command);
      },
    },
    providerExpectation: async (accountId: string, accessToken: string) => {
      if (!pipe) throw new Error('Synthetic provider peer is not installed.');
      await pipe.request('provider-expectation', { accountId, accessToken });
    },
    providerFacts: async () => {
      if (!pipe) throw new Error('Synthetic provider peer is not installed.');
      return pipe.request('provider-facts', null) as Promise<{
        initialTokenRequests: number;
        refreshedTokenRequests: number;
        accountMatched: boolean;
        unexpectedAuthorization: boolean;
      }>;
    },
    hasNativeAuthFile: async (threadId: string) => {
      const path = join(worker, 'openkit/threads', threadId, 'codex/native/auth.json');
      try {
        await access(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw new Error('Owned native auth-file presence could not be observed.');
      }
    },
    close,
  };
}

/** Records exact copied bytes, independently of the immutable image address. */
async function hashTree(
  root: string,
  relativePath = ''
): Promise<Array<{ path: string; sha256: string }>> {
  const result: Array<{ path: string; sha256: string }> = [];
  for (const item of await readdir(join(root, relativePath), { withFileTypes: true })) {
    const path = join(relativePath, item.name);
    if (item.isDirectory()) result.push(...(await hashTree(root, path)));
    else if (item.isFile())
      result.push({
        path,
        sha256: createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      });
    else throw new Error('Candidate closure contains a non-regular entry.');
  }
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Uses only an owned empty Docker config and the explicitly named local daemon. */
function dockerArguments(config: string, command: string[]) {
  return ['--host', 'unix:///var/run/docker.sock', '--config', config, ...command];
}

/** Reads only a named projection; child error objects and output never enter diagnostics. */
function dockerMetadata(
  config: string,
  command: string[],
  milliseconds = 20_000,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error('Owned Docker metadata was cancelled.'));
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('docker', dockerArguments(config, command), {
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: dirname(config),
          TMPDIR: dirname(config),
          LANG: 'C',
          LC_ALL: 'C',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(milliseconds)])
          : AbortSignal.timeout(milliseconds),
        killSignal: 'SIGKILL',
      });
    } catch {
      reject(new Error('Owned Docker metadata prerequisite failed.'));
      return;
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let failed = false;
    child.once('error', () => {
      failed = true;
    });
    const streamFailed = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    child.stdout?.once('error', streamFailed);
    child.stderr?.once('error', streamFailed);
    child.stdout?.on('data', (value: Buffer) => {
      if (byteLength + value.length > 16 * 1024) {
        failed = true;
        child.kill('SIGKILL');
      } else {
        byteLength += value.length;
        chunks.push(Buffer.from(value));
      }
    });
    // Values and arbitrary Docker error payloads are never relayed or retained.
    child.stderr?.resume();
    child.once('close', (code) => {
      if (code === 0 && !failed && !signal?.aborted) {
        try {
          resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim());
          return;
        } catch {
          /* A malformed projection is a fixed, value-free prerequisite failure. */
        }
      }
      reject(new Error('Owned Docker metadata prerequisite failed.'));
    });
  });
}

/** Parses only JSON string lines; callers validate their closed names before reading any value. */
function imageKeyLines(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split('\n').filter((line) => line.length > 0)) {
    const key: unknown = JSON.parse(line);
    if (typeof key !== 'string') throw new Error('Selected image metadata keys are invalid.');
    keys.push(key);
  }
  return keys;
}

/**
 * Measures only the explicitly selected local image through a conditional external image peer.
 * It does not qualify the canonical Rust importer/collector, physical NanoHost, OpenShell or A1.
 */
async function inspectSelectedLocalImage(
  config: string,
  selectedImage: string,
  signal: AbortSignal
) {
  try {
    signal.throwIfAborted();
    if (!/^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/.test(selectedImage))
      throw new Error('Selected image must have an explicit immutable address.');
    const raw: unknown = JSON.parse(
      await dockerMetadata(
        config,
        ['image', 'inspect', '--format', IMAGE_IDENTITY_FORMAT, selectedImage],
        20_000,
        signal
      )
    );
    if (!Array.isArray(raw) || raw.length !== 8)
      throw new Error('Selected image identity is invalid.');
    const [
      imageDigest,
      repoDigests,
      architecture,
      operatingSystem,
      user,
      workingDirectory,
      family,
      version,
    ]: unknown[] = raw;
    if (
      typeof imageDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(imageDigest) ||
      architecture !== 'amd64' ||
      operatingSystem !== 'linux' ||
      user !== '1000:1000' ||
      workingDirectory !== '/tmp/openkit-bootstrap' ||
      family !== 'openkit-worker' ||
      version !== '1' ||
      (selectedImage !== imageDigest &&
        (!Array.isArray(repoDigests) || !repoDigests.some((value) => value === selectedImage)))
    )
      throw new Error('Selected local image prerequisites are unsuitable.');
    const targets = imageKeyLines(
      await dockerMetadata(
        config,
        ['image', 'inspect', '--format', IMAGE_VOLUME_KEYS_FORMAT, selectedImage],
        20_000,
        signal
      )
    );
    const expectedTargets = new Set(['/openkit/threads', '/sandbox', '/workspace']);
    if (
      targets.length !== 3 ||
      new Set(targets).size !== 3 ||
      targets.some((target) => !expectedTargets.has(target))
    )
      throw new Error('Selected image has unsupported automatic volumes.');
    const names = imageKeyLines(
      await dockerMetadata(
        config,
        ['image', 'inspect', '--format', IMAGE_ENV_KEYS_FORMAT, selectedImage],
        20_000,
        signal
      )
    );
    const allowed = new Set(PUBLIC_IMAGE_ENV_NAMES);
    const observed = new Set(names);
    if (
      names.length > 128 ||
      observed.size !== names.length ||
      names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || !allowed.has(name))
    )
      throw new Error('Selected image has an unapproved environment name.');
    // No value command exists before the complete keys-only allowlist check above.
    const lines = (
      await dockerMetadata(
        config,
        ['image', 'inspect', '--format', IMAGE_PUBLIC_ENV_VALUES_FORMAT, selectedImage],
        20_000,
        signal
      )
    )
      .split('\n')
      .filter((line) => line.length > 0);
    const digestLine = lines.shift();
    if (!digestLine || JSON.parse(digestLine) !== imageDigest)
      throw new Error('Selected image identity changed during observation.');
    const entries: Array<[string, string]> = [];
    const returned = new Set<string>();
    for (const line of lines) {
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== 'string')
        throw new Error('Selected image public environment is invalid.');
      const separator = entry.indexOf('=');
      if (separator < 1) throw new Error('Selected image public environment is invalid.');
      const name = entry.slice(0, separator);
      if (!allowed.has(name) || !observed.has(name) || returned.has(name))
        throw new Error('Selected image public environment keys changed.');
      returned.add(name);
      entries.push([name, entry.slice(separator + 1)]);
    }
    if (returned.size !== observed.size || names.some((name) => !returned.has(name)))
      throw new Error('Selected image public environment is incomplete.');
    const validated = NativeEnvironmentValuesSchema.safeParse(Object.fromEntries(entries));
    if (!validated.success)
      throw new Error('Selected image public environment exceeds its contract.');
    const canonical = canonicalNativeEnvironment(validated.data);
    if (Buffer.byteLength(canonical, 'utf8') > 16 * 1024)
      throw new Error('Selected image public environment exceeds its byte bound.');
    const effectResult = {
      digest: imageDigest,
      platform: { architecture, os: operatingSystem },
      storageLayout: {
        family,
        version,
        uid: Number(user.split(':')[0]),
        gid: Number(user.split(':')[1]),
        workingDirectory,
        targets: targets.sort().map((target) => ({ target })),
      },
      environmentDefaults: {
        defaultsDigest: `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
        values: validated.data,
      },
    };
    const image = parseNanoHostImageInspection(effectResult);
    if (!image.environmentDefaults) throw new Error('Measured image defaults are unavailable.');
    return { effectResult, image, defaults: image.environmentDefaults };
  } catch {
    // Neither JSON/schema errors nor spawn errors may expose projected values.
    throw new Error(
      'Selected local image observation failed; inspect its approved metadata prerequisites.'
    );
  }
}

/** Exact strict-loopback namespace; no network object, published port or host socket. */
function workerContainerArguments(input: {
  image: string;
  name: string;
  config: string;
  candidate: string;
  worker: string;
  ipc: string;
  binary: string;
}) {
  const mounts = [
    [input.candidate, '/candidate', true],
    [input.binary, '/usr/local/lib/codex/bin/codex', true],
    [join(input.worker, 'openkit'), '/openkit', false],
    [join(input.worker, 'openkit/threads'), '/openkit/threads', false],
    [join(input.worker, 'workspace'), '/workspace', false],
    [join(input.worker, 'sandbox'), '/sandbox', false],
    [input.ipc, '/fixture-ipc', false],
  ] as const;
  if (mounts.some(([source]) => /[,\r\n]/.test(source)))
    throw new Error('Unsafe component mount path.');
  return dockerArguments(input.config, [
    'run',
    '--name',
    input.name,
    '--label',
    'openkit.test.owner=cred6042b',
    '--cidfile',
    join(input.config, 'container.id'),
    '--rm',
    '--interactive',
    '--init',
    '--pull',
    'never',
    '--network',
    'none',
    '--read-only',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,mode=1777,size=256m',
    ...mounts.flatMap(([source, target, readonly]) => [
      '--mount',
      `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`,
    ]),
    '--workdir',
    '/candidate',
    '--entrypoint',
    '/usr/bin/env',
    input.image,
    '-i',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'HOME=/sandbox',
    'USER=sandbox',
    'LOGNAME=sandbox',
    'LANG=C.UTF-8',
    'TMPDIR=/tmp/openkit-bootstrap',
    'TMP=/tmp/openkit-bootstrap',
    'TEMP=/tmp/openkit-bootstrap',
    'XDG_CONFIG_HOME=/sandbox/.config',
    'XDG_CACHE_HOME=/sandbox/.cache',
    'XDG_DATA_HOME=/sandbox/.local/share',
    '/usr/local/bin/node',
    '/candidate/component-driver.mjs',
  ]);
}

/** Real native H2 connection through an opaque, fixture-owned Unix byte relay. */
async function connectCoreH2(input: {
  socketPath: string;
  app: ReturnType<typeof createApp>;
  coreDb: ReturnType<typeof createTestCoreDb>;
  signal: AbortSignal;
  beforePrivateAcquire(): (response: Response) => Promise<void>;
}) {
  const target = await recordTestNativeRuntimeTarget(input.coreDb);
  const authority = getNanoHostTransportSessionAuthority(input.app);
  const dispatch = createNanoHostSessionDispatch({
    coreDb: input.coreDb,
    sessionAuthority: authority,
  });
  const observedFetch = async (...args: Parameters<typeof input.app.fetch>) => {
    const request = args[0];
    let kind: string | undefined;
    if (new URL(request.url).pathname === '/worker-control/harness/login') {
      const value = (await request.clone().json()) as { kind?: unknown };
      if (typeof value.kind === 'string') kind = value.kind;
    }
    const observe = kind === 'acquire' ? input.beforePrivateAcquire() : undefined;
    const response = await boundedFixtureWait(
      input.app.fetch(...args),
      'actual private Core response',
      15_000,
      input.signal
    );
    // Pass-through observation before response bytes reach the native consumer;
    // no response body, request selector, credential or authority is replaced.
    if (response.ok && observe)
      await boundedFixtureWait(
        observe(response),
        'own acquire evidence observation',
        2_000,
        input.signal
      );
    return response;
  };
  const listener = getRequestListener(observedFetch);
  const sessions = new Set<ServerHttp2Session>();
  let admitted = false;
  const server = createHttp2Server((request, response) => {
    try {
      if (!admitted) {
        const physicalConnection = readNanoHostPhysicalConnectionContext(request);
        if (!physicalConnection) throw new Error('Real Integration H2 session is absent.');
        authority.admit({
          identityId: target.identityId,
          connectionGeneration: target.connectionGeneration,
          physicalConnection,
        });
        admitted = true;
      }
      void Promise.resolve(listener(request, response)).catch(() => response.destroy());
    } catch {
      response.writeHead(403);
      response.end();
    }
  });
  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  const socket = connectSocket(input.socketPath);
  try {
    await boundedFixtureWait(
      once(socket, 'connect'),
      'actual Core H2 socket connection',
      5_000,
      input.signal
    );
    input.signal.throwIfAborted();
    server.emit('connection', socket);
  } catch (error) {
    socket.destroy();
    for (const session of sessions) session.destroy();
    server.close();
    throw error;
  }
  return {
    route: dispatch.route.bind(dispatch),
    close: (() => {
      let joined: Promise<void> | undefined;
      return () => {
        if (joined) return joined;
        joined = (async () => {
          socket.destroy();
          for (const session of sessions) session.destroy();
          server.close();
          await boundedFixtureWait(
            authority.closeAllPhysicalConnections(),
            'actual H2 authority join',
            1_000
          );
        })();
        return joined;
      };
    })(),
  };
}

/** Private pipe carries actual Harness commands/results, never test-created success envelopes. */
function harnessPipe(child: ChildProcessWithoutNullStreams, signal: AbortSignal) {
  let next = 0;
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const installed = Promise.withResolvers<{ nodeVersion: string }>();
  const ready = Promise.withResolvers<void>();
  void installed.promise.catch(() => undefined);
  void ready.promise.catch(() => undefined);
  let failed = false;
  const reader = createInterface({ input: child.stdout });
  const fail = () => {
    failed = true;
    installed.reject(new Error('Owned Worker component process ended before its listener.'));
    ready.reject(new Error('Owned Worker component process ended before Integration readiness.'));
    for (const entry of pending.values())
      entry.reject(new Error('Owned Worker component pipe ended.'));
    pending.clear();
  };
  child.once('error', fail);
  child.once('exit', fail);
  signal.addEventListener('abort', fail, { once: true });
  if (signal.aborted) fail();
  // Never relay native/driver stderr into a test failure or raw qualification log.
  child.stderr.resume();
  reader.on('line', (line) => {
    if (line.length > 4 * 1024 * 1024) {
      fail();
      return;
    }
    try {
      const value = JSON.parse(line) as {
        kind?: string;
        id?: number;
        ok?: boolean;
        value?: unknown;
        nodeVersion?: unknown;
      };
      if (value.kind === 'listener-installed') {
        if (typeof value.nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(value.nodeVersion)) {
          fail();
          return;
        }
        installed.resolve({ nodeVersion: value.nodeVersion });
        return;
      }
      if (value.kind === 'integration-ready') {
        ready.resolve();
        return;
      }
      if (!value.id) {
        fail();
        return;
      }
      const response = pending.get(value.id);
      if (!response) {
        fail();
        return;
      }
      pending.delete(value.id);
      if (value.ok) response.resolve(value.value);
      else response.reject(new Error('Owned Worker component operation refused.'));
    } catch {
      fail();
    }
  });
  const request = (kind: string, value: unknown): Promise<unknown> => {
    if (failed) return Promise.reject(new Error('Owned Worker component pipe is closed.'));
    const id = ++next;
    const response = Promise.withResolvers<unknown>();
    pending.set(id, response);
    child.stdin.write(`${JSON.stringify({ id, kind, value })}\n`, (error) => {
      if (error) fail();
    });
    return boundedFixtureWait(response.promise, 'actual Worker pipe reply', 20_000, signal);
  };
  return {
    installed: installed.promise,
    ready: ready.promise,
    handle: (command: NanoHostHarnessCommand) =>
      request('handle', command) as Promise<NanoHostHarnessResult>,
    request,
    close: () => {
      signal.removeEventListener('abort', fail);
      fail();
      reader.close();
    },
  };
}

/** Uses the actual current Worker and an injected real Codex factory with only owned loopback transport. */
async function componentDriver() {
  const { WorkerHarness, openSandboxIntegration, WORKER_ADAPTERS } = await import(
    '@openkit/worker-shim'
  );
  // This is the actual candidate factory module, not a native or authorization double.
  const codexModuleUrl = new URL(
    './adapters/codex.js',
    import.meta.resolve('@openkit/worker-shim')
  );
  const {
    createCodexResidentAdapter,
  }: typeof import('../../../packages/worker-shim/dist/adapters/codex.js') = await import(
    codexModuleUrl.href
  );
  const { workerThreadRuntimeRoot } = await import('@openkit/worker-protocol');
  const net = await import('node:net');
  const http = await import('node:http');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const readline = await import('node:readline');
  await fs.mkdir('/tmp/openkit-bootstrap', { mode: 0o700, recursive: true });
  const providerTokens: string[] = [];
  let providerAccount = '';
  const providerFacts = {
    initialTokenRequests: 0,
    refreshedTokenRequests: 0,
    accountMatched: true,
    unexpectedAuthorization: false,
  };
  // This is the sole Worker-side provider double. It cannot answer a native RPC,
  // invent a quota observation, authorize Core use or receive a refresh token.
  const upgradedSockets = new Set<Duplex>();
  const peer = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.includes('responses')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    let bytes = 0;
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) {
        response.writeHead(413);
        response.end();
        return;
      }
    }
    providerFacts.accountMatched &&= request.headers['chatgpt-account-id'] === providerAccount;
    const index = providerTokens.findIndex(
      (token) => request.headers.authorization === `Bearer ${token}`
    );
    if (index < 0) {
      providerFacts.unexpectedAuthorization = true;
      response.writeHead(403);
      response.end('{}');
      return;
    }
    if (index === 0) {
      providerFacts.initialTokenRequests += 1;
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"error":{"code":"token_expired","message":"Synthetic token expiry."}}');
      return;
    }
    providerFacts.refreshedTokenRequests += 1;
    const item = {
      id: 'msg_component',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Synthetic native Login reply.', annotations: [] }],
    };
    const payload = {
      id: 'resp_component',
      status: 'completed',
      output: [item],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    };
    const events = [
      { type: 'response.created', response: { id: payload.id, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: 'Synthetic native Login reply.',
      },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: payload },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    );
  });
  // HTTP 426 asks the actual pin to select its own HTTP/SSE fallback.
  peer.on('upgrade', (_request, socket) => {
    upgradedSockets.add(socket);
    socket.once('error', () => socket.destroy());
    socket.once('close', () => upgradedSockets.delete(socket));
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    peer.once('error', reject);
    peer.listen(17894, '127.0.0.1', resolve);
  });
  const integration = await openSandboxIntegration();
  const sockets = new Set<Socket>();
  const relay = net.createServer({ allowHalfOpen: true }, (incoming) => {
    const outgoing = net.connect(17891, '127.0.0.1');
    sockets.add(incoming);
    sockets.add(outgoing);
    for (const socket of [incoming, outgoing]) {
      socket.once('error', () => {
        incoming.destroy();
        outgoing.destroy();
      });
      socket.once('close', () => sockets.delete(socket));
    }
    incoming.pipe(outgoing).pipe(incoming);
  });
  await new Promise<void>((resolve, reject) => {
    relay.once('error', reject);
    relay.listen('/fixture-ipc/integration.sock', resolve);
  });
  process.stdout.write(
    `${JSON.stringify({ kind: 'listener-installed', nodeVersion: process.version })}\n`
  );
  await integration.ready;
  const harness = new WorkerHarness({
    integration,
    adapters: {
      ...WORKER_ADAPTERS,
      codex: createCodexResidentAdapter({
        binaryPath: '/usr/local/lib/codex/bin/codex',
        nativeLoginTransportBaseUrl: 'http://127.0.0.1:17894',
      }),
    },
  });
  process.stdout.write(`${JSON.stringify({ kind: 'integration-ready' })}\n`);
  const reader = readline.createInterface({ input: process.stdin });
  const invocations = new Set<Promise<void>>();
  try {
    for await (const line of reader) {
      const frame = JSON.parse(line) as { id: number; kind: string; value: unknown };
      const invocation = (async () => {
        try {
          let value: unknown;
          if (frame.kind === 'provider-expectation') {
            const expected = frame.value as { accountId: string; accessToken: string };
            if (
              Object.keys(expected).sort().join(',') !== 'accessToken,accountId' ||
              typeof expected.accountId !== 'string' ||
              typeof expected.accessToken !== 'string' ||
              !expected.accountId ||
              !expected.accessToken ||
              expected.accessToken.length > 65536
            )
              throw new Error('Invalid synthetic provider expectation.');
            if (providerAccount && expected.accountId !== providerAccount)
              throw new Error('Synthetic provider account unexpectedly changed.');
            providerAccount = expected.accountId;
            providerTokens.push(expected.accessToken);
            value = null;
          } else if (frame.kind === 'provider-facts') value = { ...providerFacts };
          else if (frame.kind === 'handle') {
            const command = frame.value as NanoHostHarnessCommand;
            if (command.operation === 'session.open') {
              const body = command.body as { threadId: string; adapterId: string };
              const state = path.join(
                workerThreadRuntimeRoot(body.threadId, body.adapterId),
                'native'
              );
              await fs.mkdir(state, { mode: 0o700, recursive: true });
              // Only the owned native state: no ambient home, config or auth-file read.
              await fs.writeFile(
                path.join(state, 'config.toml'),
                'chatgpt_base_url = "http://127.0.0.1:17894"\n[features]\nresponses_websockets = false\nresponses_websockets_v2 = false\n',
                { flag: 'wx' }
              );
            }
            value = await harness.handle(command);
          } else throw new Error('Unknown fixture pipe operation.');
          process.stdout.write(`${JSON.stringify({ id: frame.id, ok: true, value })}\n`);
        } catch {
          process.stdout.write(`${JSON.stringify({ id: frame.id, ok: false })}\n`);
        }
      })();
      // Side-band outside-provider expectations must remain responsive while an
      // actual native start waits on Core OAuth. Core still serializes Harness commands.
      invocations.add(invocation);
      void invocation.finally(() => invocations.delete(invocation));
    }
  } finally {
    reader.close();
    await Promise.allSettled(invocations);
    await integration.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      relay.close((error) => (error ? reject(error) : resolve()))
    );
    await Promise.all(
      [...upgradedSockets].map(
        (socket) =>
          new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('Synthetic Upgrade socket did not close.')),
              1_000
            );
            socket.once('close', () => {
              clearTimeout(timeout);
              resolve();
            });
            socket.destroy();
          })
      )
    );
    peer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      peer.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
