import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type WorkerLineage,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  WorkerRuntimeRawStreamManifestSchema,
} from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
import { CodexRuntimeProvenanceCapture } from './codex-runtime-provenance.js';

const LINEAGE: WorkerLineage = {
  agentSessionId: 'as_provenance_1',
  packageSnapshotId: 'pkg_provenance_1',
  requestId: 'req_provenance_1',
  threadId: 'th_outer_1',
  turnId: 'turn_outer_1',
  workspaceId: 'ws_provenance_1',
};
const ROLLOUT_CANDIDATE_HARD_CAP = 256;
const RETAINED_FRAME_HARD_CAP = 4096;

describe('Codex runtime provenance capture', () => {
  it('parses the pinned Codex 0.153.4 primary and child rollout snapshots', async () => {
    const fixture = provenanceFixture();
    const primary = readFileSync(snapshotUrl('exec-primary.jsonl'));
    installRolloutBytes(
      fixture.codexHome,
      'root.jsonl',
      readFileSync(snapshotUrl('rollout-root.jsonl'))
    );
    installRolloutBytes(
      fixture.codexHome,
      'child.jsonl',
      readFileSync(snapshotUrl('rollout-child-0001.jsonl'))
    );
    const capture = new CodexRuntimeProvenanceCapture(fixture.options);

    await capture.writePrimaryChunk(primary.subarray(0, 91));
    await capture.writePrimaryChunk(primary.subarray(91));
    await capture.finalize();

    const manifest = WorkerRuntimeRawStreamManifestSchema.parse(
      readJson(fixture.streamManifestPath)
    );
    expect(manifest).toMatchObject({
      adapterVersion: '0.153.4',
      captureStatus: 'complete',
      streams: [
        expect.objectContaining({ streamRef: 'stream-0000.jsonl' }),
        expect.objectContaining({ streamRef: 'stream-0001.jsonl' }),
        expect.objectContaining({ streamRef: 'stream-0002.jsonl' }),
      ],
    });
    expect(readIndex(fixture.nativeOriginIndexPath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventKind: 'item.completed',
          nativeThreadId: '019f0000-0000-7000-8000-000000000001',
          streamRef: 'stream-0000.jsonl',
        }),
        expect.objectContaining({
          nativeSessionId: '019f0000-0000-7000-8000-000000000001',
          nativeThreadId: '019f0000-0000-7000-8000-000000000002',
          parentNativeThreadId: '019f0000-0000-7000-8000-000000000001',
          runtimeDepth: 1,
          runtimeNickname: 'Curie',
          runtimeRole: 'reviewer',
          streamRef: 'stream-0002.jsonl',
        }),
      ])
    );
  });

  it('preserves split primary bytes and indexes every physical frame', async () => {
    const fixture = provenanceFixture();
    installRollout(fixture.codexHome, 'root.jsonl', [
      sessionMeta({ sessionId: 'session-root', threadId: 'thread-root' }),
      rolloutLine('turn_context', { turn_id: 'native-turn-root' }),
    ]);
    const capture = new CodexRuntimeProvenanceCapture(fixture.options);
    const bytes = Buffer.from(
      [
        JSON.stringify({ thread_id: 'thread-root', type: 'thread.started' }),
        JSON.stringify({
          item: { text: 'split 💡', type: 'agent_message' },
          type: 'item.completed',
        }),
        '',
      ].join('\n')
    );
    const unicodeOffset = bytes.indexOf(Buffer.from('💡'));

    await capture.writePrimaryChunk(bytes.subarray(0, unicodeOffset + 1));
    await capture.writePrimaryChunk(bytes.subarray(unicodeOffset + 1, bytes.length - 1));
    await capture.writePrimaryChunk(bytes.subarray(bytes.length - 1));
    await capture.finalize();

    const primaryPath = join(fixture.rawStreamsRoot, 'stream-0000.jsonl');
    expect(readFileSync(primaryPath)).toEqual(bytes);
    const manifest = WorkerRuntimeRawStreamManifestSchema.parse(
      readJson(fixture.streamManifestPath)
    );
    expect(manifest).toMatchObject({
      adapterVersion: '0.153.4',
      captureStatus: 'complete',
      lineage: LINEAGE,
      primaryStreamRef: 'stream-0000.jsonl',
      runtimeFamily: 'codex',
      streams: [
        {
          bytes: bytes.length,
          captureStatus: 'complete',
          frameCount: 2,
          sha256: sha256(bytes),
          sourceKind: 'primary',
          stableTerminal: true,
          streamRef: 'stream-0000.jsonl',
        },
        expect.objectContaining({
          captureStatus: 'complete',
          sourceKind: 'runtime-thread',
          stableTerminal: true,
          streamRef: 'stream-0001.jsonl',
        }),
      ],
    });
    const entries = readIndex(fixture.nativeOriginIndexPath);
    expect(entries.slice(0, 2)).toEqual([
      expect.objectContaining({
        byteLength: firstFrameLength(bytes),
        byteOffset: 0,
        eventKind: 'thread.started',
        frameSequence: 0,
        nativeThreadId: 'thread-root',
        parseStatus: 'parsed',
        streamRef: 'stream-0000.jsonl',
      }),
      expect.objectContaining({
        byteLength: bytes.length - firstFrameLength(bytes),
        byteOffset: firstFrameLength(bytes),
        eventKind: 'item.completed',
        frameSequence: 1,
        nativeThreadId: 'thread-root',
        parseStatus: 'parsed',
        streamRef: 'stream-0000.jsonl',
      }),
    ]);
    expect(entries[0]?.frameSha256).toBe(sha256(bytes.subarray(0, firstFrameLength(bytes))));
  });

  it('copies only the stable rollout forest reachable from native spawn edges', async () => {
    const fixture = provenanceFixture();
    installRollout(fixture.codexHome, 'root.jsonl', [
      sessionMeta({ sessionId: 'session-root', threadId: 'thread-root' }),
      rolloutLine('turn_context', { turn_id: 'native-turn-root' }),
    ]);
    installRollout(fixture.codexHome, 'child-researcher.jsonl', [
      sessionMeta({
        depth: 1,
        nickname: 'Curie',
        parentThreadId: 'thread-root',
        role: 'researcher',
        sessionId: 'session-root',
        threadId: 'thread-child-a',
      }),
      rolloutLine('turn_context', { turn_id: 'native-turn-a' }),
    ]);
    installRollout(fixture.codexHome, 'child-reviewer.jsonl', [
      sessionMeta({
        depth: 1,
        nickname: 'Turing',
        parentThreadId: 'thread-root',
        role: 'reviewer',
        sessionId: 'session-root',
        threadId: 'thread-child-b',
      }),
      rolloutLine('turn_context', { turn_id: 'native-turn-b' }),
    ]);
    installRollout(fixture.codexHome, 'unrelated.jsonl', [
      sessionMeta({ sessionId: 'session-other', threadId: 'thread-unrelated' }),
    ]);
    const capture = new CodexRuntimeProvenanceCapture(fixture.options);

    await capture.writePrimaryChunk(
      Buffer.from(
        [
          JSON.stringify({ thread_id: 'thread-root', type: 'thread.started' }),
          JSON.stringify({
            item: {
              receiver_thread_ids: ['thread-child-b', 'thread-child-a'],
              sender_thread_id: 'thread-root',
              status: 'completed',
              tool: 'spawn_agent',
              type: 'collab_tool_call',
            },
            type: 'item.completed',
          }),
          '',
        ].join('\n')
      )
    );
    await capture.finalize();

    const manifest = WorkerRuntimeRawStreamManifestSchema.parse(
      readJson(fixture.streamManifestPath)
    );
    expect(manifest.captureStatus).toBe('complete');
    expect(manifest.streams.map((stream) => stream.streamRef)).toEqual([
      'stream-0000.jsonl',
      'stream-0001.jsonl',
      'stream-0002.jsonl',
      'stream-0003.jsonl',
    ]);
    const copiedText = manifest.streams
      .slice(1)
      .map((stream) => readFileSync(join(fixture.rawStreamsRoot, stream.streamRef), 'utf8'))
      .join('\n');
    expect(copiedText).toContain('thread-root');
    expect(copiedText).toContain('thread-child-a');
    expect(copiedText).toContain('thread-child-b');
    expect(copiedText).not.toContain('thread-unrelated');
    const childEntries = readIndex(fixture.nativeOriginIndexPath).filter(
      (entry) => entry.nativeThreadId === 'thread-child-a'
    );
    expect(childEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nativeSessionId: 'session-root',
          parentNativeThreadId: 'thread-root',
          runtimeDepth: 1,
          runtimeNickname: 'Curie',
          runtimeRole: 'researcher',
        }),
        expect.objectContaining({ nativeTurnId: 'native-turn-a' }),
      ])
    );
  });

  it('marks malformed, partial, missing, and bounded captures incomplete', async () => {
    const missingFixture = provenanceFixture();
    installRollout(missingFixture.codexHome, 'root.jsonl', [
      sessionMeta({ sessionId: 'session-root', threadId: 'thread-root' }),
    ]);
    const missingCapture = new CodexRuntimeProvenanceCapture(missingFixture.options);
    await missingCapture.writePrimaryChunk(
      Buffer.from(
        `${JSON.stringify({ thread_id: 'thread-root', type: 'thread.started' })}\n${JSON.stringify({
          item: {
            receiver_thread_ids: ['thread-missing'],
            sender_thread_id: 'thread-root',
            tool: 'spawn_agent',
            type: 'collab_tool_call',
          },
          type: 'item.completed',
        })}\n`
      )
    );
    await missingCapture.finalize();
    expect(readJson(missingFixture.streamManifestPath)).toMatchObject({
      captureStatus: 'unstable',
    });

    const boundedFixture = provenanceFixture({ maxTotalBytes: 128 });
    installRollout(boundedFixture.codexHome, 'root.jsonl', [
      sessionMeta({ sessionId: 'session-root', threadId: 'thread-root' }),
    ]);
    const boundedCapture = new CodexRuntimeProvenanceCapture(boundedFixture.options);
    const oversized = Buffer.from(
      `${JSON.stringify({ thread_id: 'thread-root', type: 'thread.started' })}\n{not-json}\n${'x'.repeat(160)}`
    );
    await boundedCapture.writePrimaryChunk(oversized);
    await boundedCapture.finalize();
    const boundedManifest = WorkerRuntimeRawStreamManifestSchema.parse(
      readJson(boundedFixture.streamManifestPath)
    );
    expect(boundedManifest.captureStatus).toBe('truncated');
    expect(boundedManifest.streams[0]).toMatchObject({
      bytes: 128,
      captureStatus: 'truncated',
      stableTerminal: false,
    });
    expect(readFileSync(join(boundedFixture.rawStreamsRoot, 'stream-0000.jsonl'))).toEqual(
      oversized.subarray(0, 128)
    );
    expect(readIndex(boundedFixture.nativeOriginIndexPath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parseStatus: 'malformed' }),
        expect.objectContaining({ parseStatus: 'truncated' }),
      ])
    );
  });

  it('publishes incomplete manifests for terminal partial frames and contradictory parentage', async () => {
    const partialFixture = provenanceFixture();
    installRollout(partialFixture.codexHome, 'root.jsonl', [
      sessionMeta({ sessionId: 'session-root', threadId: 'thread-root' }),
    ]);
    const partialCapture = new CodexRuntimeProvenanceCapture(partialFixture.options);
    await partialCapture.writePrimaryChunk(
      Buffer.from(
        `${JSON.stringify({ thread_id: 'thread-root', type: 'thread.started' })}\n{"type":"item.completed"`
      )
    );

    await expect(partialCapture.finalize()).resolves.toBeUndefined();
    expect(readJson(partialFixture.streamManifestPath)).toMatchObject({
      captureStatus: 'truncated',
      streams: expect.arrayContaining([
        expect.objectContaining({ captureStatus: 'truncated', stableTerminal: false }),
      ]),
    });

    const contradictoryFixture = provenanceFixture();
    installRollout(contradictoryFixture.codexHome, 'root.jsonl', [
      sessionMeta({ sessionId: 'session-root', threadId: 'thread-root' }),
    ]);
    installRollout(contradictoryFixture.codexHome, 'child.jsonl', [
      sessionMeta({
        depth: 1,
        parentThreadId: 'thread-other-parent',
        sessionId: 'session-other',
        threadId: 'thread-child',
      }),
    ]);
    const contradictoryCapture = new CodexRuntimeProvenanceCapture(contradictoryFixture.options);
    await contradictoryCapture.writePrimaryChunk(
      Buffer.from(
        `${JSON.stringify({ thread_id: 'thread-root', type: 'thread.started' })}\n${JSON.stringify({
          item: {
            receiver_thread_ids: ['thread-child'],
            sender_thread_id: 'thread-root',
            tool: 'spawn_agent',
            type: 'collab_tool_call',
          },
          type: 'item.completed',
        })}\n`
      )
    );
    await contradictoryCapture.finalize();

    expect(readJson(contradictoryFixture.streamManifestPath)).toMatchObject({
      captureStatus: 'unstable',
    });
  });

  it('bounds rollout candidate discovery before inspecting candidates beyond the hard cap', async () => {
    const fixture = provenanceFixture({ maxStreamCount: 2 });
    installRollout(fixture.codexHome, '000-root.jsonl', [
      sessionMeta({ sessionId: 'session-root', threadId: 'thread-root' }),
    ]);
    for (let index = 0; index < ROLLOUT_CANDIDATE_HARD_CAP - 1; index += 1) {
      installRollout(fixture.codexHome, `100-unrelated-${String(index).padStart(3, '0')}.jsonl`, [
        sessionMeta({ sessionId: `session-${index}`, threadId: `thread-${index}` }),
      ]);
    }
    installRollout(fixture.codexHome, 'zzz-conflicting-root.jsonl', [
      sessionMeta({ sessionId: 'session-conflict', threadId: 'thread-root' }),
    ]);
    const capture = new CodexRuntimeProvenanceCapture(fixture.options);

    await capture.writePrimaryChunk(primaryExec('thread-root'));
    await capture.finalize();

    expect(readJson(fixture.streamManifestPath)).toMatchObject({
      captureStatus: 'truncated',
      streams: [
        expect.objectContaining({ streamRef: 'stream-0000.jsonl' }),
        expect.objectContaining({ streamRef: 'stream-0001.jsonl' }),
      ],
    });
  });

  it('stops retaining raw bytes at the global frame hard cap and indexes every retained frame', async () => {
    const fixture = provenanceFixture({ maxStreamCount: 2 });
    installRollout(fixture.codexHome, 'root.jsonl', [
      sessionMeta({ sessionId: 'session-root', threadId: 'thread-root' }),
    ]);
    const frames = [
      JSON.stringify({ thread_id: 'thread-root', type: 'thread.started' }),
      ...Array.from({ length: RETAINED_FRAME_HARD_CAP }, () =>
        JSON.stringify({ type: 'turn.started' })
      ),
    ];
    const retainedPrimary = Buffer.from(`${frames.slice(0, RETAINED_FRAME_HARD_CAP).join('\n')}\n`);
    const capture = new CodexRuntimeProvenanceCapture(fixture.options);

    await capture.writePrimaryChunk(Buffer.from(`${frames.join('\n')}\n`));
    await capture.finalize();

    const manifest = WorkerRuntimeRawStreamManifestSchema.parse(
      readJson(fixture.streamManifestPath)
    );
    expect(['failed', 'truncated']).toContain(manifest.captureStatus);
    expect(manifest.streams[0]).toMatchObject({
      bytes: retainedPrimary.byteLength,
      captureStatus: 'truncated',
      frameCount: RETAINED_FRAME_HARD_CAP,
      stableTerminal: false,
    });
    expect(readFileSync(join(fixture.rawStreamsRoot, 'stream-0000.jsonl'))).toEqual(
      retainedPrimary
    );
    const index = readIndex(fixture.nativeOriginIndexPath);
    expect(index).toHaveLength(
      manifest.streams.reduce((total, stream) => total + stream.frameCount, 0)
    );
    for (const stream of manifest.streams) {
      const entries = index.filter((entry) => entry.streamRef === stream.streamRef);
      expect(entries).toHaveLength(stream.frameCount);
      expect(entries.map((entry) => entry.frameSequence)).toEqual(
        Array.from({ length: stream.frameCount }, (_, sequence) => sequence)
      );
    }
  });

  it('bounds inherited native identifiers and event kinds in the origin index', async () => {
    const fixture = provenanceFixture({ maxStreamCount: 1 });
    const oversizedThreadId = `thread-${'x'.repeat(4096)}`;
    const oversizedEventKind = `event-${'y'.repeat(4096)}`;
    const capture = new CodexRuntimeProvenanceCapture(fixture.options);
    const frames = [
      JSON.stringify({ thread_id: oversizedThreadId, type: 'thread.started' }),
      ...Array.from({ length: 128 }, () => JSON.stringify({ type: oversizedEventKind })),
    ];

    await capture.writePrimaryChunk(Buffer.from(`${frames.join('\n')}\n`));
    await capture.finalize();

    const manifest = WorkerRuntimeRawStreamManifestSchema.parse(
      readJson(fixture.streamManifestPath)
    );
    const indexBytes = readFileSync(fixture.nativeOriginIndexPath);
    expect(manifest.captureStatus).not.toBe('complete');
    expect(indexBytes.byteLength).toBeLessThan(128 * 1024);
    expect(indexBytes.toString('utf8')).not.toContain(oversizedThreadId);
    expect(indexBytes.toString('utf8')).not.toContain(oversizedEventKind);
  });

  it('rejects a primary rollout candidate that declares a native parent', async () => {
    const fixture = provenanceFixture();
    installRollout(fixture.codexHome, 'root.jsonl', [
      sessionMeta({
        parentThreadId: 'thread-foreign-parent',
        sessionId: 'session-root',
        threadId: 'thread-root',
      }),
    ]);
    const capture = new CodexRuntimeProvenanceCapture(fixture.options);

    await capture.writePrimaryChunk(primaryExec('thread-root'));
    await capture.finalize();

    expect(readJson(fixture.streamManifestPath)).toMatchObject({
      captureStatus: expect.not.stringMatching(/^complete$/),
    });
  });

  it('fails capture when the root rollout omits the pinned Codex CLI version', async () => {
    const fixture = provenanceFixture();
    installRollout(fixture.codexHome, 'root.jsonl', [
      sessionMeta({ cliVersion: null, sessionId: 'session-root', threadId: 'thread-root' }),
    ]);
    const capture = new CodexRuntimeProvenanceCapture(fixture.options);

    await capture.writePrimaryChunk(primaryExec('thread-root'));
    await capture.finalize();

    expect(readJson(fixture.streamManifestPath)).toMatchObject({ captureStatus: 'failed' });
  });

  it('fails capture when a child rollout reports another Codex CLI version', async () => {
    const fixture = provenanceFixture();
    installRollout(fixture.codexHome, 'root.jsonl', [
      sessionMeta({ sessionId: 'session-root', threadId: 'thread-root' }),
    ]);
    installRollout(fixture.codexHome, 'child.jsonl', [
      sessionMeta({
        cliVersion: '0.145.0',
        depth: 1,
        parentThreadId: 'thread-root',
        sessionId: 'session-root',
        threadId: 'thread-child',
      }),
    ]);
    const capture = new CodexRuntimeProvenanceCapture(fixture.options);

    await capture.writePrimaryChunk(primaryExec('thread-root', ['thread-child']));
    await capture.finalize();

    expect(readJson(fixture.streamManifestPath)).toMatchObject({ captureStatus: 'failed' });
  });

  it('rejects conflicting primary thread.started identities', async () => {
    const fixture = provenanceFixture();
    installRollout(fixture.codexHome, 'root-a.jsonl', [
      sessionMeta({ sessionId: 'session-root-a', threadId: 'thread-root-a' }),
    ]);
    installRollout(fixture.codexHome, 'root-b.jsonl', [
      sessionMeta({ sessionId: 'session-root-b', threadId: 'thread-root-b' }),
    ]);
    const capture = new CodexRuntimeProvenanceCapture(fixture.options);

    await capture.writePrimaryChunk(
      Buffer.concat([primaryExec('thread-root-a'), primaryExec('thread-root-b')])
    );
    await capture.finalize();

    expect(readJson(fixture.streamManifestPath)).toMatchObject({
      captureStatus: expect.not.stringMatching(/^complete$/),
    });
  });

  it('anchors child attribution to the first session_meta when inherited history repeats the root', async () => {
    const fixture = provenanceFixture();
    installRollout(fixture.codexHome, 'root.jsonl', [
      sessionMeta({ sessionId: 'session-root', threadId: 'thread-root' }),
    ]);
    installRollout(fixture.codexHome, 'child.jsonl', [
      sessionMeta({
        depth: 1,
        nickname: 'Curie',
        parentThreadId: 'thread-root',
        role: 'researcher',
        sessionId: 'session-root',
        threadId: 'thread-child',
      }),
      sessionMeta({ sessionId: 'session-root', threadId: 'thread-root' }),
      rolloutLine('turn_context', { turn_id: 'native-turn-child' }),
    ]);
    const capture = new CodexRuntimeProvenanceCapture(fixture.options);

    await capture.writePrimaryChunk(primaryExec('thread-root', ['thread-child']));
    await capture.finalize();

    expect(readJson(fixture.streamManifestPath)).toMatchObject({
      captureStatus: 'complete',
    });
    const childEntries = readIndex(fixture.nativeOriginIndexPath).filter(
      (entry) => entry.streamRef === 'stream-0002.jsonl'
    );
    expect(childEntries).toHaveLength(3);
    expect(childEntries).toEqual(
      childEntries.map(() =>
        expect.objectContaining({
          nativeSessionId: 'session-root',
          nativeThreadId: 'thread-child',
          parentNativeThreadId: 'thread-root',
          runtimeDepth: 1,
          runtimeNickname: 'Curie',
          runtimeRole: 'researcher',
        })
      )
    );
  });
});

/** Optional runtime provenance fixture limit overrides. */
interface FixtureOverrides {
  maxStreamCount?: number;
  maxTotalBytes?: number;
}

/**
 * Creates isolated runtime provenance output and Codex-home paths.
 *
 * @param overrides Optional capture-limit overrides.
 * @returns Fixture paths and capture options.
 */
function provenanceFixture(overrides: FixtureOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-codex-provenance-'));
  const sessionDir = join(root, 'openkit-session');
  const codexHome = join(root, 'codex-home');

  return {
    codexHome,
    nativeOriginIndexPath: join(sessionDir, 'runtime', 'native-origin-index.jsonl'),
    options: {
      adapterVersion: '0.153.4',
      codexHome,
      lineage: LINEAGE,
      maxStreamCount: overrides.maxStreamCount ?? 8,
      maxTotalBytes: overrides.maxTotalBytes ?? 1024 * 1024,
      nativeOriginIndexPath: join(sessionDir, 'runtime', 'native-origin-index.jsonl'),
      rawStreamsRoot: join(sessionDir, 'runtime', 'raw'),
      streamManifestPath: join(sessionDir, 'runtime', 'raw-streams.json'),
    },
    rawStreamsRoot: join(sessionDir, 'runtime', 'raw'),
    streamManifestPath: join(sessionDir, 'runtime', 'raw-streams.json'),
  };
}

/** Native Codex session metadata used by one minimized rollout fixture. */
interface SessionMetaInput {
  cliVersion?: string | null;
  depth?: number;
  nickname?: string;
  parentThreadId?: string;
  role?: string;
  sessionId: string;
  threadId: string;
}

/**
 * Builds one minimized Codex 0.153.4 rollout session metadata line.
 *
 * @param input Native session and thread metadata.
 * @returns One rollout JSONL line.
 */
function sessionMeta(input: SessionMetaInput): string {
  return rolloutLine('session_meta', {
    ...(input.cliVersion === null ? {} : { cli_version: input.cliVersion ?? '0.153.4' }),
    cwd: '/workspace/openkit',
    id: input.threadId,
    originator: 'codex_exec',
    ...(input.parentThreadId ? { parent_thread_id: input.parentThreadId } : {}),
    session_id: input.sessionId,
    source: input.parentThreadId
      ? {
          subagent: {
            thread_spawn: {
              ...(input.nickname ? { agent_nickname: input.nickname } : {}),
              ...(input.role ? { agent_role: input.role } : {}),
              ...(input.depth === undefined ? {} : { depth: input.depth }),
              parent_thread_id: input.parentThreadId,
            },
          },
        }
      : 'exec',
    timestamp: '2026-07-13T00:00:00.000Z',
  });
}

/**
 * Builds one minimized Codex rollout JSONL line.
 *
 * @param type Rollout item type.
 * @param payload Rollout item payload.
 * @returns Serialized rollout line.
 */
function rolloutLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    payload,
    timestamp: '2026-07-13T00:00:00.000Z',
    type,
  });
}

/**
 * Builds a minimized primary exec stream with an optional native spawn edge.
 *
 * @param threadId Primary native thread id.
 * @param receivers Native child thread ids spawned by the primary thread.
 * @returns LF-terminated primary exec JSONL bytes.
 */
function primaryExec(threadId: string, receivers: string[] = []): Buffer {
  const frames = [JSON.stringify({ thread_id: threadId, type: 'thread.started' })];
  if (receivers.length > 0) {
    frames.push(
      JSON.stringify({
        item: {
          receiver_thread_ids: receivers,
          sender_thread_id: threadId,
          tool: 'spawn_agent',
          type: 'collab_tool_call',
        },
        type: 'item.completed',
      })
    );
  }
  return Buffer.from(`${frames.join('\n')}\n`);
}

/**
 * Writes a stable rollout under the standard Codex sessions tree.
 *
 * @param codexHome Isolated Codex home.
 * @param name Rollout filename.
 * @param lines Serialized rollout lines.
 */
function installRollout(codexHome: string, name: string, lines: string[]): void {
  installRolloutBytes(codexHome, name, Buffer.from(`${lines.join('\n')}\n`));
}

/**
 * Writes exact stable rollout bytes under the standard Codex sessions tree.
 *
 * @param codexHome Isolated Codex home.
 * @param name Rollout filename suffix.
 * @param bytes Exact rollout bytes.
 */
function installRolloutBytes(codexHome: string, name: string, bytes: Uint8Array): void {
  const path = join(codexHome, 'sessions', '2026', '07', '13', `rollout-${name}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/**
 * Resolves one package-owned pinned Codex snapshot.
 *
 * @param name Snapshot filename.
 * @returns File URL for the snapshot.
 */
function snapshotUrl(name: string): URL {
  return new URL(`../snapshots/codex-0.153.4/${name}`, import.meta.url);
}

/**
 * Reads and validates the emitted native-origin index.
 *
 * @param path Index JSONL path.
 * @returns Validated index entries.
 */
function readIndex(path: string) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => WorkerRuntimeNativeOriginIndexEntrySchema.parse(JSON.parse(line)));
}

/**
 * Reads a JSON document from disk.
 *
 * @param path JSON file path.
 * @returns Parsed JSON value.
 */
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Computes the canonical runtime provenance digest for bytes.
 *
 * @param bytes Bytes to hash.
 * @returns Prefixed lowercase SHA-256 digest.
 */
function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Returns the byte length of the first newline-terminated frame.
 *
 * @param bytes Complete stream bytes.
 * @returns First physical frame length.
 */
function firstFrameLength(bytes: Uint8Array): number {
  return Buffer.from(bytes).indexOf(0x0a) + 1;
}
