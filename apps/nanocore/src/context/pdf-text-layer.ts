import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type MediaByteSource,
  MediaProcessFailure,
  type MediaResourceProfile,
  type MediaStageReservation,
  validMediaSource as validSource,
  withStagedMediaSource,
} from './media-process.js';
import { PDF_TEXT_LAYER_OPTIONS } from './pdf-text-layer-child.js';

/** An authorized immutable source. Emit at most 64KiB per chunk, honor cancellation and recheck access. */
export type PdfTextLayerSource = MediaByteSource;

/** Hard processor ceilings, independent of upload admission and model token admission. */
export interface PdfTextLayerLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxPages: number;
  /** V8 old-generation heap ceiling in the short-lived Node child, not total process memory. */
  heapBytes: number;
  wallTimeMs: number;
}

/** Named defaults for the same packaged Node/PDF.js path on the host and in a container. */
export const PDF_TEXT_LAYER_LIMITS: Readonly<PdfTextLayerLimits> = Object.freeze({
  maxInputBytes: 67_108_864,
  maxOutputBytes: 2_097_152,
  maxPages: 64,
  heapBytes: 536_870_912,
  wallTimeMs: 20_000,
});

/** Output identity includes every setting that can change the representation or its coverage. */
export interface PdfTextLayerProcessor extends MediaResourceProfile {
  id: 'pdfjs-pdf-text-layer-v1';
  pdfjsVersion: string;
  nodeVersion: string;
  configuration: PdfTextLayerLimits & {
    encoding: 'UTF-8';
    textLayout: 'pdfjs-items-v1';
    options: typeof PDF_TEXT_LAYER_OPTIONS;
    eol: 'unix';
    heapScope: 'v8-old-generation';
  };
}

/** Offsets address UTF-8 representation bytes, never offsets in the original PDF. */
export interface PdfPageLocator {
  page: number;
  coordinateSpace: 'representation-utf8';
  startByte: number;
  endByte: number;
  hasText: boolean;
}

/** Complete means all declared text-layer pages were extracted, not that images were understood. */
export interface PdfTextLayerDerivative {
  schema: 'pdf-text-layer-v1';
  source: Omit<PdfTextLayerSource, 'open'>;
  processor: PdfTextLayerProcessor;
  cacheKey: string;
  representationId: string;
  representationDigest: string;
  text: string;
  pages: PdfPageLocator[];
  coverage: {
    kind: 'pdf-text-layer';
    complete: boolean;
    /** Always false: text extraction cannot prove absence of text in embedded images. */
    provesCompleteBodyAbsence: false;
    totalPages: number;
    processedPages: number;
    pagesWithoutText: number[];
    reason: 'all-text-layer-pages' | 'pages-without-text' | 'page-limit';
  };
}

/** Retained processor, page locators and text-layer coverage within the existing package projection. */
export const PdfTextLayerEvidenceSchema = z.object({
  processor: z.object({
    id: z.literal('pdfjs-pdf-text-layer-v1'),
    resourceProfileDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    pdfjsVersion: z.string().min(1).max(128),
    nodeVersion: z.string().min(1).max(128),
    configuration: z.object({
      maxInputBytes: z.number().int().positive().max(PDF_TEXT_LAYER_LIMITS.maxInputBytes),
      maxOutputBytes: z.number().int().positive().max(PDF_TEXT_LAYER_LIMITS.maxOutputBytes),
      maxPages: z.number().int().positive().max(PDF_TEXT_LAYER_LIMITS.maxPages),
      heapBytes: z.number().int().min(1_048_576).max(PDF_TEXT_LAYER_LIMITS.heapBytes),
      wallTimeMs: z.number().int().positive().max(PDF_TEXT_LAYER_LIMITS.wallTimeMs),
      encoding: z.literal('UTF-8'),
      textLayout: z.literal('pdfjs-items-v1'),
      options: z.object({
        isEvalSupported: z.literal(false),
        disableFontFace: z.literal(true),
        useSystemFonts: z.literal(false),
        useWorkerFetch: z.literal(false),
        useWasm: z.literal(false),
        enableXfa: z.literal(false),
        stopAtErrors: z.literal(true),
      }),
      eol: z.literal('unix'),
      heapScope: z.literal('v8-old-generation'),
    }),
  }),
  pages: z
    .array(
      z.object({
        page: z.number().int().positive(),
        coordinateSpace: z.literal('representation-utf8'),
        startByte: z.number().int().nonnegative(),
        endByte: z.number().int().nonnegative(),
        hasText: z.boolean(),
      })
    )
    .max(PDF_TEXT_LAYER_LIMITS.maxPages),
  coverage: z.object({
    kind: z.literal('pdf-text-layer'),
    complete: z.boolean(),
    provesCompleteBodyAbsence: z.literal(false),
    totalPages: z.number().int().positive(),
    processedPages: z.number().int().positive().max(PDF_TEXT_LAYER_LIMITS.maxPages),
    pagesWithoutText: z.array(z.number().int().positive()).max(PDF_TEXT_LAYER_LIMITS.maxPages),
    reason: z.enum(['all-text-layer-pages', 'pages-without-text', 'page-limit']),
  }),
});

/** Failures contain no host path, subprocess text, source body or fabricated representation. */
export type PdfTextLayerResult =
  | { status: 'available' | 'incomplete'; derivative: PdfTextLayerDerivative }
  | {
      status: 'unavailable';
      reason:
        | 'invalid-source'
        | 'invalid-limits'
        | 'dependency-unavailable'
        | 'source-unavailable'
        | 'source-changed'
        | 'encrypted'
        | 'invalid-pdf'
        | 'resource-limited'
        | 'cancelled'
        | 'cleanup-unavailable';
      complete: false;
      provesCompleteBodyAbsence: false;
    };

type FailureReason = Extract<PdfTextLayerResult, { status: 'unavailable' }>['reason'];
class ProcessorFailure extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

/** Source adapters own cache publication and current-audience validation, not this processor. */
export interface ProcessPdfTextLayerInput {
  source: PdfTextLayerSource;
  /** Private source-owned staging parent. It must not be a caller-selected public path. */
  temporaryRoot: string;
  signal?: AbortSignal;
  limits?: Partial<PdfTextLayerLimits>;
  /** Reserve this exact staging forecast through the existing shared disk-admission owner. */
  reserveTemporaryBytes(bytes: number): MediaStageReservation;
}

const INFO_BYTES = 16_384;

/** Processes only verified private bytes; no PDF parser runs in NanoCore or the Retrieval Kernel. */
export async function processPdfTextLayer(
  input: ProcessPdfTextLayerInput
): Promise<PdfTextLayerResult> {
  const limits = { ...PDF_TEXT_LAYER_LIMITS, ...input.limits };
  const unavailable = (reason: FailureReason): PdfTextLayerResult => ({
    status: 'unavailable',
    reason,
    complete: false,
    provesCompleteBodyAbsence: false,
  });
  if (!validSource(input.source)) return unavailable('invalid-source');
  if (!validLimits(limits)) return unavailable('invalid-limits');
  if (input.source.byteLength > limits.maxInputBytes) return unavailable('resource-limited');
  const original = { ...input.source, open: input.source.open.bind(input.source) };
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(limits.wallTimeMs),
  ]);
  try {
    checkSignal(signal, input.signal);
    let pdfjsVersion: string;
    try {
      pdfjsVersion = createRequire(import.meta.url)('pdfjs-dist/package.json').version;
      if (typeof pdfjsVersion !== 'string' || pdfjsVersion.length > 128)
        throw new Error('Invalid processor version.');
    } catch {
      throw new ProcessorFailure('dependency-unavailable');
    }
    return await withStagedMediaSource(
      original,
      input.temporaryRoot,
      input.reserveTemporaryBytes,
      signal,
      'pdf-text-layer-',
      async (sourcePath) => {
        const configuration: PdfTextLayerProcessor['configuration'] = {
          ...limits,
          encoding: 'UTF-8',
          textLayout: 'pdfjs-items-v1',
          options: PDF_TEXT_LAYER_OPTIONS,
          eol: 'unix',
          heapScope: 'v8-old-generation',
        };
        const nodeVersion = process.versions.node;
        const processor: PdfTextLayerProcessor = {
          id: 'pdfjs-pdf-text-layer-v1',
          resourceProfileDigest: digest(
            JSON.stringify({
              pdfjsVersion,
              nodeVersion,
              configuration,
              invocation: childInvocation(limits, '/private-source'),
            })
          ),
          pdfjsVersion,
          nodeVersion,
          configuration,
        };
        const { text, pages, totalPages } = await runChild(sourcePath, limits, signal);
        const pagesWithoutText = pages.filter((page) => !page.hasText).map((page) => page.page);
        const complete = pages.length === totalPages && pagesWithoutText.length === 0;
        const source = {
          sourceKey: original.sourceKey,
          revision: original.revision,
          originalDigest: original.originalDigest,
          byteLength: original.byteLength,
        };
        const representationId = `pdf-text-layer-v1:${digest(JSON.stringify(processor))}`;
        const result: PdfTextLayerResult = {
          status: complete ? 'available' : 'incomplete',
          derivative: {
            schema: 'pdf-text-layer-v1',
            source,
            processor,
            representationId,
            cacheKey: digest(JSON.stringify({ source, processor })),
            representationDigest: digest(text),
            text,
            pages,
            coverage: {
              kind: 'pdf-text-layer',
              complete,
              provesCompleteBodyAbsence: false,
              totalPages,
              processedPages: pages.length,
              pagesWithoutText,
              reason:
                pages.length < totalPages
                  ? 'page-limit'
                  : pagesWithoutText.length
                    ? 'pages-without-text'
                    : 'all-text-layer-pages',
            },
          },
        };
        checkSignal(signal, input.signal);
        return result;
      }
    );
  } catch (error) {
    return unavailable(
      signal.aborted
        ? input.signal?.aborted
          ? 'cancelled'
          : 'resource-limited'
        : error instanceof ProcessorFailure || error instanceof MediaProcessFailure
          ? error.reason
          : 'source-unavailable'
    );
  }
}

/** Uses the same fixed child launch for execution and measured resource-profile identity. */
function childInvocation(limits: PdfTextLayerLimits, sourcePath: string) {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return {
    command: process.execPath,
    arguments: [
      `--max-old-space-size=${Math.floor(limits.heapBytes / 1_048_576)}`,
      '--disallow-code-generation-from-strings',
      fileURLToPath(new URL(`./pdf-text-layer-child.${extension}`, import.meta.url)),
      sourcePath,
      JSON.stringify(limits),
    ],
    environment: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
  };
}

/** Bounds the private result envelope, kills on cancellation, and waits for the parser to exit before cleanup. */
function runChild(sourcePath: string, limits: PdfTextLayerLimits, signal: AbortSignal) {
  return new Promise<{ text: string; pages: PdfPageLocator[]; totalPages: number }>(
    (resolve, reject) => {
      if (signal.aborted) {
        reject(new ProcessorFailure('resource-limited'));
        return;
      }
      const invocation = childInvocation(limits, sourcePath);
      const child = spawn(invocation.command, invocation.arguments, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: invocation.environment,
        cwd: '/',
      });
      const output: Buffer[] = [];
      let outputBytes = 0;
      let errorBytes = 0;
      let failure: ProcessorFailure | undefined;
      const stop = () => {
        failure ??= new ProcessorFailure('resource-limited');
        child.kill('SIGKILL');
      };
      signal.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        // JSON can expand each text byte to six bytes. Page metadata has a separate fixed allowance.
        if (outputBytes > limits.maxOutputBytes * 6 + 32_768) stop();
        else output.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errorBytes += chunk.byteLength;
        if (errorBytes > INFO_BYTES) stop();
      });
      child.on('error', () => {
        failure ??= new ProcessorFailure('dependency-unavailable');
      });
      child.on('close', (code, terminationSignal) => {
        signal.removeEventListener('abort', stop);
        if (failure) return reject(failure);
        if (terminationSignal || code === 4)
          return reject(new ProcessorFailure('resource-limited'));
        if (code !== 0)
          return reject(
            new ProcessorFailure(
              code === 3 ? 'encrypted' : code === 2 ? 'invalid-pdf' : 'dependency-unavailable'
            )
          );
        try {
          const result = z.object({
            text: z.string(),
            pages: PdfTextLayerEvidenceSchema.shape.pages,
            totalPages: z.number().int().positive(),
          }).parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output))));
          if (
            Buffer.byteLength(result.text) > limits.maxOutputBytes ||
            result.pages.length !== Math.min(result.totalPages, limits.maxPages)
          ) throw new ProcessorFailure('resource-limited');
          resolve(result);
        } catch (error) {
          reject(error instanceof ProcessorFailure ? error : new ProcessorFailure('invalid-pdf'));
        }
      });
      if (signal.aborted) stop();
    }
  );
}

/** Preserves cancellation separately from the total processing deadline. */
function checkSignal(signal: AbortSignal, caller?: AbortSignal): void {
  if (signal.aborted)
    throw new ProcessorFailure(caller?.aborted ? 'cancelled' : 'resource-limited');
}
/** Identifies exact processor facts or complete extracted UTF-8 bytes. */
function digest(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/** Allows stricter invocation budgets without widening the release processor ceilings. */
function validLimits(limits: PdfTextLayerLimits): boolean {
  return Object.entries(PDF_TEXT_LAYER_LIMITS).every(([key, ceiling]) => {
    const value = limits[key as keyof PdfTextLayerLimits];
    return Number.isSafeInteger(value) && value > 0 && value <= ceiling &&
      (key !== 'heapBytes' || value >= 1_048_576);
  });
}
