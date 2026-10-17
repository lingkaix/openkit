// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkerContextPackageSourceFile } from './worker-context-package.js';
import { readWorkerSourceSnapshot } from './worker-source-read.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Real immutable files; only the caller's current authorization predicate is controlled. */
function fixture(bytes = Buffer.from('界'.repeat(40_000))) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'worker-source-read-'));
  roots.push(workspaceRoot);
  const workspaceId = allocateEntityId('ws');
  const threadId = allocateEntityId('th');
  const turnId = allocateEntityId('tu');
  const artifactId = allocateEntityId('ar');
  const originalSnapshotPath = `originals/artifacts/${artifactId}/1/payload`;
  const path = join(
    workspaceRoot,
    `threads/${threadId}/turns/${turnId}/context-package`,
    originalSnapshotPath
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  const source: WorkerContextPackageSourceFile = {
    source: {
      kind: 'artifact',
      reference: { scopeId: `artifact/workspace/${workspaceId}`, objectId: artifactId },
      artifactVersion: 1,
    },
    originalDigest: digest(bytes),
    byteLength: bytes.length,
    mediaType: 'text/plain',
    originalSnapshotPath,
    packagePath: `sources/artifacts/${artifactId}/1.txt`,
    projection: {
      kind: 'excerpt',
      sourceRevision: '1',
      representationId: 'original-utf8',
      representationDigest: digest(bytes),
      representationByteLength: bytes.length,
      deliveredDigest: digest(bytes.subarray(0, 2046)),
      ranges: [{ start: 0, end: 2046 }],
      byteLength: 2046,
      truncated: true,
      availability: 'incomplete',
      originalSnapshotPath,
    },
  };
  const assertCurrent = vi.fn();
  return {
    source,
    path,
    bytes,
    input: { workspaceRoot, threadId, turnId, source, assertCurrent },
  };
}

it('reads an exact retained UTF-8 snapshot through preview, range continuation and EOF with a bounded envelope', async () => {
  const f = fixture();
  const preview = await readWorkerSourceSnapshot(f.input);
  expect(preview).toMatchObject({
    status: 'ready',
    text: '界'.repeat(682),
    range: { start: 0, end: 2046 },
    sourceByteLength: 120_000,
  });
  if (preview.status !== 'ready') throw new Error('Expected preview.');
  const buffers = [Buffer.from(preview.text)];
  let cursor = preview.cursor;
  while (cursor) {
    const page = await readWorkerSourceSnapshot({ ...f.input, mode: 'read', cursor });
    if (page.status !== 'ready') throw new Error('Expected continued read.');
    expect(page.range.start).toBe(cursor.range.start);
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(51_200);
    expect(page.text).not.toContain('\ufffd');
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65_536);
    buffers.push(Buffer.from(page.text));
    cursor = page.cursor;
  }
  expect(Buffer.concat(buffers)).toEqual(f.bytes);
});

it('reads the retained PDF representation and preserves incomplete page coverage rather than decoding its binary original', async () => {
  const f = fixture(Buffer.from([0, 255, 128]));
  const text = Buffer.from('Page one\n\f');
  const relative = `representations/artifacts/${f.source.source.reference.objectId}/1/pdf-text-layer.txt`;
  const packageRoot = f.path.slice(0, -f.source.originalSnapshotPath.length);
  mkdirSync(dirname(join(packageRoot, relative)), { recursive: true });
  writeFileSync(join(packageRoot, relative), text);
  f.source.mediaType = 'application/pdf';
  f.source.projection = {
    ...f.source.projection,
    byteLength: text.length,
    deliveredDigest: digest(text),
    ranges: [{ start: 0, end: text.length }],
    truncated: false,
    representationSnapshotPath: relative,
    representationId: 'pdf-text-layer:fixture',
    representationDigest: digest(text),
    representationByteLength: text.length,
    pdfTextLayer: {
      coverage: {
        kind: 'pdf-text-layer',
        complete: false,
        provesCompleteBodyAbsence: false,
        totalPages: 2,
        processedPages: 1,
        pagesWithoutText: [],
        reason: 'page-limit',
      },
    } as NonNullable<WorkerContextPackageSourceFile['projection']['pdfTextLayer']>,
  };
  expect(await readWorkerSourceSnapshot(f.input)).toMatchObject({
    status: 'ready',
    text: text.toString(),
    eof: true,
    coverage: { complete: false, reason: 'page-limit' },
    sourceByteLength: 3,
  });
});

it('never exposes bytes, identity or a cursor for descriptor, revoked, missing, corrupt or linked snapshots', async () => {
  const f = fixture();
  f.input.assertCurrent.mockImplementationOnce(() => {
    throw new Error('Private source access denied.');
  });
  expect(await readWorkerSourceSnapshot(f.input)).toEqual({
    status: 'unavailable',
    reason: 'unavailable',
  });
  const descriptor = {
    ...f.source,
    projection: {
      ...f.source.projection,
      kind: 'descriptor' as const,
      availability: 'unavailable' as const,
    },
  };
  expect(await readWorkerSourceSnapshot({ ...f.input, source: descriptor })).toEqual({
    status: 'unavailable',
    reason: 'unsupported',
  });
  writeFileSync(f.path, 'Changed bytes');
  expect(await readWorkerSourceSnapshot(f.input)).toMatchObject({ status: 'unavailable' });
  rmSync(f.path);
  expect(await readWorkerSourceSnapshot(f.input)).toMatchObject({ status: 'unavailable' });
  const outside = join(f.input.workspaceRoot, 'outside');
  writeFileSync(outside, f.bytes);
  symlinkSync(outside, f.path);
  expect(await readWorkerSourceSnapshot(f.input)).toMatchObject({ status: 'unavailable' });
});

it('refuses a stale cursor, cancellation and revocation before disclosure without a usable handle', async () => {
  const f = fixture();
  const first = await readWorkerSourceSnapshot(f.input);
  if (first.status !== 'ready' || !first.cursor) throw new Error('Expected continuation.');
  const stale = { ...first.cursor, binding: `sha256:${'a'.repeat(64)}` };
  expect(await readWorkerSourceSnapshot({ ...f.input, mode: 'read', cursor: stale })).toEqual({
    status: 'unavailable',
    reason: 'stale',
  });
  const controller = new AbortController();
  controller.abort();
  expect(await readWorkerSourceSnapshot({ ...f.input, signal: controller.signal })).toEqual({
    status: 'unavailable',
    reason: 'cancelled',
  });
  let calls = 0;
  f.input.assertCurrent.mockImplementation(() => {
    if (++calls > 3) throw new Error('Revoked.');
  });
  expect(await readWorkerSourceSnapshot(f.input)).toEqual({
    status: 'unavailable',
    reason: 'unavailable',
  });
});

it('continues exact selected Notebook bytes and withholds all output after canonical read revocation', async () => {
  const bytes = Buffer.from('界'.repeat(40_000));
  let admitted = true;
  const readKnowledge = vi.fn(() => {
    if (!admitted) throw new Error('Current Knowledge read denied.');
    return bytes.toString();
  });
  const input = {
    workspaceRoot: '/unused', workspaceId: allocateEntityId('ws'),
    threadId: allocateEntityId('th'), turnId: allocateEntityId('tu'), assertCurrent: () => {}, readKnowledge,
    knowledge: {
      knowledgePageId: 'pinned', notebookRevision: 'selected-notebook-commit',
      contentDigest: digest(bytes), sourceRefs: [], packagePath: 'knowledge/pages/pinned.md',
      projection: { kind: 'excerpt' as const, sourceRevision: 'selected-notebook-commit',
        representationId: 'original-utf8', representationDigest: digest(bytes), representationByteLength: bytes.length,
        deliveredDigest: digest(bytes.subarray(0, 2046)), ranges: [{ start: 0, end: 2046 }],
        byteLength: 2046, truncated: true, availability: 'incomplete' as const },
    },
  };
  const preview = await readWorkerSourceSnapshot(input);
  if (preview.status !== 'ready' || !preview.cursor) throw new Error('Expected pinned preview.');
  expect(preview.text).toBe('界'.repeat(682));
  const continued = await readWorkerSourceSnapshot({ ...input, mode: 'read', cursor: preview.cursor });
  expect(continued).toMatchObject({ status: 'ready', range: { start: 2046 } });
  if (continued.status !== 'ready') throw new Error('Expected continuation.');
  expect(continued.identity.revision).toBe('selected-notebook-commit');
  expect(continued.text).not.toContain('\ufffd');
  admitted = false;
  expect(await readWorkerSourceSnapshot({ ...input, mode: 'read', cursor: preview.cursor }))
    .toEqual({ status: 'unavailable', reason: 'unavailable' });
});
