import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type MediaByteSource,
  MediaProcessFailure,
  type MediaStageReservation,
  validMediaSource,
  withStagedMediaSource,
} from './media-process.js';
import { VISION_PDF_OPTIONS } from './vision-view-child.js';

/** Integer coordinates in original image pixels or the selected page's rotated 72-dpi raster. */
export interface VisionCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Independent source, raster, delivery and execution ceilings; callers may only lower these. */
export interface VisionViewLimits {
  maxInputBytes: number;
  maxDimension: number;
  maxPixels: number;
  /** Bounds one decoded RGBA raster and the combined canvases created by this processor, not RSS. */
  maxDecodedBytes: number;
  maxOutputDimension: number;
  maxOutputBytes: number;
  /** V8 old-generation heap in the child; native decoder allocations are separate. */
  heapBytes: number;
  wallTimeMs: number;
}

/** Release defaults, independent of upload acceptance and model media-token admission. */
export const VISION_VIEW_LIMITS: Readonly<VisionViewLimits> = Object.freeze({
  maxInputBytes: 67_108_864,
  maxDimension: 16_384,
  maxPixels: 16_777_216,
  maxDecodedBytes: 67_108_864,
  maxOutputDimension: 1_536,
  maxOutputBytes: 262_144,
  heapBytes: 536_870_912,
  wallTimeMs: 20_000,
});

/** Closed, value-free failures; no subprocess text, source identity or working path is returned. */
export type VisionViewFailure = {
  status: 'unavailable';
  reason:
    | 'unsupported'
    | 'invalid_request'
    | 'invalid_image'
    | 'resource_limited'
    | 'cancelled'
    | 'unavailable'
    | 'cleanup_unavailable';
};

/** One bounded JPEG and explicit original, page, crop, processor and delivered-byte identities. */
export type VisionViewResult =
  | VisionViewFailure
  | {
      status: 'available';
      source: Omit<MediaByteSource, 'open'>;
      originalDimensions: { width: number; height: number; frames: 1 };
      page: number | null;
      crop: VisionCrop;
      coordinateSpace: 'image-pixels' | 'pdf-page-raster-72dpi';
      processor: {
        id: 'node-canvas-vision-v1';
        nodeVersion: string;
        canvasVersion: string;
        pdfjsVersion: string;
        resourceProfileDigest: string;
        configuration: VisionViewLimits & {
          quality: 80;
          background: 'white';
          upscale: false;
          heapScope: 'v8-old-generation';
          pdfOptions: typeof VISION_PDF_OPTIONS;
        };
      };
      delivered: {
        digest: string;
        byteLength: number;
        mediaType: 'image/jpeg';
        width: number;
        height: number;
      };
      bytes: Buffer;
    };

/** Private per-operation inputs; source adapters own fresh authorization and shared disk admission. */
export interface ProcessVisionViewInput {
  source: MediaByteSource;
  mediaType: string;
  page?: number | undefined;
  crop?: VisionCrop | undefined;
  temporaryRoot: string;
  reserveTemporaryBytes(bytes: number): MediaStageReservation;
  limits?: Partial<VisionViewLimits> | undefined;
  signal?: AbortSignal | undefined;
}

const ChildResultSchema = z.object({
  originalDimensions: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frames: z.literal(1),
  }),
  crop: z.object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data: z.string(),
});

/** Stages and hashes only retained selected bytes, then runs the decoder outside the Core parent. */
export async function processVisionView(input: ProcessVisionViewInput): Promise<VisionViewResult> {
  const limits = { ...VISION_VIEW_LIMITS, ...input.limits };
  const fail = (reason: VisionViewFailure['reason']): VisionViewFailure => ({
    status: 'unavailable',
    reason,
  });
  if (!validMediaSource(input.source)) return fail('unavailable');
  if (!['image/png', 'image/jpeg', 'application/pdf'].includes(input.mediaType))
    return fail('unsupported');
  if (
    !Object.entries(VISION_VIEW_LIMITS).every(([key, ceiling]) => {
      const value = limits[key as keyof VisionViewLimits];
      return (
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= ceiling &&
        (key !== 'heapBytes' || value >= 1_048_576)
      );
    })
  )
    return fail('invalid_request');
  if (input.source.byteLength > limits.maxInputBytes) return fail('resource_limited');
  if (
    (input.mediaType === 'application/pdf'
      ? !Number.isSafeInteger(input.page) || input.page! < 1
      : input.page !== undefined) ||
    (input.crop && !validCrop(input.crop))
  )
    return fail('invalid_request');
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(limits.wallTimeMs),
  ]);
  try {
    signal.throwIfAborted();
    const require = createRequire(import.meta.url);
    const canvasVersion: unknown = require('@napi-rs/canvas/package.json').version;
    const pdfjsVersion: unknown = require('pdfjs-dist/package.json').version;
    if (typeof canvasVersion !== 'string' || typeof pdfjsVersion !== 'string')
      return fail('unavailable');
    const view = await withStagedMediaSource(
      input.source,
      input.temporaryRoot,
      input.reserveTemporaryBytes,
      signal,
      'vision-view-',
      async (sourcePath): Promise<Extract<VisionViewResult, { status: 'available' }>> => {
        const configuration = {
          ...limits,
          quality: 80 as const,
          background: 'white' as const,
          upscale: false as const,
          heapScope: 'v8-old-generation' as const,
          pdfOptions: VISION_PDF_OPTIONS,
        };
        const processor = {
          id: 'node-canvas-vision-v1' as const,
          nodeVersion: process.versions.node,
          canvasVersion,
          pdfjsVersion,
          configuration,
          resourceProfileDigest: hash(
            JSON.stringify({
              canvasVersion,
              pdfjsVersion,
              nodeVersion: process.versions.node,
              configuration,
              invocation: childInvocation('/private-source', input, limits),
            })
          ),
        };
        const result = await runChild(sourcePath, input, limits, signal);
        signal.throwIfAborted();
        const bytes = Buffer.from(result.data, 'base64');
        if (
          !bytes.length ||
          bytes.length > limits.maxOutputBytes ||
          result.data !== bytes.toString('base64') ||
          bytes[0] !== 0xff ||
          bytes[1] !== 0xd8 ||
          Math.max(result.width, result.height) > limits.maxOutputDimension ||
          Math.max(result.originalDimensions.width, result.originalDimensions.height) >
            limits.maxDimension ||
          result.originalDimensions.width * result.originalDimensions.height > limits.maxPixels ||
          result.originalDimensions.width * result.originalDimensions.height * 4 >
            limits.maxDecodedBytes ||
          result.crop.left + result.crop.width > result.originalDimensions.width ||
          result.crop.top + result.crop.height > result.originalDimensions.height
        )
          throw new Error('Invalid child result.');
        const { sourceKey, revision, originalDigest, byteLength } = input.source;
        return {
          status: 'available',
          source: { sourceKey, revision, originalDigest, byteLength },
          originalDimensions: result.originalDimensions,
          crop: result.crop,
          page: input.page ?? null,
          coordinateSpace:
            input.mediaType === 'application/pdf' ? 'pdf-page-raster-72dpi' : 'image-pixels',
          processor,
          delivered: {
            digest: hash(bytes),
            byteLength: bytes.length,
            mediaType: 'image/jpeg',
            width: result.width,
            height: result.height,
          },
          bytes,
        };
      }
    );
    signal.throwIfAborted();
    return view;
  } catch (error) {
    if (signal.aborted) return fail(input.signal?.aborted ? 'cancelled' : 'resource_limited');
    if (error instanceof MediaProcessFailure)
      return fail(
        error.reason === 'cleanup-unavailable'
          ? 'cleanup_unavailable'
          : error.reason === 'resource-limited'
            ? 'resource_limited'
            : 'unavailable'
      );
    return fail(error instanceof ChildFailure ? error.reason : 'unavailable');
  }
}

/** Rejects ambiguous coordinates before private staging. */
function validCrop(crop: VisionCrop): boolean {
  return (
    Object.values(crop).every(Number.isSafeInteger) &&
    crop.left >= 0 &&
    crop.top >= 0 &&
    crop.width > 0 &&
    crop.height > 0
  );
}
/** Fixed direct invocation with no inherited secrets, shell, source-selected switches or host settings. */
function childInvocation(path: string, input: ProcessVisionViewInput, limits: VisionViewLimits) {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return [
    `--max-old-space-size=${Math.floor(limits.heapBytes / 1_048_576)}`,
    '--disallow-code-generation-from-strings',
    fileURLToPath(new URL(`./vision-view-child.${extension}`, import.meta.url)),
    path,
    JSON.stringify({ mediaType: input.mediaType, page: input.page, crop: input.crop, limits }),
  ];
}
/** Local child status; error text never crosses the boundary. */
class ChildFailure extends Error {
  constructor(readonly reason: VisionViewFailure['reason']) {
    super(reason);
  }
}
/** Caps both pipes and waits for close after cancellation before staging cleanup can release capacity. */
function runChild(
  path: string,
  input: ProcessVisionViewInput,
  limits: VisionViewLimits,
  signal: AbortSignal
) {
  return new Promise<z.infer<typeof ChildResultSchema>>((resolve, reject) => {
    if (signal.aborted) return reject(new ChildFailure('cancelled'));
    const child = spawn(process.execPath, childInvocation(path, input, limits), {
      cwd: '/',
      env: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let failure: ChildFailure | undefined;
    let count = 0;
    let errors = 0;
    const chunks: Buffer[] = [];
    const stop = () => {
      failure ??= new ChildFailure('resource_limited');
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      count += chunk.length;
      if (count > Math.ceil(limits.maxOutputBytes / 3) * 4 + 4096) stop();
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.length;
      if (errors > 16_384) stop();
    });
    child.on('error', () => {
      failure ??= new ChildFailure('unavailable');
    });
    child.on('close', (code, terminationSignal) => {
      signal.removeEventListener('abort', stop);
      if (failure) return reject(failure);
      if (terminationSignal || code === 4) return reject(new ChildFailure('resource_limited'));
      if (code !== 0)
        return reject(
          new ChildFailure(
            code === 2 ? 'invalid_image' : code === 3 ? 'invalid_request' : 'unavailable'
          )
        );
      try {
        resolve(
          ChildResultSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
          )
        );
      } catch {
        reject(new ChildFailure('invalid_image'));
      }
    });
    if (signal.aborted) stop();
  });
}
/** Identifies the exact original-independent processor configuration or delivered JPEG bytes. */
function hash(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
