import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalNativeEnvironment } from '@openkit/worker-protocol';
import { afterAll } from 'vitest';
import type { AgentManifest } from '../agents/manifest.js';
import type { ResolveAgentEnvironmentPackageInput } from '../runtime/agent-environment.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target.js';
import {
  admitWorkerImageEnvironment,
  writeWorkerImageSettlement,
} from '../runtime/worker-image-settlements.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { materializeRuntimeImage } from '../worker-environments/worker-environment-preparation.js';

/** Explicit synthetic confirmed image evidence for tests whose subject is another contract. */
export function admitTestNativeEnvironment(
  coreDb: CoreDb,
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
  const candidate = {
    authoredArtifactId: `ar_test_${requestId}`,
    authoredArtifactVersion: 1 as const,
    authoredContentDigest: inputDigest,
    inputDigest,
  };
  writeWorkerImageSettlement(coreDb, {
    ...candidate,
    requestId,
    operation: image.kind === 'build' ? 'image.build' : 'image.acquire',
    outcome: { kind: 'success', imageDigest },
  });
  admitWorkerImageEnvironment(coreDb, candidate, { imageDigest, defaultsDigest, values });
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
  const prepared = <I extends Pick<ResolveAgentEnvironmentPackageInput, 'agentSetup' | 'coreDb'>>(
    input: I
  ) => {
    const coreDb = input.coreDb ?? fixtureDb;
    if (input.agentSetup?.manifest) admitTestNativeEnvironment(coreDb, input.agentSetup.manifest);
    return { ...input, coreDb };
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
 * @returns The current target record; existing evidence is left untouched.
 */
export function recordTestNativeRuntimeTarget(coreDb: CoreDb, targetId = 'target_local') {
  const existing = getNanoHostRuntimeTarget(coreDb, targetId);
  if (existing) return existing;
  const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: readDataRootLayoutMarker(coreDb.dataRoot).deploymentId,
    identityId: 'identity_local',
    observedAt: new Date().toISOString(),
    targetId,
  });
  return upsertNanoHostRuntimeTarget(coreDb, {
    ...target,
    freshEmpty: true,
    observedAt: new Date().toISOString(),
    physicalEpoch: 'a'.repeat(64),
    predecessorFenced: true,
    ready: true,
  });
}
