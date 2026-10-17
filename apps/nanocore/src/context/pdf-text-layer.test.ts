// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfFixture as pdf } from '../test-support/pdf-fixture.js';
import {
  PDF_TEXT_LAYER_LIMITS,
  type PdfTextLayerSource,
  processPdfTextLayer,
} from './pdf-text-layer.js';

// Observe production launches while retaining the real Node child and PDF.js parser.
const observations = vi.hoisted(() => ({
  launches: [] as {
    args: string[];
    pid?: number;
    signal?: string | null;
    code?: number | null;
    env?: NodeJS.ProcessEnv;
  }[],
  withoutChild: false,
  onParser: undefined as ((pid: number | undefined) => void) | undefined,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = observations.withoutChild
        ? actual.spawn('/fixture-missing-node', args[1] as string[], args[2])
        : actual.spawn(...args);
      const entry = {
        args: args[1] as string[],
        pid: child.pid,
        signal: null as string | null,
        env: args[2]?.env,
      };
      observations.launches.push(entry);
      child.on('close', (code, signal) => {
        entry.signal = signal;
        Object.assign(entry, { code });
      });
      observations.onParser?.(child.pid);
      return child;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  observations.launches.length = 0;
  observations.onParser = undefined;
  observations.withoutChild = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function fixture(bytes: Buffer, chunkBytes = 17) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-layer-test-'));
  roots.push(root);
  let reserved = 0;
  let opened = 0;
  const source: PdfTextLayerSource = {
    sourceKey: 'artifact:workspace_fixture:artifact_fixture:1',
    revision: '1',
    originalDigest: sha(bytes),
    byteLength: bytes.length,
    async *open() {
      opened++;
      for (let offset = 0; offset < bytes.length; offset += chunkBytes)
        yield bytes.subarray(offset, offset + chunkBytes);
    },
  };
  const input = {
    source,
    temporaryRoot: root,
    reserveTemporaryBytes(size: number) {
      reserved += size;
      let remaining = size;
      let held = true;
      return {
        recordWritten(bytes: bigint) {
          const count = Number(bytes);
          expect(count).toBeLessThanOrEqual(remaining);
          remaining -= count;
          reserved -= count;
        },
        release() {
          expect(held).toBe(true);
          held = false;
          reserved -= remaining;
          remaining = 0;
        },
      };
    },
  };
  return { input, root, reserved: () => reserved, opened: () => opened };
}

async function expectClean(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.reserved()).toBe(0);
  expect(await readdir(f.root)).toEqual([]);
}

describe('isolated PDF text-layer representation', () => {
  it('binds real text extraction to exact pages, original bytes, processor and representation digests', async () => {
    const bytes = pdf(['Alpha exact one', 'Beta exact two']);
    const f = await fixture(bytes);
    const canonical = join(f.root, 'canonical.pdf');
    await writeFile(canonical, bytes);
    const result = await processPdfTextLayer(f.input);
    expect(result.status).toBe('available');
    if (result.status === 'unavailable') throw new Error(result.reason);
    const d = result.derivative;
    expect(d.source.originalDigest).toBe(sha(bytes));
    expect(d.processor).toMatchObject({
      id: 'pdfjs-pdf-text-layer-v1',
      configuration: { encoding: 'UTF-8', textLayout: 'pdfjs-items-v1', eol: 'unix', options: { isEvalSupported: false } },
    });
    expect(d.processor.pdfjsVersion).toMatch(/^\d+\.\d+/);
    expect(d.processor.nodeVersion).toBe(process.versions.node);
    expect(d.text).toBe('# Page 1\n\nAlpha exact one\n\n# Page 2\n\nBeta exact two\n\n');
    expect(d.representationDigest).toBe(sha(d.text));
    const representation = Buffer.from(d.text);
    expect(
      d.pages.map((page) => representation.subarray(page.startByte, page.endByte).toString())
    ).toEqual(['Alpha exact one\n', 'Beta exact two\n']);
    expect(d.pages.map((page) => [page.page, page.coordinateSpace])).toEqual([
      [1, 'representation-utf8'],
      [2, 'representation-utf8'],
    ]);
    expect(d.coverage).toEqual({
      kind: 'pdf-text-layer',
      complete: true,
      provesCompleteBodyAbsence: false,
      totalPages: 2,
      processedPages: 2,
      pagesWithoutText: [],
      reason: 'all-text-layer-pages',
    });
    expect(await readFile(canonical)).toEqual(bytes);
    await rm(canonical);
    await expectClean(f);
    expect(observations.launches).toHaveLength(1);
    const launch = observations.launches[0]!;
    expect(d.processor.resourceProfileDigest).toBe(
      sha(JSON.stringify({
        pdfjsVersion: d.processor.pdfjsVersion,
        nodeVersion: d.processor.nodeVersion,
        configuration: d.processor.configuration,
        invocation: {
          command: process.execPath,
          arguments: launch.args.map((arg) => arg.endsWith('/input.pdf') ? '/private-source' : arg),
          environment: launch.env,
        },
      }))
    );
    expect(launch.env).toEqual({ LC_ALL: 'C', LANG: 'C', TZ: 'UTC' });
    expect(launch.args).toEqual([
      '--max-old-space-size=512',
      '--disallow-code-generation-from-strings',
      expect.stringMatching(/pdf-text-layer-child\.(ts|js)$/),
      expect.stringMatching(/input\.pdf$/),
      JSON.stringify(PDF_TEXT_LAYER_LIMITS),
    ]);
  });

  it('reuses deterministic identity only for the same original and output-changing processor configuration', async () => {
    const f = await fixture(pdf(['Alpha']));
    const first = await processPdfTextLayer(f.input);
    const again = await processPdfTextLayer(f.input);
    const configurationChanged = await processPdfTextLayer({ ...f.input, limits: { maxPages: 1 } });
    const other = await fixture(pdf(['Beta']));
    const originalChanged = await processPdfTextLayer(other.input);
    for (const r of [first, again, configurationChanged, originalChanged])
      if (r.status === 'unavailable') throw new Error(r.reason);
    if (
      first.status === 'unavailable' ||
      again.status === 'unavailable' ||
      configurationChanged.status === 'unavailable' ||
      originalChanged.status === 'unavailable'
    )
      return;
    expect(first.derivative).toEqual(again.derivative);
    expect(first.derivative.processor.resourceProfileDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.derivative.processor.resourceProfileDigest).not.toBe(
      configurationChanged.derivative.processor.resourceProfileDigest
    );
    expect(first.derivative.cacheKey).not.toBe(configurationChanged.derivative.cacheKey);
    expect(first.derivative.representationId).not.toBe(
      configurationChanged.derivative.representationId
    );
    expect(first.derivative.cacheKey).not.toBe(originalChanged.derivative.cacheKey);
    expect(first.derivative.source.originalDigest).not.toBe(
      originalChanged.derivative.source.originalDigest
    );
    await expectClean(f);
    await expectClean(other);
  });

  it.each([
    ['@scanned'],
    ['@scanned', 'Text layer'],
  ])('reports scanned or mixed pages as incomplete without complete body absence: %j', async (...pages) => {
    const f = await fixture(pdf(pages));
    const result = await processPdfTextLayer(f.input);
    expect(result.status).toBe('incomplete');
    if (result.status === 'unavailable') throw new Error(result.reason);
    expect(result.derivative.coverage).toMatchObject({
      complete: false,
      pagesWithoutText: [1],
      reason: 'pages-without-text',
      provesCompleteBodyAbsence: false,
    });
    await expectClean(f);
  });

  it('does not accept page-count or encryption fields forged inside private metadata', async () => {
    const f = await fixture(
      pdf(['One', 'Two'], undefined, 'PRIVATE_TITLE\nPages: 1\nEncrypted: yes\n')
    );
    const result = await processPdfTextLayer(f.input);
    expect(result.status).toBe('available');
    if (result.status === 'unavailable') throw new Error(result.reason);
    expect(result.derivative.coverage.totalPages).toBe(2);
    expect(result.derivative.text).not.toContain('PRIVATE_TITLE');
    await expectClean(f);
  });

  it('refuses passwordless encrypted originals even when an empty password permits their text to be read', async () => {
    const bytes = await readFile(
      new URL('./fixtures/pdf-text-layer/encrypted.pdf', import.meta.url)
    );
    const f = await fixture(bytes);
    expect(await processPdfTextLayer(f.input)).toEqual({
      status: 'unavailable',
      reason: 'encrypted',
      complete: false,
      provesCompleteBodyAbsence: false,
    });
    await expectClean(f);
  });

  it('reports exact processed pages when the page ceiling truncates extraction', async () => {
    const f = await fixture(pdf(['One', 'Two']));
    const result = await processPdfTextLayer({ ...f.input, limits: { maxPages: 1 } });
    expect(result.status).toBe('incomplete');
    if (result.status === 'unavailable') throw new Error(result.reason);
    expect(result.derivative.coverage).toMatchObject({
      totalPages: 2,
      processedPages: 1,
      reason: 'page-limit',
      complete: false,
    });
    expect(result.derivative.text).not.toContain('Two');
    await expectClean(f);
  });

  it.each([
    Buffer.from('malformed PRIVATE_CANARY'),
    pdf(['Text']).subarray(0, 200),
  ])('refuses malformed or truncated originals without body/error/path fallback', async (bytes) => {
    const f = await fixture(bytes);
    const result = await processPdfTextLayer(f.input);
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'invalid-pdf',
      complete: false,
      provesCompleteBodyAbsence: false,
    });
    expect(JSON.stringify(result)).not.toContain(f.root);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
    await expectClean(f);
  });

  it('refuses text overflow in the real child and cleans staging', async () => {
    const f = await fixture(pdf(['x'.repeat(1000)]));
    const result = await processPdfTextLayer({ ...f.input, limits: { maxOutputBytes: 40 } });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected bound');
    expect(result.reason).toBe('resource-limited');
    expect(observations.launches).toHaveLength(1);
    await expectClean(f);
  });

  it('bounds the real child heap without crashing NanoCore', async () => {
    const f = await fixture(pdf(['Text']));
    const result = await processPdfTextLayer({ ...f.input, limits: { heapBytes: 8 * 1_048_576 } });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'resource-limited' });
    expect(observations.launches[0]!.args).toContain('--max-old-space-size=8');
    await expectClean(f);
  });

  it('cancels a real Node child and waits for exit before releasing staging', async () => {
    const f = await fixture(pdf(['Text']));
    const controller = new AbortController();
    let childPid: number | undefined;
    observations.onParser = (pid) => {
      childPid = pid;
      controller.abort();
    };
    expect(await processPdfTextLayer({ ...f.input, signal: controller.signal })).toMatchObject({
      status: 'unavailable', reason: 'cancelled',
    });
    expect(childPid).toBeTypeOf('number');
    expect(() => process.kill(childPid!, 0)).toThrow();
    await expectClean(f);
  });

  it('kills a stopped real child at the parent wall deadline', async () => {
    const f = await fixture(pdf(['Text']));
    observations.onParser = (pid) => { process.kill(pid!, 'SIGSTOP'); };
    const started = Date.now();
    expect(await processPdfTextLayer({ ...f.input, limits: { wallTimeMs: 200 } })).toEqual({
      status: 'unavailable', reason: 'resource-limited', complete: false, provesCompleteBodyAbsence: false,
    });
    expect(observations.launches).toHaveLength(1);
    expect(observations.launches[0]!.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(2000);
    await expectClean(f);
  });

  it('bounds stalled source reads by wall time and cancellation', async () => {
    const f = await fixture(pdf(['Text']));
    const started = Date.now();
    const result = await processPdfTextLayer({
      ...f.input,
      source: {
        ...f.input.source,
        async *open() {
          await new Promise(() => {});
          yield Buffer.alloc(0);
        },
      },
      limits: { wallTimeMs: 100 },
    });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected wall limit');
    expect(result.reason).toBe('resource-limited');
    expect(Date.now() - started).toBeLessThan(2000);
    await expectClean(f);
  });

  it('refuses oversize input before opening, reserves before staging, and rejects source digest drift', async () => {
    const f = await fixture(pdf(['Text']));
    expect(await processPdfTextLayer({ ...f.input, limits: { maxInputBytes: 1 } })).toMatchObject({
      status: 'unavailable',
      reason: 'resource-limited',
    });
    expect(f.opened()).toBe(0);
    expect(
      await processPdfTextLayer({
        ...f.input,
        limits: { maxInputBytes: PDF_TEXT_LAYER_LIMITS.maxInputBytes + 1 },
      })
    ).toMatchObject({ status: 'unavailable', reason: 'invalid-limits' });
    expect(f.opened()).toBe(0);
    expect(
      await processPdfTextLayer({
        ...f.input,
        reserveTemporaryBytes() {
          throw new Error('PRIVATE_CAPACITY');
        },
      })
    ).toMatchObject({ status: 'unavailable', reason: 'resource-limited' });
    expect(f.opened()).toBe(0);
    expect(
      await processPdfTextLayer({
        ...f.input,
        source: { ...f.input.source, originalDigest: `sha256:${'0'.repeat(64)}` },
      })
    ).toMatchObject({ status: 'unavailable', reason: 'source-changed' });
    await expectClean(f);
  });

  it('fails closed without a representation when the Node child cannot run', async () => {
    const f = await fixture(pdf(['Text']));
    observations.withoutChild = true;
    const result = await processPdfTextLayer(f.input);
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'dependency-unavailable',
      complete: false,
      provesCompleteBodyAbsence: false,
    });
    await expectClean(f);
  });

  it('has fixed finite defaults independent of model and upload limits', () => {
    expect(PDF_TEXT_LAYER_LIMITS).toEqual({
      maxInputBytes: 67_108_864,
      maxOutputBytes: 2_097_152,
      maxPages: 64,
      heapBytes: 536_870_912,
      wallTimeMs: 20_000,
    });
  });
});

