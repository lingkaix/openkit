import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MAX_ARTIFACT_FILE_BYTES,
  TurnInputReferenceSchema,
  type TurnSchema,
} from '@openkit/protocol';
import type { z } from 'zod';
import {
  assertCanonicalDirectory,
  turnFilePayloadPath,
} from '../storage/workspace-file-records.js';
import {
  type BoundedByteSource,
  BoundedSourceError,
  openBoundedSourceView,
} from './bounded-source-view.js';
import type {
  WorkerContextPackageProjection,
  WorkerContextPackageSourceFileInput,
} from './worker-context-package.js';

type Turn = z.infer<typeof TurnSchema>;

const CHUNK_BYTES = 65_536;
const TEXT_MEDIA = new Set(['text/plain', 'text/markdown', 'application/json']);

/** Prepares only the originals already admitted by this receiving Turn. The snapshot writer must verify every complete original before publication. The current authority callback must recheck the Turn inventory, source audience and destination admission; it is never serialized or used as a durable access grant. Original names are display data and never path components. */
export async function prepareTurnFileSourceInputs(input: {
  readonly workspaceRoot: string;
  readonly turn: Turn;
  readonly assertCurrent: () => void;
  readonly signal?: AbortSignal;
}): Promise<WorkerContextPackageSourceFileInput[]> {
  const signal = input.signal ?? new AbortController().signal;
  const assertCurrent = input.assertCurrent;
  const workspaceRoot = input.workspaceRoot;
  const { workspaceId, threadId, id: turnId } = input.turn;
  const originals = (input.turn.fileInputs ?? []).map((original) => Object.freeze({ ...original }));
  const result: WorkerContextPackageSourceFileInput[] = [];
  for (const [ordinal, original] of originals.entries()) {
    signal.throwIfAborted();
    assertCurrent();
    const reference = TurnInputReferenceSchema.parse({
      scopeId: `input/turn/${workspaceId}/${threadId}/${turnId}`,
      objectId: String(ordinal),
    });
    const originalSnapshotPath = `originals/turn-inputs/${ordinal}/payload`;
    const packagePath = `sources/turn-inputs/${ordinal}.txt`;
    const path = turnFilePayloadPath(workspaceRoot, threadId, turnId, ordinal);
    const first = await acquire(path, original.sizeBytes, assertCurrent, signal);
    let delivered: Uint8Array;
    let projection: WorkerContextPackageProjection;
    try {
      const source: BoundedByteSource = {
        identity: {
          sourceKey: `${reference.scopeId}/${reference.objectId}`,
          revision: String(ordinal),
          originalDigest: original.contentDigest,
          representationId: 'original-utf8',
          representationDigest: original.contentDigest,
        },
        byteLength: original.sizeBytes,
        read: async (offset, maximum, currentSignal) => {
          currentSignal.throwIfAborted();
          const bytes = Buffer.alloc(Math.min(maximum, CHUNK_BYTES));
          const read = await first.handle.read(bytes, 0, bytes.length, offset);
          return bytes.subarray(0, read.bytesRead);
        },
        assertUnchanged: async (currentSignal) => {
          currentSignal.throwIfAborted();
          assertCurrent();
          if (!unchanged(first.identity, await first.handle.stat({ bigint: true })))
            throw new BoundedSourceError('stale');
        },
      };
      const view = TEXT_MEDIA.has(original.mediaType)
        ? await openBoundedSourceView(
            source,
            {
              maxRepresentationBytes: MAX_ARTIFACT_FILE_BYTES,
              maxEnvelopeBytes: 65_536,
              timeoutMs: 30_000,
            },
            signal
          )
        : { status: 'unavailable' as const, reason: 'unsupported' as const };
      const page = view.status === 'ready' ? await view.preview(signal) : view;
      if (page.status === 'ready') {
        delivered = Buffer.from(page.text, 'utf8');
        projection = {
          kind: page.truncated ? 'excerpt' : 'body',
          sourceRevision: String(ordinal),
          representationId: 'original-utf8',
          representationDigest: original.contentDigest,
          representationByteLength: original.sizeBytes,
          deliveredDigest: sha256(delivered),
          ranges: [page.range].map(({ start, end }) => ({ start, end })),
          byteLength: delivered.byteLength,
          truncated: page.truncated,
          availability: page.truncated ? 'incomplete' : 'available',
          originalSnapshotPath,
        };
      } else {
        if (!['unsupported', 'invalid_utf8', 'resource_limited'].includes(page.reason))
          throw new Error('Turn input text representation is unavailable.');
        delivered = Buffer.from(
          JSON.stringify({
            status: 'unavailable',
            reason: page.reason,
            source: reference,
            originalDigest: original.contentDigest,
            byteLength: original.sizeBytes,
            mediaType: original.mediaType,
          }),
          'utf8'
        );
        projection = {
          kind: 'descriptor',
          sourceRevision: String(ordinal),
          representationId: 'unavailable-original-view-v1',
          representationDigest: original.contentDigest,
          representationByteLength: original.sizeBytes,
          deliveredDigest: sha256(delivered),
          ranges: [],
          byteLength: delivered.byteLength,
          truncated: true,
          availability: 'unavailable',
          originalSnapshotPath,
        };
      }
      assertCurrent();
      if (!unchanged(first.identity, await first.handle.stat({ bigint: true })))
        throw new Error('Turn original input changed during projection.');
    } finally {
      await first.handle.close();
    }
    const reopen = async (currentSignal: AbortSignal) => {
      const current = await acquire(path, original.sizeBytes, assertCurrent, currentSignal);
      if (!unchanged(first.identity, current.identity)) {
        await current.handle.close();
        throw new Error('Turn original input changed after projection.');
      }
      return current.handle;
    };
    result.push({
      source: { kind: 'turn-input', reference },
      originalDigest: original.contentDigest,
      byteLength: original.sizeBytes,
      mediaType: original.mediaType,
      originalSnapshotPath,
      packagePath,
      projection,
      deliveredBytes: delivered,
      assertUnchanged: async (currentSignal = signal) => {
        const handle = await reopen(currentSignal);
        await handle.close();
      },
      open: async function* (currentSignal) {
        const handle = await reopen(currentSignal);
        try {
          let offset = 0;
          while (offset < original.sizeBytes) {
            currentSignal.throwIfAborted();
            const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, original.sizeBytes - offset));
            const read = await handle.read(bytes, 0, bytes.length, offset);
            if (!read.bytesRead) throw new Error('Turn original input ended before its bound.');
            offset += read.bytesRead;
            yield bytes.subarray(0, read.bytesRead);
          }
          assertCurrent();
          if (!unchanged(first.identity, await handle.stat({ bigint: true })))
            throw new Error('Turn original input changed during copying.');
        } finally {
          await handle.close();
        }
      },
    });
  }
  return result;
}

/** Opens only the canonical unique regular payload, under the receiving Turn's existing owner. */
async function acquire(
  path: string,
  byteLength: number,
  assertCurrent: () => void,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  assertCurrent();
  let parent = dirname(path);
  for (let level = 0; level < 7; level += 1) {
    assertCanonicalDirectory(parent);
    parent = dirname(parent);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    signal.throwIfAborted();
    const identity = await handle.stat({ bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n || identity.size !== BigInt(byteLength))
      throw new Error('Turn original input is unavailable.');
    return { handle, identity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Pins the descriptor identity and every modification marker across projection and copying. */
function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    right.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Digests only bounded delivered bytes; the streaming snapshot writer proves the complete original. */
function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
