/** Subprocess oracle: uncaught stream errors and rejections fail the whole probe. */
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkerResidentSession, WorkerResidentTurnInput } from '../adapter-registry.js';
import { startSyntheticInference } from '../test-support/inference.js';
import { DEEPSEEK_SESSION_UPDATE_LIMIT_BYTES, deepseekResidentAdapter } from './deepseek.js';

const scenario = process.argv[1] ?? '';
const root = mkdtempSync(join(tmpdir(), 'deepseek-fault-'));
for (const name of ['state', 'control', 'work']) mkdirSync(join(root, name));
const inference = await startSyntheticInference(() =>
  scenario.startsWith('idle-') ? { text: 'done' } : { hang: true }
);
let session: WorkerResidentSession | undefined;
let child: ChildProcessWithoutNullStreams | undefined;
try {
  session = await deepseekResidentAdapter.openSession({
    agentSessionId: 'fault-probe',
    controlRoot: join(root, 'control'),
    stateRoot: join(root, 'state'),
    environment: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir() },
    resumeReference: null,
    loopback: {
      inferenceBaseUrl: inference.url,
      inferenceCredential: 'synthetic-inference-credential',
      capabilityBaseUrl: 'http://127.0.0.1:9',
      capabilityCredential: 'synthetic-capability-credential',
    },
  });
  const route: WorkerResidentTurnInput['llmRoute'] = {
    credentialVisibility: 'none',
    endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
    id: 'route',
    model: 'probe-model',
    providerInstanceId: 'provider',
  };
  const input: WorkerResidentTurnInput = {
    llmRoute: route,
    allowedLlmRoutes: [route],
    mcpServerIds: [],
    skillTargetPaths: [],
    workingDirectory: join(root, 'work'),
    turnDirectory: join(root, 'work'),
    turnId: 'turn',
    turnInput: 'hang',
    runtimeCapture: {
      captureCoverage: { scope: 'workspace', value: 'off' },
      credentialValues: [],
      emit: async () => undefined,
      packageSnapshotId: 'snapshot',
    },
  };
  const active = await session.startTurn(input);
  const internals = session as unknown as {
    child: ChildProcessWithoutNullStreams;
    outbound: PassThrough;
    stopProcess(): Promise<boolean>;
    agent: { closed: Promise<void> };
    promptRequestId: number;
  };
  child = internals.child;
  for (let attempt = 0; inference.requests.length === 0 && attempt < 500; attempt++)
    await delay(10);
  assert.ok(inference.requests.length > 0, 'real native prompt reached inference');
  let outcome = 'pending';
  const observed = active.settled.then(
    (result) => {
      outcome = 'fulfilled';
      return result;
    },
    () => {
      outcome = 'rejected';
      return null;
    }
  );
  if (scenario.startsWith('idle-')) await observed;
  const unproved = scenario.endsWith('-unproved');
  const originalStop = internals.stopProcess.bind(session);
  if (unproved) internals.stopProcess = async () => false;
  const stoppedHost =
    scenario.startsWith('close') ||
    scenario.startsWith('content') ||
    scenario.startsWith('overflow');
  if (stoppedHost) child.kill('SIGSTOP');
  let invalidForwarded = false;
  const base = scenario.replace(/^idle-/, '').replace(/-unproved$/, '');
  if (base === 'write')
    child.stdin.emit('error', Object.assign(new Error('injected pipe failure'), { code: 'EPIPE' }));
  else if (base === 'read') child.stdout.destroy(new Error('injected read failure'));
  else if (base === 'premature-close') child.stdout.emit('close');
  else if (base === 'transport')
    internals.outbound.destroy(new Error('injected transport failure'));
  else if (base === 'close') {
    const closing = session.close();
    assert.equal(session.close(), closing, 'close callers share failure');
    const checkedClose = closing.then(
      () => 'fulfilled',
      () => 'rejected'
    );
    await delay(10_500);
    assert.equal(
      outcome,
      unproved ? 'rejected' : 'pending',
      'settlement must wait for exit proof or reject an unproved stop'
    );
    assert.notEqual(session.childState(), 'absent');
    assert.equal(await checkedClose, 'rejected');
  } else {
    const id = internals.promptRequestId;
    const frames: Record<string, unknown> = {
      method: { jsonrpc: '2.0', method: 7, params: {} },
      'request-result': { jsonrpc: '2.0', method: 'future/request', id, params: {}, result: {} },
      'request-error': {
        jsonrpc: '2.0',
        method: 'future/request',
        id,
        params: {},
        error: { code: -1, message: 'bad' },
      },
      'response-params': { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' }, params: {} },
      'response-noid': { jsonrpc: '2.0', result: {} },
      both: {
        jsonrpc: '2.0',
        id,
        result: { stopReason: 'end_turn' },
        error: { code: -1, message: 'bad' },
      },
      error: { jsonrpc: '2.0', id, error: { code: 'bad', message: 7 } },
      id: { jsonrpc: '2.0', id: {}, result: { stopReason: 'end_turn' } },
      missing: { jsonrpc: '2.0', id },
      params: { jsonrpc: '2.0', method: 'future/notification', params: 7 },
      content: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: new TextDecoder().decode(
            ((await session.nativeHandle()) as { reference: Uint8Array }).reference
          ),
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'invalid-required', text: 'discard' },
          },
        },
      },
    };
    if (base === 'additive') {
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'future/notification', params: { extension: true }, extra: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', extra: {} }, extra: {} })}\n`
        )
      );
      assert.equal((await observed)?.status, 'completed');
      assert.equal(session.childState(), 'running');
      assert.equal((await session.nativeHandle()).state, 'ready');
      console.log('PROBE-PASS', scenario);
    } else if (base === 'typed-id') {
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({ jsonrpc: '2.0', id: String(id), result: { stopReason: 'end_turn' } })}\n`
        )
      );
      await delay(100);
      assert.equal(outcome, 'pending', 'a string id cannot settle a numeric request');
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`
        )
      );
      assert.equal((await observed)?.status, 'completed');
      console.log('PROBE-PASS', scenario);
      process.exitCode = 0;
    } else {
      if (base === 'overflow')
        frames.overflow = {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ignored',
            update: {
              sessionUpdate: 'future',
              text: 'x'.repeat(DEEPSEEK_SESSION_UPDATE_LIMIT_BYTES),
            },
          },
        };
      const frame = JSON.stringify(frames[base]);
      if (!['content', 'overflow'].includes(base)) {
        internals.outbound.on('data', (bytes: Buffer) => {
          if (bytes.toString('utf8').includes(frame)) invalidForwarded = true;
        });
      }
      child.stdout.emit('data', Buffer.from(`${frame}\n`));
    }
  }
  if (base !== 'typed-id' && base !== 'additive') {
    if (scenario.startsWith('idle-')) {
      for (let attempt = 0; session.childState() !== 'absent' && attempt < 500; attempt++)
        await delay(10);
      assert.equal(session.childState(), 'absent');
    }
    const result = await deadline(observed, 5_000, 'timed out');
    assert.notEqual(result, 'timed out', 'failure must have a bounded stop/fence');
    assert.equal(
      invalidForwarded,
      false,
      'invalid envelope must not enter SDK discard/logging paths'
    );
    if (!scenario.startsWith('idle-')) {
      if (unproved) {
        assert.equal(outcome, 'rejected');
        assert.notEqual(session.childState(), 'absent');
      } else {
        assert.equal(outcome, 'fulfilled');
        assert.equal(typeof result === 'object' && result?.status, 'failed');
        assert.equal(typeof result === 'object' && result?.assistantText, null);
        assert.equal(session.childState(), 'absent');
      }
    }
    assert.equal((await session.nativeHandle()).state, 'unknown');
    if (!unproved)
      await deadline(
        internals.agent.closed.then(() => true),
        1_000,
        false
      ).then((closed) => assert.equal(closed, true, 'SDK requests retired'));
    if (unproved && base !== 'close') {
      const fenced = await session.startTurn(input);
      await assert.rejects(fenced.settled);
      assert.equal(inference.requests.length, 1, 'fenced admission sends no new prompt');
    } else await assert.rejects(session.startTurn(input));
    console.log('PROBE-PASS', scenario);
  }
  internals.stopProcess = originalStop;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child?.once('exit', () => resolve()));
  }
  await session?.close().catch(() => undefined);
  await inference.close();
  rmSync(root, { recursive: true, force: true });
}

/** A probe deadline that never leaves a timer running after the deciding observation. */
function deadline<T, F>(pending: Promise<T>, milliseconds: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    pending,
    new Promise<F>((resolve) => {
      timer = setTimeout(() => resolve(fallback), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
