import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeRetrievalServices } from '../retrieval-service.js';
import {
  pdfSourceRetrievalDocument,
  searchPdfSourceSnapshot,
} from './pdf-source-representation.js';
import { PDF_TEXT_LAYER_LIMITS } from './pdf-text-layer.js';
import { PDF_TEXT_LAYER_OPTIONS } from './pdf-text-layer-child.js';
import type { WorkerContextPackageSourceFile } from './worker-context-package.js';

const roots: string[] = [];
afterEach(async () => {
  await closeRetrievalServices();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Synthetic retained text tests transport and search; PDF.js extraction has its own real PDF suite. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'pdf-source-retrieval-'));
  roots.push(dataRoot);
  const workspaceRoot = join(dataRoot, 'workspaces', 'workspace');
  const threadId = 'thread',
    turnId = 'turn';
  const packageRoot = join(workspaceRoot, 'threads', threadId, 'turns', turnId, 'context-package');
  const representationPath = 'representations/selected.txt';
  mkdirSync(join(packageRoot, 'representations'), { recursive: true });
  const text = 'first page\n\fsecond needle\n';
  const firstEnd = Buffer.byteLength('first page\n\f');
  const bytes = Buffer.byteLength(text);
  const sha = (value: string | Uint8Array) =>
    `sha256:${createHash('sha256').update(value).digest('hex')}`;
  writeFileSync(join(packageRoot, representationPath), text);
  const source: WorkerContextPackageSourceFile = {
    source: {
      kind: 'artifact',
      reference: { scopeId: 'artifact/workspace/workspace', objectId: 'selected' },
      artifactVersion: 1,
    },
    originalDigest: sha(Buffer.from([0, 255, 2])),
    byteLength: 3,
    mediaType: 'application/pdf',
    originalSnapshotPath: 'originals/selected.pdf',
    packagePath: 'sources/selected.txt',
    projection: {
      kind: 'excerpt',
      sourceRevision: '1',
      representationId: 'pdf-text-layer:test-profile',
      representationDigest: sha(text),
      representationByteLength: bytes,
      deliveredDigest: sha('first page'),
      ranges: [{ start: 0, end: 10 }],
      byteLength: 10,
      truncated: true,
      availability: 'incomplete',
      representationSnapshotPath: representationPath,
      pdfTextLayer: {
        processor: {
          id: 'pdfjs-pdf-text-layer-v1',
          resourceProfileDigest: sha('synthetic transport fixture'),
          pdfjsVersion: 'fixture',
          nodeVersion: process.versions.node,
          configuration: {
            ...PDF_TEXT_LAYER_LIMITS,
            encoding: 'UTF-8',
            textLayout: 'pdfjs-items-v1',
            options: PDF_TEXT_LAYER_OPTIONS,
            eol: 'unix',
            heapScope: 'v8-old-generation',
          },
        },
        pages: [
          {
            page: 1,
            coordinateSpace: 'representation-utf8',
            startByte: 0,
            endByte: firstEnd,
            hasText: true,
          },
          {
            page: 2,
            coordinateSpace: 'representation-utf8',
            startByte: firstEnd,
            endByte: bytes,
            hasText: true,
          },
        ],
        coverage: {
          kind: 'pdf-text-layer',
          complete: false,
          provesCompleteBodyAbsence: false,
          totalPages: 3,
          processedPages: 2,
          pagesWithoutText: [],
          reason: 'page-limit',
        },
      },
    },
  };
  return { dataRoot, workspaceRoot, packageRoot, threadId, turnId, source };
}

it('keeps original identity separate from processor, representation bytes and page coordinates', () => {
  const f = fixture();
  const document = pdfSourceRetrievalDocument(f.source, relative(f.dataRoot, f.packageRoot))!;
  expect(document.digest).toBe(f.source.originalDigest.slice(7));
  expect(document.size).toBe(3);
  expect(document.content).toMatchObject({
    kind: 'representation',
    digest: f.source.projection.representationDigest.slice(7),
    processor: 'pdf-text-layer:test-profile',
    complete: false,
    fragments: [
      { start: 0, end: 12 },
      { start: 12, end: 26 },
    ],
  });
  expect(JSON.stringify(document)).not.toContain(f.dataRoot);
  f.source.projection.kind = 'descriptor';
  expect(pdfSourceRetrievalDocument(f.source, 'unused')).toBeNull();
});

it('searches retained text with real kernel page provenance and withholds results after revocation', async () => {
  const f = fixture();
  const query = { mode: 'exact' as const, query: 'needle', limit: 20 };
  const result = await searchPdfSourceSnapshot({ ...f, query, assertCurrent() {} });
  expect(result).toMatchObject({
    status: 'ready',
    result: {
      complete: false,
      hits: [
        {
          digest: f.source.originalDigest.slice(7),
          representation_digest: f.source.projection.representationDigest.slice(7),
          processor: 'pdf-text-layer:test-profile',
          locator: {
            kind: 'text',
            start: 19,
            end: 25,
            original: `${JSON.stringify(f.source.source.reference)}#page=2`,
          },
        },
      ],
    },
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(48 * 1024);
  let checks = 0;
  expect(
    await searchPdfSourceSnapshot({
      ...f,
      query,
      assertCurrent() {
        checks += 1;
        if (checks === 5) throw new Error('private authority detail');
      },
    })
  ).toEqual({ status: 'unavailable', reason: 'unavailable' });
  expect(checks).toBe(5);
  unlinkSync(join(f.packageRoot, f.source.projection.representationSnapshotPath!));
  const missing = await searchPdfSourceSnapshot({ ...f, query, assertCurrent() {} });
  expect(missing).toMatchObject({ status: 'ready', result: { hits: [], complete: false } });
  expect(JSON.stringify(missing)).not.toContain('needle');
}, 30_000);
