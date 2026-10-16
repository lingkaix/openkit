import { createHash } from 'node:crypto';
import {
  assertMediaIsolation, type MediaByteSource, MediaProcessFailure,
  type MediaProcessLimits, type MediaStageReservation, mediaProcessInvocation,
  runMediaProcess, validMediaSource, withStagedMediaSource,
} from './media-process.js';

/** Fixed image bounds apply before decoding; the encoded result has its own independent cap. */
export interface VisionViewLimits extends MediaProcessLimits {
  maxInputBytes: number;
  maxPixels: number;
  maxDimension: number;
  maxOutputBytes: number;
  maxOutputDimension: number;
}
/** Release-authored defaults; callers may only lower limits. Frames are fixed at one. */
export const VISION_VIEW_LIMITS: Readonly<VisionViewLimits> = Object.freeze({
  maxInputBytes: 67_108_864, maxPixels: 33_554_432, maxDimension: 16_384,
  maxOutputBytes: 2_097_152, maxOutputDimension: 1536,
  addressSpaceBytes: 536_870_912, cpuSeconds: 5, wallTimeMs: 20_000,
});
/** Original-image pixel coordinates; crop never describes coordinates in resized output. */
export interface VisionCrop { left: number; top: number; width: number; height: number; }
/** Explicit source-owned request. The caller checks current access before processing and disclosure. */
export interface ProcessVisionViewInput {
  source: MediaByteSource;
  mediaType: string;
  crop?: VisionCrop;
  temporaryRoot: string;
  reserveTemporaryBytes(bytes: number): MediaStageReservation;
  limits?: Partial<VisionViewLimits>;
  signal?: AbortSignal;
}
/** Successful output is a separate bounded representation; failures provide no bytes or handle. */
export type VisionViewResult = {
  status: 'available';
  source: Omit<MediaByteSource, 'open'>;
  originalDimensions: { width: number; height: number; frames: 1 };
  crop: VisionCrop;
  processor: {
    id: 'imagemagick-vision-v1'; identifyVersion: string; convertVersion: string;
    resourceProfileDigest: string;
    configuration: VisionViewLimits & { frames: 1; quality: 80; format: 'jpeg'; crop: VisionCrop };
  };
  delivered: { digest: string; byteLength: number; mediaType: 'image/jpeg'; width: number; height: number };
  bytes: Buffer;
} | { status: 'unavailable'; reason: 'unsupported' | 'invalid_request' | 'invalid_image' | 'resource_limited' | 'cancelled' | 'unavailable' };

const environment = { OMP_NUM_THREADS: '1', MAGICK_THREAD_LIMIT: '1' };
const resourceArgs = ['-limit', 'memory', '128MiB', '-limit', 'map', '0', '-limit', 'disk', '0', '-limit', 'thread', '1'];

/** Creates an explicit bounded PNG/JPEG vision view in the existing native media boundary, without a model call, OCR, durable cache or original mutation. */
export async function processVisionView(input: ProcessVisionViewInput): Promise<VisionViewResult> {
  const unavailable = (reason: Extract<VisionViewResult, { status: 'unavailable' }>['reason']): VisionViewResult => ({ status: 'unavailable', reason });
  const limits = { ...VISION_VIEW_LIMITS, ...input.limits };
  if (!validMediaSource(input.source) || !Object.entries(limits).every(([key, value]) => Number.isSafeInteger(value) && value > 0 && value <= VISION_VIEW_LIMITS[key as keyof VisionViewLimits]))
    return unavailable('invalid_request');
  const coder = input.mediaType === 'image/png' ? 'png' : input.mediaType === 'image/jpeg' ? 'jpeg' : null;
  if (!coder) return unavailable('unsupported');
  if (input.source.byteLength > limits.maxInputBytes) return unavailable('resource_limited');
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(limits.wallTimeMs)]);
  const source = { ...input.source, open: input.source.open.bind(input.source) };
  try {
    signal.throwIfAborted();
    await assertMediaIsolation(limits, signal, environment);
    const versions: string[] = [];
    for (const executable of ['/usr/bin/identify', '/usr/bin/convert'] as const) {
      const version = await runMediaProcess(executable, ['-version'], limits, signal, undefined, 4096, environment);
      const match = /^Version: ImageMagick ([^\r\n]{1,256})\r?\n/.exec(version.stdout.toString('utf8'));
      if (version.code !== 0 || version.stderr.length || !match) return unavailable('unavailable');
      versions.push(match[1]!);
    }
    return await withStagedMediaSource(source, input.temporaryRoot, input.reserveTemporaryBytes, signal, 'vision-view-', async (sourcePath) => {
      const inputName = `${coder}:/input.pdf`;
      const probeArgs = [...resourceArgs, '-ping', '-format', '%m %w %h %n\n', inputName];
      const probe = await runMediaProcess('/usr/bin/identify', probeArgs, limits, signal, sourcePath, 4096, environment);
      const dimensions = /^(PNG|JPEG) ([1-9][0-9]{0,8}) ([1-9][0-9]{0,8}) ([1-9][0-9]{0,4})\r?\n$/.exec(probe.stdout.toString('utf8'));
      if (probe.code !== 0 || probe.stderr.length || !dimensions) return unavailable('invalid_image');
      const width = Number(dimensions[2]), height = Number(dimensions[3]), frames = Number(dimensions[4]);
      if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels || frames !== 1)
        return unavailable('resource_limited');
      const crop = input.crop ? { ...input.crop } : { left: 0, top: 0, width, height };
      if (![crop.left, crop.top, crop.width, crop.height].every(Number.isSafeInteger) || crop.left < 0 || crop.top < 0 || crop.width < 1 || crop.height < 1 || crop.left + crop.width > width || crop.top + crop.height > height)
        return unavailable('invalid_request');
      const decodeArgs = [
        ...resourceArgs, inputName,
        '-crop', `${crop.width}x${crop.height}+${crop.left}+${crop.top}`, '+repage',
        '-thumbnail', `${limits.maxOutputDimension}x${limits.maxOutputDimension}>`,
        '-background', 'white', '-alpha', 'remove', '-strip', '-quality', '80', 'jpeg:-',
      ];
      const output = await runMediaProcess('/usr/bin/convert', decodeArgs, limits, signal, sourcePath, limits.maxOutputBytes, environment);
      if (output.code !== 0 || output.stderr.length) return unavailable('invalid_image');
      const deliveredDimensions = jpegDimensions(output.stdout);
      if (!deliveredDimensions || deliveredDimensions.width > limits.maxOutputDimension || deliveredDimensions.height > limits.maxOutputDimension)
        return unavailable('invalid_image');
      signal.throwIfAborted();
      const configuration = { ...limits, frames: 1 as const, quality: 80 as const, format: 'jpeg' as const, crop };
      const resourceProfileDigest = sha(JSON.stringify({
        versions, configuration,
        probe: mediaProcessInvocation('/usr/bin/identify', probeArgs, limits, '<source>', environment),
        decode: mediaProcessInvocation('/usr/bin/convert', decodeArgs, limits, '<source>', environment),
      }));
      return {
        status: 'available',
        source: { sourceKey: source.sourceKey, revision: source.revision, originalDigest: source.originalDigest, byteLength: source.byteLength },
        originalDimensions: { width, height, frames: 1 }, crop,
        processor: { id: 'imagemagick-vision-v1', identifyVersion: versions[0]!, convertVersion: versions[1]!, resourceProfileDigest, configuration },
        delivered: { digest: sha(output.stdout), byteLength: output.stdout.length, mediaType: 'image/jpeg', ...deliveredDimensions },
        bytes: output.stdout,
      };
    });
  } catch (error) {
    if (input.signal?.aborted) return unavailable('cancelled');
    if (signal.aborted || (error instanceof MediaProcessFailure && error.reason === 'resource-limited')) return unavailable('resource_limited');
    return unavailable('unavailable');
  }
}

/** Hashes delivered bytes and actual processor configuration without introducing another identity owner. */
function sha(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Reads only bounded JPEG marker metadata produced by the trusted encoder; no decoder runs in Core. */
function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xda || marker === 0xd9) return null;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return null;
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}
