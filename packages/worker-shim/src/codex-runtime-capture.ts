import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  codexFrameActivities,
  listRolloutFiles,
  MAX_CODEX_RUNTIME_STREAMS,
  type ParsedFrame,
  parseCodexPrimaryFrame,
  parseCodexRolloutFrame,
  type RolloutCandidate,
  readRolloutCandidate,
  type StreamOriginContext,
} from './codex-runtime-provenance.js';
import {
  type emitRuntimeFact,
  type RuntimeCaptureInput,
  type RuntimeFact,
  RuntimeJsonlReader,
  RuntimeSemanticCapture,
  runtimeOriginRef,
  runtimeRef,
} from './runtime-capture.js';

/** One observed native file's identity and pre-launch byte watermark. */
interface Watermark {
  dev: number;
  ino: number;
  size: number;
}
/** One reachable append-only source, with a bounded physical frame decoder. */
interface RolloutTail {
  candidate: RolloutCandidate;
  position: number;
  reader: RuntimeJsonlReader;
  context: StreamOriginContext;
  sourceRef: string;
  stopped: boolean;
}

/** Incremental pinned Codex observation capture; it does not advertise verified provenance. */
export class CodexRuntimeCapture {
  private readonly primaryContext: StreamOriginContext = {};
  private readonly primary: RuntimeJsonlReader;
  private readonly watermarks = new Map<string, Watermark>();
  private readonly tails = new Map<string, RolloutTail>();
  private readonly parents = new Map<string, string>();
  private readonly semantic: RuntimeSemanticCapture;
  private readonly gaps = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopped = false;
  private failed: unknown;
  private initialScanTruncated = false;
  private readonly primaryRef: string;

  /** Creates the reader; use create() to establish pre-launch retained-file watermarks. */
  private constructor(
    private readonly input: RuntimeCaptureInput,
    private readonly codexHome: string
  ) {
    this.primaryRef = runtimeRef('rts', input.packageSnapshotId, 'stdout');
    this.semantic = new RuntimeSemanticCapture(input);
    this.primary = new RuntimeJsonlReader(async (bytes, _sequence, failure) => {
      if (!bytes) {
        await this.gap(this.primaryRef, 'primary-content', failure!);
        return;
      }
      let invalid = false;
      const parsed = parseCodexPrimaryFrame(
        bytes,
        false,
        this.primaryContext,
        (parent, child) => this.spawn(parent, child),
        () => {
          invalid = true;
        }
      );
      if (invalid || parsed.parseStatus !== 'parsed')
        await this.gap(this.primaryRef, 'primary-content', 'malformed-frame');
      else await this.project(parsed, this.primaryRef);
    });
  }

  /** Snapshots source positions before native launch, without reading historical bodies. */
  public static async create(
    input: RuntimeCaptureInput,
    codexHome: string
  ): Promise<CodexRuntimeCapture> {
    const capture = new CodexRuntimeCapture(input, codexHome);
    const files = await listRolloutFiles(join(codexHome, 'sessions'));
    capture.initialScanTruncated = files.truncated;
    for (const path of files.paths) {
      const candidate = await readRolloutCandidate(path, '0.153.4');
      if (candidate)
        capture.watermarks.set(path, {
          dev: candidate.initialDev,
          ino: candidate.initialIno,
          size: candidate.initialSize,
        });
    }
    return capture;
  }

  /** Consumes live stdout under backpressure; the first chunk starts independent child polling. */
  public writeStdout(chunk: Uint8Array): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Runtime capture is stopped.'));
    return this.enqueue(async () => {
      if (!this.started) {
        this.started = true;
        await this.coverage(
          this.primaryRef,
          'primary-content',
          this.input.captureCoverage.value === 'on' ? 'collecting' : 'off'
        );
        await this.coverage(this.primaryRef, 'child-metadata', 'collecting');
        await this.coverage(
          this.primaryRef,
          'child-content',
          this.input.captureCoverage.value === 'on' ? 'collecting' : 'off'
        );
        if (this.initialScanTruncated)
          await this.gap(this.primaryRef, 'child-metadata', 'limit-exceeded');
        this.schedule();
      }
      await this.primary.write(chunk);
      await this.poll();
    });
  }

  /** Stops periodic work, drains currently readable source bytes, and reports unresolved children. */
  public async finalize(): Promise<void> {
    if (this.stopped) {
      if (this.failed) throw this.failed;
      return;
    }
    this.stopped = true;
    clearTimeout(this.timer);
    await this.enqueue(async () => {
      await this.primary.finish();
      await this.poll();
      for (const tail of this.tails.values()) {
        await tail.reader.finish();
        if (tail.context.inheritedHistory)
          await this.gap(tail.sourceRef, 'child-content', 'source-missing');
      }
      for (const child of this.parents.keys())
        if (!this.tails.has(child))
          await this.gap(
            runtimeRef('rts', this.input.packageSnapshotId, child),
            'child-content',
            'source-missing'
          );
      if (!this.primaryContext.threadId || !this.tails.has(this.primaryContext.threadId))
        await this.gap(this.primaryRef, 'primary-content', 'source-missing');
      await this.semantic.interrupt();
      await this.coverage(this.primaryRef, 'primary-content', 'ended');
      await this.coverage(this.primaryRef, 'child-metadata', 'ended');
      await this.coverage(this.primaryRef, 'child-content', 'ended');
    });
    if (this.failed) throw this.failed;
  }

  /** Releases timers after supervision failure; accepted Core observations are never erased. */
  public async invalidate(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.queue.catch(() => undefined);
    await this.semantic.interrupt();
  }

  /** Serializes timer and stdout mutations, retaining the original failure for finalization. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(work);
    this.queue = result.catch((error: unknown) => {
      this.failed ??= error;
    });
    return result;
  }

  /** Polls quietly running children without depending on another primary stdout event. */
  private schedule(): void {
    if (this.stopped || this.failed) return;
    this.timer = setTimeout(() => {
      void this.enqueue(() => this.poll())
        .catch(async () => {
          await this.gap(this.primaryRef, 'child-content', 'collector-failed').catch(
            () => undefined
          );
        })
        .finally(() => this.schedule());
    }, 100);
    this.timer.unref();
  }

  /** Retains only causal spawn edges; contradictory ancestry cannot select a winner. */
  private spawn(parent: string, child: string): void {
    if (parent === child || (this.parents.has(child) && this.parents.get(child) !== parent))
      throw new Error('Conflicting runtime ancestry.');
    let ancestor: string | undefined = parent;
    for (let depth = 0; ancestor && depth <= MAX_CODEX_RUNTIME_STREAMS; depth += 1) {
      if (ancestor === child) throw new Error('Cyclic runtime ancestry.');
      ancestor = this.parents.get(ancestor);
    }
    if (this.parents.size >= MAX_CODEX_RUNTIME_STREAMS && !this.parents.has(child))
      throw new Error('Runtime ancestry exceeds its bound.');
    this.parents.set(child, parent);
  }

  /** Discovers metadata under the existing guards and reads bodies only after root reachability. */
  private async poll(): Promise<void> {
    const root = this.primaryContext.threadId;
    if (!root) return;
    const files = await listRolloutFiles(join(this.codexHome, 'sessions'));
    if (files.truncated) await this.gap(this.primaryRef, 'child-metadata', 'limit-exceeded');
    const candidates = new Map<string, RolloutCandidate>();
    const duplicates = new Set<string>();
    for (const path of files.paths) {
      const candidate = await readRolloutCandidate(path, '0.153.4');
      if (!candidate) continue;
      if (candidates.has(candidate.threadId)) duplicates.add(candidate.threadId);
      else candidates.set(candidate.threadId, candidate);
    }
    const reachable = new Set([root]);
    for (let pass = 0; pass < MAX_CODEX_RUNTIME_STREAMS; pass += 1) {
      let added = false;
      for (const candidate of candidates.values()) {
        if (
          candidate.parentThreadId &&
          reachable.has(candidate.parentThreadId) &&
          !reachable.has(candidate.threadId)
        ) {
          if (reachable.size >= MAX_CODEX_RUNTIME_STREAMS - 1) {
            await this.gap(this.primaryRef, 'child-metadata', 'limit-exceeded');
            break;
          }
          this.spawn(candidate.parentThreadId, candidate.threadId);
          reachable.add(candidate.threadId);
          added = true;
        }
      }
      for (const [child, parent] of this.parents)
        if (reachable.has(parent) && !reachable.has(child)) {
          if (reachable.size >= MAX_CODEX_RUNTIME_STREAMS - 1) {
            await this.gap(this.primaryRef, 'child-metadata', 'limit-exceeded');
            break;
          }
          reachable.add(child);
          added = true;
        }
      if (!added) break;
    }
    for (const id of reachable) {
      const candidate = candidates.get(id);
      const sourceRef = runtimeRef('rts', this.input.packageSnapshotId, id);
      if (!candidate) {
        const existing = this.tails.get(id);
        if (existing) {
          existing.stopped = true;
          await this.gap(sourceRef, 'child-content', 'source-missing');
        }
        continue;
      }
      if (
        duplicates.has(id) ||
        !candidate.valid ||
        (id === root && candidate.parentThreadId) ||
        (this.parents.has(id) && this.parents.get(id) !== candidate.parentThreadId)
      ) {
        await this.gap(sourceRef, 'child-metadata', 'source-changed');
        continue;
      }
      if (!candidate.adapterVersionValid) {
        await this.gap(
          sourceRef,
          id === root ? 'primary-content' : 'child-content',
          'version-mismatch'
        );
        continue;
      }
      let tail = this.tails.get(id);
      if (!tail) {
        const before = this.watermarks.get(candidate.path);
        if (
          before &&
          (before.dev !== candidate.initialDev ||
            before.ino !== candidate.initialIno ||
            before.size > candidate.initialSize)
        ) {
          await this.gap(sourceRef, 'child-content', 'source-changed');
          continue;
        }
        const context: StreamOriginContext = {
          threadId: id,
          sessionId: candidate.sessionId,
          inheritedHistory: candidate.copiedHistory ?? false,
          ...(candidate.parentThreadId ? { parentThreadId: candidate.parentThreadId } : {}),
        };
        if (before) await this.restoreContext(candidate, before.size, context);
        const reader = new RuntimeJsonlReader(async (bytes, _sequence, failure) => {
          if (!bytes) {
            await this.gap(sourceRef, id === root ? 'primary-content' : 'child-content', failure!);
            return;
          }
          let invalid = false;
          const parsed = parseCodexRolloutFrame(
            bytes,
            false,
            context,
            (parent, child) => this.spawn(parent, child),
            () => {
              invalid = true;
            }
          );
          if (invalid || parsed.parseStatus !== 'parsed')
            await this.gap(
              sourceRef,
              id === root ? 'primary-content' : 'child-content',
              'malformed-frame'
            );
          else await this.project(parsed, sourceRef);
        });
        tail = {
          candidate,
          position: before?.size ?? 0,
          reader,
          context,
          sourceRef,
          stopped: false,
        };
        this.tails.set(id, tail);
        await this.emit(sourceRef, {
          kind: 'origin',
          runtimeOriginRef: runtimeOriginRef(this.input.packageSnapshotId, id),
          ...(candidate.parentThreadId
            ? {
                parentRuntimeOriginRef: runtimeOriginRef(
                  this.input.packageSnapshotId,
                  candidate.parentThreadId
                ),
              }
            : {}),
          phase: 'observed',
        });
      }
      if (!tail.stopped) await this.readTail(tail);
    }
  }

  /** Replays only parser eligibility before a watermark; historical activities and bodies are never emitted. */
  private async restoreContext(
    candidate: RolloutCandidate,
    size: number,
    context: StreamOriginContext
  ): Promise<void> {
    const handle = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.dev !== candidate.initialDev ||
        stat.ino !== candidate.initialIno ||
        stat.size < size
      )
        throw new Error('Runtime source changed before parser state restoration.');
      const reader = new RuntimeJsonlReader(async (bytes) => {
        if (bytes)
          parseCodexRolloutFrame(
            bytes,
            false,
            context,
            () => undefined,
            () => undefined
          );
      });
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, size - position),
          position
        );
        if (!bytesRead) throw new Error('Runtime source ended before its watermark.');
        await reader.write(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }

  /** Reads only appended bytes from the same regular file; replacement or shrink is a gap. */
  private async readTail(tail: RolloutTail): Promise<void> {
    const handle = await open(tail.candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.dev !== tail.candidate.initialDev ||
        stat.ino !== tail.candidate.initialIno ||
        stat.size < tail.position
      ) {
        tail.stopped = true;
        await this.gap(tail.sourceRef, 'child-content', 'source-changed');
        return;
      }
      const buffer = Buffer.alloc(64 * 1024);
      while (tail.position < stat.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, stat.size - tail.position),
          tail.position
        );
        if (!bytesRead) break;
        await tail.reader.write(buffer.subarray(0, bytesRead));
        tail.position += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }

  /** Projects native facts through opaque refs and the complete-content admission boundary. */
  private async project(frame: ParsedFrame, sourceRef: string): Promise<void> {
    const timestamp = frame.value?.timestamp;
    const sourceTimestamp =
      typeof timestamp === 'string' &&
      /^\d{4}-\d{2}-\d{2}T.*Z$/.test(timestamp) &&
      Number.isFinite(Date.parse(timestamp))
        ? timestamp
        : undefined;
    const frameKey = `${sourceRef}:${this.semantic.nextSequence(sourceRef)}`;
    for (const activity of codexFrameActivities(frame)) {
      const origin = activity.threadId
        ? runtimeOriginRef(this.input.packageSnapshotId, activity.threadId)
        : null;
      const key = activity.key ?? frameKey;
      const scopedKey = `${activity.threadId ?? sourceRef}:${key}`;
      const fact: RuntimeFact =
        activity.kind === 'origin'
          ? {
              kind: 'origin',
              runtimeOriginRef: origin,
              phase: activity.phase,
              ...(activity.parentThreadId
                ? {
                    parentRuntimeOriginRef: runtimeOriginRef(
                      this.input.packageSnapshotId,
                      activity.parentThreadId
                    ),
                  }
                : {}),
            }
          : activity.kind === 'assistant'
            ? {
                kind: 'assistant',
                runtimeOriginRef: origin,
                phase: activity.phase,
                messageRef: runtimeRef('rtm', this.input.packageSnapshotId, scopedKey),
                representation: 'snapshot',
              }
            : {
                kind: 'tool',
                runtimeOriginRef: origin,
                phase: activity.phase,
                callRef: runtimeRef('rtc', this.input.packageSnapshotId, scopedKey),
                ...(activity.toolName ? { toolName: activity.toolName } : {}),
                ...(activity.exitCode === undefined ? {} : { exitCode: activity.exitCode }),
              };
      await this.emit(sourceRef, fact, activity.body, sourceTimestamp);
    }
    await this.semantic.flushCompleted();
  }

  /** Allocates a source-local observation coordinate and awaits metadata-first publication. */
  private async emit(
    sourceRef: string,
    fact: RuntimeFact,
    body?: Parameters<typeof emitRuntimeFact>[3],
    sourceTimestamp?: string
  ): Promise<void> {
    await this.semantic.emit(sourceRef, fact, body, sourceTimestamp);
  }
  /** Emits a bounded collector-availability fact, never a completeness assertion. */
  private coverage(
    sourceRef: string,
    family: 'primary-content' | 'child-metadata' | 'child-content',
    coverage: 'off' | 'collecting' | 'ended'
  ): Promise<void> {
    return this.emit(sourceRef, { kind: 'coverage', runtimeOriginRef: null, family, coverage });
  }
  /** Records each source/reason gap once, without raw paths or exceptions. */
  private async gap(
    sourceRef: string,
    family: 'primary-content' | 'child-metadata' | 'child-content',
    reason:
      | 'source-missing'
      | 'source-changed'
      | 'version-mismatch'
      | 'malformed-frame'
      | 'partial-frame'
      | 'limit-exceeded'
      | 'collector-failed'
  ): Promise<void> {
    const key = `${sourceRef}:${family}:${reason}`;
    if (this.gaps.has(key)) return;
    this.gaps.add(key);
    await this.emit(sourceRef, {
      kind: 'coverage',
      runtimeOriginRef: null,
      family,
      coverage: 'unavailable',
      reason,
    });
  }
}
