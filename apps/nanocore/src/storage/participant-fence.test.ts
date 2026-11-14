// openkit-test-platform: posix
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import {
  composeWorkspaceMcpCatalog,
  createMcpConfig,
  updateMcpBinding,
} from '../catalog/resource-catalog.js';
import { OperationError } from '../operation-error.js';
import {
  createDefaultWorkerMcpGateway,
  WorkerMcpGatewayCallError,
} from '../runtime/worker-mcp-gateway.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import {
  createWorkspaceBackup,
  readBlockers,
  WORKSPACE_BACKUP_POLICY,
} from './workspace-backup.js';
import { withVerifiedWorkspaceSnapshotSource } from './workspace-backup-bundle.js';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const outcome = <T>(original: Promise<T>): Promise<Outcome<T>> =>
  original.then<Outcome<T>, Outcome<T>>(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  );

// Test-owned scheduling only: release the ORIGINAL phase after this window,
// independently of Tool settlement. This is not a Tool or product latency bound.
const OBSERVATION_WINDOW_MS = 250;

let cleanupCurrent: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanupCurrent?.();
  cleanupCurrent = undefined;
});

/** Keeps deciding evidence outside the prepared invocation root's automatic removal. */
function retainedNamespace(): string {
  const invocation = tmpdir();
  const parent = dirname(invocation);
  const uid = process.getuid?.();
  const own = lstatSync(invocation);
  const outer = lstatSync(parent);
  if (
    uid === undefined ||
    !basename(invocation).startsWith('openkit-vitest-') ||
    realpathSync(invocation) !== invocation ||
    realpathSync(parent) !== parent ||
    !own.isDirectory() ||
    own.isSymbolicLink() ||
    own.uid !== uid ||
    (own.mode & 0o7777) !== 0o700 ||
    !outer.isDirectory() ||
    outer.isSymbolicLink() ||
    own.dev !== outer.dev ||
    (outer.uid !== uid && !(outer.uid === 0 && (outer.mode & 0o7777) === 0o1777)) ||
    ((outer.mode & 0o022) !== 0 && (outer.mode & 0o1000) === 0)
  )
    throw new Error('UNKNOWN: prepared invocation namespace identity is unavailable.');
  const root = mkdtempSync(join(parent, 'storecore2-row3-participant-retained-'));
  console.log('ROW3_PARTICIPANT_NAMESPACE', root);
  const made = lstatSync(root);
  if (
    realpathSync(root) !== root ||
    !made.isDirectory() ||
    made.isSymbolicLink() ||
    made.uid !== uid ||
    (made.mode & 0o7777) !== 0o700 ||
    made.dev !== outer.dev
  )
    throw new Error(`UNKNOWN: retain unqualified namespace ${root}`);
  return root;
}

// DX Snapshot Cut And Capture Protection; BACKUP Local Hot Capture; Core Storage:
// every physical mutable-file writer must be excluded at the common cut, or
// capture must refuse. This is an idle participant case, not busy Worker proof.
it('excludes the original gateway-owned MCP file publisher from the capture cut or refuses capture', async () => {
  let stopped = false;
  let passed = false;
  let namespace: string | undefined;
  let core: ReturnType<typeof openCoreDb> | undefined;
  let gateway: ReturnType<typeof createDefaultWorkerMcpGateway> | undefined;
  let observer: { mockRestore(): void } | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let releasePhase: (() => void) | undefined;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const pending: Promise<void>[] = [];
  const cleanupErrors: unknown[] = [];
  const originalErrors: unknown[] = [];
  const facts: Record<string, unknown> = {};

  /** Registers before invoking each original owner, including setup and synchronous bridges. */
  function start<T>(call: () => T): T {
    if (stopped) throw new Error('UNKNOWN: original producer offered after teardown.');
    const joined = Promise.withResolvers<void>();
    pending.push(joined.promise);
    try {
      const original = call();
      void Promise.resolve(original).then(
        () => joined.resolve(),
        (error: unknown) => {
          originalErrors.push(error);
          joined.resolve();
        }
      );
      return original;
    } catch (error) {
      originalErrors.push(error);
      joined.resolve();
      throw error;
    }
  }

  const cleanup = () => {
    stopped = true;
    releasePhase?.(); // Always free the original capture before joining deferred original work.
    cleanupPromise ??= (async () => {
      await Promise.all(pending);
      observer?.mockRestore();
      const dispose = async (call: () => unknown) => {
        try {
          await call();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      if (gateway) await dispose(() => gateway!.close());
      await dispose(() => closeWorkspaceProductReadHandles());
      await dispose(() => {
        if (core?.sqlite.open) core.sqlite.close();
      });
      await dispose(() => shutdownControlStoreWorkerClient());
      facts.originalErrors = originalErrors;
      facts.cleanupErrors = cleanupErrors;
      facts.passed = passed;
      console.log(
        'ROW3_PARTICIPANT_FACTS',
        JSON.stringify(facts, (_key, value) =>
          value instanceof Error
            ? { ...value, name: value.name, message: value.message, stack: value.stack }
            : value
        )
      );
      // A clean run without a witnessed OLD overlap is UNKNOWN for the OLD gate.
      // Retain even a Vitest pass until the independent author classifies its facts.
      if (namespace)
        console.log(
          'RETAIN namespace and enclosing runtime until independent classification:',
          namespace
        );
      if (cleanupErrors.length)
        throw new AggregateError(cleanupErrors, 'Original owner cleanup failed.');
    })();
    return cleanupPromise;
  };
  cleanupCurrent = cleanup;

  try {
    namespace = start(retainedNamespace);
    const dataRoot = join(namespace, 'source');
    const store = await start(() => createDemoStore({ dataRoot }));
    core = start(() => openCoreDb(dataRoot));
    const ownerId = start(() => ensureLocalUser(core!));
    start(() =>
      recordWorkspaceOwnerMembership({
        coreDb: core!,
        workspaceId: DEMO_WORKSPACE_ID,
        ownerUserId: ownerId,
      })
    );
    const gate = new WorkspaceMutationAdmission();
    store.setWorkspaceMutationAdmission(gate);
    const created = start(() =>
      createMcpConfig({
        dataRoot,
        owner: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
        createdAt: new Date().toISOString(),
        declaration: {
          kind: 'stdio',
          command: process.execPath,
          args: [
            fileURLToPath(new URL('../test-support/mcp-stdio-stub.mjs', import.meta.url)),
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Gateway-owned literal expansion.
            '${PLUGIN_DATA}/calls.log',
          ],
        },
        displayName: 'Original capture participant',
        expectedRevision: 0,
        id: 'capture-publisher',
        allowedTools: ['echo'],
        selectCurrent: true,
      })
    );
    const binding = created.catalog.mcp.bindings[0]!;
    start(() =>
      updateMcpBinding({
        dataRoot,
        owner: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
        entryId: 'capture-publisher',
        expectedRevision: 1,
        binding: { ...binding, enabled: true, timeoutMs: 5_000 },
      })
    );
    gateway = start(() => createDefaultWorkerMcpGateway(core));
    const server = resolveWorkspaceMcpServer({
      catalog: composeWorkspaceMcpCatalog({ dataRoot, workspaceId: DEMO_WORKSPACE_ID }),
      serverId: 'capture-publisher',
    });
    const target = { workspaceId: DEMO_WORKSPACE_ID, server };
    const call = (message: string) =>
      start(() => gateway!.callTool({ ...target, toolName: 'echo', arguments: { message } }));
    const before = await call('before-cut');
    expect(before.structuredContent).toMatchObject({
      message: 'before-cut',
      pid: expect.any(Number),
    });
    const relative = `catalog/mcp-data/${binding.packageDataKey}/calls.log`;
    const log = join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID, relative);
    expect(readFileSync(log, 'utf8')).toBe('before-cut\n');
    expect(gateway.getServerHealth(target)).toBe('ready');
    expect(readBlockers({ coreDb: core, store, workspaceId: DEMO_WORKSPACE_ID })).toEqual([]);
    facts.before = before;
    facts.relative = relative;

    const backupId = allocateEntityId('wsbak');
    const bundleRoot = join(dataRoot, 'server/backups/workspaces', DEMO_WORKSPACE_ID, backupId);
    const stagingParent = join(namespace, 'staging');
    mkdirSync(stagingParent);
    const input = {
      ...WORKSPACE_BACKUP_POLICY,
      source: {
        kind: 'live-workspace' as const,
        dataRoot,
        coreDb: core,
        store,
        mutationAdmission: gate,
        actor: { kind: 'local' as const, userId: ownerId },
      },
      workspaceId: DEMO_WORKSPACE_ID,
      backupId,
      purpose: 'backup' as const,
      expectedSourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      bundleRoot,
      stagingParent,
      admission: new FileStorageAdmission(namespace, () => 0n),
      expectedRelease: { version: '0.1.0-row3-oracle', buildId: 'independent-participant-fence' },
    };
    let entered = false;
    let during: Outcome<Awaited<ReturnType<typeof call>>> | undefined;
    let duringObservation: Promise<void> | undefined;
    let phaseError: unknown;
    let phaseReleased = false;
    const emit = Worker.prototype.emit;
    observer = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
      this: Worker,
      event,
      ...args
    ) {
      const frame = args[0];
      if (
        !stopped &&
        !entered &&
        event === 'message' &&
        frame?.kind === 'phase' &&
        frame.phase === 'db-backup' &&
        frame.path === workspaceDbPath(dataRoot, DEMO_WORKSPACE_ID)
      ) {
        entered = true;
        const originalWorker = this;
        const forwarded = Promise.withResolvers<void>();
        pending.push(forwarded.promise); // Register the original phase's delivery before offering work.
        releasePhase = () => {
          if (phaseReleased) return;
          if (releaseTimer) clearTimeout(releaseTimer);
          try {
            facts.gateClosedBeforePhaseRelease = gate.isClosed(DEMO_WORKSPACE_ID);
            facts.bytesBeforePhaseRelease = readFileSync(log, 'utf8');
            facts.phaseReleasedByCleanup = stopped;
          } catch (error) {
            phaseError ??= error;
          } finally {
            phaseReleased = true;
            try {
              emit.call(originalWorker, event, ...args); // Same original frame, exactly once.
            } catch (error) {
              phaseError ??= error;
            } finally {
              forwarded.resolve();
            }
          }
        };
        // Install the independent release BEFORE evaluating the original producer.
        releaseTimer = setTimeout(releasePhase, OBSERVATION_WINDOW_MS);
        try {
          facts.gateClosedAtOffer = gate.isClosed(DEMO_WORKSPACE_ID);
          facts.duringOfferBytes = readFileSync(log, 'utf8');
          duringObservation = outcome(call('during-cut')).then((observed) => {
            during = observed;
            facts.gateClosedAtSettlement = gate.isClosed(DEMO_WORKSPACE_ID);
            facts.phaseReleasedAtSettlement = phaseReleased;
            facts.duringSettlementBytes = readFileSync(log, 'utf8');
            facts.during = during;
          });
          // Record the observation continuation as well as its original producer.
          const joined = Promise.withResolvers<void>();
          pending.push(joined.promise);
          void duringObservation.then(
            () => joined.resolve(),
            (error: unknown) => {
              phaseError ??= error;
              joined.resolve();
            }
          );
        } catch (error) {
          phaseError ??= error;
          releasePhase();
        }
        return true;
      }
      return emit.call(this, event, ...args);
    });
    const captured = await outcome(start(() => createWorkspaceBackup(input)));
    // Capture can now release its cut independently of the original Tool.
    // Join that same call afterwards; never cancel it or impose a result deadline.
    await duringObservation;
    facts.captured = captured;
    facts.entered = entered;
    facts.phaseError = phaseError;
    if (phaseError) throw phaseError;
    if (!captured.ok) {
      // An identified unfreezable participant may truthfully refuse capture.
      // A setup/collection/format/unknown failure cannot satisfy this branch.
      expect(captured.error).toBeInstanceOf(OperationError);
      expect(captured.error).toMatchObject({
        code: 'workspace_blocked',
        status: 409,
        details: { workspaceId: DEMO_WORKSPACE_ID, operation: 'capture', retryable: false },
      });
      expect(existsSync(join(bundleRoot, 'seal.json'))).toBe(false);
      facts.observation = 'truthful-capture-refusal';
    } else {
      expect(entered, 'The original capture must reach its real Workspace copy boundary.').toBe(
        true
      );
      expect(facts.gateClosedAtOffer).toBe(true);
      expect(facts.duringOfferBytes).toBe('before-cut\n');
      expect(facts.phaseReleasedByCleanup).toBe(false);
      expect(captured.value).toMatchObject({ purpose: 'backup', disposition: 'sealed' });
      await start(() =>
        withVerifiedWorkspaceSnapshotSource(
          {
            ...input,
            dataRoot,
            source: { kind: 'local-snapshot', workspaceId: DEMO_WORKSPACE_ID, backupId },
          },
          async (bundle) => {
            const chunks: Buffer[] = [];
            for await (const chunk of bundle.readFile(relative)) chunks.push(Buffer.from(chunk));
            facts.verifiedCutBytes = Buffer.concat(chunks).toString('utf8');
            expect(facts.verifiedCutBytes).toBe('before-cut\n');
          }
        )
      );
      const publishedBytes = 'before-cut\nduring-cut\n';
      const inCutEffect =
        (facts.gateClosedBeforePhaseRelease === true &&
          facts.bytesBeforePhaseRelease === publishedBytes) ||
        (facts.gateClosedAtSettlement === true && facts.duringSettlementBytes === publishedBytes);
      facts.inCutEffect = inCutEffect;
      facts.observation = inCutEffect
        ? 'actual-in-cut-publication'
        : 'no-in-cut-publication-observed';
      // This assertion decides only actual bytes observed with the real gate closed.
      // A response after release alone cannot establish when its earlier effect ran.
      expect(inCutEffect, 'Original MCP bytes were published inside the held capture cut.').toBe(
        false
      );
      expect(during).toBeDefined();
      if (!during) throw new Error('UNKNOWN: original Tool settlement was not observed.');
      if (!during.ok) {
        const frozen =
          during.error instanceof OperationError && during.error.code === 'workspace_frozen';
        const uncontacted =
          during.error instanceof WorkerMcpGatewayCallError &&
          during.error.upstreamEffect === 'not-contacted';
        expect(frozen || uncontacted, 'The original refusal must prove no upstream contact.').toBe(
          true
        );
        expect(facts.duringSettlementBytes).toBe('before-cut\n');
        facts.observation = 'typed-precontact-refusal';
      } else {
        expect(during.value.structuredContent).toMatchObject({
          message: 'during-cut',
          pid: expect.any(Number),
        });
        expect(facts.gateClosedAtSettlement).toBe(false);
        expect(facts.duringSettlementBytes).toBe(publishedBytes);
        // Allowed deferred outcome. On OLD this is UNKNOWN/no demonstrated gap,
        // not an exclusion proof or permission to retry this window for color.
        facts.observation = 'success-after-release-no-in-cut-effect-observed';
      }
    }
    expect(gate.isClosed(DEMO_WORKSPACE_ID)).toBe(false);
    const after = await call('after-cut');
    expect(after.structuredContent).toMatchObject({
      message: 'after-cut',
      pid: expect.any(Number),
    });
    expect(readFileSync(log, 'utf8')).toBe(
      during?.ok ? 'before-cut\nduring-cut\nafter-cut\n' : 'before-cut\nafter-cut\n'
    );
    facts.after = after;
    passed = true;
  } finally {
    await cleanup();
  }
});
