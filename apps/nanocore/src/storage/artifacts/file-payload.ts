import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { MAX_ARTIFACT_FILE_BYTES } from '@openkit/protocol';
import { stagePrivateFile } from '@openkit/storage';

import {
  FileAdmissionError,
  FileByteAdmission,
  type FileStorageReservation,
} from './file-admission.js';

/** Immutable bytes verified in private same-filesystem staging, without product acceptance. */
export interface StagedArtifactPayload {
  readonly path: string;
  readonly byteLength: number;
  readonly contentDigest: string;
  /** Removes this request's files; reservation release requires this cleanup to succeed. */
  remove(): Promise<void>;
}

/** A failed capture whose occupied staging could not be proved removed. */
export class ArtifactPayloadCleanupError extends Error {
  /** Retains private diagnostic causes without exposing source bytes in the message. */
  constructor(causes: readonly unknown[]) {
    super('Artifact payload staging requires cleanup.', { cause: new AggregateError(causes) });
    this.name = 'ArtifactPayloadCleanupError';
  }
}

/** A complete stream whose actual bytes contradict admitted file metadata. */
export class ArtifactPayloadIntegrityError extends Error {
  /** Creates a bounded refusal without revealing source content. */
  constructor(readonly code: 'invalid_request' | 'source_digest_mismatch') {
    super('The file bytes do not match their admitted size and digest.');
    this.name = 'ArtifactPayloadIntegrityError';
  }
}

/** Captures exact bytes with stream backpressure and no text decoding. The caller holds the capacity reservation through publication or proved cleanup. Existing boot staging cleanup handles abandoned requests without claiming acceptance. */
export async function stageArtifactPayload(input: {
  readonly workspaceRoot: string;
  readonly source: Readable;
  readonly expectedByteLength: number;
  readonly expectedDigest: string;
  readonly reservation: FileStorageReservation;
  readonly submission?: FileByteAdmission;
  readonly signal?: AbortSignal;
  /** Optional source-owned check before any original chunk can be written. */
  readonly inspectChunk?: (chunk: Buffer) => void;
}): Promise<StagedArtifactPayload> {
  if (
    !Number.isSafeInteger(input.expectedByteLength) ||
    input.expectedByteLength < 0 ||
    input.expectedByteLength > MAX_ARTIFACT_FILE_BYTES ||
    !/^sha256:[a-f0-9]{64}$/.test(input.expectedDigest)
  ) {
    input.source.destroy();
    throw new FileAdmissionError('invalid_file_size');
  }
  input.signal?.throwIfAborted();
  input.reservation.assertAvailable();
  const stagingParent = join(dirname(input.workspaceRoot), '.staging');
  return stagePrivateFile(
    stagingParent,
    input,
    FileByteAdmission,
    ArtifactPayloadIntegrityError,
    ArtifactPayloadCleanupError
  );
}
