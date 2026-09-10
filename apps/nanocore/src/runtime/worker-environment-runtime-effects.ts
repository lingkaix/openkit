import { createHash } from 'node:crypto';
import type { WorkerEnvironmentCandidateRef } from '@openkit/app-api-schemas';

import {
  type AgentEnvironmentPackage,
  EMPTY_BUILD_CONTEXT_DIGEST,
  EMPTY_BUILD_CONTEXT_REF,
} from '@openkit/config-schema';
import { commandInputHash } from './idempotent-command.js';
import type { NanoHostSessionDispatch } from './nanohost-session-dispatch.js';
import type { WorkerStorageBinding, WorkerStorageLayout } from './worker-storage-bindings.js';
import { workerStorageLayoutDigest } from './worker-storage-bindings.js';

/** Exact prepared image fact returned by the existing NanoHost image owner. */
export interface PreparedWorkerEnvironmentImage {
  readonly imageDigest: string;
  readonly layout: WorkerStorageLayout;
  readonly layoutDigest: string;
}

/** Internal host-observed retained-storage status used for Core verification and projection. */
export interface WorkerEnvironmentStorageInspection {
  readonly attachment: {
    readonly generation: number;
    readonly sandboxId: string;
  } | null;
  readonly layoutDigest: string | null;
  readonly capacity: {
    readonly availableBytes: number;
    readonly totalBytes: number;
  };
  readonly scopeDigest: string | null;
  readonly state:
    | 'missing'
    | 'initializing'
    | 'available'
    | 'attached'
    | 'incomplete'
    | 'unknown'
    | 'conflicted';
  readonly storageRef: string;
  readonly targets: readonly {
    readonly initialized: boolean;
    readonly target: string;
    readonly volumeRef: string;
  }[];
}

/** Existing fixed NanoHost effects exposed to the bounded environment operation owner. */
export interface WorkerEnvironmentRuntimeEffects {
  /** Acquires/builds and inspects one exact authored image without mounting or draining work. */
  prepareImage(input: {
    readonly authorize: () => boolean;
    readonly candidate: WorkerEnvironmentCandidateRef;
    readonly image: AgentEnvironmentPackage['runtime']['image'];
  }): Promise<PreparedWorkerEnvironmentImage>;
  /** Awaits one already-dispatched image result after restart without replay authority. */
  recoverImageEffect(input: {
    readonly candidate: WorkerEnvironmentCandidateRef;
    readonly image: AgentEnvironmentPackage['runtime']['image'];
    readonly operation: 'image.acquire' | 'image.build';
  }): Promise<unknown>;
  /** Inspects one already-authorized exact Core association. */
  inspectStorage(input: {
    readonly authorize: () => boolean;
    readonly binding: WorkerStorageBinding;
    readonly commandRequestId: string;
  }): Promise<WorkerEnvironmentStorageInspection>;
  /** Purges one already-marked exact Core association. */
  purgeStorage(input: {
    readonly authorize: () => boolean;
    readonly binding: WorkerStorageBinding;
    readonly commandRequestId: string;
  }): Promise<{ readonly state: 'purged' | 'retained' | 'unknown'; readonly storageRef: string }>;
}

/** Creates the narrow environment-operation adapter over the existing NanoHost dispatcher. */
export function createWorkerEnvironmentRuntimeEffects(
  dispatch: NanoHostSessionDispatch
): WorkerEnvironmentRuntimeEffects {
  return {
    async prepareImage(input) {
      requireAuthorized(input.authorize);
      const image = input.image;
      const preparationId = workerEnvironmentPreparationIdentity(input.candidate, image);
      const deploymentDigest =
        image.kind === 'reference' &&
        image.pullPolicy === 'never' &&
        /^sha256:[0-9a-f]{64}$/.test(image.ref)
          ? image.ref
          : null;
      let imageDigest: string;
      if (deploymentDigest) {
        imageDigest = deploymentDigest;
      } else if (image.kind === 'reference') {
        imageDigest = requireDigest(
          await dispatch.effect({
            input: { imageReference: image.ref },
            kind: 'image.acquire',
            imageSettlement: imageSettlementIdentity(input.candidate, image),
            requestId: effectRequestId(preparationId, 'image.acquire'),
          })
        );
      } else {
        if (
          image.contextRef !== EMPTY_BUILD_CONTEXT_REF ||
          image.contextDigest !== EMPTY_BUILD_CONTEXT_DIGEST
        ) {
          throw new Error('NanoHost image build requires the exact V1 empty build-context pair.');
        }
        imageDigest = requireDigest(
          await dispatch.effect({
            input: {
              arguments: image.arguments,
              argumentsDigest: image.argumentsDigest,
              contextDigest: image.contextDigest,
              contextRef: image.contextRef,
              dockerfile: image.input.content,
              dockerfileDigest: image.input.digest,
              egress: image.egress,
              layerLimit: image.layerLimit,
              outputLimitBytes: image.outputLimitBytes,
              timeLimitSeconds: image.timeLimitSeconds,
            },
            kind: 'image.build',
            imageSettlement: imageSettlementIdentity(input.candidate, image),
            requestId: effectRequestId(preparationId, 'image.build'),
          })
        );
      }
      requireAuthorized(input.authorize);
      const inspection = parseNanoHostImageInspection(
        await dispatch.effect({
          input: { imageDigest },
          kind: 'image.inspect',
          requestId: effectRequestId(preparationId, 'image.inspect'),
        })
      );
      if (inspection.imageDigest !== imageDigest) {
        throw new Error('NanoHost image inspection returned a different digest.');
      }
      return inspection;
    },

    async recoverImageEffect(input) {
      if (!dispatch.expectResultOnly) {
        throw new Error('NanoHost image result-only recovery is unavailable.');
      }
      const preparationId = workerEnvironmentPreparationIdentity(input.candidate, input.image);
      const settlement = await dispatch.expectResultOnly([
        {
          kind: input.operation,
          imageSettlement: imageSettlementIdentity(input.candidate, input.image),
          requestId: effectRequestId(preparationId, input.operation),
        },
      ]);
      if (settlement.kind !== input.operation) {
        throw new Error('NanoHost image recovery returned a different operation.');
      }
      return settlement.result;
    },

    async inspectStorage(input) {
      requireAuthorized(input.authorize);
      const result = requireStorageInspection(
        await dispatch.effect({
          input: {
            attachmentGeneration: input.binding.attachmentGeneration,
            storageRef: input.binding.storageRef,
          },
          kind: 'storage.inspect',
          requestId: effectRequestId(input.commandRequestId, 'storage.inspect'),
        })
      );
      if (result.storageRef !== input.binding.storageRef) {
        throw new Error('NanoHost storage inspection returned a different association.');
      }
      if (
        result.state !== 'missing' &&
        (result.scopeDigest !== input.binding.scopeDigest ||
          result.layoutDigest !== input.binding.layoutDigest)
      ) {
        return { ...result, state: 'conflicted' };
      }
      return result;
    },

    async purgeStorage(input) {
      requireAuthorized(input.authorize);
      if (input.binding.state !== 'purge-pending') {
        throw new Error('Worker storage is not reserved for purge.');
      }
      const result = requirePurgeResult(
        await dispatch.effect({
          input: {
            attachmentGeneration: input.binding.attachmentGeneration,
            storageRef: input.binding.storageRef,
          },
          kind: 'storage.purge',
          requestId: effectRequestId(input.commandRequestId, 'storage.purge'),
        })
      );
      if (result.storageRef !== input.binding.storageRef) {
        throw new Error('NanoHost storage purge returned a different association.');
      }
      return result;
    },
  };
}

/** Derives one stable fixed-effect identity from its existing command receipt. */
export function workerEnvironmentEffectRequestId(
  preparationIdentity: string,
  operation: 'image.acquire' | 'image.build' | 'image.inspect' | 'storage.inspect' | 'storage.purge'
): string {
  return effectRequestId(preparationIdentity, operation);
}

/** Derives the exact preparation identity from immutable authored Artifact and image input. */
export function workerEnvironmentPreparationIdentity(
  candidate: WorkerEnvironmentCandidateRef,
  image: AgentEnvironmentPackage['runtime']['image']
): string {
  if (
    !candidate.artifactId ||
    !Number.isSafeInteger(candidate.artifactVersion) ||
    candidate.artifactVersion !== 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(candidate.contentDigest)
  ) {
    throw new Error('Worker environment candidate lineage is invalid.');
  }
  return commandInputHash({ candidate, image }).slice('sha256:'.length);
}

/** Parses the strict image inspection result. */
export function parseNanoHostImageInspection(value: unknown): PreparedWorkerEnvironmentImage {
  const record = requireRecord(value, 'image inspection');
  requireExactFields(record, ['digest', 'platform', 'storageLayout'], 'image inspection');
  const storageLayout = requireRecord(record.storageLayout, 'image storage layout');
  requireExactFields(
    storageLayout,
    ['family', 'gid', 'targets', 'uid', 'version', 'workingDirectory'],
    'image storage layout'
  );
  const platform = requireRecord(record.platform, 'image platform');
  requireExactFields(platform, ['architecture', 'os'], 'image platform');
  if (!Array.isArray(storageLayout.targets)) {
    throw new Error('NanoHost image storage targets are invalid.');
  }
  const layout: WorkerStorageLayout = {
    family: nullableString(storageLayout.family, 'storage family'),
    version: nullableString(storageLayout.version, 'storage version'),
    uid: nonNegativeInteger(storageLayout.uid, 'storage uid'),
    gid: nonNegativeInteger(storageLayout.gid, 'storage gid'),
    workingDirectory: requiredString(storageLayout.workingDirectory, 'working directory'),
    platform: {
      architecture: requiredString(platform.architecture, 'platform architecture'),
      os: requiredString(platform.os, 'platform operating system'),
    },
    targets: storageLayout.targets.map((target) => {
      const entry = requireRecord(target, 'image storage target');
      requireExactFields(entry, ['target'], 'image storage target');
      return { target: requiredString(entry.target, 'storage target') };
    }),
  };
  return {
    imageDigest: requiredDigest(record.digest, 'image'),
    layout,
    layoutDigest: workerStorageLayoutDigest(layout),
  };
}

/** Parses the strict retained-storage inspection result. */
function requireStorageInspection(value: unknown): WorkerEnvironmentStorageInspection {
  const record = requireRecord(value, 'storage inspection');
  requireExactFields(
    record,
    ['attachment', 'capacity', 'layoutDigest', 'scopeDigest', 'state', 'storageRef', 'targets'],
    'storage inspection'
  );
  const states = new Set<WorkerEnvironmentStorageInspection['state']>([
    'missing',
    'initializing',
    'available',
    'attached',
    'incomplete',
    'unknown',
    'conflicted',
  ]);
  if (!states.has(record.state as WorkerEnvironmentStorageInspection['state'])) {
    throw new Error('NanoHost storage inspection state is invalid.');
  }
  if (!Array.isArray(record.targets)) {
    throw new Error('NanoHost storage inspection targets are invalid.');
  }
  const capacity = requireRecord(record.capacity, 'storage capacity');
  requireExactFields(capacity, ['availableBytes', 'totalBytes'], 'storage capacity');
  let attachment: WorkerEnvironmentStorageInspection['attachment'] = null;
  if (record.attachment !== null) {
    const entry = requireRecord(record.attachment, 'storage attachment');
    requireExactFields(entry, ['generation', 'sandboxId'], 'storage attachment');
    attachment = {
      generation: positiveInteger(entry.generation, 'attachment generation'),
      sandboxId: requiredString(entry.sandboxId, 'Sandbox'),
    };
  }
  const availableBytes = nonNegativeInteger(capacity.availableBytes, 'available bytes');
  const totalBytes = nonNegativeInteger(capacity.totalBytes, 'total bytes');
  if (availableBytes > totalBytes) {
    throw new Error('NanoHost storage capacity is invalid.');
  }
  return {
    attachment,
    capacity: { availableBytes, totalBytes },
    layoutDigest: nullableDigest(record.layoutDigest, 'storage layout'),
    scopeDigest: nullableDigest(record.scopeDigest, 'storage scope'),
    state: record.state as WorkerEnvironmentStorageInspection['state'],
    storageRef: requiredString(record.storageRef, 'storage'),
    targets: record.targets.map((target) => {
      const entry = requireRecord(target, 'storage target');
      requireExactFields(entry, ['initialized', 'target', 'volumeRef'], 'storage target');
      if (typeof entry.initialized !== 'boolean') {
        throw new Error('NanoHost storage target initialization is invalid.');
      }
      return {
        initialized: entry.initialized,
        target: requiredString(entry.target, 'storage target'),
        volumeRef: requiredString(entry.volumeRef, 'volume'),
      };
    }),
  };
}

/** Parses the strict whole-association purge result. */
function requirePurgeResult(value: unknown): {
  readonly state: 'purged' | 'retained' | 'unknown';
  readonly storageRef: string;
} {
  const record = requireRecord(value, 'storage purge');
  requireExactFields(record, ['state', 'storageRef'], 'storage purge');
  if (record.state !== 'purged' && record.state !== 'retained' && record.state !== 'unknown') {
    throw new Error('NanoHost storage purge state is invalid.');
  }
  return { state: record.state, storageRef: requiredString(record.storageRef, 'storage') };
}

/** Reads one exact digest from an acquire/build result. */
function requireDigest(value: unknown): string {
  const record = requireRecord(value, 'image effect');
  return requiredDigest(record.digest, 'image');
}

/** Rejects calls that bypass the current operation owner authorization. */
function requireAuthorized(authorize: () => boolean): void {
  if (!authorize()) throw new Error('Worker environment operation is not authorized.');
}

/** Derives one lowercase effect correlation digest. */
function effectRequestId(commandRequestId: string, operation: string): string {
  const requestId = requiredString(commandRequestId, 'command request');
  return createHash('sha256').update(`${operation}\0${requestId}`, 'utf8').digest('hex');
}

/** Requires one strict object. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`NanoHost ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

/** Requires one exact object field set. */
function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  if (Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) {
    throw new Error(`NanoHost ${label} contains an unowned field.`);
  }
}

/** Requires one bounded identity-like string. */
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) {
    throw new Error(`NanoHost ${label} is invalid.`);
  }
  return value;
}

/** Requires one exact lowercase SHA-256 digest. */
function requiredDigest(value: unknown, label: string): string {
  const digest = requiredString(value, `${label} digest`);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`NanoHost ${label} digest is invalid.`);
  }
  return digest;
}

/** Requires a nullable lowercase SHA-256 digest. */
function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : requiredDigest(value, label);
}

/** Requires one nullable bounded string. */
function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label);
}

/** Requires one nonnegative integer. */
function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`NanoHost ${label} is invalid.`);
  }
  return value as number;
}

/** Requires one positive integer. */
function positiveInteger(value: unknown, label: string): number {
  const integer = nonNegativeInteger(value, label);
  if (integer < 1) throw new Error(`NanoHost ${label} is invalid.`);
  return integer;
}

/** Binds only preparation results to their immutable candidate and canonical input. */
function imageSettlementIdentity(
  candidate: WorkerEnvironmentCandidateRef,
  image: AgentEnvironmentPackage['runtime']['image']
) {
  return {
    authoredArtifactId: candidate.artifactId,
    authoredArtifactVersion: 1 as const,
    authoredContentDigest: candidate.contentDigest,
    inputDigest: commandInputHash(image),
  };
}
