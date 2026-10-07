import { createHash } from 'node:crypto';
import type {
  NanoHostEffectOperation,
  NanoHostSessionEffectRequest,
} from './nanohost-session-dispatch.js';
import type { WorkerBackendSessionRecord } from './worker-backend-sessions.js';

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
  const requestId = createHash('sha256')
    .update(
      stableNanoHostEffectJson({
        backendSessionId: identity.backendSessionId,
        input: commandInput,
        leaseId: attemptId,
        operation,
        packageSnapshotId: identity.packageSnapshotId,
      })
    )
    .digest('hex');
  return { input: commandInput, kind: operation, requestId };
}

/** Serializes deterministic request identity input with recursive key ordering. */
export function stableNanoHostEffectJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableNanoHostEffectJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
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
