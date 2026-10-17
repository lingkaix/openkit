// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { expect, it, onTestFinished } from 'vitest';
import { processVisionView } from './vision-view.js';

/** Supplies exact originals and observes cleanup before storage reservation release. */
function fixture(bytes: Buffer, mediaType: string) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'vision-view-'));
  onTestFinished(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  let outstanding = 0;
  let releases = 0;
  return {
    temporaryRoot,
    releases: () => releases,
    outstanding: () => outstanding,
    input: {
      mediaType, temporaryRoot,
      source: {
        sourceKey: 'artifact:vision-fixture', revision: '1', byteLength: bytes.length,
        originalDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        async *open(signal: AbortSignal) {
          for (let offset = 0; offset < bytes.length; offset += 65_536) {
            signal.throwIfAborted();
            yield bytes.subarray(offset, offset + 65_536);
          }
        },
      },
      reserveTemporaryBytes(count: number) {
        outstanding += count;
        let remaining = count;
        return {
          recordWritten(size: bigint) { remaining -= Number(size); outstanding -= Number(size); },
          release() {
            expect(readdirSync(temporaryRoot)).toEqual([]);
            outstanding -= remaining;
            remaining = 0;
            releases++;
          },
        };
      },
    },
  };
}

/** Exact xref offsets and different solid page colors make page selection a pixel oracle. */
function coloredPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>',
  ];
  for (const color of ['1 0 0', '0 0 1']) {
    const stream = `${color} rg 0 0 32 16 re f\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 32 16] /Resources << >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

it('rasterizes the explicitly selected second PDF page and proves different page pixels through the real child', async () => {
  const f = fixture(coloredPdf(), 'application/pdf');
  const second = await processVisionView({ ...f.input, page: 2 });
  const first = await processVisionView({ ...f.input, page: 1 });
  expect(second.status).toBe('available');
  expect(first.status).toBe('available');
  if (second.status !== 'available' || first.status !== 'available') throw new Error('Expected actual PDF rasterization.');
  expect(second).toMatchObject({
    page: 2, coordinateSpace: 'pdf-page-raster-72dpi', originalDimensions: { width: 32, height: 16, frames: 1 },
    crop: { left: 0, top: 0, width: 32, height: 16 },
    source: { originalDigest: f.input.source.originalDigest },
    delivered: { mediaType: 'image/jpeg', width: 32, height: 16 },
    processor: { id: 'node-canvas-vision-v1', configuration: { heapScope: 'v8-old-generation' } },
  });
  const pixel = async (bytes: Buffer) => {
    const image = await loadImage(bytes);
    const canvas = createCanvas(32, 16);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(16, 8, 1, 1).data);
  };
  const blue = await pixel(second.bytes);
  const red = await pixel(first.bytes);
  expect(blue[2]).toBeGreaterThan(240);
  expect(blue[0]).toBeLessThan(15);
  expect(red[0]).toBeGreaterThan(240);
  expect(red[2]).toBeLessThan(15);
  expect(second.delivered.digest).toBe(`sha256:${createHash('sha256').update(second.bytes).digest('hex')}`);
  expect(second.delivered.digest).not.toBe(first.delivered.digest);
  expect(second.bytes.length).toBeLessThanOrEqual(262_144);
  expect(f.releases()).toBe(2);
  expect(f.outstanding()).toBe(0);
  expect(readdirSync(f.temporaryRoot)).toEqual([]);
}, 45_000);

it('refuses a small PNG whose header exceeds the independent pixel budget and cleans staging before release', async () => {
  const canvas = createCanvas(8, 4);
  const f = fixture(await canvas.encode('png'), 'image/png');
  const result = await processVisionView({ ...f.input, limits: { maxPixels: 8 } });
  expect(result).toEqual({ status: 'unavailable', reason: 'resource_limited' });
  expect(f.releases()).toBe(1);
  expect(f.outstanding()).toBe(0);
  expect(readdirSync(f.temporaryRoot)).toEqual([]);
}, 30_000);
