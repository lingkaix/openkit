// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import { readNanoHostMeasuredHarnessIdentity } from '../runtime/nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target-records.js';
import { readWorkerImageSettlement } from '../runtime/worker-image-settlements-records.js';
import {
  ControlHarnessLifecycleInputSchema,
  NanoHostLocalHarnessLifecycleInputSchema,
} from './harness-lifecycle-codecs.js';
import { ControlWorkerImageInputSchema } from './worker-image-codecs.js';

it('commits local Harness and image tuples without admitting mixed Core operations', async () => {
  const timestamp = '2026-11-21T00:00:00.000Z';
  const targetId = 'target-native';
  const physicalEpoch = 'f'.repeat(64);
  const imageDigest = `sha256:${'a'.repeat(64)}`;
  const harnessInstanceId = 'harness-native';
  const agentSessionRuntimeBindingId = 'binding-native';
  const inputs = [
    {
      kind: 'runtime.create',
      adapterId: 'codex',
      adapterVersion: 'fixture',
      harnessBindingRef: 'harness-binding',
      harnessCompatibilityKey: 'b'.repeat(64),
      harnessInstanceId,
      imageDigest,
      originPhysicalEpoch: physicalEpoch,
      runtimeTargetId: targetId,
      sandboxBindingRef: 'sandbox-binding',
      sandboxCompatibilityKey: 'c'.repeat(64),
      sandboxIntegrationBindingRef: 'sandbox-integration',
      sandboxRuntimeId: 'sandbox-runtime',
      timestamp,
    },
    {
      kind: 'session-binding.open',
      agentSessionCompatibilityKey: 'd'.repeat(64),
      agentSessionId: 'session-native',
      agentSessionRuntimeBindingId,
      effectiveSetupGeneration: 1,
      harnessInstanceId,
      threadId: 'thread-native',
      timestamp,
      workspaceId: 'workspace-native',
    },
  ].map((input) => NanoHostLocalHarnessLifecycleInputSchema.parse(input));
  const restore = { kind: 'sandbox.restore-admission', sandboxRuntimeId: 'sandbox-runtime' };
  expect(ControlHarnessLifecycleInputSchema.safeParse(restore).success).toBe(true);
  expect(NanoHostLocalHarnessLifecycleInputSchema.safeParse(restore).success).toBe(false);
  const image = {
    authoredArtifactId: 'ar_00000000-0000-7ce7-b2d8-9d02176fb5b5',
    authoredArtifactVersion: 1,
    authoredContentDigest: `sha256:${'b'.repeat(64)}`,
    inputDigest: `sha256:${'c'.repeat(64)}`,
    outcome: { kind: 'success', imageDigest },
  };
  const buildRequestId = '1'.repeat(64);
  const acquisitionRequestId = '2'.repeat(64);
  const build = ControlWorkerImageInputSchema.parse({
    kind: 'settlement',
    value: { ...image, operation: 'image.build', requestId: buildRequestId },
  });
  const acquisition = ControlWorkerImageInputSchema.parse({
    kind: 'settlement',
    value: { ...image, operation: 'image.acquire', requestId: acquisitionRequestId },
  });

  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-serving-local-'));
  const path = join(root, 'state.sqlite');
  try {
    const sqlite = new Database(path);
    try {
      migrate(drizzle(sqlite), {
        migrationsFolder: fileURLToPath(
          new URL('../../drizzle/extensions/nanohost/', import.meta.url)
        ),
      });
      const owner = { sqlite };
      const target = allocateNanoHostRuntimeTargetConnectionGeneration(owner, {
        deploymentId: 'deployment-native',
        identityId: 'identity-native',
        observedAt: timestamp,
        targetId,
      });
      upsertNanoHostRuntimeTarget(owner, {
        ...target,
        freshEmpty: true,
        physicalEpoch,
        predecessorFenced: true,
        ready: true,
      });
    } finally {
      sqlite.close();
    }
    const worker = new Worker(
      `
      const assert = require('node:assert/strict');
      const { workerData } = require('node:worker_threads');
      (async () => {
        const { applyNanoHostLocalHarnessLifecycle } = await import(workerData.handler);
        const { applyNanoHostLocalWorkerImage } = await import(workerData.imageHandler);
        const sqlite = new (require(workerData.sqlite))(workerData.path, { fileMustExist: true });
        try {
          sqlite.pragma('foreign_keys = ON');
          sqlite.pragma('synchronous = FULL');
          for (const input of workerData.inputs) {
            assert.equal(sqlite.transaction(() =>
              applyNanoHostLocalHarnessLifecycle({ sqlite }, input)
            ).immediate(), null);
          }
          const applyImage = input => sqlite.transaction(() =>
            applyNanoHostLocalWorkerImage({ sqlite }, input)
          ).immediate();
          assert.equal(applyImage(workerData.build), null);
          assert.equal(applyImage(workerData.build), null);
          assert.throws(() => applyImage(workerData.acquisition), /transition precondition failed/);
        } finally {
          sqlite.close();
        }
      })().catch(error => { process.nextTick(() => { throw error; }); });
      `,
      {
        eval: true,
        workerData: {
          acquisition,
          build,
          handler: new URL('../../dist/storage/harness-lifecycle-native.js', import.meta.url).href,
          imageHandler: new URL('../../dist/storage/worker-image-native.js', import.meta.url).href,
          inputs,
          path,
          sqlite: createRequire(import.meta.url).resolve('better-sqlite3'),
        },
      }
    );
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`NanoHost fixture worker exited ${code}.`))
        );
      });
    } finally {
      await worker.terminate();
    }

    const reader = new Database(path, { fileMustExist: true, readonly: true });
    try {
      expect(
        readNanoHostMeasuredHarnessIdentity({ sqlite: reader }, agentSessionRuntimeBindingId)
      ).toBe(imageDigest);
      expect(readWorkerImageSettlement({ sqlite: reader }, buildRequestId)?.outcome).toEqual(
        image.outcome
      );
      expect(readWorkerImageSettlement({ sqlite: reader }, acquisitionRequestId)).toBeNull();
      expect(reader.pragma('foreign_key_check')).toEqual([]);
    } finally {
      reader.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
