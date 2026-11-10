import { readFile } from 'node:fs/promises';

/** Image-owned path, outside retained and Worker-writable volumes; never an environment override. */
export const WORKER_RELEASE_IDENTITY_PATH = '/usr/local/lib/openkit/release-identity.json';

/** Compatibility provenance only; Core remains the deciding owner. */
export interface WorkerBuildIdentity {
  readonly sourceCommit: string;
  readonly releaseTag: string | null;
}

/** Missing/corrupt image metadata stays unknown for Core's typed pre-readiness refusal. */
export async function readWorkerReleaseIdentity(
  path = WORKER_RELEASE_IDENTITY_PATH
): Promise<WorkerBuildIdentity | null> {
  try {
    const bytes = await readFile(path);
    // The immutable build envelope must not become an unbounded private-poll payload.
    if (bytes.length > 4096) return null;
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    );
    if (
      !value ||
      typeof value !== 'object' ||
      !('sourceCommit' in value) ||
      typeof value.sourceCommit !== 'string' ||
      !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
      !('releaseTag' in value) ||
      (value.releaseTag !== null && typeof value.releaseTag !== 'string')
    )
      return null;
    // Core applies its existing complete release-tag grammar and exact identity comparison.
    return { sourceCommit: value.sourceCommit, releaseTag: value.releaseTag };
  } catch {
    return null;
  }
}
