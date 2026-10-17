import { dirname, join } from 'node:path';
import type { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { ensureCanonicalDirectoryAsync } from '../storage/workspace-file-records.js';
import type { WorkerContextPackageSourceFile } from './worker-context-package.js';
import { workerSourceOriginal } from './worker-source-read.js';
import { processVisionView, type VisionCrop, type VisionViewResult } from './vision-view.js';

/**
 * Processes one accepted selected original under shared file admission and rechecks current authority after cleanup, before any image or identity can be disclosed.
 * @param input Current selected source and existing shared storage owner, never a caller-selected host path.
 * @returns A bounded JPEG with provenance, or a value-free unavailable result.
 */
export async function viewWorkerSourceSnapshot(input: {
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly source: WorkerContextPackageSourceFile;
  readonly assertCurrent: () => void;
  readonly admission: FileStorageAdmission;
  readonly page?: number | undefined;
  readonly crop?: VisionCrop | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<VisionViewResult> {
  try {
    input.signal?.throwIfAborted();
    input.assertCurrent();
    const temporaryRoot = join(dirname(input.workspaceRoot), '.staging');
    const directory = input.admission.reserve({ stagingBytes: 65_536n, publicationBytes: 0n, extractionBytes: 0n, derivativeBytes: 0n });
    try { await ensureCanonicalDirectoryAsync(temporaryRoot); } finally { directory.release(); }
    const result = await processVisionView({
      source: workerSourceOriginal(input), mediaType: input.source.mediaType,
      page: input.page, crop: input.crop, signal: input.signal, temporaryRoot,
      reserveTemporaryBytes(bytes) {
        const reservation = input.admission.reserve({ stagingBytes: BigInt(bytes) + 131_072n, publicationBytes: 0n, extractionBytes: 0n, derivativeBytes: 0n });
        return { recordWritten: (count) => reservation.recordWritten(Number(count)), release: () => reservation.release() };
      },
    });
    input.signal?.throwIfAborted();
    input.assertCurrent();
    return result;
  } catch {
    return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unavailable' };
  }
}
