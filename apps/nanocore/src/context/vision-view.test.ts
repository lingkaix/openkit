// openkit-test-platform: posix
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { createPdfFixture } from '../test-support/pdf-fixture.js';
import { processVisionView } from './vision-view.js';

const observations = vi.hoisted(() => ({ decodes: 0, rasterArguments: [] as string[][] }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if ((args[1] as string[]).includes('jpeg:-')) observations.decodes += 1;
      if (
        (args[1] as string[]).includes('/usr/bin/pdftoppm') &&
        (args[1] as string[]).includes('-jpeg')
      )
        observations.rasterArguments.push([...(args[1] as string[])]);
      return actual.spawn(...args);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  observations.decodes = 0;
  observations.rasterArguments.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A valid RGB PNG with independently encoded header, CRC and scanlines. */
function png(width: number, height: number, declaredWidth = width): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(declaredWidth);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const value = 16 + column * 24 + row * 4;
      pixels.fill(
        value,
        row * (width * 3 + 1) + 1 + column * 3,
        row * (width * 3 + 1) + 4 + column * 3
      );
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Shared admission double measures actual private staging release; parsing and isolation stay real. */
async function fixture(bytes = png(8, 6)) {
  const root = await mkdtemp(join(tmpdir(), 'vision-view-'));
  roots.push(root);
  let reserved = 0;
  return {
    input: {
      source: {
        sourceKey: 'selected-image',
        revision: '1',
        originalDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        byteLength: bytes.length,
        async *open() {
          yield bytes;
        },
      },
      mediaType: 'image/png' as const,
      temporaryRoot: root,
      reserveTemporaryBytes(size: number) {
        reserved += size;
        return {
          recordWritten() {},
          release() {
            reserved -= size;
          },
        };
      },
    },
    root,
    reserved: () => reserved,
  };
}

it('returns an actual isolated bounded JPEG crop with separate original and delivered identities', async () => {
  const f = await fixture();
  const result = await processVisionView({
    ...f.input,
    crop: { left: 1, top: 1, width: 3, height: 2 },
  });
  expect(result.status).toBe('available');
  if (result.status !== 'available') throw new Error('The real image processor is unavailable.');
  expect(result.source).toEqual({ ...f.input.source, open: undefined });
  expect(result.originalDimensions).toEqual({ width: 8, height: 6, frames: 1 });
  expect(result.crop).toEqual({ left: 1, top: 1, width: 3, height: 2 });
  expect(result.delivered).toMatchObject({ mediaType: 'image/jpeg', width: 3, height: 2 });
  expect(result.delivered.digest).toBe(
    `sha256:${createHash('sha256').update(result.bytes).digest('hex')}`
  );
  expect(result.delivered.digest).not.toBe(result.source.originalDigest);
  const output = join(f.root, 'observed.jpg');
  await writeFile(output, result.bytes);
  expect(
    execFileSync('/usr/bin/identify', ['-format', '%wx%h', output], { encoding: 'utf8' })
  ).toBe('3x2');
  const decoded = execFileSync('/usr/bin/convert', [output, '-depth', '8', 'gray:-']);
  expect(decoded.length).toBe(6);
  for (const [index, expected] of [44, 68, 92, 48, 72, 96].entries())
    expect(Math.abs(decoded[index]! - expected)).toBeLessThanOrEqual(5);
  expect(observations.decodes).toBe(1);
  expect(f.reserved()).toBe(0);
}, 30_000);

it('refuses a declared oversized raster before starting the image decoder', async () => {
  const f = await fixture(png(1, 1, 20_000));
  const result = await processVisionView(f.input);
  expect(result.status).toBe('unavailable');
  expect(observations.decodes).toBe(0);
  expect(f.reserved()).toBe(0);
}, 30_000);

it('renders only the requested PDF page and preserves its original raster crop coordinates', async () => {
  const f = await fixture(createPdfFixture(['first page', 'second page']));
  const result = await processVisionView({
    ...f.input,
    mediaType: 'application/pdf',
    page: 2,
    crop: { left: 20, top: 30, width: 8, height: 6 },
  });
  expect(result).toMatchObject({
    status: 'available',
    page: 2,
    coordinateSpace: 'pdf-page-raster-72dpi',
    originalDimensions: { width: 612, height: 792, frames: 1 },
    crop: { left: 20, top: 30, width: 8, height: 6 },
    delivered: { width: 8, height: 6, mediaType: 'image/jpeg' },
  });
  const launch = observations.rasterArguments[0]!;
  const executable = launch.indexOf('/usr/bin/pdftoppm');
  expect(launch.slice(executable + 1)).toEqual([
    '-f',
    '2',
    '-l',
    '2',
    '-singlefile',
    '-r',
    '72',
    '-x',
    '20',
    '-y',
    '30',
    '-W',
    '8',
    '-H',
    '6',
    '-jpeg',
    '/input.pdf',
  ]);
  expect(f.reserved()).toBe(0);
}, 30_000);
