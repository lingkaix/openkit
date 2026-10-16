import { dirname, join } from 'node:path';
import type { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { ensureCanonicalDirectoryAsync } from '../storage/workspace-file-records.js';
import { processVisionView, type VisionCrop, type VisionViewResult } from './vision-view.js';
import type { WorkerContextPackageSourceFile } from './worker-context-package.js';
import { workerSourceOriginal } from './worker-source-read.js';

/** Processes an explicitly requested retained original. The accepted inventory owns identity; current authority and the shared disk-admission owner remain mandatory before processing and disclosure. */
export async function viewWorkerSourceSnapshot(input: {
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly source: WorkerContextPackageSourceFile;
  readonly assertCurrent: () => void;
  readonly fileAdmission?: FileStorageAdmission | undefined;
  readonly crop?: VisionCrop | undefined;
  readonly page?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<VisionViewResult> {
  try {
    input.signal?.throwIfAborted();
    input.assertCurrent();
    const admission = input.fileAdmission;
    if (!admission) return { status: 'unavailable', reason: 'unavailable' };
    const temporaryRoot = join(dirname(input.workspaceRoot), '.staging');
    const directory = admission.reserve({
      stagingBytes: 65_536n,
      publicationBytes: 0n,
      extractionBytes: 0n,
      derivativeBytes: 0n,
    });
    try {
      await ensureCanonicalDirectoryAsync(temporaryRoot);
    } finally {
      directory.release();
    }
    input.assertCurrent();
    const result = await processVisionView({
      source: workerSourceOriginal(input),
      mediaType: input.source.mediaType,
      temporaryRoot,
      ...(input.crop ? { crop: input.crop } : {}),
      ...(input.page !== undefined ? { page: input.page } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      reserveTemporaryBytes(bytes) {
        const reservation = admission.reserve({
          stagingBytes: BigInt(bytes) + 131_072n,
          publicationBytes: 0n,
          extractionBytes: 0n,
          derivativeBytes: 0n,
        });
        return {
          recordWritten: (count) => reservation.recordWritten(Number(count)),
          release: () => reservation.release(),
        };
      },
    });
    input.signal?.throwIfAborted();
    input.assertCurrent();
    return result;
  } catch {
    return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unavailable' };
  }
}
