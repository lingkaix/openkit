import { createHash } from 'node:crypto';
import {
  assertMediaIsolation,
  type MediaByteSource,
  MediaProcessFailure,
  type MediaResourceProfile,
  type MediaStageReservation,
  runMediaProcess,
  validMediaResourceProfile,
  validMediaSource as validSource,
  withStagedMediaSource,
} from './media-process.js';

/** An authorized immutable source. Emit at most 64KiB per chunk, honor cancellation and recheck access. */
export type PdfTextLayerSource = MediaByteSource;

/** Hard processor ceilings, independent of upload admission and model token admission. */
export interface PdfTextLayerLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxPages: number;
  /** Per-process address space. Bubblewrap adds fixed supervisor overhead, not an aggregate memory quota. */
  addressSpaceBytes: number;
  cpuSeconds: number;
  wallTimeMs: number;
}

/** Named, conservative defaults; runtime packaging must supply Poppler, Bubblewrap and prlimit. */
export const PDF_TEXT_LAYER_LIMITS: Readonly<PdfTextLayerLimits> = Object.freeze({
  maxInputBytes: 67_108_864,
  maxOutputBytes: 2_097_152,
  maxPages: 64,
  addressSpaceBytes: 536_870_912,
  cpuSeconds: 5,
  wallTimeMs: 20_000,
});

/** Output identity includes every setting that can change the representation or its coverage. */
export interface PdfTextLayerProcessor extends MediaResourceProfile {
  id: 'poppler-pdf-text-layer-v1';
  pdfinfoVersion: string;
  pdftotextVersion: string;
  configuration: PdfTextLayerLimits & {
    encoding: 'UTF-8';
    layout: true;
    eol: 'unix';
    addressSpaceScope: 'per-process';
    parserDescendants: 0;
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

/** Failures contain no host path, subprocess text, source body or fabricated representation. */
export type PdfTextLayerResult =
  | { status: 'available' | 'incomplete'; derivative: PdfTextLayerDerivative }
  | {
      status: 'unavailable';
      reason:
        | 'invalid-source'
        | 'invalid-resource-profile'
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
export interface ProcessPdfTextLayerInput extends MediaResourceProfile {
  source: PdfTextLayerSource;
  /** Private source-owned staging parent. It must not be a caller-selected public path. */
  temporaryRoot: string;
  signal?: AbortSignal;
  limits?: Partial<PdfTextLayerLimits>;
  /** Reserve this exact staging forecast through the existing shared disk-admission owner. */
  reserveTemporaryBytes(bytes: number): MediaStageReservation;
}

const INFO_BYTES = 16_384;
const EXECUTABLES = {
  pdfinfo: '/usr/bin/pdfinfo',
  pdftotext: '/usr/bin/pdftotext',
} as const;

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
  if (!validMediaResourceProfile(input)) return unavailable('invalid-resource-profile');
  const resourceProfileDigest = input.resourceProfileDigest;
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
    await assertMediaIsolation(limits, signal);
    // Even version discovery uses the real isolation boundary, before opening source bytes.
    const versions: string[] = [];
    for (const kind of ['pdfinfo', 'pdftotext'] as const) {
      const version = await runContained(kind, ['-v'], limits, signal, undefined, 4096);
      const match = new RegExp(`^${kind} version ([0-9]+(?:\\.[0-9]+){1,3})\\r?\\n`).exec(
        version.stderr
      );
      if (version.code !== 0 || !match || version.stdout.length !== 0)
        throw new ProcessorFailure('dependency-unavailable');
      versions.push(match[1] as string);
    }
    return await withStagedMediaSource(
      original,
      input.temporaryRoot,
      input.reserveTemporaryBytes,
      signal,
      'pdf-text-layer-',
      async (sourcePath) => {
        const info = await runContained(
          'pdfinfo',
          ['/input.pdf'],
          limits,
          signal,
          sourcePath,
          INFO_BYTES
        );
        if (info.code !== 0 || info.stderr.length !== 0) throw new ProcessorFailure('invalid-pdf');
        // Poppler prints free-form metadata first. Use the final generated fields, not forged metadata lines.
        const totalPagesText = [...info.stdout.matchAll(/^Pages:[ \t]+(\d+)[ \t]*$/gm)].at(-1)?.[1];
        const totalPages = Number(totalPagesText);
        const encrypted = [...info.stdout.matchAll(/^Encrypted:[ \t]+(yes|no)(?:[ \t]|$)/gm)].at(
          -1
        )?.[1];
        if (encrypted === 'yes') throw new ProcessorFailure('encrypted');
        if (encrypted !== 'no' || !Number.isSafeInteger(totalPages) || totalPages < 1)
          throw new ProcessorFailure('invalid-pdf');
        const processor: PdfTextLayerProcessor = {
          id: 'poppler-pdf-text-layer-v1',
          resourceProfileDigest,
          pdfinfoVersion: versions[0] as string,
          pdftotextVersion: versions[1] as string,
          configuration: {
            ...limits,
            encoding: 'UTF-8',
            layout: true,
            eol: 'unix',
            addressSpaceScope: 'per-process',
            parserDescendants: 0,
          },
        };
        let text = '';
        let byteLength = 0;
        const pages: PdfPageLocator[] = [];
        const pagesWithoutText: number[] = [];
        for (let page = 1; page <= Math.min(totalPages, limits.maxPages); page++) {
          const header = `# Page ${page}\n\n`;
          const remaining = limits.maxOutputBytes - byteLength - Buffer.byteLength(header) - 1;
          if (remaining < 1) throw new ProcessorFailure('resource-limited');
          const output = await runContained(
            'pdftotext',
            [
              '-f',
              `${page}`,
              '-l',
              `${page}`,
              '-layout',
              '-enc',
              'UTF-8',
              '-eol',
              'unix',
              '-nopgbrk',
              '/input.pdf',
              '-',
            ],
            limits,
            signal,
            sourcePath,
            remaining
          );
          if (output.code !== 0 || output.stderr.length !== 0)
            throw new ProcessorFailure('invalid-pdf');
          const hasText = output.stdout.trim().length > 0;
          if (!hasText) pagesWithoutText.push(page);
          text += header;
          byteLength += Buffer.byteLength(header);
          const startByte = byteLength;
          text += output.stdout;
          byteLength += Buffer.byteLength(output.stdout);
          pages.push({
            page,
            coordinateSpace: 'representation-utf8',
            startByte,
            endByte: byteLength,
            hasText,
          });
          text += '\n';
          byteLength++;
        }
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

/** Decodes only the bounded native text result, preserving PDF's strict UTF8/BOM semantics. */
async function runContained(
  kind: keyof typeof EXECUTABLES,
  args: string[],
  limits: PdfTextLayerLimits,
  signal: AbortSignal,
  sourcePath: string | undefined,
  outputLimit: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const result = await runMediaProcess(
    EXECUTABLES[kind],
    args,
    limits,
    signal,
    sourcePath,
    outputLimit
  );
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    return {
      code: result.code,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    };
  } catch {
    throw new ProcessorFailure('invalid-pdf');
  }
}

function checkSignal(signal: AbortSignal, caller?: AbortSignal): void {
  if (signal.aborted)
    throw new ProcessorFailure(caller?.aborted ? 'cancelled' : 'resource-limited');
}
function digest(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function validLimits(limits: PdfTextLayerLimits): boolean {
  return (
    Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0) &&
    limits.maxInputBytes <= 1_000_000_000 &&
    limits.maxOutputBytes <= 16_777_216 &&
    limits.maxPages <= 1024 &&
    limits.addressSpaceBytes <= 1_073_741_824 &&
    limits.cpuSeconds <= 60 &&
    limits.wallTimeMs <= 60_000
  );
}
