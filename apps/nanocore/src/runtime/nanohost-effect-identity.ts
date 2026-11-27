import { createHash } from 'node:crypto';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { compareCodeUnits } from '@openkit/protocol';
import type {
  NanoHostEffectOperation,
  NanoHostSessionEffectRequest,
} from './nanohost-session-dispatch.js';
import type { WorkerBackendSessionRecord } from './worker-backend-session-records.js';

/**
 * Re-derives the complete fixed-effect identity shared by dispatch and retained-delivery correlation.
 *
 * @param identity Immutable backend attempt and package identity.
 * @param attemptId Exact execution attempt owning that attempt.
 * @param operation Fixed NanoHost effect.
 * @param input Canonical operation input, before wire projection.
 * @returns The unchanged command input and deterministic request identity; derivation grants no dispatch authority.
 */
export function createNanoHostEffectRequest(
  identity: Pick<WorkerBackendSessionRecord, 'backendSessionId' | 'packageSnapshotId'>,
  attemptId: string,
  operation: NanoHostEffectOperation,
  input: Readonly<Record<string, unknown>>
): NanoHostSessionEffectRequest {
  const { attemptId: _attemptId, ...carriedInput } = input;
  const commandInput =
    operation === 'bridge.open' || operation === 'image.inspect'
      ? carriedInput
      : {
          backendSessionId: identity.backendSessionId,
          leaseId: attemptId,
          packageSnapshotId: identity.packageSnapshotId,
          ...carriedInput,
        };
  // Request lineage is retained; credential integrity and comparison material
  // stays in private carriage and must not become a secret fingerprint.
  const privateKeys =
    operation === 'reference.import' &&
    ['runtime-credential', 'runtime-credential-replace'].includes(String(commandInput.slot))
      ? new Set(['body', 'source', 'sha256', 'byteLength'])
      : operation === 'workspace.collect'
        ? new Set(['checkValues'])
        : null;
  const identityInput = privateKeys
    ? Object.fromEntries(Object.entries(commandInput).filter(([key]) => !privateKeys.has(key)))
    : commandInput;
  const requestId = createHash('sha256')
    .update(
      stableNanoHostEffectJson({
        backendSessionId: identity.backendSessionId,
        input: identityInput,
        leaseId: attemptId,
        operation,
        packageSnapshotId: identity.packageSnapshotId,
      })
    )
    .digest('hex');
  return { input: commandInput, kind: operation, requestId };
}

/** Identifies the first image operation from the immutable Worker package and anchor. */
export function createNanoHostInitialImageRequest(
  identity: Pick<WorkerBackendSessionRecord, 'backendSessionId' | 'packageSnapshotId'>,
  attemptId: string,
  pkg: AgentEnvironmentPackage
): { readonly kind: 'image.acquire' | 'image.build'; readonly requestId: string } {
  const image = pkg.runtime.environment
    ? { kind: 'reference' as const, ref: pkg.runtime.environment.imageDigest }
    : pkg.runtime.image;
  if (image.kind === 'reference')
    return {
      kind: 'image.acquire',
      requestId: createNanoHostEffectRequest(identity, attemptId, 'image.acquire', {
        imageReference: image.ref,
      }).requestId!,
    };
  return {
    kind: 'image.build',
    requestId: createNanoHostEffectRequest(identity, attemptId, 'image.build', {
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
    }).requestId!,
  };
}

/** Serializes deterministic request identity input with recursive key ordering. */
export function stableNanoHostEffectJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableNanoHostEffectJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableNanoHostEffectJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Recovers the embedded physical Sandbox identity from one backend attempt identity. */
export function nanoHostSandboxIdFromBackendSessionId(backendSessionId: string): string {
  if (!/^nh-[0-9a-f]{16}-[0-9a-f]{16}$/.test(backendSessionId)) {
    throw new Error('NanoHost backend session identity is invalid.');
  }
  return backendSessionId.slice(0, 19);
}
