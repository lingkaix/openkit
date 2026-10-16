import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BoundedByteSource,
  BoundedSourceError,
  type BoundedSourceView,
  openBoundedSourceView,
  type SourceViewCursor,
  type SourceViewIdentity,
  type SourceViewLimits,
  type SourceViewPage,
} from './bounded-source-view.js';

const limits: SourceViewLimits = {
  maxRepresentationBytes: 1_000_000,
  timeoutMs: 5_000,
  maxEnvelopeBytes: 65_536,
};
const originals = JSON.parse(
  readFileSync(
    new URL('../../../../tests/fixtures/large-context/cases.json', import.meta.url),
    'utf8'
  )
).originals as Array<{
  id: string;
  patternHex: string;
  repeats: number;
  size: number;
  sha256: string;
}>;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Test oracle over original bytes; no production digest or range helper supplies expected values. */
function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** An existing inline byte owner, with observable bounded source calls. */
function inline(bytes: Buffer, identity: Partial<SourceViewIdentity> = {}) {
  return {
    identity: {
      sourceKey:
        'artifact:ws_00000000-0000-7000-8000-000000000401/ar_00000000-0000-7000-8000-0000000003eb@1',
      revision: 'revision-1',
      originalDigest: digest(bytes),
      representationId: 'original-utf8',
      representationDigest: digest(bytes),
      ...identity,
    },
    byteLength: bytes.length,
    read: vi.fn(async (offset: number, maxBytes: number, _signal: AbortSignal) =>
      bytes.subarray(offset, offset + maxBytes)
    ),
    assertUnchanged: vi.fn((_signal: AbortSignal) => {}),
  } satisfies BoundedByteSource;
}

/** Requires a genuinely verified view before exercising its read methods. */
async function ready(source: BoundedByteSource, budget = limits): Promise<BoundedSourceView> {
  const result = await openBoundedSourceView(source, budget);
  expect(result).toMatchObject({ status: 'ready' });
  if (result.status !== 'ready') throw new Error('Expected a verified source view.');
  return result;
}

/** Checks exact original ranges and the complete serialized envelope independently. */
function page(
  result: Awaited<ReturnType<BoundedSourceView['read']>>,
  bytes: Buffer
): SourceViewPage {
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error('Expected a bounded source page.');
  expect(Buffer.from(result.text, 'utf8')).toEqual(
    bytes.subarray(result.range.start, result.range.end)
  );
  expect(result.representationByteLength).toBe(bytes.length);
  expect(result.truncated).toBe(result.range.start > 0 || result.range.end < bytes.length);
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(65_536);
  return result;
}

describe('bounded UTF-8 source views', () => {
  it.each([
    ['preview', 2_048],
    ['preview', 2_049],
    ['read', 51_200],
    ['read', 51_201],
  ] as const)('enforces the %s byte ceiling for %i original bytes', async (mode, size) => {
    const bytes = Buffer.alloc(size, 120);
    const view = await ready(inline(bytes));
    const result = page(await view[mode](), bytes);
    const expected = mode === 'preview' ? 2_048 : 51_200;
    expect(result.range).toEqual({
      representationId: 'original-utf8',
      start: 0,
      end: Math.min(expected, size),
    });
    expect(result.mode).toBe(mode);
    expect(result.requestedRange).toEqual({ start: 0, end: Math.min(expected, size) });
    expect(result.eof).toBe(size === expected);
    expect(result.cursor === null).toBe(result.eof);
    expect(result.omittedRanges).toEqual(size === expected ? [] : [{ start: expected, end: size }]);
  });

  it.each([
    ['preview', 50],
    ['preview', 51],
    ['read', 2_000],
    ['read', 2_001],
  ] as const)('independently enforces the %s line ceiling for %i LF-terminated lines', async (mode, lines) => {
    const bytes = Buffer.from('x\n'.repeat(lines));
    const view = await ready(inline(bytes));
    const result = page(await view[mode](), bytes);
    const expected = mode === 'preview' ? 50 : 2_000;
    expect(result.range.end).toBe(Math.min(expected, lines) * 2);
    expect(result.lineCount).toBe(Math.min(expected, lines));
    expect(result.eof).toBe(lines === expected);
    if (result.cursor) {
      const remainder = page(await view.read(result.cursor), bytes);
      expect(remainder.range).toMatchObject({ start: expected * 2, end: bytes.length });
      expect(remainder.eof).toBe(true);
    }
  });

  it.each([
    '界',
    '😀',
  ])('never splits or replaces %s across preview, read, or source-read boundaries', async (character) => {
    const bytes = Buffer.from(character.repeat(18_000));
    const source = inline(bytes);
    // Deliberately split every source response inside multibyte code points.
    source.read.mockImplementation(async (offset, maxBytes) =>
      bytes.subarray(offset, offset + Math.min(maxBytes, 7))
    );
    const view = await ready(source);
    const preview = page(await view.preview(), bytes);
    const width = Buffer.byteLength(character, 'utf8');
    expect(preview.range.end).toBe(Math.floor(2_048 / width) * width);
    const first = page(await view.read(), bytes);
    expect(first.range.end).toBe(Math.floor(51_200 / width) * width);
    const next = page(await view.read(first.cursor!), bytes);
    expect(next.range.start).toBe(first.range.end);
    expect(first.text + next.text).toBe(bytes.toString('utf8'));
    expect(next.eof).toBe(true);
  });

  it('reads the frozen CJK source using its prior digest and exact byte ranges', async () => {
    const fixture = originals.find((entry) => entry.id === 'cjk-single-line')!;
    const bytes = Buffer.from(fixture.patternHex.repeat(fixture.repeats), 'hex');
    const view = await ready(
      inline(bytes, { originalDigest: fixture.sha256, representationDigest: fixture.sha256 })
    );
    const preview = page(await view.preview(), bytes);
    const first = page(await view.read(), bytes);
    const last = page(await view.read(first.cursor!), bytes);
    expect(preview.range).toMatchObject({ start: 0, end: 2_046 });
    expect(first.range).toMatchObject({ start: 0, end: 51_198 });
    expect(last.range).toMatchObject({ start: 51_198, end: 54_000 });
    expect(last.eof).toBe(true);
  });

  it('makes exact progress through one huge line and reports EOF only at its final byte', async () => {
    const fixture = originals.find((entry) => entry.id === 'huge-single-line')!;
    const bytes = Buffer.from(fixture.patternHex.repeat(fixture.repeats), 'hex');
    const view = await ready(
      inline(bytes, { originalDigest: fixture.sha256, representationDigest: fixture.sha256 })
    );
    const first = page(await view.read(), bytes);
    const middle = page(await view.read(first.cursor!), bytes);
    const last = page(await view.read(middle.cursor!), bytes);
    expect([first.range, middle.range, last.range]).toEqual([
      { representationId: 'original-utf8', start: 0, end: 51_200 },
      { representationId: 'original-utf8', start: 51_200, end: 102_400 },
      { representationId: 'original-utf8', start: 102_400, end: 120_000 },
    ]);
    expect([first.lineCount, middle.lineCount, last.lineCount]).toEqual([1, 1, 1]);
    expect([first.eof, middle.eof, last.eof]).toEqual([false, false, true]);
    expect([first.truncated, middle.truncated, last.truncated]).toEqual([true, true, true]);
    expect(last.cursor).toBeNull();
    expect(first.text + middle.text + last.text).toBe(bytes.toString('utf8'));
    expect(middle.omittedRanges).toEqual([
      { start: 0, end: 51_200 },
      { start: 102_400, end: 120_000 },
    ]);
  });

  it('preserves BOM and CRLF bytes and applies both caps to a partial final line', async () => {
    const bytes = Buffer.from(`\ufeff${'x\r\n'.repeat(49)}${'界'.repeat(1_000)}`);
    const view = await ready(inline(bytes));
    const first = page(await view.preview(), bytes);
    expect(first.text.startsWith('\ufeff')).toBe(true);
    expect(first.text).toContain('\r\n');
    expect(first.range.end).toBe(2_046);
    expect(first.lineCount).toBe(50);
    const next = page(await view.read(first.cursor!), bytes);
    expect(first.text + next.text).toBe(bytes.toString('utf8'));
    expect(next.eof).toBe(true);
  });

  it('distinguishes a verified empty source from an unavailable source', async () => {
    const bytes = Buffer.alloc(0);
    const view = await ready(inline(bytes), { ...limits, maxRepresentationBytes: 0 });
    expect(page(await view.preview(), bytes)).toMatchObject({
      text: '',
      representationByteLength: 0,
      lineCount: 0,
      truncated: false,
      eof: true,
      cursor: null,
      range: { start: 0, end: 0 },
      omittedRanges: [],
    });
  });

  it.each([
    'sourceKey',
    'revision',
    'originalDigest',
    'representationId',
    'representationDigest',
  ] as const)('rejects a continuation after its %s changes', async (field) => {
    const bytes = Buffer.alloc(60_000, 120);
    const source = inline(bytes);
    const initial = await ready(source);
    const cursor = page(await initial.preview(), bytes).cursor!;
    const identity = {
      ...source.identity,
      [field]: field.endsWith('Digest') ? `sha256:${'a'.repeat(64)}` : 'changed-identity',
    };
    if (field === 'representationDigest') {
      source.identity = identity;
      expect(await initial.read(cursor)).toEqual({ status: 'unavailable', reason: 'stale' });
    } else {
      const changed = await ready(inline(bytes, identity));
      expect(await changed.read(cursor)).toEqual({ status: 'unavailable', reason: 'stale' });
    }
  });

  it('binds the requested mode and range, with explicit preview-to-read continuation', async () => {
    const bytes = Buffer.alloc(120_000, 120);
    const view = await ready(inline(bytes));
    const preview = page(await view.preview(), bytes);
    expect(preview.mode).toBe('preview');
    expect(preview.cursor).toMatchObject({ mode: 'read', range: { start: 2_048, end: 53_248 } });
    expect(page(await view.read(preview.cursor!), bytes)).toMatchObject({
      mode: 'read',
      requestedRange: { start: 2_048, end: 53_248 },
    });
    expect(
      await view.read({ ...preview.cursor!, mode: 'preview' } as unknown as SourceViewCursor)
    ).toEqual({ status: 'unavailable', reason: 'invalid_request' });
    expect(await view.read({ ...preview.cursor!, range: { start: 2_049, end: 53_249 } })).toEqual({
      status: 'unavailable',
      reason: 'stale',
    });
    expect(await view.read({ ...preview.cursor!, range: { start: 2_048, end: 53_247 } })).toEqual({
      status: 'unavailable',
      reason: 'invalid_request',
    });
  });

  it('keeps derived text identity distinct from the binary original and reports representation offsets', async () => {
    const bytes = Buffer.from('Extracted PDF page text.\n');
    const originalDigest = `sha256:${'b'.repeat(64)}`;
    const view = await ready(
      inline(bytes, { originalDigest, representationId: 'pdf-text:processor-v1:config-a' })
    );
    const result = page(await view.read(), bytes);
    expect(result.identity).toMatchObject({ originalDigest, representationDigest: digest(bytes) });
    expect(result.range).toEqual({
      representationId: 'pdf-text:processor-v1:config-a',
      start: 0,
      end: bytes.length,
    });
    expect(result.identity.originalDigest).not.toBe(result.identity.representationDigest);
  });

  it.each([
    Buffer.from('00ffc328800a', 'hex'),
    Buffer.concat([Buffer.alloc(70_000, 120), Buffer.from([0xe7, 0x95])]),
  ])('refuses invalid UTF-8 anywhere in the representation without a preview or replacement', async (bytes) => {
    const result = await openBoundedSourceView(inline(bytes), limits);
    expect(result).toEqual({ status: 'unavailable', reason: 'invalid_utf8' });
    expect(result).not.toHaveProperty('preview');
    expect(result).not.toHaveProperty('cursor');
  });

  it('rejects a corrupt digest and both short and surplus declared EOF', async () => {
    const bytes = Buffer.from('Exact bytes');
    expect(
      await openBoundedSourceView(
        inline(bytes, { representationDigest: `sha256:${'a'.repeat(64)}` }),
        limits
      )
    ).toEqual({ status: 'unavailable', reason: 'corrupt' });
    for (const byteLength of [bytes.length - 1, bytes.length + 1]) {
      const source = { ...inline(bytes), byteLength };
      expect(await openBoundedSourceView(source, limits)).toEqual({
        status: 'unavailable',
        reason: 'corrupt',
      });
    }
    expect(await openBoundedSourceView({ ...inline(bytes), byteLength: 0 }, limits)).toEqual({
      status: 'unavailable',
      reason: 'corrupt',
    });
  });

  it('rejects oversized source replies and a no-progress source instead of looping', async () => {
    const source = inline(Buffer.from('text'));
    source.read.mockImplementationOnce(async () => Buffer.alloc(65_537));
    expect(await openBoundedSourceView(source, limits)).toEqual({
      status: 'unavailable',
      reason: 'corrupt',
    });
    source.read.mockImplementation(async () => Buffer.alloc(0));
    expect(await openBoundedSourceView(source, limits)).toEqual({
      status: 'unavailable',
      reason: 'corrupt',
    });
  });

  it('bounds all identity, omission, cursor and JSON-escaped body bytes in one envelope', async () => {
    const bytes = Buffer.from('\u0000"\\'.repeat(20_000));
    const source = inline(bytes, {
      sourceKey: 's'.repeat(900),
      revision: 'r'.repeat(400),
      representationId: 'p'.repeat(400),
    });
    const budget = { ...limits, maxEnvelopeBytes: 4_096 };
    const view = await ready(source, budget);
    let cursor: SourceViewCursor | undefined;
    const parts: string[] = [];
    do {
      const result = page(await view.read(cursor), bytes);
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(4_096);
      expect(result.range.end).toBeGreaterThan(result.range.start);
      expect(
        result.cursor ? Buffer.byteLength(JSON.stringify(result.cursor), 'utf8') : 0
      ).toBeLessThan(256);
      parts.push(result.text);
      cursor = result.cursor ?? undefined;
      if (result.eof) break;
    } while (parts.length < 500);
    expect(parts.join('')).toBe(bytes.toString('utf8'));
  });

  it('returns only a fixed descriptor when metadata or the remaining envelope budget cannot fit', async () => {
    const bytes = Buffer.from('readable');
    const oversized = inline(bytes, { sourceKey: 'PRIVATE'.repeat(100_000) });
    const invalid = await openBoundedSourceView(oversized, limits);
    expect(invalid).toEqual({ status: 'unavailable', reason: 'invalid_request' });
    expect(oversized.read).not.toHaveBeenCalled();
    const aggregate = inline(bytes, {
      sourceKey: 's'.repeat(700),
      revision: 'r'.repeat(700),
      representationId: 'p'.repeat(700),
    });
    expect(await openBoundedSourceView(aggregate, limits)).toEqual({
      status: 'unavailable',
      reason: 'invalid_request',
    });
    expect(aggregate.read).not.toHaveBeenCalled();
    const view = await ready(inline(bytes), { ...limits, maxEnvelopeBytes: 128 });
    expect(await view.read()).toEqual({ status: 'unavailable', reason: 'resource_limited' });
    expect(await openBoundedSourceView(inline(bytes), { ...limits, maxEnvelopeBytes: 1 })).toEqual({
      status: 'unavailable',
      reason: 'invalid_request',
    });
  });

  it('admits derived sources above one GB only under the caller byte budget, without allocating the source', async () => {
    const source = { ...inline(Buffer.alloc(0)), byteLength: 1_000_000_001 };
    source.read.mockImplementation(async () => {
      throw new BoundedSourceError('missing');
    });
    expect(
      await openBoundedSourceView(source, { ...limits, maxRepresentationBytes: 1_000_000_001 })
    ).toEqual({ status: 'unavailable', reason: 'missing' });
    expect(source.read).toHaveBeenCalledOnce();
    expect(source.read.mock.calls[0]![1]).toBe(65_536);
    source.read.mockClear();
    expect(
      await openBoundedSourceView(source, { ...limits, maxRepresentationBytes: 1_000_000_000 })
    ).toEqual({ status: 'unavailable', reason: 'resource_limited' });
    expect(source.read).not.toHaveBeenCalled();
  });

  it.each([
    'unsupported',
    'missing',
    'corrupt',
    'stale',
  ] as const)('keeps %s diagnostics bounded and never returns a working-looking handle', async (reason) => {
    const source = inline(Buffer.from('PRIVATE body'));
    source.read.mockImplementation(async () => {
      throw new BoundedSourceError(reason);
    });
    expect(await openBoundedSourceView(source, limits)).toEqual({ status: 'unavailable', reason });
    source.read.mockImplementation(async () => {
      throw Object.assign(new Error('PRIVATE path and original bytes'), { code: 'ENOENT' });
    });
    expect(await openBoundedSourceView(source, limits)).toEqual({
      status: 'unavailable',
      reason: 'missing',
    });
  });

  it('bounds stalled verification and range reads and passes cancellation to the source owner', async () => {
    const source = inline(Buffer.alloc(60_000, 120));
    source.read.mockImplementationOnce(
      async (_offset, _length, signal) =>
        new Promise<Buffer>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('PRIVATE timeout cause')), {
            once: true,
          })
        )
    );
    expect(await openBoundedSourceView(source, { ...limits, timeoutMs: 20 })).toEqual({
      status: 'unavailable',
      reason: 'resource_limited',
    });
    const stalledRange = inline(Buffer.alloc(60_000, 120));
    const timedView = await ready(stalledRange, { ...limits, timeoutMs: 100 });
    stalledRange.read.mockImplementation(
      async (_offset, _length, signal) =>
        new Promise<Buffer>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('PRIVATE range timeout cause')), {
            once: true,
          })
        )
    );
    expect(await timedView.read()).toEqual({ status: 'unavailable', reason: 'resource_limited' });
    const view = await ready(source);
    const controller = new AbortController();
    let entered: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    source.read.mockImplementation(async (_offset, _length, signal) => {
      entered!();
      return new Promise<Buffer>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('PRIVATE cancel cause')), {
          once: true,
        })
      );
    });
    const pending = view.read(undefined, controller.signal);
    await reading;
    controller.abort();
    expect(await pending).toEqual({ status: 'unavailable', reason: 'cancelled' });
    expect(await openBoundedSourceView(source, limits, controller.signal)).toEqual({
      status: 'unavailable',
      reason: 'cancelled',
    });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('refuses invalid source byte admission %s before access', async (maxRepresentationBytes) => {
    const source = inline(Buffer.from('text'));
    expect(await openBoundedSourceView(source, { ...limits, maxRepresentationBytes })).toEqual({
      status: 'unavailable',
      reason: 'invalid_request',
    });
    expect(source.read).not.toHaveBeenCalled();
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
  ])('rejects a nonpositive or unbounded deadline %s before source access', async (timeoutMs) => {
    const source = inline(Buffer.from('text'));
    expect(await openBoundedSourceView(source, { ...limits, timeoutMs })).toEqual({
      status: 'unavailable',
      reason: 'invalid_request',
    });
    expect(source.read).not.toHaveBeenCalled();
  });

  it('reads real held file descriptors and rejects drift and a later missing source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bounded-source-'));
    roots.push(root);
    const path = join(root, 'source');
    const bytes = Buffer.from('界'.repeat(25_000));
    await writeFile(path, bytes);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = await handle.stat({ bigint: true });
      const source: BoundedByteSource = {
        identity: inline(bytes).identity,
        byteLength: bytes.length,
        async assertUnchanged() {
          const current = await handle.stat({ bigint: true });
          if (
            !current.isFile() ||
            current.nlink !== 1n ||
            current.ino !== before.ino ||
            current.dev !== before.dev ||
            current.size !== before.size ||
            current.mtimeNs !== before.mtimeNs ||
            current.ctimeNs !== before.ctimeNs
          )
            throw new BoundedSourceError('stale');
        },
        async read(offset, maxBytes) {
          expect(maxBytes).toBeLessThanOrEqual(65_536);
          const buffer = Buffer.alloc(maxBytes);
          const { bytesRead } = await handle.read(buffer, 0, maxBytes, offset);
          return buffer.subarray(0, bytesRead);
        },
      };
      const view = await ready(source);
      const first = page(await view.read(), bytes);
      expect(first.range.end).toBe(51_198);
      await writeFile(path, Buffer.alloc(bytes.length, 120));
      expect(await view.read(first.cursor!)).toEqual({ status: 'unavailable', reason: 'stale' });
      expect(await openBoundedSourceView(source, limits)).toEqual({
        status: 'unavailable',
        reason: 'stale',
      });
    } finally {
      await handle.close();
    }
    await rm(path);
    const missing = inline(bytes);
    missing.assertUnchanged.mockImplementation(async () => {
      await open(path, 'r');
    });
    expect(await openBoundedSourceView(missing, limits)).toEqual({
      status: 'unavailable',
      reason: 'missing',
    });
  });
});
