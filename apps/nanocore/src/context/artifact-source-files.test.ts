// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { ArtifactSchema } from '@openkit/protocol';
import { afterEach, expect, it } from 'vitest';
import type { z } from 'zod';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { stageArtifactPayload } from '../storage/artifacts/file-payload.js';
import { artifactFilePayloadPath } from '../storage/artifacts/file-records.js';
import { withCanonicalFileWriteAdmission } from '../storage/canonical-write-capacity.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { prepareArtifactSourceInputs } from './artifact-source-files.js';
import {
  createWorkerContextPackageFiles,
  type WorkerContextPackageSourceFileInput,
  writeWorkerContextPackageFiles,
} from './worker-context-package.js';

type Artifact = z.infer<typeof ArtifactSchema>;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Independently hashes exact fixture bytes for the canonical original owner. */
function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Creates an actual immutable Artifact through the Store and private capture owners. */
async function fixture(
  body: Buffer,
  format: 'file' | 'text' | 'markdown' | 'json' = 'file',
  mediaType = 'text/plain',
  artifactId = 'ar_selected'
) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-source-files-'));
  roots.push(root);
  const store = createDemoStore({ dataRoot: root });
  const workspace = store.listWorkspaces().find((entry) => entry.kind === 'code')!;
  const workspaceRoot = join(root, 'workspaces', workspace.id);
  const admission = new FileStorageAdmission(root, () => 0n);
  const digest = sha256(body);
  const requestId = 'artifact-source-import';
  const artifact: Artifact = {
    id: artifactId,
    workspaceId: workspace.id,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: '../../display-data',
    status: 'ready',
    summary: null,
    version: 1,
    content:
      format === 'file'
        ? { format, byteLength: body.length, mediaType }
        : { format, body: body.toString('utf8') },
    contentDigest: digest,
    lastMutationRequestId: requestId,
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: requestId,
      sourceDigest: digest,
      actor: { kind: 'user', id: 'user_local' },
      requestId,
      recordedAt: '2026-10-17T00:00:00.000Z',
    },
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  };
  if (format === 'file') {
    const reservation = admission.reserve({
      stagingBytes: BigInt(body.length) + 65_536n,
      publicationBytes: 65_536n,
      extractionBytes: 0n,
      derivativeBytes: 0n,
    });
    try {
      const stage = await stageArtifactPayload({
        workspaceRoot,
        source: Readable.from([body]),
        expectedByteLength: body.length,
        expectedDigest: digest,
        reservation,
      });
      try {
        withCanonicalFileWriteAdmission(admission, () => store.createArtifact(artifact, stage));
      } finally {
        await stage.remove();
      }
    } finally {
      reservation.release();
    }
  } else withCanonicalFileWriteAdmission(admission, () => store.createArtifact(artifact));
  let allowed = true;
  const input = {
    workspaceRoot,
    artifacts: [store.getArtifact(workspace.id, artifact.id)],
    assertCurrent: (captured: Readonly<Artifact>) => {
      if (!allowed) throw new Error('Current Artifact access was revoked.');
      expect(captured).toEqual(store.getArtifact(workspace.id, artifact.id));
    },
  };
  return {
    root,
    workspaceRoot,
    artifact: input.artifacts[0]!,
    input,
    body,
    admission,
    store,
    path: artifactFilePayloadPath(workspaceRoot, artifact.id, 1),
    revoke: () => {
      allowed = false;
    },
  };
}

it('prepares a bounded preview and exact streamed original larger than the inline processor ceiling', async () => {
  const original = Buffer.alloc(16_777_217);
  const f = await fixture(original);
  // Independent frozen Python hashlib oracle, also used by the original S39 regression.
  const expected = 'sha256:1003b1b5dc078189799a1216ce0f9fbcebb94e8b6b83c58c4b03345f07f94ced';
  const sources = await prepareArtifactSourceInputs(f.input);
  expect(sources).toHaveLength(1);
  const source = sources[0]!;
  expect(source.originalDigest).toBe(expected);
  expect(source.originalSnapshotPath).toBe('originals/artifacts/ar_selected/1/payload');
  expect(source.packagePath).toBe('sources/artifacts/ar_selected/1.txt');
  expect(source.deliveredBytes).toEqual(original.subarray(0, 2048));
  expect(source.projection).toMatchObject({
    representationId: 'original-utf8',
    representationDigest: expected,
    representationByteLength: original.length,
    ranges: [{ start: 0, end: 2048 }],
    byteLength: 2048,
    truncated: true,
    availability: 'incomplete',
  });
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of source.open(new AbortController().signal)) {
    expect(chunk.byteLength).toBeLessThanOrEqual(65_536);
    expect(Buffer.from(chunk).equals(original.subarray(length, length + chunk.byteLength))).toBe(
      true
    );
    hash.update(chunk);
    length += chunk.byteLength;
  }
  expect(length).toBe(original.length);
  expect(`sha256:${hash.digest('hex')}`).toBe(expected);
});

it('preserves retained inline original identity separately from its bounded delivered excerpt', async () => {
  const body = Buffer.from(`\ufeff${'é🙂\n'.repeat(100)}`);
  const f = await fixture(body, 'markdown');
  const [source] = await prepareArtifactSourceInputs(f.input);
  expect(source).toBeDefined();
  expect(source!.originalDigest).toBe(sha256(body));
  expect(source!.deliveredBytes).toEqual(Buffer.from(`\ufeff${'é🙂\n'.repeat(50)}`));
  expect(source!.projection.deliveredDigest).toBe(sha256(source!.deliveredBytes));
  expect(source!.projection.deliveredDigest).not.toBe(source!.originalDigest);
});

it.each([
  { body: Buffer.alloc(0), mediaType: 'text/plain', availability: 'available', reason: undefined },
  {
    body: Buffer.from([0, 255, 128]),
    mediaType: 'application/octet-stream',
    availability: 'unavailable',
    reason: 'unsupported',
  },
  {
    body: Buffer.concat([Buffer.alloc(4096, 97), Buffer.from([255])]),
    mediaType: 'text/plain',
    availability: 'unavailable',
    reason: 'invalid_utf8',
  },
])('keeps empty and unsupported originals truthful ($mediaType, $reason)', async ({
  body,
  mediaType,
  availability,
  reason,
}) => {
  const f = await fixture(body, 'file', mediaType);
  const [source] = await prepareArtifactSourceInputs(f.input);
  expect(source!.projection.availability).toBe(availability);
  expect(source!.originalDigest).toBe(sha256(body));
  if (reason) {
    expect(source!.projection).toMatchObject({ kind: 'descriptor', ranges: [], truncated: true });
    expect(source!.deliveredBytes.byteLength).toBeLessThanOrEqual(2048);
    expect(JSON.parse(Buffer.from(source!.deliveredBytes).toString('utf8'))).toMatchObject({
      status: 'unavailable',
      reason,
    });
    expect(Buffer.from(source!.deliveredBytes).toString('utf8')).not.toContain('\ufffd');
  } else
    expect(source!.projection).toMatchObject({
      kind: 'body',
      ranges: [{ start: 0, end: 0 }],
      byteLength: 0,
      truncated: false,
    });
  const files = packageFor(f, [source!]);
  await writeWorkerContextPackageFiles(f.workspaceRoot, files, { admission: f.admission });
  const snapshot = join(f.workspaceRoot, 'threads/th_source/turns/tu_source/context-package');
  expect(readFileSync(join(snapshot, source!.originalSnapshotPath))).toEqual(body);
  expect(readFileSync(join(snapshot, source!.packagePath))).toEqual(source!.deliveredBytes);
});

/** Exercises the actual S39 producer/consumer rather than duplicating its digest checks. */
function packageFor(
  f: Awaited<ReturnType<typeof fixture>>,
  sourceFiles: WorkerContextPackageSourceFileInput[]
) {
  return createWorkerContextPackageFiles({
    workspaceId: f.artifact.workspaceId,
    threadId: 'th_source',
    turnId: 'tu_source',
    workerRequestItemId: 'it_source',
    workerRequestBytes: 'Inspect selected originals',
    includedItemIds: ['it_source'],
    contextBudgetTokens: 4096,
    materialSelections: [],
    sourceFiles,
  });
}

it.each([
  'version',
  'text-digest',
  'inline-digest',
  'binary-digest',
] as const)('refuses incorrect selected %s identity at its proving boundary', async (change) => {
  const f = await fixture(
    Buffer.from('exact canonical original'),
    change === 'inline-digest' ? 'text' : 'file',
    change === 'binary-digest' ? 'application/octet-stream' : 'text/plain'
  );
  const changed = structuredClone(f.artifact);
  if (change === 'version') changed.version = 2;
  else {
    changed.contentDigest = `sha256:${'0'.repeat(64)}`;
    if (changed.origin.kind === 'imported') changed.origin.sourceDigest = changed.contentDigest;
  }
  // Omit current-owner checks only to isolate the independent payload SHA proof; runtime must supply them.
  const pending = prepareArtifactSourceInputs({
    ...f.input,
    artifacts: [changed],
    assertCurrent: () => {},
  });
  if (change === 'binary-digest') {
    const sources = await pending;
    await expect(
      writeWorkerContextPackageFiles(f.workspaceRoot, packageFor(f, sources), {
        admission: f.admission,
      })
    ).rejects.toThrow(/digest mismatch/);
  } else await expect(pending).rejects.toThrow();
});

it.each([
  'edited',
  'replaced',
  'symlink',
  'hardlink',
  'metadata',
  'parent-symlink',
] as const)('rejects an original %s after preview', async (change) => {
  const f = await fixture(Buffer.from('exact canonical original'));
  const [source] = await prepareArtifactSourceInputs(f.input);
  const sibling = join(f.root, 'replacement');
  if (change === 'edited') writeFileSync(f.path, Buffer.alloc(f.body.length, 120));
  if (change === 'replaced') {
    renameSync(f.path, sibling);
    writeFileSync(f.path, f.body);
  }
  if (change === 'symlink') {
    renameSync(f.path, sibling);
    symlinkSync(sibling, f.path);
  }
  if (change === 'hardlink') linkSync(f.path, sibling);
  if (change === 'metadata') chmodSync(f.path, 0o640);
  if (change === 'parent-symlink') {
    const parent = dirname(f.path);
    renameSync(parent, sibling);
    symlinkSync(sibling, parent);
  }
  await expect(source!.assertUnchanged()).rejects.toThrow();
  const iterator = source!.open(new AbortController().signal)[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toThrow();
});

it('rechecks current exact metadata and authority before acquisition and after awaited operations', async () => {
  const f = await fixture(Buffer.from('exact canonical original'));
  const [source] = await prepareArtifactSourceInputs(f.input);
  f.revoke();
  await expect(source!.assertUnchanged()).rejects.toThrow('revoked');
  await expect(
    source!.open(new AbortController().signal)[Symbol.asyncIterator]().next()
  ).rejects.toThrow('revoked');
  await expect(prepareArtifactSourceInputs(f.input)).rejects.toThrow('revoked');
  let permitted = true;
  const betweenAwaits = {
    ...f.input,
    assertCurrent: () => {
      if (!permitted) throw new Error('revoked between source awaits');
      queueMicrotask(() => {
        permitted = false;
      });
    },
  };
  await expect(prepareArtifactSourceInputs(betweenAwaits)).rejects.toThrow(
    'revoked between source awaits'
  );
});

it('captures nested metadata before callbacks can mutate caller-owned input', async () => {
  const f = await fixture(Buffer.from('exact canonical original'));
  const [source] = await prepareArtifactSourceInputs({
    ...f.input,
    assertCurrent: (captured) => {
      f.input.artifacts[0]!.version = 99;
      f.input.artifacts[0]!.title = 'mutated';
      if (f.input.artifacts[0]!.content.format === 'file')
        f.input.artifacts[0]!.content.byteLength = 0;
      expect(captured.version).toBe(1);
      expect(captured.title).toBe('../../display-data');
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured.content)).toBe(true);
    },
  });
  expect(source!.source).toMatchObject({ artifactVersion: 1 });
  expect(source!.byteLength).toBe(f.body.length);
  expect(source!.originalSnapshotPath).toBe('originals/artifacts/ar_selected/1/payload');
  await source!.assertUnchanged();
});

it('refuses cancellation during preparation and before returning a subsequent original chunk', async () => {
  const f = await fixture(Buffer.alloc(65_537, 97));
  const before = new AbortController();
  before.abort();
  await expect(
    prepareArtifactSourceInputs({ ...f.input, signal: before.signal })
  ).rejects.toThrow();
  const during = new AbortController();
  await expect(
    prepareArtifactSourceInputs({
      ...f.input,
      signal: during.signal,
      assertCurrent: () => {
        queueMicrotask(() => during.abort());
      },
    })
  ).rejects.toThrow();
  const [source] = await prepareArtifactSourceInputs(f.input);
  const controller = new AbortController();
  const iterator = source!.open(controller.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual(f.body.subarray(0, 65_536));
  controller.abort();
  await expect(iterator.next()).rejects.toThrow();
});

it.each([
  16_777_216, 16_777_217,
])('bounds the inline processor independently while streaming %i exact original bytes', async (byteLength) => {
  const f = await fixture(Buffer.alloc(byteLength), 'text');
  const [source] = await prepareArtifactSourceInputs(f.input);
  if (byteLength > 16_777_216) {
    expect(source!.projection).toMatchObject({
      kind: 'descriptor',
      availability: 'unavailable',
      ranges: [],
    });
    expect(JSON.parse(Buffer.from(source!.deliveredBytes).toString('utf8')).reason).toBe(
      'resource_limited'
    );
  } else {
    expect(source!.projection).toMatchObject({
      kind: 'excerpt',
      availability: 'incomplete',
      ranges: [{ start: 0, end: 2048 }],
    });
    expect(source!.deliveredBytes).toEqual(f.body.subarray(0, 2048));
  }
  let length = 0;
  const hash = createHash('sha256');
  for await (const chunk of source!.open(new AbortController().signal)) {
    expect(chunk.byteLength).toBeLessThanOrEqual(65_536);
    length += chunk.byteLength;
    hash.update(chunk);
  }
  expect(length).toBe(byteLength);
  expect(`sha256:${hash.digest('hex')}`).toBe(
    byteLength === 16_777_217
      ? 'sha256:1003b1b5dc078189799a1216ce0f9fbcebb94e8b6b83c58c4b03345f07f94ced'
      : sha256(f.body)
  );
});

it.each([
  'text',
  'markdown',
  'json',
] as const)('streams retained %s bytes across surrogate-pair boundaries without replacement drift', async (format) => {
  const f = await fixture(Buffer.from(`${'a'.repeat(16_383)}🙂${'é'.repeat(500)}`), format);
  const [source] = await prepareArtifactSourceInputs(f.input);
  const chunks: Uint8Array[] = [];
  for await (const chunk of source!.open(new AbortController().signal)) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(f.body);
});

it('refuses duplicate selections and malformed current source identity before touching originals', async () => {
  const f = await fixture(Buffer.from('exact canonical original'));
  await expect(
    prepareArtifactSourceInputs({ ...f.input, artifacts: [f.artifact, f.artifact] })
  ).rejects.toThrow(/duplicated/);
  await expect(
    prepareArtifactSourceInputs({ ...f.input, artifacts: [{ ...f.artifact, id: '../escape' }] })
  ).rejects.toThrow();
  await expect(
    prepareArtifactSourceInputs({
      ...f.input,
      assertCurrent: () => {
        throw new Error('current metadata mismatch');
      },
    })
  ).rejects.toThrow('current metadata mismatch');
});

// Actual descriptor-lifetime observation requires Linux procfs; other POSIX systems retain semantic coverage above.
it.runIf(process.platform === 'linux')(
  'closes preview descriptors and iterator return/throw/cancellation descriptors',
  async () => {
    const f = await fixture(Buffer.alloc(65_537, 97));
    const count = () =>
      readdirSync('/proc/self/fd').filter((name) => {
        try {
          return readlinkSync(join('/proc/self/fd', name)) === f.path;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      }).length;
    const [source] = await prepareArtifactSourceInputs(f.input);
    expect(count()).toBe(0);
    for (const mode of ['return', 'throw', 'abort'] as const) {
      const controller = new AbortController();
      const iterator = source!.open(controller.signal)[Symbol.asyncIterator]();
      await iterator.next();
      expect(count()).toBe(1);
      if (mode === 'return') await iterator.return?.();
      if (mode === 'throw')
        await expect(iterator.throw?.(new Error('consumer stopped'))).rejects.toThrow(
          'consumer stopped'
        );
      if (mode === 'abort') {
        controller.abort();
        await expect(iterator.next()).rejects.toThrow();
      }
      expect(count()).toBe(0);
    }
  }
);

it('keeps unavailable descriptor bytes fixed even when opaque identifiers require JSON escaping', async () => {
  const id = '\u0001'.repeat(200);
  const f = await fixture(Buffer.from([255]), 'file', 'application/octet-stream', id);
  const [source] = await prepareArtifactSourceInputs(f.input);
  expect(source!.source.reference.objectId).toBe(id);
  expect(source!.originalSnapshotPath).toBe(`originals/artifacts/${id}/1/payload`);
  expect(Buffer.from(source!.deliveredBytes).toString('utf8')).toBe(
    '{"status":"unavailable","reason":"unsupported"}'
  );
  expect(source!.deliveredBytes.byteLength).toBeLessThan(128);
  expect(source!.originalDigest).toBe(sha256(f.body));
});

/** Produces one small valid two-page PDF with exact xref offsets and a real text layer. */
function selectedPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [4 0 R 6 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let page = 1; page <= 2; page++) {
    const stream = `BT /F1 12 Tf 72 720 Td ${Array.from({ length: 40 }, (_, line) => `(${page}:${line} PDF retained text layer marker) Tj 0 -12 Td`).join(' ')} ET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

it('retains a selected PDF original and complete isolated text representation while delivering only its bounded preview', async () => {
  const original = selectedPdf();
  const f = await fixture(original, 'file', 'application/pdf');
  const [source] = await prepareArtifactSourceInputs({ ...f.input, admission: f.admission });
  expect(source!.projection.kind).toBe('excerpt');
  expect(source!.projection.representationId).toMatch(/^pdf-text-layer-v1:sha256:/);
  expect(source!.projection.representationSnapshotPath).toBe(
    'representations/artifacts/ar_selected/1/pdf-text-layer.txt'
  );
  const files = packageFor(f, [source!]);
  await writeWorkerContextPackageFiles(f.workspaceRoot, files, { admission: f.admission });
  const root = join(f.workspaceRoot, 'threads/th_source/turns/tu_source/context-package');
  expect(readFileSync(join(root, source!.originalSnapshotPath))).toEqual(original);
  const complete = readFileSync(join(root, source!.projection.representationSnapshotPath!));
  const expected = [1, 2]
    .map(
      (page) =>
        `# Page ${page}\n\n${Array.from({ length: 40 }, (_, line) => `${page}:${line} PDF retained text layer marker\n`).join('')}\n`
    )
    .join('');
  expect(complete.toString('utf8')).toBe(expected);
  expect(source!.projection.representationDigest).toBe(sha256(complete));
  expect(source!.projection.representationDigest).not.toBe(source!.originalDigest);
  expect(source!.projection.deliveredDigest).toBe(sha256(source!.deliveredBytes));
  expect(source!.projection.deliveredDigest).not.toBe(source!.projection.representationDigest);
  expect(source!.deliveredBytes.byteLength).toBeLessThanOrEqual(2048);
  expect(
    Buffer.from(source!.deliveredBytes).toString('utf8').split('\n').length - 1
  ).toBeLessThanOrEqual(50);
  const range = source!.projection.ranges[0]!;
  expect(Buffer.from(source!.deliveredBytes)).toEqual(complete.subarray(range.start, range.end));
  expect(source!.projection.pdfTextLayer).toMatchObject({
    coverage: {
      complete: true,
      totalPages: 2,
      processedPages: 2,
      provesCompleteBodyAbsence: false,
    },
    pages: [
      { page: 1, coordinateSpace: 'representation-utf8' },
      { page: 2, coordinateSpace: 'representation-utf8' },
    ],
    processor: { id: 'poppler-pdf-text-layer-v1' },
  });
  expect(readFileSync(join(root, 'instructions.md'), 'utf8')).toBe('Inspect selected originals');
  expect(
    files.fileInventory.find((file) => file.path === source!.projection.representationSnapshotPath)
  ).toMatchObject({
    contentDigest: sha256(complete),
    byteLength: complete.byteLength,
  });
});

it('retains a selected encrypted PDF original with only an unavailable descriptor and no representation handle', async () => {
  const original = readFileSync(
    new URL('./fixtures/pdf-text-layer/encrypted.pdf', import.meta.url)
  );
  const f = await fixture(original, 'file', 'application/pdf');
  const [source] = await prepareArtifactSourceInputs({ ...f.input, admission: f.admission });
  expect(source!.projection).toMatchObject({
    kind: 'descriptor',
    availability: 'unavailable',
    ranges: [],
  });
  expect(JSON.parse(Buffer.from(source!.deliveredBytes).toString('utf8'))).toMatchObject({
    status: 'unavailable',
    reason: 'encrypted',
  });
  expect(source!.projection).not.toHaveProperty('representationSnapshotPath');
  expect(source!).not.toHaveProperty('openRepresentation');
  const files = packageFor(f, [source!]);
  await writeWorkerContextPackageFiles(f.workspaceRoot, files, { admission: f.admission });
  const root = join(f.workspaceRoot, 'threads/th_source/turns/tu_source/context-package');
  expect(readFileSync(join(root, source!.originalSnapshotPath))).toEqual(original);
  expect(files.fileInventory.some((file) => file.path.startsWith('representations/'))).toBe(false);
});
