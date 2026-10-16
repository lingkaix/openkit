// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PDF_TEXT_LAYER_LIMITS,
  type PdfTextLayerSource,
  processPdfTextLayer,
} from './pdf-text-layer.js';

// Observe production launches while retaining the real parser, namespaces and resource limiter.
const observations = vi.hoisted(() => ({
  launches: [] as {
    args: string[];
    pid?: number;
    signal?: string | null;
    code?: number | null;
    env?: NodeJS.ProcessEnv;
  }[],
  withoutIsolation: false,
  onParser: undefined as ((pid: number | undefined) => void) | undefined,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = observations.withoutIsolation
        ? actual.spawn(
            args[0],
            (args[1] as string[]).map((arg) =>
              arg === '/usr/bin/bwrap' ? '/fixture-missing-isolation' : arg
            ),
            args[2]
          )
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
      if (entry.args.includes('-layout')) observations.onParser?.(child.pid);
      return child;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  observations.launches.length = 0;
  observations.onParser = undefined;
  observations.withoutIsolation = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Produce exact xref offsets rather than relying on Poppler's damaged-file repair. */
function pdf(pages: readonly string[], compressedContent?: Buffer, metadataTitle?: string): Buffer {
  const objects: Buffer[] = [];
  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(
    Buffer.from(
      `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`
    )
  );
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  for (const page of pages) {
    const stream =
      compressedContent ??
      (page === '@scanned'
        ? Buffer.concat([
            Buffer.from('q 100 0 0 100 72 600 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID '),
            Buffer.from([255, 255, 255]),
            Buffer.from(' EI Q\n'),
          ])
        : Buffer.from(page ? `BT /F1 12 Tf 72 720 Td (${page}) Tj ET\n` : ''));
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`
      )
    );
    objects.push(
      Buffer.concat([
        Buffer.from(
          `<< /Length ${stream.length}${compressedContent ? ' /Filter /FlateDecode' : ''} >>\nstream\n`
        ),
        stream,
        Buffer.from('\nendstream'),
      ])
    );
  }
  if (metadataTitle !== undefined) objects.push(Buffer.from(`<< /Title (${metadataTitle}) >>`));
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [0];
  let length = parts[0]!.length;
  for (const [i, object] of objects.entries()) {
    offsets.push(length);
    const body = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    parts.push(body);
    length += body.length;
  }
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join(
          ''
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${metadataTitle === undefined ? '' : ` /Info ${objects.length} 0 R`} >>\nstartxref\n${length}\n%%EOF\n`
    )
  );
  return Buffer.concat(parts);
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
      id: 'poppler-pdf-text-layer-v1',
      configuration: { encoding: 'UTF-8', layout: true, eol: 'unix' },
    });
    expect(d.processor.pdfinfoVersion).toMatch(/^\d+\.\d+/);
    expect(d.processor.pdftotextVersion).toMatch(/^\d+\.\d+/);
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
    const launch = observations.launches.find((entry) => entry.args.includes('-layout'))!;
    const infoLaunch = observations.launches.find(
      (entry) => entry.args.includes('/usr/bin/pdfinfo') && entry.args.includes('/input.pdf')
    )!;
    const observedInvocation = (entry: typeof launch, normalizePage: boolean) => ({
      command: '/usr/bin/prlimit',
      arguments: entry.args.map((arg, index, args) =>
        arg.endsWith('/input.pdf') && arg !== '/input.pdf'
          ? '/private-source'
          : normalizePage && (args[index - 1] === '-f' || args[index - 1] === '-l')
            ? 'selected-page'
            : arg
      ),
      environment: entry.env,
    });
    expect(d.processor.resourceProfileDigest).toBe(
      sha(
        JSON.stringify({
          pdfinfoVersion: d.processor.pdfinfoVersion,
          pdftotextVersion: d.processor.pdftotextVersion,
          configuration: d.processor.configuration,
          pdfinfo: observedInvocation(infoLaunch, false),
          pdftotext: observedInvocation(launch, true),
        })
      )
    );
    expect(launch.env).toEqual({ LC_ALL: 'C' });
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '--unshare-all',
        '--new-session',
        '--die-with-parent',
        '--clearenv',
        '--remount-ro',
        '--fsize=0',
        '--cpu=5',
        '--as=536870912',
        '--nofile=64',
        '/input.pdf',
      ])
    );
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

  it('refuses passwordless encrypted originals even when Poppler permits their text to be read', async () => {
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

  it('refuses output overflow by killing the real parser and cleaning staging', async () => {
    const f = await fixture(pdf(['x'.repeat(1000)]));
    const result = await processPdfTextLayer({ ...f.input, limits: { maxOutputBytes: 40 } });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected bound');
    expect(result.reason).toBe('resource-limited');
    expect(observations.launches.some((entry) => entry.args.includes('-layout'))).toBe(true);
    await expectClean(f);
  });

  it('enforces a hard CPU limit on real compressed PDF content without crashing NanoCore', async () => {
    const content = deflateSync(Buffer.from('0 0 m 1 1 l S\n'.repeat(3_000_000)));
    const f = await fixture(pdf([''], content), 65_536);
    const result = await processPdfTextLayer({
      ...f.input,
      limits: { cpuSeconds: 1, wallTimeMs: 10_000 },
    });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected CPU bound');
    expect(result.reason).toBe('resource-limited');
    expect(
      observations.launches.some(
        (entry) =>
          entry.args.includes('-layout') && (entry.signal === 'SIGKILL' || entry.code === 137)
      )
    ).toBe(true);
    await expectClean(f);
  });

  it('cancels a real parser process and leaves neither a derivative nor staging bytes', async () => {
    const content = deflateSync(Buffer.from('0 0 m 1 1 l S\n'.repeat(3_000_000)));
    const f = await fixture(pdf([''], content), 65_536);
    const controller = new AbortController();
    let actualParserPid: number | undefined;
    let actualLimits = '';
    let parserStart = '';
    let observation: Promise<void> | undefined;
    observations.onParser = (pid) => {
      observation = (async () => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const pending = pid ? [pid] : [];
          while (pending.length) {
            const current = pending.shift()!;
            try {
              const command = (await readFile(`/proc/${current}/comm`, 'utf8')).trim();
              if (command === 'pdftotext') {
                actualParserPid = current;
                actualLimits = await readFile(`/proc/${current}/limits`, 'utf8');
                parserStart = processIdentity(
                  await readFile(`/proc/${current}/stat`, 'utf8')
                ).start;
                controller.abort();
                return;
              }
              const children = await readFile(`/proc/${current}/task/${current}/children`, 'utf8');
              pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
            } catch {
              /* The real process may have exited between observations. */
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();
    };
    const result = await processPdfTextLayer({ ...f.input, signal: controller.signal });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected cancellation');
    expect(result.reason).toBe('cancelled');
    await observation;
    expect(actualParserPid).toBeTypeOf('number');
    await expectStopped(actualParserPid!, parserStart);
    expect(actualLimits).toMatch(/Max address space\s+536870912\s+536870912/);
    expect(actualLimits).toMatch(/Max cpu time\s+5\s+5/);
    expect(actualLimits).toMatch(/Max file size\s+0\s+0/);
    expect(actualLimits).toMatch(/Max open files\s+64\s+64/);
    expect(actualLimits).toMatch(/Max processes\s+0\s+0/);
    await expectClean(f);
  });

  it('kills a real parser at the total wall deadline', async () => {
    const content = deflateSync(Buffer.from('0 0 m 1 1 l S\n'.repeat(3_000_000)));
    const f = await fixture(pdf([''], content), 65_536);
    const started = Date.now();
    const result = await processPdfTextLayer({ ...f.input, limits: { wallTimeMs: 200 } });
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'resource-limited',
      complete: false,
      provesCompleteBodyAbsence: false,
    });
    expect(observations.launches.some((entry) => entry.args.includes('-layout'))).toBe(true);
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

  it('fails closed before opening the source when the real isolation executable cannot run', async () => {
    const f = await fixture(pdf(['Text']));
    observations.withoutIsolation = true;
    const result = await processPdfTextLayer(f.input);
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'dependency-unavailable',
      complete: false,
      provesCompleteBodyAbsence: false,
    });
    expect(f.opened()).toBe(0);
    await expectClean(f);
  });

  it('has fixed finite defaults independent of model and upload limits', () => {
    expect(PDF_TEXT_LAYER_LIMITS).toEqual({
      maxInputBytes: 67_108_864,
      maxOutputBytes: 2_097_152,
      maxPages: 64,
      addressSpaceBytes: 536_870_912,
      cpuSeconds: 5,
      wallTimeMs: 20_000,
    });
  });
});

/** Compare PID starttime, so reuse cannot conceal a still-running parser or kill another process. */
function processIdentity(stat: string): { state: string; start: string } {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  return { state: fields[0]!, start: fields[19]! };
}
async function expectStopped(pid: number, start: string): Promise<void> {
  try {
    const current = processIdentity(await readFile(`/proc/${pid}/stat`, 'utf8'));
    expect(current.start !== start || ['Z', 'X'].includes(current.state)).toBe(true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
