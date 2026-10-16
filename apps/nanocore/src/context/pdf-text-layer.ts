import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** An authorized immutable source. Emit at most 64KiB per chunk, honor cancellation and recheck access. */
export interface PdfTextLayerSource {
  sourceKey: string;
  revision: string;
  originalDigest: string;
  byteLength: number;
  open(signal: AbortSignal): AsyncIterable<Uint8Array>;
}

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
export interface PdfTextLayerProcessor {
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
  reserveTemporaryBytes(bytes: number): { release(): void };
}

const INFO_BYTES = 16_384;
const EXECUTABLES = {
  pdfinfo: '/usr/bin/pdfinfo',
  pdftotext: '/usr/bin/pdftotext',
  forkProbe: '/usr/bin/timeout',
};

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
  let directory: string | undefined;
  let reservation: { release(): void } | undefined;
  let result: PdfTextLayerResult;
  try {
    checkSignal(signal, input.signal);
    // Prove the no-descendant limit under the actual runtime identity, including a root-host mapping.
    // GNU timeout must attempt a real fork and fail EAGAIN; success would prove a root/capability bypass.
    const noFork = await runContained(
      'forkProbe',
      ['1', '/usr/bin/pdfinfo', '-v'],
      limits,
      signal,
      undefined,
      4096
    );
    if (
      noFork.code !== 125 ||
      noFork.stdout !== '' ||
      noFork.stderr !== 'timeout: fork system call failed: Resource temporarily unavailable\n'
    )
      throw new ProcessorFailure('dependency-unavailable');
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
    try {
      reservation = input.reserveTemporaryBytes(original.byteLength);
    } catch {
      throw new ProcessorFailure('resource-limited');
    }
    directory = await mkdtemp(join(input.temporaryRoot, 'pdf-text-layer-'));
    await chmod(directory, 0o700);
    const sourcePath = join(directory, 'input.pdf');
    await stageSource(original, sourcePath, signal);
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
    result = {
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
  } catch (error) {
    result = unavailable(
      signal.aborted
        ? input.signal?.aborted
          ? 'cancelled'
          : 'resource-limited'
        : error instanceof ProcessorFailure
          ? error.reason
          : 'source-unavailable'
    );
  }
  // Unproved cleanup retains the shared reservation and withholds any derivative.
  try {
    if (directory) await rm(directory, { recursive: true, force: true });
    reservation?.release();
  } catch {
    return unavailable('cleanup-unavailable');
  }
  return result;
}

/** Copies bounded chunks into a new private file and verifies the exact canonical digest. */
async function stageSource(
  source: PdfTextLayerSource,
  path: string,
  signal: AbortSignal
): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let observed = 0;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  try {
    iterator = source.open(signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await withCancellation(iterator.next(), signal);
      if (next.done) break;
      if (
        !(next.value instanceof Uint8Array) ||
        next.value.byteLength > source.byteLength - observed
      )
        throw new ProcessorFailure('source-changed');
      if (next.value.byteLength === 0 || next.value.byteLength > 65_536)
        throw new ProcessorFailure('source-unavailable');
      signal.throwIfAborted();
      // Own this bounded view while asynchronous I/O runs; the producer cannot mutate the digest proof.
      const chunk = Buffer.from(next.value);
      await file.writeFile(chunk);
      hash.update(chunk);
      observed += chunk.byteLength;
    }
    if (observed !== source.byteLength || `sha256:${hash.digest('hex')}` !== source.originalDigest)
      throw new ProcessorFailure('source-changed');
  } finally {
    await file.close();
    // A source owner must honor the signal; its uncooperative iterator cannot delay cleanup.
    void iterator?.return?.().catch(() => {});
  }
  await chmod(path, 0o400);
}

/** Fixed executable, namespace and sanitized environment; neither path nor PDF bytes select code. */
function runContained(
  kind: keyof typeof EXECUTABLES,
  args: string[],
  limits: PdfTextLayerLimits,
  signal: AbortSignal,
  sourcePath: string | undefined,
  outputLimit: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProcessorFailure('resource-limited'));
      return;
    }
    const command = spawn(
      '/usr/bin/prlimit',
      [
        `--as=${limits.addressSpaceBytes}`,
        `--cpu=${limits.cpuSeconds}`,
        '--core=0',
        '--fsize=0',
        '--nofile=64',
        '--',
        '/usr/bin/bwrap',
        '--unshare-all',
        '--uid',
        '65534',
        '--gid',
        '65534',
        '--die-with-parent',
        '--new-session',
        '--cap-drop',
        'ALL',
        '--clearenv',
        '--setenv',
        'LC_ALL',
        'C',
        '--setenv',
        'HOME',
        '/nonexistent',
        '--ro-bind',
        '/usr',
        '/usr',
        '--ro-bind-try',
        '/lib',
        '/lib',
        '--ro-bind-try',
        '/lib64',
        '/lib64',
        '--ro-bind-try',
        '/etc/fonts',
        '/etc/fonts',
        ...(sourcePath ? ['--ro-bind', sourcePath, '/input.pdf'] : []),
        '--remount-ro',
        '/',
        '--',
        '/usr/bin/prlimit',
        '--nproc=0',
        '--',
        EXECUTABLES[kind],
        ...args,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { LC_ALL: 'C' }, cwd: '/' }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let failure: ProcessorFailure | undefined;
    const stop = (reason: FailureReason) => {
      failure ??= new ProcessorFailure(reason);
      if (command.pid) {
        try {
          process.kill(-command.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    };
    const abort = () => stop('resource-limited');
    signal.addEventListener('abort', abort, { once: true });
    command.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) stop('resource-limited');
      else stdout.push(chunk);
    });
    command.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > INFO_BYTES) stop('resource-limited');
      else stderr.push(chunk);
    });
    command.on('error', () => {
      failure ??= new ProcessorFailure('dependency-unavailable');
    });
    command.on('close', (code, terminationSignal) => {
      signal.removeEventListener('abort', abort);
      if (failure) {
        reject(failure);
        return;
      }
      // Bubblewrap relays a signalled sandbox child's exit as 128+signal instead of signalling itself.
      if (terminationSignal || code === 137 || code === 152) {
        reject(new ProcessorFailure('resource-limited'));
        return;
      }
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        resolve({
          code,
          stdout: decoder.decode(Buffer.concat(stdout)),
          stderr: decoder.decode(Buffer.concat(stderr)),
        });
      } catch {
        reject(new ProcessorFailure('invalid-pdf'));
      }
    });
    if (signal.aborted) abort();
  });
}

/** Releases an abort listener on both completion and cancellation without waiting on a source. */
function withCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
  });
}

function checkSignal(signal: AbortSignal, caller?: AbortSignal): void {
  if (signal.aborted)
    throw new ProcessorFailure(caller?.aborted ? 'cancelled' : 'resource-limited');
}
function digest(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function validSource(source: PdfTextLayerSource): boolean {
  return (
    typeof source.sourceKey === 'string' &&
    source.sourceKey.length > 0 &&
    source.sourceKey.length <= 1024 &&
    typeof source.revision === 'string' &&
    source.revision.length > 0 &&
    source.revision.length <= 256 &&
    /^sha256:[0-9a-f]{64}$/.test(source.originalDigest) &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength >= 0 &&
    source.byteLength <= 1_000_000_000 &&
    typeof source.open === 'function'
  );
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
