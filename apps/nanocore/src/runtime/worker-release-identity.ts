import {
  type PresentReleaseIdentity,
  PresentReleaseIdentitySchema,
  type ReleaseBuildIdentity,
} from '@openkit/app-api-schemas';
import { OperationError } from '../operation-error-core.js';

/** Compatibility refusal contains no peer values, paths or credential material. */
export class WorkerReleaseIncompatibleError extends OperationError {
  public constructor() {
    super(
      'worker_release_incompatible',
      'Worker build identity is absent, invalid or different from the running Core release.',
      409
    );
    this.name = 'WorkerReleaseIncompatibleError';
  }
}

/** Select bounded untrusted fields without running a semantic-version regex on peer input. */
export function projectWorkerReleaseIdentity(observed: unknown): PresentReleaseIdentity | null {
  if (
    !observed ||
    typeof observed !== 'object' ||
    Array.isArray(observed) ||
    !Object.hasOwn(observed, 'sourceCommit') ||
    !Object.hasOwn(observed, 'releaseTag')
  )
    return null;
  const value = observed as Record<string, unknown>;
  if (
    typeof value.sourceCommit !== 'string' ||
    value.sourceCommit.length !== 40 ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    (value.releaseTag !== null &&
      (typeof value.releaseTag !== 'string' || value.releaseTag.length > 4000))
  )
    return null;
  return { sourceCommit: value.sourceCommit, releaseTag: value.releaseTag };
}

/** Exact build compatibility is additional admission, never authentication or readiness authority. */
export function requireMatchingWorkerReleaseIdentity(
  expected: ReleaseBuildIdentity | undefined,
  observed: unknown
): PresentReleaseIdentity {
  // Boot owns and validates the trusted expected tag. Peer tags only compare to that exact value.
  const core = PresentReleaseIdentitySchema.safeParse(expected);
  const worker = projectWorkerReleaseIdentity(observed);
  if (
    !core.success ||
    !worker ||
    core.data.sourceCommit !== worker.sourceCommit ||
    core.data.releaseTag !== worker.releaseTag
  )
    throw new WorkerReleaseIncompatibleError();
  return core.data;
}
