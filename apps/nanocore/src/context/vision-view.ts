import { createHash } from 'node:crypto';
import { type FileHandle, open } from 'node:fs/promises';
import {
  assertMediaIsolation,
  type MediaByteSource,
  MediaProcessFailure,
  type MediaResourceProfile,
  type MediaStageReservation,
  runMediaProcess,
  validMediaResourceProfile,
  validMediaSource,
  withStagedMediaSource,
} from './media-process.js';

/** Independent source, decode and delivery ceilings; none is a model token estimate. */
export interface VisionViewLimits {
  maxInputBytes: number;
  maxSourceDimension: number;
  maxSourcePixels: number;
  maxFrames: 1;
  maxDecodedBytes: number;
  maxDeliveredDimension: number;
  maxDeliveredPixels: number;
  maxDeliveredBytes: number;
  maxHeaderBytes: number;
  maxChunkHeaders: number;
  /** Per-process address space, with fixed Bubblewrap supervisor overhead. */
  addressSpaceBytes: number;
  cpuSeconds: number;
  wallTimeMs: number;
}
/** Conservative raster defaults, independent of arbitrary-file upload admission. */
export const VISION_VIEW_LIMITS: Readonly<VisionViewLimits> = Object.freeze({
  maxInputBytes: 33_554_432,
  maxSourceDimension: 8192,
  maxSourcePixels: 16_777_216,
  maxFrames: 1,
  maxDecodedBytes: 536_870_912,
  maxDeliveredDimension: 1024,
  maxDeliveredPixels: 1_048_576,
  maxDeliveredBytes: 1_048_576,
  maxHeaderBytes: 65_536,
  maxChunkHeaders: 1024,
  addressSpaceBytes: 1_073_741_824,
  cpuSeconds: 5,
  wallTimeMs: 15_000,
});
const IMAGE_ENV = Object.freeze({
  MAGICK_THREAD_LIMIT: '1',
  OMP_NUM_THREADS: '1',
  MAGICK_OCL_DEVICE: 'OFF',
});
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const HEADER_GUARD = 'raster-header-v1';
// Q16-HDRI may use 8-byte quanta. Four channels and four live planes are forecast before decode.
const DECODE_BYTES_PER_PIXEL = 128;

type Reason =
  | 'not-requested'
  | 'invalid-source'
  | 'invalid-resource-profile'
  | 'invalid-limits'
  | 'unsupported-format'
  | 'unsupported-animation'
  | 'invalid-image'
  | 'dimensions-exceeded'
  | 'dependency-unavailable'
  | 'source-unavailable'
  | 'source-changed'
  | 'resource-limited'
  | 'cancelled'
  | 'cleanup-unavailable';
class VisionFailure extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}

/** One source-owner request; absence of explicit intent cannot start image processing. */
export interface CreateVisionViewInput extends MediaResourceProfile {
  requested: true;
  source: MediaByteSource;
  temporaryRoot: string;
  reserveTemporaryBytes(bytes: number): MediaStageReservation;
  signal?: AbortSignal;
  limits?: Partial<VisionViewLimits>;
}
/** Bounded exact PNG bytes and source facts required for parent-side cost admission. */
export interface VisionView {
  schema: 'vision-view-v1';
  source: Omit<MediaByteSource, 'open'>;
  processor: MediaResourceProfile & {
    id: 'imagemagick-vision-v1';
    executableVersion: string;
    configuration: VisionViewLimits & {
      headerGuard: typeof HEADER_GUARD;
      decodedBytesPerPixel: 128;
      encoding: 'PNG-RGBA8';
      colorSpace: 'sRGB';
      metadata: 'strip';
      orientation: 'auto';
      filter: 'Lanczos';
      resize: 'fit-no-enlarge';
      threadCount: 1;
      addressSpaceScope: 'per-process';
      parserDescendants: 0;
    };
  };
  representationId: string;
  representationDigest: string;
  cacheKey: string;
  mediaType: 'image/png';
  bytes: Buffer;
  sourceImage: {
    format: 'PNG' | 'JPEG' | 'GIF' | 'WEBP';
    width: number;
    height: number;
    frames: 1;
    bitDepth: number;
    decodedMemoryForecast: number;
  };
  deliveredImage: {
    width: number;
    height: number;
    frames: 1;
    bitDepth: 8;
    pixels: number;
    byteLength: number;
  };
  locator: {
    kind: 'image';
    frame: 1;
    coordinateSpace: 'source-pixels';
    crop: { x: 0; y: 0; width: number; height: number };
  };
  coverage: {
    kind: 'image-view';
    complete: false;
    provesCompleteBodyAbsence: false;
    omissions: ('metadata' | 'original-resolution')[];
  };
}
/** Never substitutes original bytes or a fictitious working handle on failure. */
export type VisionViewResult =
  | { status: 'available'; view: VisionView }
  | { status: 'unavailable'; reason: Reason; complete: false; provesCompleteBodyAbsence: false };

/** Produces only an explicitly requested bounded raster. No OCR, model or cache mutation occurs. */
export async function createVisionView(input: CreateVisionViewInput): Promise<VisionViewResult> {
  const unavailable = (reason: Reason): VisionViewResult => ({
    status: 'unavailable',
    reason,
    complete: false,
    provesCompleteBodyAbsence: false,
  });
  if (input.requested !== true) return unavailable('not-requested');
  if (!validMediaResourceProfile(input)) return unavailable('invalid-resource-profile');
  const resourceProfileDigest = input.resourceProfileDigest;
  if (!validMediaSource(input.source)) return unavailable('invalid-source');
  const limits = { ...VISION_VIEW_LIMITS, ...input.limits };
  if (!validLimits(limits)) return unavailable('invalid-limits');
  if (input.source.byteLength > limits.maxInputBytes) return unavailable('resource-limited');
  const original = { ...input.source, open: input.source.open.bind(input.source) };
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(limits.wallTimeMs),
  ]);
  try {
    signal.throwIfAborted();
    await assertMediaIsolation(limits, signal, IMAGE_ENV);
    const version = await native(['-version'], limits, signal, undefined, 4096);
    const executableVersion = /^Version: (ImageMagick [^\r\n]{1,240})\r?\n/.exec(
      version.stdout.toString('utf8')
    )?.[1];
    if (version.code !== 0 || version.stderr.length !== 0 || !executableVersion)
      throw new VisionFailure('dependency-unavailable');
    return await withStagedMediaSource<VisionViewResult>(
      original,
      input.temporaryRoot,
      input.reserveTemporaryBytes,
      signal,
      'vision-view-',
      async (path) => {
        const format = await inspectContainer(path, original.byteLength, limits, signal);
        // Force only the admitted built-in raster coder; a misleading extension cannot select a delegate.
        const imagePath = `${format.toLowerCase()}:/input.pdf`;
        const header = await native(
          ['identify', '-ping', ...resourceFlags(limits), '-format', '%m %w %h %n %z\n', imagePath],
          limits,
          signal,
          path,
          4096
        );
        if (header.code !== 0 || header.stderr.length !== 0)
          throw new VisionFailure('invalid-image');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(header.stdout);
        const rows = text
          .trim()
          .split('\n')
          .map((line) => /^(PNG|JPEG|GIF|WEBP) (\d+) (\d+) (\d+) (\d+)$/.exec(line));
        if (rows.some((row) => row === null)) throw new VisionFailure('invalid-image');
        if (rows.length !== 1 || rows.some((row) => row?.[4] !== '1'))
          throw new VisionFailure('unsupported-animation');
        const row = rows[0];
        if (!row || row[1] !== format) throw new VisionFailure('invalid-image');
        const width = Number(row[2]);
        const height = Number(row[3]);
        const bitDepth = Number(row[5]);
        const pixels = width * height;
        const decodedMemoryForecast = pixels * DECODE_BYTES_PER_PIXEL;
        if (
          ![width, height, bitDepth, pixels, decodedMemoryForecast].every(
            (value) => Number.isSafeInteger(value) && value > 0
          )
        )
          throw new VisionFailure('invalid-image');
        if (
          width > limits.maxSourceDimension ||
          height > limits.maxSourceDimension ||
          pixels > limits.maxSourcePixels
        )
          throw new VisionFailure('dimensions-exceeded');
        if (bitDepth > 16 || decodedMemoryForecast > limits.maxDecodedBytes)
          throw new VisionFailure('resource-limited');
        const output = await native(
          [
            ...resourceFlags(limits),
            `${imagePath}[0]`,
            '-auto-orient',
            '-strip',
            '-colorspace',
            'sRGB',
            '-filter',
            'Lanczos',
            '-resize',
            `${limits.maxDeliveredDimension}x${limits.maxDeliveredDimension}>`,
            '-define',
            'png:exclude-chunks=all',
            '-define',
            'png:color-type=6',
            '-depth',
            '8',
            'png:-',
          ],
          limits,
          signal,
          path,
          limits.maxDeliveredBytes
        );
        if (output.code !== 0 || output.stderr.length !== 0)
          throw new VisionFailure('invalid-image');
        const bytes = output.stdout;
        if (
          bytes.length < 33 ||
          !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
          bytes.readUInt32BE(8) !== 13 ||
          bytes.toString('ascii', 12, 16) !== 'IHDR' ||
          bytes[24] !== 8 ||
          bytes[25] !== 6
        )
          throw new VisionFailure('invalid-image');
        const deliveredWidth = bytes.readUInt32BE(16);
        const deliveredHeight = bytes.readUInt32BE(20);
        const deliveredPixels = deliveredWidth * deliveredHeight;
        if (
          !deliveredWidth ||
          !deliveredHeight ||
          deliveredWidth > limits.maxDeliveredDimension ||
          deliveredHeight > limits.maxDeliveredDimension ||
          deliveredPixels > limits.maxDeliveredPixels
        )
          throw new VisionFailure('resource-limited');
        const source = {
          sourceKey: original.sourceKey,
          revision: original.revision,
          originalDigest: original.originalDigest,
          byteLength: original.byteLength,
        };
        const processor: VisionView['processor'] = {
          id: 'imagemagick-vision-v1',
          resourceProfileDigest,
          executableVersion,
          configuration: {
            ...limits,
            headerGuard: HEADER_GUARD,
            decodedBytesPerPixel: DECODE_BYTES_PER_PIXEL,
            encoding: 'PNG-RGBA8',
            colorSpace: 'sRGB',
            metadata: 'strip',
            orientation: 'auto',
            filter: 'Lanczos',
            resize: 'fit-no-enlarge',
            threadCount: 1,
            addressSpaceScope: 'per-process',
            parserDescendants: 0,
          },
        };
        signal.throwIfAborted();
        return {
          status: 'available',
          view: {
            schema: 'vision-view-v1',
            source,
            processor,
            representationId: `vision-view-v1:${digest(JSON.stringify(processor))}`,
            representationDigest: digest(bytes),
            cacheKey: digest(JSON.stringify({ source, processor })),
            mediaType: 'image/png',
            bytes,
            sourceImage: { format, width, height, frames: 1, bitDepth, decodedMemoryForecast },
            deliveredImage: {
              width: deliveredWidth,
              height: deliveredHeight,
              frames: 1,
              bitDepth: 8,
              pixels: deliveredPixels,
              byteLength: bytes.length,
            },
            locator: {
              kind: 'image',
              frame: 1,
              coordinateSpace: 'source-pixels',
              crop: { x: 0, y: 0, width, height },
            },
            coverage: {
              kind: 'image-view',
              complete: false,
              provesCompleteBodyAbsence: false,
              omissions:
                pixels === deliveredPixels ? ['metadata'] : ['metadata', 'original-resolution'],
            },
          },
        };
      }
    );
  } catch (error) {
    return unavailable(
      signal.aborted
        ? input.signal?.aborted
          ? 'cancelled'
          : 'resource-limited'
        : error instanceof VisionFailure || error instanceof MediaProcessFailure
          ? error.reason
          : 'source-unavailable'
    );
  }
}

/** Bound metadata traversal independently of native header decoding, including hidden APNG frames. */
async function inspectContainer(
  path: string,
  length: number,
  limits: VisionViewLimits,
  signal: AbortSignal
): Promise<VisionView['sourceImage']['format']> {
  const file = await open(path, 'r');
  try {
    const prefix = await readExact(file, 0, Math.min(length, 16), signal);
    if (prefix.subarray(0, 8).equals(PNG_SIGNATURE)) {
      let offset = 8;
      let headers = 0;
      let metadata = 0;
      let sawData = false;
      while (offset < length) {
        if (++headers > limits.maxChunkHeaders) throw new VisionFailure('resource-limited');
        const chunk = await readExact(file, offset, 8, signal);
        const size = chunk.readUInt32BE(0);
        const kind = chunk.toString('ascii', 4, 8);
        if (size > length - offset - 12) throw new VisionFailure('invalid-image');
        if (headers === 1 && (kind !== 'IHDR' || size !== 13))
          throw new VisionFailure('invalid-image');
        if (['acTL', 'fcTL', 'fdAT'].includes(kind))
          throw new VisionFailure('unsupported-animation');
        if (kind === 'IDAT') sawData = true;
        else {
          metadata += size + 12;
          if (metadata > limits.maxHeaderBytes) throw new VisionFailure('resource-limited');
        }
        offset += size + 12;
        if (kind === 'IEND') {
          if (size !== 0 || offset !== length || !sawData) throw new VisionFailure('invalid-image');
          return 'PNG';
        }
      }
      throw new VisionFailure('invalid-image');
    }
    if (prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP') {
      if (prefix.readUInt32LE(4) !== length - 8) throw new VisionFailure('invalid-image');
      let offset = 12;
      let headers = 0;
      let metadata = 0;
      let sawData = false;
      while (offset < length) {
        if (++headers > limits.maxChunkHeaders) throw new VisionFailure('resource-limited');
        const chunk = await readExact(file, offset, 8, signal);
        const kind = chunk.toString('ascii', 0, 4);
        const size = chunk.readUInt32LE(4);
        if (size > length - offset - 8) throw new VisionFailure('invalid-image');
        if (kind === 'ANIM' || kind === 'ANMF') throw new VisionFailure('unsupported-animation');
        if (kind === 'VP8X') {
          if (size !== 10) throw new VisionFailure('invalid-image');
          const flags = await readExact(file, offset + 8, 1, signal);
          if ((flags[0]! & 2) !== 0) throw new VisionFailure('unsupported-animation');
        }
        if (kind === 'VP8 ' || kind === 'VP8L') sawData = true;
        else {
          metadata += size + 8;
          if (metadata > limits.maxHeaderBytes) throw new VisionFailure('resource-limited');
        }
        offset += 8 + size + (size % 2);
        if (offset > length) throw new VisionFailure('invalid-image');
      }
      if (offset !== length || !sawData) throw new VisionFailure('invalid-image');
      return 'WEBP';
    }
    if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return 'JPEG';
    if (['GIF87a', 'GIF89a'].includes(prefix.toString('ascii', 0, 6))) return 'GIF';
    throw new VisionFailure('unsupported-format');
  } finally {
    await file.close();
  }
}
/** Small exact reads cannot allocate a compressed source or follow a PDF/vector delegate. */
async function readExact(
  file: FileHandle,
  offset: number,
  length: number,
  signal: AbortSignal
): Promise<Buffer> {
  signal.throwIfAborted();
  const bytes = Buffer.alloc(length);
  const result = await file.read(bytes, 0, length, offset);
  if (result.bytesRead !== length) throw new VisionFailure('invalid-image');
  return bytes;
}
/** Maps ImageMagick's own cache/frame resources below the independent OS bounds. */
function resourceFlags(limits: VisionViewLimits): string[] {
  return [
    '-regard-warnings',
    '-limit',
    'thread',
    '1',
    '-limit',
    'memory',
    `${limits.maxDecodedBytes}`,
    '-limit',
    'map',
    '0',
    '-limit',
    'disk',
    '0',
    '-limit',
    'width',
    `${limits.maxSourceDimension}`,
    '-limit',
    'height',
    `${limits.maxSourceDimension}`,
    '-limit',
    'list-length',
    // ImageMagick uses an exclusive list ceiling; one extra header must be observable.
    '3',
  ];
}
/** The only native image executable is fixed by this release-authored producer. */
function native(
  args: string[],
  limits: VisionViewLimits,
  signal: AbortSignal,
  path: string | undefined,
  maxOutput: number
) {
  return runMediaProcess('/usr/bin/magick', args, limits, signal, path, maxOutput, IMAGE_ENV);
}
function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function validLimits(limits: VisionViewLimits): boolean {
  return (
    Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0) &&
    limits.maxInputBytes <= 67_108_864 &&
    limits.maxSourceDimension <= 32768 &&
    limits.maxSourcePixels <= 67_108_864 &&
    limits.maxFrames === 1 &&
    limits.maxDecodedBytes <= 1_073_741_824 &&
    limits.maxDeliveredDimension <= 2048 &&
    limits.maxDeliveredPixels <= 4_194_304 &&
    limits.maxDeliveredBytes <= 4_194_304 &&
    limits.maxHeaderBytes <= 262144 &&
    limits.maxChunkHeaders <= 4096 &&
    limits.addressSpaceBytes <= 1_073_741_824 &&
    limits.cpuSeconds <= 60 &&
    limits.wallTimeMs <= 60_000
  );
}
