import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  makePrivateTreeDirectory,
  measureDerivedTreeBytes,
  removePrivateTree,
  writePrivateTreeFile,
} from '@openkit/storage';
import { z } from 'zod';
import type {
  FileDigestWindowScanInput,
  FileDigestWindowScanResult,
} from './storage/artifacts/worker-credential-scan.js';

/** The version-1 local service's admitted source, never a permission record. */
export interface RetrievalDocument {
  key: { namespace: string; id: string };
  revision: string;
  digest: string;
  size: number;
  name: string;
  title?: string;
  media_type: string;
  /** Optional searchable byte units within the verified full canonical source. */
  text_ranges?: { start: number; end: number }[];
  language?: 'zh' | 'ja' | 'unicode';
  metadata?: Record<string, string>;
  locator?: string;
  content:
    | { kind: 'inline-text'; text: string }
    | { kind: 'text'; path: string; range?: { start: number; end: number } }
    | {
        kind: 'representation';
        /** Confined source-owned text path; the kernel never opens its binary original. */
        path: string;
        digest: string;
        size: number;
        /** Version and output-changing configuration identity from the source processor. */
        processor: string;
        fragments: { start: number; end: number; locator: string }[];
        complete: boolean;
      }
    | { kind: 'unreadable' | 'unavailable' | 'resource-limited' };
}
/** A complete current inventory in one exact read-eligibility partition. */
export interface RetrievalScope {
  scope: string;
  documents: RetrievalDocument[];
  unavailable_objects?: number;
}
/** Every query explicitly carries its current admitted inventories. */
export interface RetrievalQuery {
  mode: 'lexical' | 'exact' | 'regex';
  query: string;
  scopes: RetrievalScope[];
  limit: number;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
const original = z.string().nullable();
const locator = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), start: count, end: count, original }),
  z.object({ kind: z.literal('title'), start: count, end: count, original }),
  z.object({ kind: z.literal('metadata'), field: z.string(), start: count, end: count }),
]);
const resultSchema = z.object({
  generations: z.record(z.string(), digest),
  mode: z.enum(['lexical', 'exact', 'regex']),
  hits: z
    .array(
      z.object({
        key: z.object({ namespace: z.string(), id: z.string() }),
        scope: z.string(),
        revision: z.string(),
        digest,
        representation: z.enum(['text', 'sidecar']),
        representation_digest: digest,
        processor: z.string().min(1).max(1024).nullable(),
        locator,
        chunk: count,
        score: z.number().finite().nullable(),
        snippet: z.string(),
        provenance: z.record(z.string(), z.string()),
      })
    )
    .max(1000),
  coverage: z.object({
    admitted_objects: count,
    searched_representations: count,
    stale_revisions: count,
    stopped_work: count,
    unsupported_bodies: count,
    inventory_complete: z.boolean(),
    representations_complete: z.boolean(),
    matches_complete: z.boolean(),
    reasons: z.record(z.string(), count),
    omitted_matches: count,
    matching_documents: count,
    enumeration_complete: z.boolean(),
  }),
  complete: z.boolean(),
});
const analysisSchema = z.object({
  language: z.enum(['zh', 'ja', 'unicode']),
  query_terms: z.array(z.string()).max(10000),
  title_terms: z.array(z.string()).max(10000),
  body_terms: z.array(z.string()).max(10000),
});
const digestWindowResultSchema = z.object({
  start: count,
  end: count,
  bytes: count,
  range_digest: digest,
  matches: z.array(z.object({ start: count, end: count })).max(1024),
});
/** Term evidence produced by the same selected analyzer as the canonical Document. */
export type RetrievalAnalysis = z.infer<typeof analysisSchema>;
/** Validated source-linked retrieval facts; this type grants no product authority. */
export type RetrievalResult = z.infer<typeof resultSchema>;
/** Closed kernel or supervision failure, with publication ambiguity kept explicit. */
export class RetrievalServiceError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'conflict' | 'unavailable' | 'resource-limited' | 'io',
    readonly uncertain = false
  ) {
    super(`Retrieval service ${code}${uncertain ? '; inspect publication before retry' : ''}.`);
    this.name = 'RetrievalServiceError';
  }
}
/** Startup admission and implementation budgets; no model can select these values. */
export interface RetrievalServiceOptions {
  executable: string;
  sourcesRoot: string;
  storeRoot: string;
  timeoutMs?: number;
  storeLimitBytes?: number;
}
const FRAME_BYTES = 8 * 1024 * 1024;
const GENERATION_BYTES = 512 * 1024 * 1024;
const DEFAULT_STORE_BYTES = 2 * 1024 * 1024 * 1024;
// Request-local text transport, not a retained representation or a cross-read body cache.
const INLINE_DOCUMENT_BYTES = 64 * 1024;
const INLINE_REQUEST_BYTES = 1024 * 1024;
const TRANSPORT_DOCUMENT_BYTES = 16 * 1024 * 1024;
const TRANSPORT_REQUEST_BYTES = 64 * 1024 * 1024;
const TRANSPORT_BUFFER_BYTES = 16 * 1024;

/** Supervises one ownership-homed stdio service; never retries an uncertain operation. */
export class RetrievalService {
  private child: ChildProcessWithoutNullStreams | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private closed = false;
  private transportRoot: string | undefined;
  private pending: ((error: RetrievalServiceError) => void) | undefined;
  private output = Buffer.alloc(0);
  private response: ((value: unknown) => void) | undefined;

  constructor(private readonly options: RetrievalServiceOptions) {
    if (
      ![options.executable, options.sourcesRoot, options.storeRoot].every(isAbsolute) ||
      !Number.isSafeInteger(options.timeoutMs ?? 65_000) ||
      (options.timeoutMs ?? 65_000) <= 0 ||
      !Number.isSafeInteger(options.storeLimitBytes ?? DEFAULT_STORE_BYTES) ||
      (options.storeLimitBytes ?? DEFAULT_STORE_BYTES) <= 0
    ) {
      throw new RetrievalServiceError('invalid-request');
    }
  }

  /** Establishes a responsive child without opening any generation or canonical text. */
  async start(): Promise<void> {
    await this.health();
  }
  /** Observes current process responsiveness through a source-free kernel operation. */
  async health(): Promise<void> {
    await this.search({ mode: 'lexical', query: 'health', scopes: [], limit: 1 });
  }
  /** Inspects the durable pointer; the adapter must re-enumerate truth before a retry. */
  async inspect(scope: string, signal?: AbortSignal): Promise<string | null> {
    const value = await this.request({ op: 'inspect', scope }, signal);
    return this.decode(z.object({ generation: digest.nullable() }), value).generation;
  }
  /** Publishes fixed admitted revisions with explicit compare-and-set, with no replay. */
  async publish(
    view: RetrievalScope,
    expectedGeneration: string | null,
    signal?: AbortSignal
  ): Promise<string> {
    const value = await this.request(
      { op: 'publish', view, expected_generation: expectedGeneration },
      signal
    );
    return this.decode(z.object({ generation: digest }), value).generation;
  }
  /** Searches only supplied scopes; all source and audience admission stays with adapters. */
  async search(request: RetrievalQuery, signal?: AbortSignal): Promise<RetrievalResult> {
    const result = this.decode(resultSchema, await this.request({ op: 'search', request }, signal));
    const admitted = new Set(request.scopes.map((scope) => scope.scope));
    if (
      result.mode !== request.mode ||
      Object.keys(result.generations).some((s) => !admitted.has(s)) ||
      result.hits.some((hit) => !admitted.has(hit.scope)) ||
      result.complete !==
        (result.coverage.inventory_complete &&
          result.coverage.representations_complete &&
          result.coverage.matches_complete)
    ) {
      this.stop();
      throw new RetrievalServiceError('unavailable');
    }
    return result;
  }
  /** Obtains kernel-owned analysis for the preserved deterministic Knowledge answer rule. */
  async analyze(
    query: string,
    title: string,
    body: string,
    language?: 'zh' | 'ja' | 'unicode'
  ): Promise<RetrievalAnalysis> {
    return this.decode(
      analysisSchema,
      await this.request({
        op: 'analyze',
        query,
        title,
        body,
        ...(language === undefined ? {} : { language }),
      })
    );
  }
  /** Compares generic digest windows under the same startup root; no retrieval generation is read or written. */
  async digestWindows(
    request: FileDigestWindowScanInput,
    signal?: AbortSignal
  ): Promise<FileDigestWindowScanResult> {
    const result = this.decode(
      digestWindowResultSchema,
      await this.request({ op: 'digest-windows', request }, signal)
    );
    if (
      result.start !== request.start ||
      result.end !== request.end ||
      result.bytes !== request.end - request.start ||
      result.matches.length > request.bounds.max_matches ||
      result.matches.some(
        (match, index) =>
          match.start < request.start ||
          match.end > request.end ||
          match.start >= match.end ||
          !request.patterns.some((pattern) => pattern.window_bytes === match.end - match.start) ||
          (index > 0 &&
            (result.matches[index - 1]!.start > match.start ||
              (result.matches[index - 1]!.start === match.start &&
                result.matches[index - 1]!.end >= match.end)))
      )
    ) {
      this.stop();
      throw new RetrievalServiceError('unavailable');
    }
    return result;
  }
  /** Sends EOF, then bounds termination; a closed supervisor never starts another child. */
  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (child) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        child.stdin.end();
      });
    }
    await this.tail.catch(() => undefined);
    if (this.transportRoot) await removePrivateTree(this.transportRoot);
  }

  /** Validates the child boundary without reflecting untrusted protocol bytes in errors. */
  private decode<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      this.stop();
      throw new RetrievalServiceError('unavailable');
    }
    return parsed.data;
  }
  /** Serializes complete RPCs, including the capacity reservation before publication. */
  private request(operation: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const run = this.tail
      .catch(() => undefined)
      .then(async () => {
        signal?.throwIfAborted();
        if (this.closed) throw new RetrievalServiceError('unavailable');
        if (operation.op === 'publish') {
          await makePrivateTreeDirectory(this.options.storeRoot);
          const used = await measureDerivedTreeBytes(
            this.options.storeRoot,
            DEFAULT_STORE_BYTES,
            RetrievalServiceError
          );
          if (used + GENERATION_BYTES > (this.options.storeLimitBytes ?? DEFAULT_STORE_BYTES))
            throw new RetrievalServiceError('resource-limited');
        }
        if (this.child) {
          try {
            await this.rpc(
              {
                op: 'search',
                request: {
                  mode: 'lexical',
                  query: 'health',
                  scopes: [],
                  limit: 1,
                },
              },
              signal
            );
          } catch (error) {
            // Only the source-free health probe ran; the requested operation was not sent.
            if (
              !(error instanceof RetrievalServiceError) ||
              error.code !== 'unavailable' ||
              this.closed
            )
              throw error;
          }
        }
        signal?.throwIfAborted();
        return this.streamInlineText(operation, signal);
      });
    this.tail = run;
    return run;
  }

  /** Borrows bounded private files for large decoded text; canonical identities and caller views stay unchanged. */
  private async streamInlineText(
    operation: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const views =
      operation.op === 'publish'
        ? [operation.view as RetrievalScope]
        : operation.op === 'search'
          ? (operation.request as RetrievalQuery).scopes
          : [];
    const storePath = relative(this.options.sourcesRoot, this.options.storeRoot);
    // Product stores are beneath their admitted source root. Other clients already have the explicit file form.
    if (
      storePath.startsWith('..') ||
      isAbsolute(storePath) ||
      !views.some((view) => view.documents.some((doc) => doc.content.kind === 'inline-text'))
    )
      return this.rpc(operation, signal);

    let inlineRemaining = INLINE_REQUEST_BYTES;
    let transportRemaining = TRANSPORT_REQUEST_BYTES;
    let capacityChecked = false;
    let metadataBytes = 1024;
    const files: string[] = [];
    const streamed: RetrievalScope[] = [];
    let primaryFailure: unknown;
    let acknowledged = false;
    let result: unknown;
    const deadline = Date.now() + (this.options.timeoutMs ?? 65_000);
    try {
      for (const view of views) {
        metadataBytes += Buffer.byteLength(JSON.stringify({ ...view, documents: [] }));
        const documents: RetrievalDocument[] = [];
        for (const document of view.documents) {
          const selected = { ...document };
          metadataBytes += Buffer.byteLength(
            JSON.stringify({ ...selected, content: { kind: 'unavailable' } })
          );
          if (metadataBytes > FRAME_BYTES - INLINE_REQUEST_BYTES - 1024)
            throw new RetrievalServiceError('resource-limited');
          if (selected.content.kind === 'inline-text') {
            const text = selected.content.text;
            const size = Buffer.byteLength(text);
            // Six is the maximum JSON escape expansion. Do not encode a complete body to measure it.
            const encodedCeiling = size * 6 + 2;
            if (size <= INLINE_DOCUMENT_BYTES && encodedCeiling <= inlineRemaining) {
              inlineRemaining -= encodedCeiling;
            } else if (
              size > TRANSPORT_DOCUMENT_BYTES ||
              size > transportRemaining ||
              Date.now() > deadline
            ) {
              selected.content = { kind: 'resource-limited' };
            } else {
              if (!capacityChecked) {
                await makePrivateTreeDirectory(this.options.storeRoot);
                const used = await measureDerivedTreeBytes(
                  this.options.storeRoot,
                  DEFAULT_STORE_BYTES,
                  RetrievalServiceError
                );
                const reserve = operation.op === 'publish' ? GENERATION_BYTES : 0;
                transportRemaining = Math.min(
                  transportRemaining,
                  Math.max(
                    0,
                    (this.options.storeLimitBytes ?? DEFAULT_STORE_BYTES) - used - reserve
                  )
                );
                capacityChecked = true;
              }
              if (size > transportRemaining) {
                selected.content = { kind: 'resource-limited' };
                documents.push(selected);
                continue;
              }
              // Reserve before I/O: partial failed files also consume the request's byte account.
              transportRemaining -= size;
              this.transportRoot ??= join(
                this.options.storeRoot,
                `.inline-transport-${randomUUID()}`
              );
              await makePrivateTreeDirectory(this.transportRoot);
              // Stable within this service, including single-scope publish and multi-scope search.
              const name = createHash('sha256')
                .update(
                  JSON.stringify([
                    view.scope,
                    selected.key.namespace,
                    selected.key.id,
                    selected.digest,
                  ])
                )
                .digest('hex');
              const path = join(this.transportRoot, name);
              const chunks = function* () {
                for (let offset = 0; offset < text.length; ) {
                  let end = Math.min(text.length, offset + TRANSPORT_BUFFER_BYTES / 4);
                  const last = text.charCodeAt(end - 1);
                  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
                  const part = text.slice(offset, end);
                  const bytes = Buffer.from(part);
                  if (bytes.toString('utf8') !== part)
                    throw new RetrievalServiceError('invalid-request');
                  yield bytes;
                  offset = end;
                }
              };
              files.push(path);
              try {
                const digest = createHash('sha256');
                let written = 0;
                await writePrivateTreeFile({
                  path,
                  source: Readable.from(chunks(), { objectMode: true, highWaterMark: 1 }),
                  signal: signal ?? new AbortController().signal,
                  cancellationMessage: 'Retrieval text transport cancelled.',
                  onChunk: (bytes) => {
                    if (this.closed) throw new RetrievalServiceError('unavailable');
                    if (Date.now() > deadline || bytes.length > TRANSPORT_BUFFER_BYTES)
                      throw new RetrievalServiceError('resource-limited');
                    digest.update(bytes);
                  },
                  onWritten: (count) => {
                    written += count;
                  },
                  validate: () => {
                    if (written !== selected.size || digest.digest('hex') !== selected.digest)
                      throw new RetrievalServiceError('conflict');
                  },
                });
                selected.content = { kind: 'text', path: relative(this.options.sourcesRoot, path) };
              } catch (error) {
                const code =
                  error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
                if (code === 'EEXIST') files.pop();
                if (
                  (error instanceof RetrievalServiceError && error.code === 'resource-limited') ||
                  ['ENOSPC', 'EDQUOT', 'EFBIG', 'EMFILE', 'ENFILE', 'EEXIST'].includes(code)
                )
                  selected.content = { kind: 'resource-limited' };
                else throw error;
              }
            }
          }
          documents.push(selected);
        }
        streamed.push({ ...view, documents });
      }
      signal?.throwIfAborted();
      if (this.closed) throw new RetrievalServiceError('unavailable');
      const transported =
        operation.op === 'publish'
          ? { ...operation, view: streamed[0] }
          : {
              ...operation,
              request: { ...(operation.request as RetrievalQuery), scopes: streamed },
            };
      result = await this.rpc(transported, signal);
      acknowledged = true;
    } catch (error) {
      primaryFailure =
        error instanceof RetrievalServiceError || signal?.aborted
          ? error
          : new RetrievalServiceError('io');
    }
    try {
      for (const path of files) await removePrivateTree(path);
    } catch {
      // A cleanup failure cannot hide the original publication ambiguity or undo an acknowledgement.
      primaryFailure ??= new RetrievalServiceError(
        'io',
        acknowledged && operation.op === 'publish'
      );
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    return result;
  }

  /** Starts a fresh child with no inherited credential environment or network configuration. */
  private spawn(): ChildProcessWithoutNullStreams {
    const child = spawn(
      this.options.executable,
      ['service', '--sources', this.options.sourcesRoot, '--store', this.options.storeRoot],
      { env: {}, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    this.child = child;
    this.output = Buffer.alloc(0);
    child.stderr.resume();
    child.on('error', () => this.failChild(child));
    child.on('exit', () => this.failChild(child));
    child.stdin.on('error', () => this.failChild(child));
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      if (this.output.length + chunk.length > FRAME_BYTES) {
        this.failChild(child, 'resource-limited');
        return;
      }
      this.output = Buffer.concat([this.output, chunk]);
      const end = this.output.indexOf(10);
      if (end < 0) return;
      if (end !== this.output.length - 1 || !this.response) {
        this.failChild(child);
        return;
      }
      try {
        const value: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(this.output.subarray(0, end))
        );
        this.output = Buffer.alloc(0);
        this.response(value);
      } catch {
        this.failChild(child);
      }
    });
    return child;
  }
  /** Converts lost transport to a bounded failure; publish ambiguity is set by its caller. */
  private failChild(
    child: ChildProcessWithoutNullStreams,
    code: 'unavailable' | 'resource-limited' = 'unavailable'
  ): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.pending?.(new RetrievalServiceError(code));
    child.kill('SIGKILL');
  }
  /** Terminates a child without carrying its pending state into a successor. */
  private stop(): void {
    if (this.child) this.failChild(this.child);
  }
  /** Owns one bounded frame/reply pair; an explicit later request may restart the child. */
  private async rpc(operation: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const id = ++this.sequence;
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, id, ...operation })}\n`);
    if (bytes.length > FRAME_BYTES) throw new RetrievalServiceError('resource-limited');
    const child = this.child ?? this.spawn();
    return new Promise((resolve, reject) => {
      let sent = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending = undefined;
        this.response = undefined;
      };
      const fail = (error: RetrievalServiceError) => {
        cleanup();
        reject(new RetrievalServiceError(error.code, sent && operation.op === 'publish'));
      };
      const timer = setTimeout(
        () => this.failChild(child, 'resource-limited'),
        this.options.timeoutMs ?? 65_000
      );
      const abort = () => this.failChild(child);
      this.pending = fail;
      signal?.addEventListener('abort', abort, { once: true });
      this.response = (value) => {
        const envelope = z
          .object({
            version: z.literal(1),
            id: z.literal(id),
            result: z.unknown().optional(),
            error: z
              .object({
                code: z.enum([
                  'invalid-request',
                  'conflict',
                  'unavailable',
                  'resource-limited',
                  'io',
                ]),
                message: z.string().max(4096),
              })
              .optional(),
          })
          .safeParse(value);
        if (
          !envelope.success ||
          (envelope.data.error === undefined) === (envelope.data.result === undefined)
        ) {
          this.failChild(child);
          return;
        }
        const reply = envelope.data;
        cleanup();
        if (reply.error) reject(new RetrievalServiceError(reply.error.code));
        else resolve(reply.result);
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      sent = true;
      child.stdin.write(bytes, (error) => {
        if (error) this.failChild(child);
      });
    });
  }
}

const services = new Map<string, RetrievalService>();
/** Resolves target-matched packaged supply or the repository's ordinary Cargo build. */
export function retrievalExecutable(): string {
  const packaged = '/usr/local/bin/retrieval-kernel';
  return existsSync(packaged)
    ? packaged
    : fileURLToPath(new URL('../../../target/debug/retrieval-kernel', import.meta.url));
}
/** Reuses process supervision inside an already admitted canonical ownership boundary. */
export function getRetrievalService(dataRoot: string, ownerRoot: string): RetrievalService {
  const child = relative(dataRoot, ownerRoot);
  if (
    !isAbsolute(dataRoot) ||
    !isAbsolute(ownerRoot) ||
    child.startsWith('..') ||
    isAbsolute(child)
  )
    throw new RetrievalServiceError('invalid-request');
  const storeRoot = join(ownerRoot, 'indexes', 'retrieval');
  let service = services.get(storeRoot);
  if (!service) {
    service = new RetrievalService({
      executable: retrievalExecutable(),
      sourcesRoot: dataRoot,
      storeRoot,
    });
    services.set(storeRoot, service);
  }
  return service;
}
/** Ends every owned child during NanoCore shutdown without replay or canonical mutation. */
export async function closeRetrievalServices(): Promise<void> {
  const closing = [...services.values()];
  services.clear();
  await Promise.all(closing.map((service) => service.close()));
}
