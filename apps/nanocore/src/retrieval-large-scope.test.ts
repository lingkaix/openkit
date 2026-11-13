// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type RetrievalDocument,
  type RetrievalScope,
  RetrievalService,
  retrievalExecutable,
} from './retrieval-service.js';

const MEBI = 1024 * 1024;
// Fixed ceilings pinned before execution, never read from the service under test.
// 8 MiB is the accepted stdio frame and inventory ceiling of the trusted local service contract.
const FRAME_CEILING_BYTES = 8 * MEBI;
// Ordinary documents stay well under each transport limit so only aggregation crosses the ceiling.
const WITHIN_CAP_DOCUMENT_BYTES = 3 * MEBI;
// Policy caps under test: 16 MiB of transported text per document, 64 MiB per request.
const PER_DOCUMENT_CAP_BYTES = 16 * MEBI;
const OVER_CAP_DOCUMENT_BYTES = 17 * MEBI;
// Direct-inline bodies are bounded far below these fixtures, so every large body must stream.
const DIRECT_INLINE_BODY_BYTES = 64 * 1024;
const LARGE_SCOPE_NEEDLE = 'needle-large-scope';
const BEYOND_CAP_NEEDLE = 'needle-beyond-cap';
const HEALTHY_NEEDLE = 'needle-healthy-neighbor';
const TEST_TIMEOUT_MS = 120_000;

const roots: string[] = [];
const services: RetrievalService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('retrieval large inline scope', () => {
  it(
    'publishes and searches one inline aggregate scope above the frame ceiling with exact coordinates',
    async () => {
      const service = createService();
      const sources = ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({
        id,
        body: newlineDelimitedBody(WITHIN_CAP_DOCUMENT_BYTES, LARGE_SCOPE_NEEDLE),
      }));
      sources.push({ id: 'neighbor', body: newlineDelimitedBody(4 * 1024, LARGE_SCOPE_NEEDLE) });
      const sourcesWithDocument = sources.map(({ id, body }) => ({
        body,
        entry: document(id, body),
      }));
      const documents = sourcesWithDocument.map(({ entry }) => entry);
      const view: RetrievalScope = { scope: 'large-inline-scope', documents };
      const aggregateBytes = documents.reduce((total, entry) => total + entry.size, 0);

      // Fixture preconditions: the aggregate crosses the accepted ceiling, every body is within cap,
      // and ordinary bodies are far above the direct-inline budget so they must be streamed.
      expect(aggregateBytes).toBeGreaterThan(FRAME_CEILING_BYTES);
      expect(WITHIN_CAP_DOCUMENT_BYTES).toBeGreaterThan(DIRECT_INLINE_BODY_BYTES);
      for (const entry of documents) {
        expect(entry.size).toBeLessThan(PER_DOCUMENT_CAP_BYTES);
      }

      const generation = await service.publish(view, null);
      expect(generation).toMatch(/^[a-f0-9]{64}$/);
      expect(await service.inspect(view.scope)).toBe(generation);

      const result = await service.search({
        mode: 'exact',
        query: LARGE_SCOPE_NEEDLE,
        scopes: [view],
        limit: 20,
      });

      expect(result.generations).toEqual({ [view.scope]: generation });
      expect(result.complete).toBe(true);
      expect(result.coverage).toEqual({
        admitted_objects: documents.length,
        searched_representations: documents.length,
        stale_revisions: 0,
        stopped_work: 0,
        unsupported_bodies: 0,
        inventory_complete: true,
        representations_complete: true,
        matches_complete: true,
        reasons: {},
        omitted_matches: 0,
        matching_documents: documents.length,
        // Complete lexical enumeration is a lexical-mode guarantee; exact scans report coordinates only.
        enumeration_complete: false,
      });
      expect(
        result.hits.every(
          (hit) =>
            hit.scope === view.scope &&
            hit.representation === 'text' &&
            hit.processor === null &&
            hit.score === null
        )
      ).toBe(true);
      expect(hitCoordinates(result.hits)).toEqual(
        sourcesWithDocument
          .map(({ entry, body }) => ({
            key: entry.key,
            locator: textLocator(entry, body.markerOffset, LARGE_SCOPE_NEEDLE.length),
          }))
          .sort((left, right) => left.key.id.localeCompare(right.key.id))
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    'reports one truthful resource-limited document above the per-document cap and keeps its neighbor searchable',
    async () => {
      const service = createService();
      const oversized = newlineDelimitedBody(
        OVER_CAP_DOCUMENT_BYTES,
        BEYOND_CAP_NEEDLE,
        PER_DOCUMENT_CAP_BYTES + DIRECT_INLINE_BODY_BYTES
      );
      const healthy = newlineDelimitedBody(4 * 1024, HEALTHY_NEEDLE);
      const oversizedDocument = document('oversized', oversized);
      const healthyDocument = document('healthy', healthy);
      const view: RetrievalScope = {
        scope: 'oversized-inline-scope',
        documents: [oversizedDocument, healthyDocument],
      };
      expect(oversizedDocument.size).toBeGreaterThan(PER_DOCUMENT_CAP_BYTES);
      expect(healthyDocument.size).toBeLessThan(PER_DOCUMENT_CAP_BYTES);

      const generation = await service.publish(view, null);
      expect(generation).toMatch(/^[a-f0-9]{64}$/);
      expect(await service.inspect(view.scope)).toBe(generation);

      const inCap = await service.search({
        mode: 'exact',
        query: HEALTHY_NEEDLE,
        scopes: [view],
        limit: 20,
      });
      expect(inCap.generations).toEqual({ [view.scope]: generation });
      expect(inCap.hits.map((hit) => ({ key: hit.key, locator: hit.locator }))).toEqual([
        {
          key: healthyDocument.key,
          locator: textLocator(healthyDocument, healthy.markerOffset, HEALTHY_NEEDLE.length),
        },
      ]);
      // The inventory, including the limited document, is committed and preserved.
      expect(inCap.coverage.admitted_objects).toBe(2);
      expect(inCap.coverage.inventory_complete).toBe(true);
      expect(inCap.coverage.stale_revisions).toBe(0);
      // The limited body is reported, not silently dropped, so the result cannot claim full coverage.
      expect(inCap.coverage.representations_complete).toBe(false);
      expect(inCap.coverage.stopped_work).toBeGreaterThanOrEqual(1);
      expect(inCap.complete).toBe(false);
      // A known transport-budget stop is reported as exactly that. A source-failure or
      // detail reason would misreport a stop this producer already knows and can name.
      expect(reportedReasons(inCap.coverage.reasons)).toEqual(['resource-limited']);

      // A term that exists only beyond the cap has no body evidence, and the gap is explicit.
      const beyondCap = await service.search({
        mode: 'exact',
        query: BEYOND_CAP_NEEDLE,
        scopes: [view],
        limit: 20,
      });
      expect(beyondCap.hits).toEqual([]);
      expect(beyondCap.coverage.matching_documents).toBe(0);
      expect(beyondCap.coverage.admitted_objects).toBe(2);
      expect(beyondCap.coverage.stale_revisions).toBe(0);
      expect(beyondCap.complete).toBe(false);
      expect(reportedReasons(beyondCap.coverage.reasons)).toEqual(['resource-limited']);
    },
    TEST_TIMEOUT_MS
  );

  it('keeps multi-byte UTF-8 boundaries and exact byte coordinates across transport buffers', async () => {
    const service = createService();
    const head = `ab${'測'.repeat(30_000)}`;
    const marker = '境界標識';
    const body = {
      text: `${head}${marker}${'測'.repeat(30_000)}尾\n`,
      markerOffset: Buffer.byteLength(head),
    };
    const entry = document('unicode-boundary', body);
    const view: RetrievalScope = { scope: 'unicode-stream-scope', documents: [entry] };
    // A body above the direct-inline cap must cross transport buffers, so boundary handling is live.
    expect(entry.size).toBeGreaterThan(DIRECT_INLINE_BODY_BYTES);

    const generation = await service.publish(view, null);
    expect(await service.inspect(view.scope)).toBe(generation);

    const result = await service.search({
      mode: 'exact',
      query: marker,
      scopes: [view],
      limit: 20,
    });
    expect(result.complete).toBe(true);
    expect(result.coverage.admitted_objects).toBe(1);
    expect(result.hits.map((hit) => hit.locator)).toEqual([
      textLocator(entry, body.markerOffset, Buffer.byteLength(marker)),
    ]);
  }, 60_000);
});

interface Body {
  text: string;
  markerOffset: number;
}

/** Builds one ordinary UTF-8 newline-delimited body with exactly one marker line. */
function newlineDelimitedBody(bytes: number, marker: string, markerAt = bytes / 2): Body {
  const lines: string[] = [];
  let written = 0;
  let markerOffset: number | undefined;
  for (let index = 0; ; index += 1) {
    if (markerOffset === undefined && written >= markerAt) {
      markerOffset = written;
      lines.push(`${marker}\n`);
      written += Buffer.byteLength(`${marker}\n`);
      continue;
    }
    if (written >= bytes) break;
    const line = `${index.toString().padStart(8, '0')} retained ordinary body text\n`;
    lines.push(line);
    written += Buffer.byteLength(line);
  }
  if (markerOffset === undefined) throw new Error('Fixture marker line was not placed.');
  return { text: lines.join(''), markerOffset };
}

/** Declares one source through the public service shape; no private transport form is assumed. */
function document(id: string, body: Body): RetrievalDocument {
  return {
    key: { namespace: 'retrieval-large-scope', id },
    revision: '1',
    digest: createHash('sha256').update(body.text).digest('hex'),
    size: Buffer.byteLength(body.text),
    name: `${id}.txt`,
    media_type: 'text/plain',
    locator: `source:${id}`,
    content: { kind: 'inline-text', text: body.text },
  };
}

/** Expected canonical byte coordinate of one literal occurrence. */
function textLocator(entry: RetrievalDocument, start: number, length: number) {
  return { kind: 'text', start, end: start + length, original: entry.locator };
}

function hitCoordinates(hits: { key: unknown; locator: unknown }[]) {
  return hits
    .map((hit) => ({ key: hit.key, locator: hit.locator }))
    .sort((left, right) =>
      (left.key as { id: string }).id.localeCompare((right.key as { id: string }).id)
    );
}

function reportedReasons(reasons: Record<string, number>): string[] {
  return Object.keys(reasons)
    .filter((reason) => (reasons[reason] ?? 0) > 0)
    .sort();
}

/**
 * Binds the real kernel to the product layout: the temporary root is the admitted
 * source boundary and the derived store stays in its private `indexes/retrieval` subtree.
 */
function createService(): RetrievalService {
  const root = mkdtempSync(join(tmpdir(), 'openkit-retrieval-large-scope-'));
  roots.push(root);
  const service = new RetrievalService({
    executable: resolve(process.env.OPENKIT_RETRIEVAL_KERNEL_EXECUTABLE ?? retrievalExecutable()),
    sourcesRoot: root,
    storeRoot: join(root, 'indexes', 'retrieval'),
  });
  services.push(service);
  return service;
}
