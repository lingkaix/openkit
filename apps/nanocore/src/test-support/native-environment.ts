import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { allocateEntityId, workspaceIdForOwner } from '@openkit/protocol';
import { canonicalNativeEnvironment } from '@openkit/worker-protocol';
import Database from 'better-sqlite3';
import { afterAll } from 'vitest';
import type { AgentManifest } from '../agents/manifest.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { ResolveAgentEnvironmentPackageInput } from '../runtime/agent-environment.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import {
  type AllocateNanoHostRuntimeTargetConnectionGenerationInput,
  getNanoHostRuntimeTarget,
  type RecordNanoHostRuntimeTargetConnectionCloseInput,
  type UpsertNanoHostRuntimeTargetInput,
} from '../runtime/nanohost-runtime-target.js';
import {
  admitWorkerImageEnvironment,
  insertWorkerImageSettlementInTransaction,
  readAdmittedWorkerImageEnvironment,
  readWorkerImageSettlement,
  type WorkerImageSettlement,
  type WorkerImageSettlementIdentity,
} from '../runtime/worker-image-settlements-records.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyMigrations, applyServerOwnerJournal } from '../storage/migrate.js';
import { transitionAdmittedNanoHostRuntimeTarget } from '../storage/nanohost-transport-owner.js';
import type { ControlRuntimeTargetInput } from '../storage/runtime-target-codecs.js';
import { materializeRuntimeImage } from '../worker-environments/worker-environment-preparation.js';

/** Populates metadata-only fixtures through the raw record leaf; this does not prove native image publication. */
export function admitTestNativeEnvironment(
  owner: Pick<CoreDb, 'sqlite'>,
  manifest: Pick<AgentManifest, 'runtime'>,
  values: Record<string, string> = {},
  measuredDigest = `sha256:${'a'.repeat(64)}`
): void {
  const image = materializeRuntimeImage(manifest.runtime.image);
  const inputDigest = commandInputHash(image);
  const imageDigest =
    image.kind === 'reference' && /^sha256:[0-9a-f]{64}$/.test(image.ref)
      ? image.ref
      : measuredDigest;
  const defaultsDigest = `sha256:${createHash('sha256').update(canonicalNativeEnvironment(values)).digest('hex')}`;
  const requestId = createHash('sha256').update(`native-test:${inputDigest}`).digest('hex');
  const prior = readWorkerImageSettlement(owner, requestId);
  const candidate = {
    authoredArtifactId: prior?.authoredArtifactId ?? allocateEntityId('ar'),
    authoredArtifactVersion: 1 as const,
    authoredContentDigest: inputDigest,
    inputDigest,
  };
  const settlement = {
    ...candidate,
    requestId,
    operation: image.kind === 'build' ? ('image.build' as const) : ('image.acquire' as const),
    outcome: { kind: 'success' as const, imageDigest },
  };
  const environment = { imageDigest, defaultsDigest, values };
  // Prepared metadata reads must not acquire a Main writer beside active native Core work.
  if (
    isDeepStrictEqual(prior, settlement) &&
    isDeepStrictEqual(readAdmittedWorkerImageEnvironment(owner, imageDigest), environment)
  )
    return;
  owner.sqlite.transaction(() => {
    insertWorkerImageSettlementInTransaction(owner, settlement);
    admitWorkerImageEnvironment(owner, candidate, environment);
  })();
}

/** Seeds synthetic image evidence in the shipped NanoHost file opened by the test's Worker. */
export async function admitTestNativeEnvironmentForRoot(
  coreDb: CoreDb,
  manifest: Pick<AgentManifest, 'runtime'>,
  values?: Record<string, string>,
  measuredDigest?: string
) {
  const { seedAdmittedTestNanoHost } = await import('./admitted-nanohost.js');
  return seedAdmittedTestNanoHost(coreDb, (sqlite) =>
    admitTestNativeEnvironment({ sqlite }, manifest, values, measuredDigest)
  );
}

/** A real migrated Core database for metadata-only tests that previously needed no image evidence. */
export function createTestNativeEnvironmentDb(): CoreDb {
  const db = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-test-native-evidence-')));
  applyMigrations(db);
  afterAll(() => {
    db.sqlite.close();
    rmSync(db.dataRoot, { recursive: true, force: true });
  });
  return db;
}

/** Supplies confirmed image defaults and explicit default-off capture to fixtures of other contracts. */
export function withTestPreparedNativeEnvironment<
  T extends Pick<
    typeof import('../runtime/agent-environment.js'),
    | 'resolveAgentSessionCompatibilityKey'
    | 'resolveAgentEnvironmentPackageMetadata'
    | 'resolveAgentEnvironmentPackage'
  >,
>(actual: T) {
  const fixtureDb = createTestNativeEnvironmentDb();
  const nanoHostDb = new Database(':memory:');
  afterAll(() => nanoHostDb.close());
  applyServerOwnerJournal(nanoHostDb, 'nanohost', () => new Database(':memory:'));
  const readFixtureEnvironment: NonNullable<
    ResolveAgentEnvironmentPackageInput['readNanoHostEnvironment']
  > = (query) => {
    nanoHostDb.pragma('query_only = ON');
    try {
      return { state: 'ready', value: query(nanoHostDb) };
    } finally {
      nanoHostDb.pragma('query_only = OFF');
    }
  };
  const prepared = <
    I extends Pick<ResolveAgentEnvironmentPackageInput, 'agentSetup' | 'coreDb'> &
      Partial<
        Pick<
          ResolveAgentEnvironmentPackageInput,
          'readNanoHostEnvironment' | 'readRuntimeConfig' | 'workspaceDataSourceCatalog' | 'turn'
        >
      >,
  >(
    input: I
  ) => {
    const coreDb = input.coreDb ?? fixtureDb;
    if (!input.readNanoHostEnvironment && input.agentSetup?.manifest)
      admitTestNativeEnvironment({ sqlite: nanoHostDb }, input.agentSetup.manifest);
    // Other-contract source fixtures explicitly install their supplied catalog as current authority.
    // Tests of missing, changed or conditional authority call the production resolver directly.
    const readRuntimeConfig =
      input.readRuntimeConfig ??
      (input.workspaceDataSourceCatalog && input.turn
        ? () =>
            createInMemoryRuntimeConfigSnapshot({
              dataRoot: null,
              agentManifests: [input.agentSetup.manifest],
              workspaceDataSourceCatalogs: [
                {
                  workspaceId: workspaceIdForOwner(input.turn!.owner),
                  path: 'data-sources.jsonc',
                  catalog: input.workspaceDataSourceCatalog!,
                },
              ],
            })
        : undefined);
    return {
      ...input,
      coreDb,
      readNanoHostEnvironment: input.readNanoHostEnvironment ?? readFixtureEnvironment,
      ...(readRuntimeConfig ? { readRuntimeConfig } : {}),
    };
  };
  return {
    ...actual,
    resolveAgentSessionCompatibilityKey: (
      input: Parameters<T['resolveAgentSessionCompatibilityKey']>[0]
    ) => actual.resolveAgentSessionCompatibilityKey(prepared(input)),
    resolveAgentEnvironmentPackageMetadata: (
      input: Parameters<T['resolveAgentEnvironmentPackageMetadata']>[0]
    ) => actual.resolveAgentEnvironmentPackageMetadata(prepared(input)),
    resolveAgentEnvironmentPackage: (
      input: Omit<ResolveAgentEnvironmentPackageInput, 'captureCoverage'> &
        Partial<Pick<ResolveAgentEnvironmentPackageInput, 'captureCoverage'>>
    ) =>
      actual.resolveAgentEnvironmentPackage({
        ...prepared(input),
        captureCoverage:
          'captureCoverage' in input ? input.captureCoverage! : { scope: 'server', value: 'off' },
      }),
  };
}

/**
 * Records explicit fresh Native target evidence for a simulated consumer fixture.
 * @param coreDb Caller-owned migrated Core database and deployment.
 * @param targetId Fixture target identity, never a production default.
 * @param options Original fixture identity, epoch and observation clocks when specified.
 * @returns The current target record; existing evidence is left untouched.
 */
export async function recordTestNativeRuntimeTarget(
  coreDb: CoreDb,
  targetId = 'target_local',
  options: {
    readonly deploymentId?: string;
    readonly identityId?: string;
    readonly allocationAt?: string;
    readonly readyAt?: string;
    readonly physicalEpoch?: string;
  } = {}
) {
  const { openAdmittedTestNanoHost } = await import('./admitted-nanohost.js');
  const { value: storage } = await openAdmittedTestNanoHost(coreDb);
  const existing = storage.owner.read((sqlite) => getNanoHostRuntimeTarget({ sqlite }, targetId));
  if (existing.state !== 'ready') throw new Error(`NanoHost target read: ${existing.reason}`);
  if (existing.value) return existing.value;
  const allocated = await transitionAdmittedNanoHostRuntimeTarget(storage, {
    kind: 'allocate',
    deploymentId: options.deploymentId ?? readDataRootLayoutMarker(coreDb.dataRoot).deploymentId,
    identityId: options.identityId ?? 'identity_local',
    observedAt: options.allocationAt ?? new Date().toISOString(),
    targetId,
  });
  if (allocated.state !== 'ready')
    throw new Error(`NanoHost target allocation: ${allocated.reason}`);
  if (!allocated.value) throw new Error('NanoHost target was not allocated.');
  const { connectionGeneration, deploymentId, identityId } = allocated.value;
  const ready = await transitionAdmittedNanoHostRuntimeTarget(storage, {
    kind: 'ready',
    connectionGeneration,
    deploymentId,
    identityId,
    targetId,
    freshEmpty: true,
    observedAt: options.readyAt ?? new Date().toISOString(),
    physicalEpoch: options.physicalEpoch ?? 'a'.repeat(64),
    predecessorFenced: true,
    ready: true,
  });
  if (ready.state !== 'ready') throw new Error(`NanoHost target readiness: ${ready.reason}`);
  if (!ready.value) throw new Error('NanoHost target readiness was not recorded.');
  return ready.value;
}

/** Applies an exact RuntimeTarget generation change in a disposable admitted root. */
export async function transitionTestNativeRuntimeTarget(
  coreDb: CoreDb,
  original: ControlRuntimeTargetInput
) {
  const { openAdmittedTestNanoHost } = await import('./admitted-nanohost.js');
  const { value: storage } = await openAdmittedTestNanoHost(coreDb);
  const result = await transitionAdmittedNanoHostRuntimeTarget(storage, original);
  if (result.state !== 'ready') throw new Error(`NanoHost fixture transition: ${result.reason}`);
  if (!result.value) throw new Error('NanoHost fixture transition has no current target.');
  return result.value;
}

/**
 * Applies one retired Core runtime-target writer input to the admitted NanoHost owner of the same root.
 * Copies exactly the fields the retired allocate / ready / close writers posted, so fixtures that spread a
 * current target record keep their original input and the admitted codec stays strict.
 */
export async function transitionTestNativeRuntimeTargetFields(
  kind: 'allocate',
  coreDb: CoreDb,
  input: AllocateNanoHostRuntimeTargetConnectionGenerationInput
): ReturnType<typeof transitionTestNativeRuntimeTarget>;
export async function transitionTestNativeRuntimeTargetFields(
  kind: 'ready',
  coreDb: CoreDb,
  input: UpsertNanoHostRuntimeTargetInput
): ReturnType<typeof transitionTestNativeRuntimeTarget>;
export async function transitionTestNativeRuntimeTargetFields(
  kind: 'close',
  coreDb: CoreDb,
  input: RecordNanoHostRuntimeTargetConnectionCloseInput
): ReturnType<typeof transitionTestNativeRuntimeTarget>;
export async function transitionTestNativeRuntimeTargetFields(
  kind: 'allocate' | 'ready' | 'close',
  coreDb: CoreDb,
  input:
    | AllocateNanoHostRuntimeTargetConnectionGenerationInput
    | UpsertNanoHostRuntimeTargetInput
    | RecordNanoHostRuntimeTargetConnectionCloseInput
) {
  if (kind === 'allocate') {
    const value = input as AllocateNanoHostRuntimeTargetConnectionGenerationInput;
    return transitionTestNativeRuntimeTarget(coreDb, {
      kind,
      targetId: value.targetId,
      identityId: value.identityId,
      deploymentId: value.deploymentId,
      observedAt: value.observedAt,
    });
  }
  if (kind === 'ready') {
    const value = input as UpsertNanoHostRuntimeTargetInput;
    return transitionTestNativeRuntimeTarget(coreDb, {
      kind,
      targetId: value.targetId,
      identityId: value.identityId,
      deploymentId: value.deploymentId,
      observedAt: value.observedAt,
      connectionGeneration: value.connectionGeneration,
      predecessorFenced: value.predecessorFenced,
      ready: value.ready,
      freshEmpty: value.freshEmpty,
      physicalEpoch: value.physicalEpoch,
    });
  }
  const value = input as RecordNanoHostRuntimeTargetConnectionCloseInput;
  return transitionTestNativeRuntimeTarget(coreDb, {
    kind,
    targetId: value.targetId,
    closedGeneration: value.closedGeneration,
    authoritativeGeneration: value.authoritativeGeneration,
    observedAt: value.observedAt,
  });
}

/**
 * Settles one fixture image result through the production admitted settlement owner of the same root.
 * Replaces the retired Core image writer in fixtures whose injected NanoHost dispatch models the outside peer:
 * the result is retained only after the current admitted target and, for acquisition, the original Core
 * journal decision accept it.
 * @param coreDb Caller-owned migrated Core database whose admitted NanoHost owner holds the target.
 * @param settlement Exact receiver result the injected peer returned.
 * @param targetId Fixture target identity recorded by recordTestNativeRuntimeTarget.
 */
export async function settleTestNativeImageResult(
  coreDb: CoreDb,
  settlement: WorkerImageSettlement,
  targetId = 'target_local'
) {
  const { reopenAdmittedTestNanoHost } = await import('./admitted-nanohost.js');
  const { settlePreparedNanoHostImage } = await import('../app.js');
  const storage = await reopenAdmittedTestNanoHost(coreDb);
  const current = storage.value.owner.read((sqlite) =>
    getNanoHostRuntimeTarget({ sqlite }, targetId)
  );
  if (current.state !== 'ready' || !current.value?.physicalEpoch)
    throw new Error('NanoHost fixture image settlement requires a ready target.');
  const { deploymentId, identityId, connectionGeneration, physicalEpoch } = current.value;
  await settlePreparedNanoHostImage(coreDb, storage, {
    settlement,
    target: { deploymentId, identityId, targetId, connectionGeneration, physicalEpoch },
  });
}

/**
 * Seeds one retained image settlement row in the admitted NanoHost file of the same root.
 * Fixture-only replacement for seeding through the retired Core image writer: no peer effect and no journal.
 * @returns The admitted NanoHost storage the caller can pass to its App.
 */
export async function seedTestNativeImageSettlement(
  coreDb: CoreDb,
  settlement: WorkerImageSettlement
) {
  const { seedAdmittedTestNanoHost } = await import('./admitted-nanohost.js');
  return seedAdmittedTestNanoHost(coreDb, (sqlite) => {
    insertWorkerImageSettlementInTransaction({ sqlite }, settlement);
  });
}

/**
 * Admits confirmed image defaults in the admitted NanoHost file of the same root, through the same records-module
 * stage (`admitWorkerImageEnvironment`) the retired async Core writer posted. Fixture-only: no peer effect.
 */
export async function admitTestNativeImageEnvironment(
  coreDb: CoreDb,
  candidate: WorkerImageSettlementIdentity,
  environment: unknown
) {
  const { seedAdmittedTestNanoHost } = await import('./admitted-nanohost.js');
  return seedAdmittedTestNanoHost(coreDb, (sqlite) => {
    admitWorkerImageEnvironment({ sqlite }, candidate, environment);
  });
}
