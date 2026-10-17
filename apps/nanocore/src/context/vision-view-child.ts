import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Canvas } from '@napi-rs/canvas';
import type { VisionCrop, VisionViewLimits } from './vision-view.js';

type Dimensions = { width: number; height: number };
/** Fixed page-render options are also reported by the parent as output-changing processor configuration. */
export const VISION_PDF_OPTIONS = Object.freeze({
  verbosity: 0,
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  useWorkerFetch: false,
  useWasm: false,
  enableXfa: false,
  stopAtErrors: true,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
} as const);
/** Status only; no parser text or source-selected data is written to the result channel on failure. */
class ViewFailure extends Error {
  readonly code: 2 | 3 | 4 | 5;
  constructor(code: 2 | 3 | 4 | 5) {
    super('Vision view unavailable.');
    this.code = code;
  }
}

/** Checks dimensions with overflow-safe arithmetic before raster or RGBA allocation. */
function checkDimensions(size: Dimensions, limits: VisionViewLimits): void {
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width < 1 ||
    size.height < 1
  )
    throw new ViewFailure(2);
  if (
    Math.max(size.width, size.height) > limits.maxDimension ||
    size.width > Math.floor(limits.maxPixels / size.height) ||
    size.width > Math.floor(limits.maxDecodedBytes / 4 / size.height)
  )
    throw new ViewFailure(4);
}

/** Parses the complete bounded PNG chunk structure and rejects animation before any decoder runs. */
function pngDimensions(bytes: Buffer): Dimensions {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new ViewFailure(2);
  let offset = 8;
  let size: Dimensions | undefined;
  let data = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12) throw new ViewFailure(2);
    if (
      pngCrc(bytes.subarray(offset + 4, offset + 8 + length)) !==
      bytes.readUInt32BE(offset + 8 + length)
    )
      throw new ViewFailure(2);
    if (!size) {
      if (kind !== 'IHDR' || length !== 13) throw new ViewFailure(2);
      size = { width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12) };
    } else if (kind === 'IHDR') throw new ViewFailure(2);
    // Even a one-frame APNG is outside the static PNG contract.
    if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') throw new ViewFailure(2);
    if (kind === 'IDAT') data = true;
    offset += length + 12;
    if (kind === 'IEND') {
      if (length !== 0 || offset !== bytes.length || !data) throw new ViewFailure(2);
      return size;
    }
  }
  throw new ViewFailure(2);
}

/** Validates every PNG chunk before decode instead of relying on decoder checksum tolerance. */
function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Walks marker lengths and entropy escapes, rejecting MPO, extra frames and concatenated JPEGs. */
function jpegDimensions(bytes: Buffer): Dimensions {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ViewFailure(2);
  let offset = 2;
  let size: Dimensions | undefined;
  let scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new ViewFailure(2);
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!size || !scan || offset !== bytes.length) throw new ViewFailure(2);
      return size;
    }
    if (
      marker === undefined ||
      marker === 0xd8 ||
      marker === 0 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      throw new ViewFailure(2);
    if (offset + 2 > bytes.length) throw new ViewFailure(2);
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || length > bytes.length - offset) throw new ViewFailure(2);
    if (marker === 0xe2 && bytes.toString('ascii', offset + 2, offset + 6) === 'MPF\0')
      throw new ViewFailure(2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (![0xc0, 0xc1, 0xc2].includes(marker) || size || length < 8 || bytes[offset + 2] !== 8)
        throw new ViewFailure(2);
      size = { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
    if (marker === 0xda) {
      if (!size) throw new ViewFailure(2);
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        let next = offset + 1;
        while (bytes[next] === 0xff) next++;
        const code = bytes[next];
        if (code === 0 || (code !== undefined && code >= 0xd0 && code <= 0xd7)) {
          offset = next + 1;
          continue;
        }
        break;
      }
    }
  }
  throw new ViewFailure(2);
}

/** Selects one exact integer source rectangle; downscaling never expands it. */
function selectCrop(size: Dimensions, requested?: VisionCrop): VisionCrop {
  const crop = requested ?? { left: 0, top: 0, ...size };
  if (
    !Object.values(crop).every(Number.isSafeInteger) ||
    crop.left < 0 ||
    crop.top < 0 ||
    crop.width < 1 ||
    crop.height < 1 ||
    crop.left > size.width - crop.width ||
    crop.top > size.height - crop.height
  )
    throw new ViewFailure(3);
  return crop;
}

/** Decodes only typed static images, or rasterizes only the explicitly selected PDF page. */
async function render(): Promise<void> {
  const request = JSON.parse(process.argv[3]!) as {
    mediaType: string;
    page?: number;
    crop?: VisionCrop;
    limits: VisionViewLimits;
  };
  const { limits } = request;
  const bytes = await readFile(process.argv[2]!);
  if (bytes.length > limits.maxInputBytes) throw new ViewFailure(4);
  let canvasModule: typeof import('@napi-rs/canvas');
  try {
    canvasModule = await import('@napi-rs/canvas');
  } catch {
    throw new ViewFailure(5);
  }
  const { createCanvas, loadImage } = canvasModule;
  let liveCanvasBytes = 0;
  // PDF.js uses this same factory for scratch canvases. The live app-created RGBA sum is separate from child heap and decoder internals.
  const allocations = new WeakMap<object, number>();
  const allocate = (width: number, height: number) => {
    checkDimensions({ width, height }, limits);
    const count = width * height * 4;
    if (count > limits.maxDecodedBytes - liveCanvasBytes) throw new ViewFailure(4);
    const canvas = createCanvas(width, height);
    liveCanvasBytes += count;
    allocations.set(canvas, count);
    return canvas;
  };
  const release = (canvas: Canvas) => {
    liveCanvasBytes -= allocations.get(canvas) ?? 0;
    allocations.delete(canvas);
    canvas.width = 0;
    canvas.height = 0;
  };
  class BoundedCanvasFactory {
    create(width: number, height: number) {
      const canvas = allocate(width, height);
      return { canvas, context: canvas.getContext('2d') };
    }
    reset(target: { canvas: Canvas; context: unknown }, width: number, height: number) {
      checkDimensions({ width, height }, limits);
      const old = allocations.get(target.canvas) ?? 0;
      const count = width * height * 4;
      if (count > limits.maxDecodedBytes - liveCanvasBytes + old) throw new ViewFailure(4);
      target.canvas.width = width;
      target.canvas.height = height;
      liveCanvasBytes += count - old;
      allocations.set(target.canvas, count);
      target.context = target.canvas.getContext('2d');
    }
    destroy(target: { canvas: Canvas | null; context: unknown }) {
      if (target.canvas) release(target.canvas);
      target.canvas = null;
      target.context = null;
    }
  }
  let size: Dimensions;
  let draw: (canvas: Canvas, crop: VisionCrop, scale: number) => Promise<void>;
  let destroy: (() => Promise<void>) | undefined;
  if (request.mediaType === 'image/png' || request.mediaType === 'image/jpeg') {
    if (request.page !== undefined) throw new ViewFailure(3);
    size = request.mediaType === 'image/png' ? pngDimensions(bytes) : jpegDimensions(bytes);
    checkDimensions(size, limits);
    const crop = selectCrop(size, request.crop);
    const scale = Math.min(1, limits.maxOutputDimension / Math.max(crop.width, crop.height));
    // Native image decode and output canvas are both present during drawing.
    if (
      size.width * size.height * 4 +
        Math.max(1, Math.floor(crop.width * scale)) *
          Math.max(1, Math.floor(crop.height * scale)) *
          4 >
      limits.maxDecodedBytes
    )
      throw new ViewFailure(4);
    const image = await loadImage(bytes);
    if (image.width !== size.width || image.height !== size.height) throw new ViewFailure(2);
    draw = async (canvas, selected) => {
      canvas
        .getContext('2d')
        .drawImage(
          image,
          selected.left,
          selected.top,
          selected.width,
          selected.height,
          0,
          0,
          canvas.width,
          canvas.height
        );
    };
  } else if (request.mediaType === 'application/pdf') {
    if (
      !Number.isSafeInteger(request.page) ||
      request.page! < 1 ||
      !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
    )
      throw new ViewFailure(3);
    let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
    try {
      pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    } catch {
      throw new ViewFailure(5);
    }
    const packageRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    const loading = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      ...VISION_PDF_OPTIONS,
      maxImageSize: Math.min(limits.maxPixels, Math.floor(limits.maxDecodedBytes / 4)),
      canvasMaxAreaInBytes: limits.maxDecodedBytes,
      CanvasFactory: BoundedCanvasFactory,
      cMapUrl: join(packageRoot, 'cmaps') + sep,
      standardFontDataUrl: join(packageRoot, 'standard_fonts') + sep,
    });
    destroy = () => loading.destroy();
    try {
      const document = await loading.promise;
      const { info } = await document.getMetadata();
      if ((info as { EncryptFilterName?: string | null }).EncryptFilterName != null)
        throw new ViewFailure(2);
      if (request.page! > document.numPages) throw new ViewFailure(3);
      const page = await document.getPage(request.page!);
      const viewport = page.getViewport({ scale: 1 });
      size = { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) };
      checkDimensions(size, limits);
      draw = async (canvas, crop, scale) => {
        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          viewport: page.getViewport({ scale }),
          transform: [1, 0, 0, 1, -crop.left * scale, -crop.top * scale],
          background: 'rgb(255,255,255)',
        }).promise;
      };
    } catch (error) {
      await loading.destroy();
      throw error;
    }
  } else throw new ViewFailure(3);
  try {
    const crop = selectCrop(size, request.crop);
    const scale = Math.min(1, limits.maxOutputDimension / Math.max(crop.width, crop.height));
    const width = Math.max(1, Math.floor(crop.width * scale));
    const height = Math.max(1, Math.floor(crop.height * scale));
    const canvas = allocate(width, height);
    try {
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      await draw(canvas, crop, scale);
      const reader = canvas.encodeStream('jpeg', 80).getReader();
      const chunks: Buffer[] = [];
      let count = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          count += next.value.length;
          if (count > limits.maxOutputBytes) {
            await reader.cancel();
            throw new ViewFailure(4);
          }
          chunks.push(Buffer.from(next.value));
        }
      } finally {
        reader.releaseLock();
      }
      process.stdout.write(
        JSON.stringify({
          originalDimensions: { ...size, frames: 1 },
          crop,
          width,
          height,
          data: Buffer.concat(chunks).toString('base64'),
        })
      );
    } finally {
      release(canvas);
    }
  } finally {
    await destroy?.();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void render().catch((error: unknown) => {
    process.exitCode =
      error instanceof ViewFailure ? error.code : error instanceof RangeError ? 4 : 2;
  });
}
