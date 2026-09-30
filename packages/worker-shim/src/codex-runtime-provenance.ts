import { createHash, type Hash } from 'node:crypto';
import { constants, type Dir } from 'node:fs';
import {
  type FileHandle,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type WorkerLineage,
  type WorkerRuntimeNativeOriginIndexEntry,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  type WorkerRuntimeRawStreamManifest,
  WorkerRuntimeRawStreamManifestSchema,
} from '@openkit/worker-protocol';
import { runtimeToolName } from './runtime-capture.js';

const PRIMARY_STREAM_REF = 'stream-0000.jsonl';
const MAX_FRAME_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_META_BYTES = 1024 * 1024;
export const MAX_ROLLOUT_CANDIDATES = 256;
/** Existing admitted reachable stream ceiling, shared with incremental capture. */
export const MAX_CODEX_RUNTIME_STREAMS = 64;
const MAX_ROLLOUT_SCAN_ENTRIES = 2048;
const MAX_RETAINED_FRAMES = 4096;
const MAX_NATIVE_INDEX_VALUE_BYTES = 512;
const MAX_EVENT_KIND_BYTES = 128;
const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type WorkerRuntimeCaptureStatus = WorkerRuntimeRawStreamManifest['captureStatus'];
type WorkerRuntimeRawStream = WorkerRuntimeRawStreamManifest['streams'][number];

/** Options for one bounded Codex runtime provenance capture. */
export interface CodexRuntimeProvenanceCaptureOptions {
  /** Pinned Codex adapter version. */
  adapterVersion: string;
  /** Codex home containing native rollout files. */
  codexHome: string;
  /** Authoritative outer OpenKit worker lineage. */
  lineage: WorkerLineage;
  /** Maximum retained raw stream count, including the primary stream. */
  maxStreamCount: number;
  /** Maximum retained bytes across all raw streams. */
  maxTotalBytes: number;
  /** Final restricted native-origin index path. */
  nativeOriginIndexPath: string;
  /** Directory receiving synthetic raw stream files. */
  rawStreamsRoot: string;
  /** Final restricted raw-stream manifest path. */
  streamManifestPath: string;
}

/** Metadata parsed from the first frame of one Codex rollout. */
export interface RolloutCandidate {
  /** Whether native metadata reports the pinned Codex adapter version. */
  adapterVersionValid: boolean;
  /** Whether this new rollout starts with copied ancestor history before its own settings marker. */
  copiedHistory?: boolean;
  /** Initial device id used to detect path replacement. */
  initialDev: number;
  /** Initial inode used to detect path replacement. */
  initialIno: number;
  /** Initial metadata-change time used to detect path replacement. */
  initialCtimeMs: number;
  /** Initial file modification time used for stability checks. */
  initialMtimeMs: number;
  /** Initial file size used for stability checks. */
  initialSize: number;
  /** Native parent thread id, when this is a child rollout. */
  parentThreadId?: string;
  /** Rollout file path. */
  path: string;
  /** Native runtime depth. */
  runtimeDepth?: number;
  /** Native runtime nickname. */
  runtimeNickname?: string;
  /** Native runtime role. */
  runtimeRole?: string;
  /** Native session id. */
  sessionId: string;
  /** Native thread id. */
  threadId: string;
  /** Whether duplicated parent fields disagreed. */
  valid: boolean;
}

/** Exact native-conversation proof retained only by the AgentSession adapter. */
export interface CodexNativeConversationProof {
  /** Lowercase SHA-256 digest safe for private Harness results. */
  readonly nativeHandleDigest: string;
  /** Raw Codex UUID restricted to the AgentSession-private adapter state. */
  readonly nativeHandle: string;
}

/**
 * Proves one exact Codex `thread.started` UUID against its pinned root rollout metadata.
 *
 * @param options Pinned adapter version, private Codex home, and exact exec JSONL bytes.
 * @returns Restricted raw handle plus its result-safe digest.
 */
export async function proveCodexNativeConversation(options: {
  readonly adapterVersion: string;
  readonly codexHome: string;
  readonly stdout: Uint8Array;
}): Promise<CodexNativeConversationProof> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(options.stdout);
  const started: string[] = [];
  for (const line of text.split('\n')) {
    if (!line) {
      continue;
    }
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Codex exec emitted a malformed JSONL event.');
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'thread.started') {
      const threadId = record.thread_id;
      if (typeof threadId !== 'string' || !CODEX_THREAD_ID_PATTERN.test(threadId)) {
        throw new Error('Codex exec emitted an invalid thread.started identity.');
      }
      started.push(threadId);
    }
  }
  if (started.length !== 1) {
    throw new Error('Codex exec must emit exactly one thread.started identity.');
  }

  const nativeHandle = started[0] as string;
  const discovered = await listRolloutFiles(join(options.codexHome, 'sessions'));
  if (discovered.truncated) {
    throw new Error('Codex rollout discovery exceeded its fixed proof bound.');
  }
  const matches: RolloutCandidate[] = [];
  for (const path of discovered.paths) {
    const candidate = await readRolloutCandidate(path, options.adapterVersion);
    if (candidate?.threadId === nativeHandle) {
      matches.push(candidate);
    }
  }
  const candidate = matches[0];
  if (
    matches.length !== 1 ||
    !candidate ||
    !candidate.adapterVersionValid ||
    !candidate.valid ||
    candidate.parentThreadId ||
    candidate.sessionId !== nativeHandle
  ) {
    throw new Error('Codex root rollout does not prove the exact native conversation.');
  }
  return {
    nativeHandle,
    nativeHandleDigest: createHash('sha256').update(nativeHandle).digest('hex'),
  };
}

/** Mutable attribution inherited by physical frames within one raw stream. */
export interface StreamOriginContext {
  /** Copied ancestor content is not newly observed work under this Turn's capture setting. */
  inheritedHistory?: boolean;
  /** Native parent thread id. */
  parentThreadId?: string;
  /** Native runtime depth. */
  runtimeDepth?: number;
  /** Native runtime nickname. */
  runtimeNickname?: string;
  /** Native runtime role. */
  runtimeRole?: string;
  /** Native session id. */
  sessionId?: string;
  /** Native thread id. */
  threadId?: string;
  /** Current native turn id. */
  turnId?: string;
}

/** Parsed product-neutral fields used to build one restricted index entry. */
export interface ParsedFrame {
  /** False while a child file carries copied ancestor history rather than current work. */
  contentEligible?: boolean;
  /** Decoded native record used only by the allowlisted runtime content projector. */
  value?: Record<string, unknown>;
  /** Runtime-native event kind. */
  eventKind: string;
  /** Parse outcome for the retained bytes. */
  parseStatus: WorkerRuntimeNativeOriginIndexEntry['parseStatus'];
  /** Origin fields known at this frame. */
  origin: StreamOriginContext;
}

/** Final metadata for one retained raw stream. */
interface CompletedRawStream {
  /** Protocol manifest row. */
  manifest: WorkerRuntimeRawStream;
}

/**
 * Streams Codex exec JSONL and its reachable rollout forest into restricted provenance files.
 */
export class CodexRuntimeProvenanceCapture {
  private readonly options: CodexRuntimeProvenanceCaptureOptions;

  private indexHandle: FileHandle | null = null;

  private indexChunks: Buffer[] = [];

  private indexChunkBytes = 0;

  private primary: RawStreamCapture | null = null;

  private initialized = false;

  private finalized = false;

  private retainedBytes = 0;

  private retainedFrames = 0;

  private captureStatus: WorkerRuntimeCaptureStatus = 'complete';

  private primaryThreadId: string | undefined;

  private primarySessionId: string | undefined;

  private readonly streams: WorkerRuntimeRawStream[] = [];

  private readonly spawnEdges = new Map<string, string[]>();

  /**
   * Creates an uninitialized capture; files are opened lazily on first use.
   *
   * @param options Capture paths, limits, version, and authoritative lineage.
   */
  public constructor(options: CodexRuntimeProvenanceCaptureOptions) {
    this.options = options;
  }

  /**
   * Retains one primary stdout chunk while honoring the global byte limit.
   *
   * @param chunk Exact process stdout bytes.
   */
  public async writePrimaryChunk(chunk: Uint8Array): Promise<void> {
    this.assertOpen();
    await this.initialize();
    const primary = this.requirePrimary();
    const retained = this.limitChunk(chunk);

    let written = 0;
    if (retained.byteLength > 0) {
      written = await primary.write(retained);
      this.retainedBytes -= retained.byteLength - written;
    }
    if (written !== chunk.byteLength) {
      primary.markTruncated();
      this.raiseStatus('truncated');
    }
  }

  /**
   * Closes the primary stream, copies the reachable stable rollout forest, and atomically commits the index and manifest.
   */
  public async finalize(): Promise<void> {
    if (this.finalized) {
      return;
    }
    await this.initialize();
    this.finalized = true;
    const primary = this.requirePrimary();

    await primary.finish();
    const primaryManifest = primary.completed().manifest;
    this.raiseStatus(primaryManifest.captureStatus);
    this.streams.push(primaryManifest);
    if (!this.primaryThreadId) {
      this.raiseStatus('failed');
    } else {
      await this.collectReachableRollouts(this.primaryThreadId);
    }
    await this.commitIndexAndManifest();
  }

  /**
   * Invalidates the manifest commit marker after a process-supervision failure.
   *
   * In-flight output may leave uncommitted restricted files, but consumers cannot treat them as a capture.
   */
  public async invalidate(): Promise<void> {
    this.finalized = true;
    await rm(this.options.streamManifestPath, { force: true });
    await rm(`${this.options.streamManifestPath}.tmp`, { force: true });
  }

  /** Ensures callers cannot write after the capture commit marker exists. */
  private assertOpen(): void {
    if (this.finalized) {
      throw new Error('Codex runtime provenance capture is already finalized.');
    }
  }

  /** Lazily creates the raw directory, temporary index, and primary stream. */
  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (
      Object.values(this.options.lineage).some(
        (value) =>
          typeof value === 'string' &&
          Buffer.byteLength(value, 'utf8') > MAX_NATIVE_INDEX_VALUE_BYTES
      ) ||
      Buffer.byteLength(this.options.adapterVersion, 'utf8') > MAX_EVENT_KIND_BYTES
    ) {
      throw new Error('Codex runtime provenance lineage or adapter version exceeds safe limits.');
    }
    this.initialized = true;
    await rm(this.options.streamManifestPath, { force: true });
    await rm(`${this.options.streamManifestPath}.tmp`, { force: true });
    await rm(this.options.rawStreamsRoot, { force: true, recursive: true });
    await rm(this.options.nativeOriginIndexPath, { force: true });
    await rm(this.temporaryIndexPath(), { force: true });
    await mkdir(this.options.rawStreamsRoot, { recursive: true });
    await mkdir(dirname(this.options.nativeOriginIndexPath), { recursive: true });
    await mkdir(dirname(this.options.streamManifestPath), { recursive: true });
    this.indexHandle = await open(this.temporaryIndexPath(), 'w');
    this.primary = await RawStreamCapture.create({
      onFrame: async (frame, coordinates) => {
        const parsed = this.parsePrimaryFrame(frame.bytes, frame.truncated);
        await this.writeIndexEntry(PRIMARY_STREAM_REF, coordinates, frame.sha256, parsed);
      },
      canStartFrame: (completedFramesAhead = 0) =>
        this.retainedFrames + completedFramesAhead < MAX_RETAINED_FRAMES,
      path: join(this.options.rawStreamsRoot, PRIMARY_STREAM_REF),
      sourceKind: 'primary',
      streamRef: PRIMARY_STREAM_REF,
    });
  }

  /** Returns the initialized primary stream or reports an internal lifecycle error. */
  private requirePrimary(): RawStreamCapture {
    if (!this.primary) {
      throw new Error('Codex runtime provenance primary stream is not initialized.');
    }

    return this.primary;
  }

  /** Restricts one chunk to the remaining global raw byte budget. */
  private limitChunk(chunk: Uint8Array): Uint8Array {
    const remaining = Math.max(0, this.options.maxTotalBytes - this.retainedBytes);
    const retained = chunk.subarray(0, remaining);
    this.retainedBytes += retained.byteLength;
    return retained;
  }

  /** Parses one primary exec frame and updates native root/spawn state. */
  private parsePrimaryFrame(bytes: Uint8Array, truncated: boolean): ParsedFrame {
    const context = this.primaryOrigin();
    const parsed = parseCodexPrimaryFrame(
      bytes,
      truncated,
      context,
      (sender, receiver) => this.recordSpawnEdge(sender, receiver),
      (status) => this.raiseStatus(status)
    );
    this.primaryThreadId = context.threadId;
    return parsed;
  }

  /** Returns the attribution currently known for primary exec frames. */
  private primaryOrigin(): StreamOriginContext {
    return {
      ...(this.primarySessionId ? { sessionId: this.primarySessionId } : {}),
      ...(this.primaryThreadId ? { threadId: this.primaryThreadId } : {}),
    };
  }

  /** Adds one stable ordered native spawn edge without duplicating receivers. */
  private recordSpawnEdge(sender: string, receiver: string): void {
    const receivers = this.spawnEdges.get(sender) ?? [];
    if (!receivers.includes(receiver)) {
      receivers.push(receiver);
      this.spawnEdges.set(sender, receivers);
    }
  }

  /** Discovers candidate rollouts and copies only the forest reachable from the root. */
  private async collectReachableRollouts(rootThreadId: string): Promise<void> {
    const candidates = await this.discoverRolloutCandidates();
    const rootCandidate = candidates.byThread.get(rootThreadId);
    if (!rootCandidate) {
      this.raiseStatus('failed');
      return;
    }
    if (rootCandidate.parentThreadId) {
      this.raiseStatus('unstable');
    }
    this.primarySessionId = rootCandidate.sessionId;
    const queue = [rootThreadId];
    const queued = new Set(queue);
    const expectedParents = new Map<string, string>();

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const threadId = queue[cursor];
      if (!threadId) {
        continue;
      }
      const candidate = candidates.byThread.get(threadId);
      if (!candidate) {
        this.raiseStatus('unstable');
        continue;
      }
      const expectedParent = expectedParents.get(threadId);
      if (
        (expectedParent && candidate.parentThreadId !== expectedParent) ||
        candidate.sessionId !== this.primarySessionId
      ) {
        this.raiseStatus('unstable');
      }
      if (this.streams.length >= this.options.maxStreamCount) {
        this.raiseStatus('truncated');
        break;
      }
      await this.copyRollout(candidate);
      const children = [
        ...(this.spawnEdges.get(threadId) ?? []),
        ...(candidates.children.get(threadId) ?? []).sort((left, right) =>
          left.localeCompare(right)
        ),
      ];
      for (const child of children) {
        if (!queued.has(child)) {
          queued.add(child);
          expectedParents.set(child, threadId);
          queue.push(child);
        } else if (expectedParents.get(child) && expectedParents.get(child) !== threadId) {
          this.raiseStatus('unstable');
        }
      }
    }
  }

  /** Enumerates bounded first-line rollout metadata beneath the standard Codex sessions tree. */
  private async discoverRolloutCandidates(): Promise<{
    byThread: Map<string, RolloutCandidate>;
    children: Map<string, string[]>;
  }> {
    const byThread = new Map<string, RolloutCandidate>();
    const children = new Map<string, string[]>();
    const root = join(this.options.codexHome, 'sessions');
    const discovered = await listRolloutFiles(root);
    if (discovered.truncated) {
      this.raiseStatus('truncated');
    }

    for (const path of discovered.paths) {
      const candidate = await readRolloutCandidate(path, this.options.adapterVersion);
      if (!candidate) {
        continue;
      }
      if (byThread.has(candidate.threadId)) {
        this.raiseStatus('unstable');
        continue;
      }
      byThread.set(candidate.threadId, candidate);
      if (!candidate.adapterVersionValid) {
        this.raiseStatus('failed');
      } else if (!candidate.valid) {
        this.raiseStatus('unstable');
      }
      if (candidate.parentThreadId) {
        const siblings = children.get(candidate.parentThreadId) ?? [];
        siblings.push(candidate.threadId);
        children.set(candidate.parentThreadId, siblings);
      }
    }

    return { byThread, children };
  }

  /** Copies, indexes, and stability-checks one reachable rollout file. */
  private async copyRollout(candidate: RolloutCandidate): Promise<void> {
    const before = await stat(candidate.path);
    const streamRef = `stream-${String(this.streams.length).padStart(4, '0')}.jsonl`;
    const context: StreamOriginContext = {
      ...(candidate.parentThreadId ? { parentThreadId: candidate.parentThreadId } : {}),
      ...(candidate.runtimeDepth === undefined ? {} : { runtimeDepth: candidate.runtimeDepth }),
      ...(candidate.runtimeNickname ? { runtimeNickname: candidate.runtimeNickname } : {}),
      ...(candidate.runtimeRole ? { runtimeRole: candidate.runtimeRole } : {}),
      sessionId: candidate.sessionId,
      threadId: candidate.threadId,
    };
    const stream = await RawStreamCapture.create({
      onFrame: async (frame, coordinates) => {
        const parsed = this.parseRolloutFrame(frame.bytes, frame.truncated, context);
        await this.writeIndexEntry(streamRef, coordinates, frame.sha256, parsed);
      },
      canStartFrame: (completedFramesAhead = 0) =>
        this.retainedFrames + completedFramesAhead < MAX_RETAINED_FRAMES,
      path: join(this.options.rawStreamsRoot, streamRef),
      sourceKind: 'runtime-thread',
      streamRef,
    });
    const sourceHandle = await open(candidate.path, 'r');
    let after = before;
    let currentPath = before;
    try {
      const opened = await sourceHandle.stat();
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < opened.size) {
        const { bytesRead } = await sourceHandle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, opened.size - position),
          position
        );
        if (bytesRead === 0) {
          break;
        }
        const bytes = buffer.subarray(0, bytesRead);
        const retained = this.limitChunk(bytes);
        let written = 0;
        if (retained.byteLength > 0) {
          written = await stream.write(retained);
          this.retainedBytes -= retained.byteLength - written;
        }
        if (written !== bytes.byteLength) {
          stream.markTruncated();
          this.raiseStatus('truncated');
          break;
        }
        position += bytesRead;
      }
      after = await sourceHandle.stat();
      currentPath = await stat(candidate.path);
    } finally {
      await sourceHandle.close();
    }
    await stream.finish();
    if (
      candidate.initialDev !== before.dev ||
      candidate.initialIno !== before.ino ||
      candidate.initialCtimeMs !== before.ctimeMs ||
      candidate.initialSize !== before.size ||
      candidate.initialMtimeMs !== before.mtimeMs ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.dev !== currentPath.dev ||
      after.ino !== currentPath.ino ||
      after.ctimeMs !== currentPath.ctimeMs ||
      after.size !== currentPath.size ||
      after.mtimeMs !== currentPath.mtimeMs
    ) {
      stream.markUnstable();
      this.raiseStatus('unstable');
    }
    const manifest = stream.completed().manifest;
    this.raiseStatus(manifest.captureStatus);
    this.streams.push(manifest);
  }

  /** Parses one rollout frame and updates inherited origin and native spawn state. */
  private parseRolloutFrame(
    bytes: Uint8Array,
    truncated: boolean,
    context: StreamOriginContext
  ): ParsedFrame {
    return parseCodexRolloutFrame(
      bytes,
      truncated,
      context,
      (sender, receiver) => this.recordSpawnEdge(sender, receiver),
      (status) => this.raiseStatus(status)
    );
  }

  /** Writes one protocol-validated native-origin JSONL entry. */
  private async writeIndexEntry(
    streamRef: string,
    coordinates: FrameCoordinates,
    frameSha256: string,
    parsed: ParsedFrame
  ): Promise<void> {
    if (!this.indexHandle) {
      throw new Error('Codex runtime provenance index is not initialized.');
    }
    const entry = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
      adapterVersion: this.options.adapterVersion,
      byteLength: coordinates.byteLength,
      byteOffset: coordinates.byteOffset,
      eventKind: parsed.eventKind,
      frameSequence: coordinates.frameSequence,
      frameSha256,
      lineage: this.options.lineage,
      ...(parsed.origin.parentThreadId
        ? { parentNativeThreadId: parsed.origin.parentThreadId }
        : {}),
      ...(parsed.origin.runtimeDepth === undefined
        ? {}
        : { runtimeDepth: parsed.origin.runtimeDepth }),
      ...(parsed.origin.runtimeNickname ? { runtimeNickname: parsed.origin.runtimeNickname } : {}),
      ...(parsed.origin.runtimeRole ? { runtimeRole: parsed.origin.runtimeRole } : {}),
      ...(parsed.origin.sessionId ? { nativeSessionId: parsed.origin.sessionId } : {}),
      ...(parsed.origin.threadId ? { nativeThreadId: parsed.origin.threadId } : {}),
      ...(parsed.origin.turnId ? { nativeTurnId: parsed.origin.turnId } : {}),
      parseStatus: parsed.parseStatus,
      runtimeFamily: 'codex',
      schemaVersion: 1,
      streamRef,
    });
    const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
    this.indexChunks.push(bytes);
    this.indexChunkBytes += bytes.byteLength;
    this.retainedFrames += 1;
    if (this.indexChunkBytes >= 64 * 1024) await this.flushIndex();
  }

  /** Batches bounded validated entries; only the manifest makes the completed index observable. */
  private async flushIndex(): Promise<void> {
    if (!this.indexHandle) throw new Error('Codex runtime provenance index is not initialized.');
    if (this.indexChunkBytes === 0) return;
    await writeAll(this.indexHandle, Buffer.concat(this.indexChunks, this.indexChunkBytes));
    this.indexChunks = [];
    this.indexChunkBytes = 0;
  }

  /** Atomically publishes the index first and the manifest commit marker last. */
  private async commitIndexAndManifest(): Promise<void> {
    if (!this.indexHandle) {
      throw new Error('Codex runtime provenance index is not initialized.');
    }
    await this.flushIndex();
    await this.indexHandle.close();
    this.indexHandle = null;
    await rename(this.temporaryIndexPath(), this.options.nativeOriginIndexPath);
    const manifest = WorkerRuntimeRawStreamManifestSchema.parse({
      adapterVersion: this.options.adapterVersion,
      captureStatus: this.captureStatus,
      lineage: this.options.lineage,
      primaryStreamRef: PRIMARY_STREAM_REF,
      runtimeFamily: 'codex',
      schemaVersion: 1,
      streams: this.streams,
    });
    const temporaryManifestPath = `${this.options.streamManifestPath}.tmp`;
    await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporaryManifestPath, this.options.streamManifestPath);
  }

  /** Raises the overall capture state without allowing a weaker state to overwrite it. */
  private raiseStatus(status: WorkerRuntimeCaptureStatus): void {
    if (captureStatusRank(status) > captureStatusRank(this.captureStatus)) {
      this.captureStatus = status;
    }
  }

  /** Returns the temporary native-origin index path. */
  private temporaryIndexPath(): string {
    return `${this.options.nativeOriginIndexPath}.tmp`;
  }
}

/** Interprets pinned primary structure for both provenance and incremental collection. */
export function parseCodexPrimaryFrame(
  bytes: Uint8Array,
  truncated: boolean,
  context: StreamOriginContext,
  spawn: (sender: string, receiver: string) => void,
  status: (value: WorkerRuntimeCaptureStatus) => void
): ParsedFrame {
  const parsed = parseJsonFrame(bytes, truncated);
  if (!parsed.value)
    return { eventKind: parsed.eventKind, origin: { ...context }, parseStatus: parsed.status };
  const value = parsed.value;
  const rawType = stringField(value, 'type');
  const type = boundedRuntimeValue(rawType, MAX_EVENT_KIND_BYTES);
  let valid = rawType === undefined || type !== undefined;
  if (type === 'thread.started') {
    const id = boundedRuntimeValue(stringField(value, 'thread_id'));
    if (!id) valid = false;
    else if (context.threadId && context.threadId !== id) {
      valid = false;
      status('unstable');
    } else context.threadId = id;
  }
  const item = objectField(value, 'item');
  if (
    item?.type === 'collab_tool_call' &&
    (stringArrayField(item, 'receiver_thread_ids').length > MAX_CODEX_RUNTIME_STREAMS ||
      Object.keys(objectField(item, 'agents_states') ?? {}).length > MAX_CODEX_RUNTIME_STREAMS)
  )
    valid = false;
  const rawSender = item ? stringField(item, 'sender_thread_id') : undefined;
  const sender = boundedRuntimeValue(rawSender);
  if (rawSender && !sender) valid = false;
  if (item?.type === 'collab_tool_call' && item.tool === 'spawn_agent' && sender) {
    for (const rawReceiver of stringArrayField(item, 'receiver_thread_ids')) {
      const receiver = boundedRuntimeValue(rawReceiver);
      if (receiver) spawn(sender, receiver);
      else valid = false;
    }
  }
  if (!valid) status('failed');
  return {
    eventKind: type ?? 'unattributed',
    origin: { ...context, ...(sender ? { threadId: sender } : {}) },
    parseStatus: valid ? parsed.status : 'unattributed',
    ...(valid ? { value } : {}),
  };
}

/** Interprets pinned rollout structure for both provenance and incremental collection. */
export function parseCodexRolloutFrame(
  bytes: Uint8Array,
  truncated: boolean,
  context: StreamOriginContext,
  spawn: (sender: string, receiver: string) => void,
  status: (value: WorkerRuntimeCaptureStatus) => void
): ParsedFrame {
  const parsed = parseJsonFrame(bytes, truncated);
  if (!parsed.value)
    return { eventKind: parsed.eventKind, origin: { ...context }, parseStatus: parsed.status };
  const value = parsed.value;
  const rawType = stringField(value, 'type');
  const type = boundedRuntimeValue(rawType, MAX_EVENT_KIND_BYTES);
  let valid = rawType === undefined || type !== undefined;
  const payload = objectField(value, 'payload');
  if (type === 'session_meta' && payload && stringField(payload, 'id') !== context.threadId)
    context.inheritedHistory = true;
  if (
    type === 'event_msg' &&
    payload?.type === 'thread_settings_applied' &&
    payload.thread_id === context.threadId
  )
    context.inheritedHistory = false;
  if (type === 'turn_context' && payload) {
    const rawId = stringField(payload, 'turn_id');
    const id = boundedRuntimeValue(rawId);
    if (rawId && !id) valid = false;
    if (id) context.turnId = id;
  }
  const rawNested = type === 'event_msg' && payload ? stringField(payload, 'type') : undefined;
  const nested = boundedRuntimeValue(rawNested, MAX_EVENT_KIND_BYTES);
  if (rawNested && !nested) valid = false;
  if (nested === 'collab_agent_spawn_end' && payload) {
    const sender = boundedRuntimeValue(stringField(payload, 'sender_thread_id'));
    const receiver = boundedRuntimeValue(stringField(payload, 'new_thread_id'));
    if (sender && receiver) spawn(sender, receiver);
    else valid = false;
  }
  if (!valid) status('failed');
  return {
    eventKind: nested ?? type ?? 'unattributed',
    origin: { ...context },
    contentEligible: !context.inheritedHistory,
    parseStatus: valid ? parsed.status : 'unattributed',
    ...(valid ? { value } : {}),
  };
}

/** One admitted native activity, still private until opaque identity projection. */
export interface CodexActivity {
  /** Semantic source kind. */
  kind: 'origin' | 'tool' | 'assistant';
  /** Native thread that reported or owns the activity. */
  threadId?: string | undefined;
  /** Explicit native parent evidence, never a send/wait receiver. */
  parentThreadId?: string;
  /** Source-reported phase, not an OpenKit lifecycle. */
  phase:
    | 'observed'
    | 'started'
    | 'updated'
    | 'running'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'closed'
    | 'unknown';
  /** Native call or message correlation scoped to its source. */
  key?: string | undefined;
  /** Validated tool identifier. */
  toolName?: string;
  /** Native command exit code when present. */
  exitCode?: number;
  /** Exact admitted semantic content, excluding the surrounding native record. */
  body?: { bytes: Uint8Array; mediaType: 'text/plain' | 'application/json'; boundary: string };
}

/** Positive-selects outward text and tool fields; never serializes a whole native frame. */
export function codexFrameActivities(frame: ParsedFrame): CodexActivity[] {
  const value = frame.value;
  if (!value || frame.parseStatus !== 'parsed' || frame.contentEligible === false) return [];
  const threadId = frame.origin.threadId;
  const activities: CodexActivity[] = [];
  const text = (value: string, boundary: string): NonNullable<CodexActivity['body']> => ({
    bytes: Buffer.from(value),
    mediaType: 'text/plain',
    boundary,
  });
  const json = (value: unknown, boundary: string): NonNullable<CodexActivity['body']> => ({
    bytes: Buffer.from(JSON.stringify(value)),
    mediaType: 'application/json',
    boundary,
  });
  const phase = (status: unknown): CodexActivity['phase'] =>
    status === 'completed'
      ? 'completed'
      : status === 'failed' || status === 'errored' || status === 'declined'
        ? 'failed'
        : status === 'running'
          ? 'running'
          : status === 'interrupted'
            ? 'interrupted'
            : status === 'shutdown'
              ? 'closed'
              : status === 'in_progress' || status === 'pending_init'
                ? 'started'
                : 'unknown';
  if (value.type === 'thread.started')
    activities.push({ kind: 'origin', threadId, phase: 'observed' });
  const item = objectField(value, 'item');
  if (
    item &&
    typeof value.type === 'string' &&
    /^item\.(started|updated|completed)$/.test(value.type)
  ) {
    const key = boundedRuntimeValue(stringField(item, 'id'));
    const itemPhase =
      value.type === 'item.started'
        ? 'started'
        : value.type === 'item.updated'
          ? 'updated'
          : phase(item.status ?? 'completed');
    if (item.type === 'agent_message' && typeof item.text === 'string')
      activities.push({
        kind: 'assistant',
        threadId,
        key,
        phase: itemPhase,
        body: text(item.text, 'runtime.assistant.text'),
      });
    const toolName =
      item.type === 'command_execution'
        ? 'shell'
        : item.type === 'file_change'
          ? 'apply_patch'
          : runtimeToolName(item.tool);
    if (
      toolName &&
      ['command_execution', 'mcp_tool_call', 'collab_tool_call', 'file_change'].includes(
        String(item.type)
      )
    ) {
      const base: CodexActivity = {
        kind: 'tool',
        threadId,
        key,
        toolName,
        phase: itemPhase,
        ...(Number.isInteger(item.exit_code) ? { exitCode: item.exit_code as number } : {}),
      };
      activities.push({
        ...base,
        ...(typeof item.command === 'string'
          ? { body: text(item.command, 'runtime.tool.arguments') }
          : item.arguments !== undefined
            ? { body: json(item.arguments, 'runtime.tool.arguments') }
            : typeof item.prompt === 'string'
              ? { body: text(item.prompt, 'runtime.tool.arguments') }
              : {}),
      });
      if (typeof item.aggregated_output === 'string' && value.type !== 'item.started')
        activities.push({ ...base, body: text(item.aggregated_output, 'runtime.tool.result') });
      if (item.result !== null && item.result !== undefined)
        activities.push({ ...base, body: json(item.result, 'runtime.tool.result') });
      if (item.error !== null && item.error !== undefined)
        activities.push({ ...base, body: json(item.error, 'runtime.tool.result') });
      if (item.type === 'file_change' && Array.isArray(item.changes))
        activities.push({ ...base, body: json(item.changes, 'runtime.tool.result') });
    }
    if (item.type === 'collab_tool_call') {
      const sender = boundedRuntimeValue(stringField(item, 'sender_thread_id'));
      if (item.tool === 'spawn_agent' && sender)
        for (const receiver of stringArrayField(item, 'receiver_thread_ids').slice(
          0,
          MAX_CODEX_RUNTIME_STREAMS
        ))
          activities.push({
            kind: 'origin',
            threadId: receiver,
            parentThreadId: sender,
            phase: 'observed',
          });
      const states = objectField(item, 'agents_states');
      if (states)
        for (const [id, state] of Object.entries(states).slice(0, MAX_CODEX_RUNTIME_STREAMS)) {
          if (!isRecord(state) || !boundedRuntimeValue(id)) continue;
          activities.push({ kind: 'origin', threadId: id, phase: phase(state.status) });
          if (typeof state.message === 'string')
            activities.push({
              kind: 'assistant',
              threadId: id,
              key: `${key}:reported:${id}`,
              phase: 'updated',
              body: text(state.message, 'runtime.assistant.reported-text'),
            });
        }
    }
  }
  const payload = objectField(value, 'payload');
  if (!payload) return activities;
  if (value.type === 'response_item') {
    const key = boundedRuntimeValue(stringField(payload, 'call_id') ?? stringField(payload, 'id'));
    if (
      payload.type === 'message' &&
      payload.role === 'assistant' &&
      (payload.channel === undefined ||
        payload.channel === 'final' ||
        payload.channel === 'commentary') &&
      Array.isArray(payload.content)
    ) {
      for (const part of payload.content)
        if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string')
          activities.push({
            kind: 'assistant',
            threadId,
            key,
            phase: 'completed',
            body: text(part.text, 'runtime.assistant.text'),
          });
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const toolName = runtimeToolName(payload.name);
      const argumentsValue = payload.type === 'function_call' ? payload.arguments : payload.input;
      if (toolName && typeof argumentsValue === 'string')
        activities.push({
          kind: 'tool',
          threadId,
          key,
          toolName,
          phase: 'started',
          body: text(argumentsValue, 'runtime.tool.arguments'),
        });
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      activities.push({
        kind: 'tool',
        threadId,
        key,
        phase: 'completed',
        ...(typeof payload.output === 'string'
          ? { body: text(payload.output, 'runtime.tool.result') }
          : payload.output !== undefined
            ? { body: json(payload.output, 'runtime.tool.result') }
            : {}),
      });
    }
  }
  if (value.type === 'event_msg') {
    if (payload.type === 'task_started' || payload.type === 'turn_started')
      activities.push({ kind: 'origin', threadId, phase: 'running' });
    if (payload.type === 'turn_aborted')
      activities.push({ kind: 'origin', threadId, phase: 'interrupted' });
    // A completed native turn is not proof that a reusable child thread has closed.
    if (payload.type === 'agent_message' && typeof payload.message === 'string')
      activities.push({
        kind: 'assistant',
        threadId,
        phase: 'completed',
        body: text(payload.message, 'runtime.assistant.text'),
      });
    if (payload.type === 'collab_agent_spawn_end') {
      const sender = boundedRuntimeValue(stringField(payload, 'sender_thread_id'));
      const receiver = boundedRuntimeValue(stringField(payload, 'new_thread_id'));
      if (sender && receiver)
        activities.push({
          kind: 'origin',
          threadId: receiver,
          parentThreadId: sender,
          phase: 'observed',
        });
    }
  }
  return activities;
}

/** Physical frame coordinates written into the native-origin index. */
interface FrameCoordinates {
  /** Retained frame byte length. */
  byteLength: number;
  /** Frame start offset within the raw stream. */
  byteOffset: number;
  /** Zero-based physical frame sequence. */
  frameSequence: number;
}

/** Finalized physical frame bytes and digest. */
interface FinalizedFrame {
  /** Bounded frame bytes available to the structural parser. */
  bytes: Uint8Array;
  /** Canonical frame digest over all retained physical bytes. */
  sha256: string;
  /** Whether the frame ended by truncation instead of LF. */
  truncated: boolean;
}

/** Creation options for one streamed raw file. */
interface RawStreamCaptureOptions {
  /** Checks the shared budget after the proposed completed frames, before retaining another frame. */
  canStartFrame: (completedFramesAhead?: number) => boolean;
  /** Frame callback used to append index entries. */
  onFrame: (frame: FinalizedFrame, coordinates: FrameCoordinates) => Promise<void>;
  /** Synthetic raw file path. */
  path: string;
  /** Manifest source kind. */
  sourceKind: WorkerRuntimeRawStream['sourceKind'];
  /** Synthetic stream reference. */
  streamRef: string;
}

/** Incremental byte-preserving raw file and physical LF-frame writer. */
class RawStreamCapture {
  private readonly options: RawStreamCaptureOptions;

  private readonly handle: FileHandle;

  private readonly streamHash = createHash('sha256');

  private frameHash: Hash = createHash('sha256');

  private framePreview: Buffer[] = [];

  private framePreviewBytes = 0;

  private frameBytes = 0;

  private bytes = 0;

  private indexedBytes = 0;

  private frameSequence = 0;

  private status: WorkerRuntimeCaptureStatus = 'complete';

  private stableTerminal = true;

  private finished = false;

  /** Creates one raw stream around an already opened file handle. */
  private constructor(options: RawStreamCaptureOptions, handle: FileHandle) {
    this.options = options;
    this.handle = handle;
  }

  /**
   * Opens one raw stream file.
   *
   * @param options Stream path, identity, and frame callback.
   * @returns Open stream capture.
   */
  public static async create(options: RawStreamCaptureOptions): Promise<RawStreamCapture> {
    await mkdir(dirname(options.path), { recursive: true });
    return new RawStreamCapture(options, await open(options.path, 'w'));
  }

  /**
   * Writes the capped raw prefix before indexing its LF-terminated physical frames.
   *
   * @param chunk Retained raw bytes.
   * @returns Number of input bytes retained before any global frame cap.
   */
  public async write(chunk: Uint8Array): Promise<number> {
    if (this.finished) {
      throw new Error(`Runtime stream ${this.options.streamRef} is already finished.`);
    }
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let retainedEnd = 0;
    let completedFramesAhead = 0;
    let startingFrame = this.frameBytes === 0;
    // Plan the capped prefix without publishing frame accounting before its physical write.
    while (retainedEnd < bytes.byteLength) {
      if (startingFrame && !this.options.canStartFrame(completedFramesAhead)) {
        this.markTruncated();
        break;
      }
      const newline = bytes.indexOf(0x0a, retainedEnd);
      retainedEnd = newline === -1 ? bytes.byteLength : newline + 1;
      if (newline !== -1) {
        completedFramesAhead += 1;
        startingFrame = true;
      }
    }
    const retained = bytes.subarray(0, retainedEnd);
    await writeAll(this.handle, retained);
    let cursor = 0;

    while (cursor < retained.byteLength) {
      const newline = retained.indexOf(0x0a, cursor);
      const end = newline === -1 ? retained.byteLength : newline + 1;
      const segment = retained.subarray(cursor, end);
      this.streamHash.update(segment);
      this.bytes += segment.byteLength;
      this.appendFrameSegment(segment);
      cursor = end;
      if (newline !== -1) {
        await this.emitFrame(false);
      }
    }

    return cursor;
  }

  /** Marks this stream as bounded and incomplete. */
  public markTruncated(): void {
    this.status = 'truncated';
    this.stableTerminal = false;
  }

  /** Marks this stream as changing during collection. */
  public markUnstable(): void {
    this.status = 'unstable';
    this.stableTerminal = false;
  }

  /** Closes the file after indexing a final non-LF partial frame as truncated. */
  public async finish(): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (this.frameBytes > 0) {
      this.markTruncated();
      await this.emitFrame(true);
    }
    await this.handle.close();
  }

  /** Returns the final protocol manifest row after the stream is closed. */
  public completed(): CompletedRawStream {
    if (!this.finished) {
      throw new Error(`Runtime stream ${this.options.streamRef} is not finished.`);
    }
    return {
      manifest: {
        bytes: this.bytes,
        captureStatus: this.status,
        frameCount: this.frameSequence,
        sha256: `sha256:${this.streamHash.digest('hex')}`,
        sourceKind: this.options.sourceKind,
        stableTerminal: this.stableTerminal,
        streamRef: this.options.streamRef,
      },
    };
  }

  /** Adds one physical segment to the current frame hash and bounded parse preview. */
  private appendFrameSegment(segment: Uint8Array): void {
    this.frameHash.update(segment);
    this.frameBytes += segment.byteLength;
    const remaining = MAX_FRAME_PREVIEW_BYTES - this.framePreviewBytes;
    if (remaining > 0) {
      const retained = Buffer.from(segment).subarray(0, remaining);
      this.framePreview.push(retained);
      this.framePreviewBytes += retained.byteLength;
    }
  }

  /** Emits one completed frame and resets the incremental frame state. */
  private async emitFrame(truncated: boolean): Promise<void> {
    const byteLength = this.frameBytes;
    const byteOffset = this.indexedBytes;
    const oversized = this.framePreviewBytes !== byteLength;
    const frame: FinalizedFrame = {
      bytes: Buffer.concat(this.framePreview),
      sha256: `sha256:${this.frameHash.digest('hex')}`,
      truncated,
    };
    await this.options.onFrame(
      oversized ? { ...frame, bytes: Buffer.from('{oversized-frame}'), truncated: false } : frame,
      { byteLength, byteOffset, frameSequence: this.frameSequence }
    );
    this.indexedBytes += byteLength;
    this.frameSequence += 1;
    this.frameHash = createHash('sha256');
    this.framePreview = [];
    this.framePreviewBytes = 0;
    this.frameBytes = 0;
  }
}

/** Parsed JSON-frame result before adapter-specific projection. */
interface JsonFrameResult {
  /** Fallback event kind for non-parsed frames. */
  eventKind: string;
  /** Protocol parse status. */
  status: WorkerRuntimeNativeOriginIndexEntry['parseStatus'];
  /** Parsed JSON object when available. */
  value: Record<string, unknown> | null;
}

/** Parses one bounded physical JSONL frame without normalizing its raw bytes. */
export function parseJsonFrame(bytes: Uint8Array, truncated: boolean): JsonFrameResult {
  if (truncated) {
    return { eventKind: 'truncated', status: 'truncated', value: null };
  }
  let end = bytes.byteLength;
  if (end > 0 && bytes[end - 1] === 0x0a) {
    end -= 1;
  }
  if (end > 0 && bytes[end - 1] === 0x0d) {
    end -= 1;
  }

  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))
    ) as unknown;
    if (!isRecord(value)) {
      return { eventKind: 'unattributed', status: 'unattributed', value: null };
    }
    return { eventKind: 'unattributed', status: 'parsed', value };
  } catch {
    return { eventKind: 'malformed', status: 'malformed', value: null };
  }
}

/** Extracts session and sub-agent origin fields from a rollout session_meta payload. */
function sessionMetadata(
  payload: Record<string, unknown>,
  adapterVersion: string
): {
  adapterVersionValid: boolean;
  origin: StreamOriginContext;
  valid: boolean;
} {
  const source = objectField(payload, 'source');
  const subagent = source ? objectField(source, 'subagent') : undefined;
  const spawn = subagent ? objectField(subagent, 'thread_spawn') : undefined;
  const rawTopParent = stringField(payload, 'parent_thread_id');
  const rawSourceParent = spawn ? stringField(spawn, 'parent_thread_id') : undefined;
  const topParent = boundedRuntimeValue(rawTopParent);
  const sourceParent = boundedRuntimeValue(rawSourceParent);
  const parentThreadId = topParent ?? sourceParent;
  const runtimeDepth = spawn ? numberField(spawn, 'depth') : undefined;
  const rawTopNickname = stringField(payload, 'agent_nickname');
  const rawSourceNickname = spawn ? stringField(spawn, 'agent_nickname') : undefined;
  const topNickname = boundedRuntimeValue(rawTopNickname);
  const sourceNickname = boundedRuntimeValue(rawSourceNickname);
  const runtimeNickname = topNickname ?? sourceNickname;
  const rawTopRole = stringField(payload, 'agent_role');
  const rawSourceRole = spawn ? stringField(spawn, 'agent_role') : undefined;
  const topRole = boundedRuntimeValue(rawTopRole);
  const sourceRole = boundedRuntimeValue(rawSourceRole);
  const runtimeRole = topRole ?? sourceRole;
  const rawSessionId = stringField(payload, 'session_id');
  const rawThreadId = stringField(payload, 'id');
  const sessionId = boundedRuntimeValue(rawSessionId);
  const threadId = boundedRuntimeValue(rawThreadId);

  return {
    adapterVersionValid: stringField(payload, 'cli_version') === adapterVersion,
    origin: {
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(runtimeDepth === undefined ? {} : { runtimeDepth }),
      ...(runtimeNickname ? { runtimeNickname } : {}),
      ...(runtimeRole ? { runtimeRole } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(threadId ? { threadId } : {}),
    },
    valid:
      rawValuesFitIndex([
        rawTopParent,
        rawSourceParent,
        rawTopNickname,
        rawSourceNickname,
        rawTopRole,
        rawSourceRole,
        rawSessionId,
        rawThreadId,
      ]) &&
      (!topParent || !sourceParent || topParent === sourceParent) &&
      (!topNickname || !sourceNickname || topNickname === sourceNickname) &&
      (!topRole || !sourceRole || topRole === sourceRole),
  };
}

/** Reads the bounded first physical line and projects one rollout candidate. */
export async function readRolloutCandidate(
  path: string,
  adapterVersion: string
): Promise<RolloutCandidate | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(metadata.size, MAX_SESSION_META_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const newline = buffer.indexOf(0x0a, 0);
    if (newline === -1 && bytesRead === MAX_SESSION_META_BYTES) {
      return null;
    }
    const end = newline === -1 ? bytesRead : newline + 1;
    const parsed = parseJsonFrame(buffer.subarray(0, end), newline === -1);
    if (!parsed.value || stringField(parsed.value, 'type') !== 'session_meta') {
      return null;
    }
    const payload = objectField(parsed.value, 'payload');
    if (!payload) {
      return null;
    }
    const projected = sessionMetadata(payload, adapterVersion);
    if (!projected.origin.sessionId || !projected.origin.threadId) {
      return null;
    }
    return {
      adapterVersionValid: projected.adapterVersionValid,
      copiedHistory: typeof payload.forked_from_id === 'string' && !payload.history_base,
      initialCtimeMs: metadata.ctimeMs,
      initialDev: metadata.dev,
      initialIno: metadata.ino,
      initialMtimeMs: metadata.mtimeMs,
      initialSize: metadata.size,
      ...(projected.origin.parentThreadId
        ? { parentThreadId: projected.origin.parentThreadId }
        : {}),
      path,
      ...(projected.origin.runtimeDepth === undefined
        ? {}
        : { runtimeDepth: projected.origin.runtimeDepth }),
      ...(projected.origin.runtimeNickname
        ? { runtimeNickname: projected.origin.runtimeNickname }
        : {}),
      ...(projected.origin.runtimeRole ? { runtimeRole: projected.origin.runtimeRole } : {}),
      sessionId: projected.origin.sessionId,
      threadId: projected.origin.threadId,
      valid: projected.valid,
    };
  } finally {
    await handle.close();
  }
}

/** Bounded rollout discovery result. */
interface RolloutFileDiscovery {
  /** Candidate rollout paths inspected by the adapter. */
  paths: string[];
  /** Whether traversal stopped at an internal candidate or directory-entry cap. */
  truncated: boolean;
}

/** Mutable state shared by bounded recursive rollout discovery. */
interface RolloutFileDiscoveryState extends RolloutFileDiscovery {
  /** Directory entries inspected across the traversal. */
  scannedEntries: number;
  /** Whether the directory-entry cap stopped traversal entirely. */
  stopped: boolean;
}

/** Recursively lists standard Codex rollout JSONL files within internal hard limits. */
export async function listRolloutFiles(root: string): Promise<RolloutFileDiscovery> {
  const state: RolloutFileDiscoveryState = {
    paths: [],
    scannedEntries: 0,
    stopped: false,
    truncated: false,
  };
  await visitRolloutDirectory(root, state);
  return {
    paths: state.paths.sort((left, right) => left.localeCompare(right)),
    truncated: state.truncated,
  };
}

/** Visits one Codex sessions directory while sharing the discovery hard limits. */
async function visitRolloutDirectory(
  root: string,
  state: RolloutFileDiscoveryState
): Promise<void> {
  if (state.stopped) {
    return;
  }
  let directory: Dir;
  try {
    directory = await opendir(root);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for await (const entry of directory) {
    state.scannedEntries += 1;
    if (state.scannedEntries > MAX_ROLLOUT_SCAN_ENTRIES) {
      state.truncated = true;
      state.stopped = true;
      return;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await visitRolloutDirectory(path, state);
    } else if (entry.isFile() && basename(path).startsWith('rollout-') && path.endsWith('.jsonl')) {
      retainBoundedRolloutCandidate(path, state);
    }
    if (state.stopped) {
      return;
    }
  }
}

/** Retains the lexically smallest bounded candidate set without materializing a directory. */
function retainBoundedRolloutCandidate(path: string, state: RolloutFileDiscoveryState): void {
  if (state.paths.length < MAX_ROLLOUT_CANDIDATES) {
    state.paths.push(path);
    return;
  }
  state.truncated = true;
  let largestIndex = 0;
  for (let index = 1; index < state.paths.length; index += 1) {
    if ((state.paths[index] ?? '').localeCompare(state.paths[largestIndex] ?? '') > 0) {
      largestIndex = index;
    }
  }
  if (path.localeCompare(state.paths[largestIndex] ?? '') < 0) {
    state.paths[largestIndex] = path;
  }
}

/** Writes an entire buffer even when the filesystem reports a partial write. */
async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten === 0) {
      throw new Error('Runtime provenance file write made no progress.');
    }
    offset += bytesWritten;
  }
}

/** Returns the ordering rank for capture-state escalation. */
function captureStatusRank(status: WorkerRuntimeCaptureStatus): number {
  return { complete: 0, truncated: 1, unstable: 2, failed: 3 }[status];
}

/** Returns a runtime-native value only when it is safe to repeat in the bounded index. */
function boundedRuntimeValue(
  value: string | undefined,
  maxBytes = MAX_NATIVE_INDEX_VALUE_BYTES
): string | undefined {
  return value !== undefined && Buffer.byteLength(value, 'utf8') <= maxBytes ? value : undefined;
}

/** Returns whether every present runtime-native value fits the index field limit. */
function rawValuesFitIndex(values: Array<string | undefined>): boolean {
  return values.every((value) => value === undefined || boundedRuntimeValue(value) !== undefined);
}

/** Returns one string field from a JSON object. */
function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

/** Returns one finite number field from a JSON object. */
function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : undefined;
}

/** Returns one nested JSON object field. */
function objectField(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  return isRecord(value[key]) ? value[key] : undefined;
}

/** Returns the string members of one array field. */
function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const candidate = value[key];
  return Array.isArray(candidate)
    ? candidate.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Checks whether a value is a non-array JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks whether an unknown error carries a Node error code. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
