// openkit-test-platform: posix
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { zstdDecompressSync } from 'node:zlib';

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkerResidentOpenInput,
  WorkerResidentSession,
  WorkerResidentTurnInput,
} from '../adapter-registry.js';
import {
  failDeepSeekAdmission,
  withholdDeepSeekResumeAcknowledgement,
} from '../test-support/deepseek-admission.js';
import {
  type CapturedInference,
  requestTexts,
  type SyntheticInference,
  startSyntheticInference,
} from '../test-support/inference.js';
import { type SyntheticMcp, startSyntheticMcp } from '../test-support/mcp-http.js';
import {
  boundDeepSeekDiagnostic,
  classifyDeepSeekStop,
  DEEPSEEK_DIAGNOSTIC_LIMIT_BYTES,
  DEEPSEEK_SESSION_UPDATE_LIMIT_BYTES,
  deepseekHostEnvironment,
  deepseekLaunchArgs,
  deepseekPermissionOutcome,
  deepseekResidentAdapter,
  deepseekSessionUpdateBytes,
  surfaceUnprovedDeepSeekTurn,
} from './deepseek.js';

// Defaults are image supply; test runs never import the developer's native home.
let imageHome: string;
beforeEach(() => {
  imageHome = mkdtempSync(join(tmpdir(), 'deepseek-test-image-'));
  vi.stubEnv('HOME', imageHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(imageHome, { force: true, recursive: true });
});

const INFERENCE = 'inference-credential-deepseek-w5';
const CAPABILITY = 'capability-credential-deepseek-w5';
const CONTROL = 'worker-control-token-deepseek-w5';
const LIVE = 180_000;

const sessions: WorkerResidentSession[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('deepseek permission and bounds', () => {
  it('selects allow_once by default and retains reject_once when no allow_once is offered', () => {
    expect(
      deepseekPermissionOutcome([
        { kind: 'allow_once', optionId: 'allow-once' },
        { kind: 'reject_once', optionId: 'reject-once' },
      ])
    ).toEqual({ outcome: 'selected', optionId: 'allow-once' });
    expect(deepseekPermissionOutcome([{ kind: 'reject_once', optionId: 'reject-once' }])).toEqual({
      outcome: 'selected',
      optionId: 'reject-once',
    });
    expect(deepseekPermissionOutcome([{ kind: 'allow_always', optionId: 'allow-always' }])).toEqual(
      {
        outcome: 'cancelled',
      }
    );
    expect(
      deepseekPermissionOutcome([{ kind: 'reject_always', optionId: 'reject-always' }])
    ).toEqual({
      outcome: 'cancelled',
    });
  });

  it('redacts secrets before keeping a 16 KiB diagnostic prefix', () => {
    const secret = 'super-secret-value';
    const text = `${secret}${'x'.repeat(DEEPSEEK_DIAGNOSTIC_LIMIT_BYTES)}${secret}`;
    const bounded = boundDeepSeekDiagnostic(text, [secret]);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(DEEPSEEK_DIAGNOSTIC_LIMIT_BYTES);
    expect(bounded).not.toContain(secret);
    expect(boundDeepSeekDiagnostic(`Bearer ${secret} tail`, [secret])).not.toContain(secret);
    const euro = `${'a'.repeat(DEEPSEEK_DIAGNOSTIC_LIMIT_BYTES - 1)}€`;
    expect(Buffer.byteLength(boundDeepSeekDiagnostic(euro, []))).toBeLessThanOrEqual(
      DEEPSEEK_DIAGNOSTIC_LIMIT_BYTES
    );
  });

  it('counts session update bytes against the 16 MiB ceiling', () => {
    const small = { sessionUpdate: 'usage_update', used: 1 };
    expect(deepseekSessionUpdateBytes(small)).toBeLessThan(DEEPSEEK_SESSION_UPDATE_LIMIT_BYTES);
    const huge = { text: 'y'.repeat(DEEPSEEK_SESSION_UPDATE_LIMIT_BYTES) };
    expect(deepseekSessionUpdateBytes(huge)).toBeGreaterThan(DEEPSEEK_SESSION_UPDATE_LIMIT_BYTES);
  });

  it('classifies terminal outcomes without treating partial text as success', () => {
    expect(
      classifyDeepSeekStop({
        badContent: false,
        cancelRequested: false,
        hostEnded: false,
        overLimit: false,
        promptFailed: false,
        stopReason: 'end_turn',
        text: '  hello world  ',
      })
    ).toMatchObject({ assistantText: 'hello world', status: 'completed' });
    expect(
      classifyDeepSeekStop({
        badContent: false,
        cancelRequested: false,
        hostEnded: false,
        overLimit: false,
        promptFailed: false,
        stopReason: 'end_turn',
        text: '   ',
      }).assistantText
    ).toBeNull();
    expect(
      classifyDeepSeekStop({
        badContent: false,
        cancelRequested: false,
        hostEnded: false,
        overLimit: false,
        promptFailed: true,
        stopReason: undefined,
        text: 'partial',
      })
    ).toMatchObject({
      assistantText: null,
      status: 'failed',
      stopReason: 'missing_terminal_outcome',
    });
    expect(
      classifyDeepSeekStop({
        badContent: false,
        cancelRequested: true,
        hostEnded: false,
        overLimit: false,
        promptFailed: false,
        stopReason: 'cancelled',
        text: 'partial',
      })
    ).toMatchObject({ assistantText: null, status: 'interrupted' });
    for (const stopReason of ['max_tokens', 'max_turn_requests', 'refusal']) {
      expect(
        classifyDeepSeekStop({
          badContent: false,
          cancelRequested: false,
          hostEnded: false,
          overLimit: false,
          promptFailed: false,
          stopReason,
          text: 'partial',
        }).status
      ).toBe('failed');
    }
    expect(
      classifyDeepSeekStop({
        badContent: false,
        cancelRequested: false,
        hostEnded: false,
        overLimit: true,
        promptFailed: false,
        stopReason: 'end_turn',
        text: 'too much',
      }).stopReason
    ).toBe('output_limit');
    expect(
      classifyDeepSeekStop({
        badContent: false,
        cancelRequested: true,
        hostEnded: false,
        overLimit: false,
        promptFailed: true,
        stopReason: undefined,
        text: 'partial',
      })
    ).toMatchObject({
      assistantText: null,
      status: 'failed',
      stopReason: 'missing_terminal_outcome',
    });
  });

  it('keeps an unproved stop pending so the Harness can fence it', async () => {
    const surfaced = surfaceUnprovedDeepSeekTurn(new Error('still live'), async () => false);
    await expect(surfaced.settled).rejects.toThrow('still live');
    const winner = await Promise.race([
      surfaced.interrupt().then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 30)),
    ]);
    expect(winner).toBe('pending');
  });

  it('resolves interrupt after an unproved stop is confirmed', async () => {
    const surfaced = surfaceUnprovedDeepSeekTurn(new Error('stopped later'), async () => true);
    await expect(surfaced.interrupt()).resolves.toBeUndefined();
  });
});

describe('deepseek resident adapter', () => {
  it(
    'completes, trims once, resumes the same conversation, and keeps credentials out of the runtime',
    async () => {
      const inference = await startSyntheticInference((_request, n) => {
        if (n === 1) return { text: ['  hello', ' world  '] };
        if (n === 2) return { text: '   ' };
        return { text: 'continued' };
      });
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const first = await session.startTurn(turn(roots, inference, 'FIRSTWORD', [], 'turn-1'));
      const completed = await first.settled;
      expect(completed).toMatchObject({
        assistantText: 'hello world',
        status: 'completed',
        stopReason: 'end_turn',
      });
      expect(completed.diagnostics?.compaction).toBe('unavailable');
      const handle = await session.nativeHandle();
      expect(handle.state).toBe('ready');
      const empty = await session.startTurn(turn(roots, inference, 'second', [], 'turn-2'));
      expect(await empty.settled).toMatchObject({ assistantText: null, status: 'completed' });
      expect(requestTexts(inference.requests[1] as CapturedInference).join('\n')).toContain(
        'FIRSTWORD'
      );
      expect(inference.requests[0]?.headers.authorization).toBe(`Bearer ${INFERENCE}`);
      const launch = deepseekLaunchArgs('/opt/dsh/lib/bin.js', join(roots.control, 'patch.yml'));
      expect(launch.join('\0')).not.toContain(INFERENCE);
      expect(launch).toEqual([
        '/opt/dsh/lib/bin.js',
        '--profile',
        'acp',
        '--patch',
        expect.any(String),
      ]);
      const hostEnv = deepseekHostEnvironment({
        agentSessionId: 'as',
        controlRoot: roots.control,
        environment: {
          ACP_CLIENT_MODULE: '/tmp/not-the-production-client',
          DSH_PUBLIC_SETTING: 'public-canary',
          CUSTOM: INFERENCE,
        },
        loopback: {
          capabilityBaseUrl: 'http://127.0.0.1:9',
          capabilityCredential: CAPABILITY,
          inferenceBaseUrl: inference.url,
          inferenceCredential: INFERENCE,
        },
        resumeReference: null,
        stateRoot: roots.state,
      });
      expect(JSON.stringify(hostEnv)).not.toContain(INFERENCE);
      expect(JSON.stringify(hostEnv)).not.toContain(CAPABILITY);
      expect(JSON.stringify(hostEnv)).not.toContain(CONTROL);
      expect(hostEnv.DSH_PERMISSION_MODE).toBe('danger-full-access');
      expect(hostEnv.DSH_TELEMETRY_MODE).toBe('DISABLED');
      expect(hostEnv.ACP_CLIENT_MODULE).toBe('/tmp/not-the-production-client');
      expect(hostEnv.DSH_PUBLIC_SETTING).toBe('public-canary');
      const patch = readFileSync(join(roots.control, 'deepseek-loopback.patch.yml'), 'utf8');
      expect(patch).toContain(INFERENCE);
      expect(statSync(join(roots.control, 'deepseek-loopback.patch.yml')).mode & 0o777).toBe(0o600);
      await session.close();
      expect(session.childState()).toBe('absent');
      expect(treeHas(roots.state, INFERENCE)).toBe(false);
      expect(treeHas(roots.state, CAPABILITY)).toBe(false);
      expect(treeHas(roots.state, CONTROL)).toBe(false);
      const reference = (handle as { reference: Uint8Array }).reference;
      const resumed = await open(roots, inference, reference);
      expect(await resumed.nativeHandle()).toEqual({ state: 'ready', reference });
      const again = await resumed.startTurn(turn(roots, inference, 'again', [], 'turn-3'));
      expect(await again.settled).toMatchObject({
        assistantText: 'continued',
        status: 'completed',
      });
      expect(requestTexts(inference.requests.at(-1) as CapturedInference).join('\n')).toContain(
        'FIRSTWORD'
      );
      await resumed.close();
      expect(resumed.childState()).toBe('absent');
      expect(existsSessionFile(roots.state)).toBe(true);
    },
    LIVE
  );

  it(
    'cancels the addressed prompt and accepts a later one',
    async () => {
      const inference = await startSyntheticInference((_request, n) => {
        if (n === 1) return { hang: true };
        return { text: 'after-cancel' };
      });
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const hanging = await session.startTurn(turn(roots, inference, 'hang', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      await hanging.interrupt();
      expect(await hanging.settled).toMatchObject({
        assistantText: null,
        status: 'interrupted',
        stopReason: 'cancelled',
      });
      const next = await session.startTurn(turn(roots, inference, 'next', [], 'turn-2'));
      expect(await next.settled).toMatchObject({
        assistantText: 'after-cancel',
        status: 'completed',
      });
      expect((await session.nativeHandle()).state).toBe('ready');
    },
    LIVE
  );

  it(
    'fails closed on partial output followed by a dropped model stream',
    async () => {
      const inference = await startSyntheticInference(() => ({ dropAfter: 'partial-text' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const turnResult = await (
        await session.startTurn(turn(roots, inference, 'fail', [], 'turn-1'))
      ).settled;
      expect(turnResult.assistantText).toBeNull();
      expect(turnResult.status).toBe('failed');
      expect(JSON.stringify(turnResult.diagnostics)).not.toContain(INFERENCE);
    },
    LIVE
  );

  it(
    'refuses a changed MCP supply before any native request and keeps the original binding',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'tool-turn' }));
      const mcp = await startSyntheticMcp({ alpha: 'alpha_tool', beta: 'beta_tool' });
      closers.push(
        () => inference.close(),
        () => mcp.close()
      );
      const roots = tempRoots();
      const session = await open(roots, inference, null, mcp);
      await (await session.startTurn(turn(roots, inference, 'FIRSTWORD', ['alpha'], 'turn-1')))
        .settled;
      expect(toolNames(inference.requests[0] as CapturedInference)).toContain(
        'mcp__alpha__alpha_tool'
      );
      const inferenceCount = inference.requests.length;
      const mcpCount = mcp.requests.length;
      const pid = Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'));
      const handle = await session.nativeHandle();
      await expect(
        session.startTurn(turn(roots, inference, 'second', ['beta'], 'turn-2'))
      ).rejects.toThrow(/supply does not match/);
      expect(inference.requests).toHaveLength(inferenceCount);
      expect(mcp.requests).toHaveLength(mcpCount);
      expect(Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'))).toBe(pid);
      expect(await session.nativeHandle()).toEqual(handle);
      const again = await session.startTurn(turn(roots, inference, 'again', ['alpha'], 'turn-3'));
      expect(await again.settled).toMatchObject({
        assistantText: 'tool-turn',
        status: 'completed',
      });
      expect(requestTexts(inference.requests.at(-1) as CapturedInference).join('\n')).toContain(
        'FIRSTWORD'
      );
      expect(mcp.requests.some((request) => request.serverId === 'beta')).toBe(false);
    },
    LIVE
  );

  it(
    'rejects a corrupt, mismatched, or missing resume without opening a fresh conversation',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'should-not-run' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const corrupt = await open(roots, inference, Uint8Array.from([0xff, 0xfe]));
      expect(await corrupt.nativeHandle()).toEqual({ state: 'unknown' });
      expect(corrupt.childState()).toBe('absent');
      await expect(corrupt.startTurn(turn(roots, inference, 'nope', [], 'turn-x'))).rejects.toThrow(
        /did not prove/
      );
      const missing = await open(roots, inference, new TextEncoder().encode('missing-session-id'));
      expect(await missing.nativeHandle()).toEqual({ state: 'unknown' });
      expect(inference.requests).toHaveLength(0);
      const real = await open(roots, inference, null);
      await (await real.startTurn(turn(roots, inference, 'seed', [], 'turn-1'))).settled;
      const handle = await real.nativeHandle();
      await real.close();
      const sidecar = join(roots.state, 'openkit-deepseek-binding.json');
      const record = JSON.parse(readFileSync(sidecar, 'utf8')) as { cwd: string };
      record.cwd = roots.other;
      writeFileSync(sidecar, JSON.stringify(record));
      const mismatched = await open(
        roots,
        inference,
        (handle as { reference: Uint8Array }).reference
      );
      expect(await mismatched.nativeHandle()).toEqual({ state: 'unknown' });
      expect(mismatched.childState()).toBe('absent');
      expect(
        processIsGone(Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8')))
      ).toBe(true);
      expect(inference.requests).toHaveLength(1);
    },
    LIVE
  );

  it('fails a direct provider route before spawning', async () => {
    const inference = await startSyntheticInference(() => ({ text: 'nope' }));
    closers.push(() => inference.close());
    const roots = tempRoots();
    const session = await open(roots, inference, null);
    const input = turn(roots, inference, 'direct', [], 'turn-1');
    const route: WorkerAdapterLlmRoute = {
      ...input.llmRoute,
      endpoint: { kind: 'openai-compatible', upstream: { kind: 'direct-provider' } },
    };
    await expect(
      session.startTurn({ ...input, llmRoute: route, allowedLlmRoutes: [route] })
    ).rejects.toThrow(/not representable/);
    expect(session.childState()).toBe('absent');
    expect(inference.requests).toHaveLength(0);
  });

  it(
    'stops the native process before rejecting a Turn that never reached the prompt',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'should-not-run' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const input = turn(roots, inference, 'bad-mcp', ['bad id'], 'turn-1');
      await expect(session.startTurn(input)).rejects.toThrow(/not representable/);
      expect(session.childState()).toBe('absent');
      expect(inference.requests).toHaveLength(0);
      expect(existsSync(join(roots.control, 'deepseek-host.pid'))).toBe(false);
    },
    LIVE
  );

  it(
    'ends a killed host and lets a successor resume without a second writer',
    async () => {
      const inference = await startSyntheticInference((_request, n) => {
        if (n === 1) return { hang: true };
        return { text: 'recovered' };
      });
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const started = await session.startTurn(turn(roots, inference, 'FIRSTWORD', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      const handle = await session.nativeHandle();
      if (handle.state !== 'ready') throw new Error('expected ready handle');
      const pid = Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'));
      expect(pid).toBeGreaterThan(0);
      process.kill(pid, 'SIGKILL');
      await session.exited;
      expect(await started.settled).toMatchObject({ assistantText: null, status: 'failed' });
      expect(session.childState()).toBe('absent');
      expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
      const successor = await open(roots, inference, handle.reference);
      const recovered = await successor.startTurn(turn(roots, inference, 'recover', [], 'turn-2'));
      expect(await recovered.settled).toMatchObject({
        assistantText: 'recovered',
        status: 'completed',
      });
      expect(requestTexts(inference.requests.at(-1) as CapturedInference).join('\n')).toContain(
        'FIRSTWORD'
      );
      expect(Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'))).not.toBe(pid);
    },
    LIVE
  );

  it(
    'does not accept a Turn after close has started',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'should-not-run' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const starting = session.startTurn(turn(roots, inference, 'race', [], 'turn-1'));
      const refused = starting.then(
        (turn) => turn,
        (error: unknown) => error
      );
      await session.close();
      const outcome = await refused;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/closing/);
      expect(existsSync(join(roots.control, 'deepseek-host.pid'))).toBe(false);
      expect(inference.requests).toHaveLength(0);
      expect(session.childState()).toBe('absent');
    },
    LIVE
  );

  it(
    'retains close refusal after unsolicited channel loss despite proved host exit',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'seed' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      await (await session.startTurn(turn(roots, inference, 'seed', [], 'loss-control'))).settled;
      const child = (
        session as unknown as { child: import('node:child_process').ChildProcessWithoutNullStreams }
      ).child;
      child.stdout.emit('error', new Error('unsolicited current-generation channel loss'));
      await waitFor(() => session.childState() === 'absent');
      expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
      await expect(session.close()).rejects.toThrow(/did not drain/);
    },
    LIVE
  );

  it(
    'shares one close promise while the host is stopped',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const hanging = await session.startTurn(turn(roots, inference, 'hang', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      const pid = Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'));
      process.kill(pid, 'SIGSTOP');
      try {
        const first = session.close();
        let secondState = 'pending';
        void session.close().then(
          () => {
            secondState = 'resolved';
          },
          () => {
            secondState = 'rejected';
          }
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(secondState).toBe('pending');
        process.kill(pid, 'SIGKILL');
        await expect(first).rejects.toThrow(/did not drain/);
        expect(secondState).toBe('rejected');
        expect(session.childState()).toBe('absent');
        void hanging;
      } finally {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The close path already reaped the stopped host.
        }
      }
    },
    LIVE
  );

  it(
    'does not treat cancellation output as a post-drain notification',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      await session.startTurn(turn(roots, inference, 'hang', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      await session.close();
      expect(session.childState()).toBe('absent');
    },
    LIVE
  );

  it(
    'does not publish a ready handle when the sidecar cannot be written',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'should-not-run' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      mkdirSync(join(roots.state, 'openkit-deepseek-binding.json'));
      await expect(
        session.startTurn(turn(roots, inference, 'seed', [], 'turn-1'))
      ).rejects.toThrow();
      expect((await session.nativeHandle()).state).not.toBe('ready');
      expect(session.childState()).toBe('absent');
      expect(inference.requests).toHaveLength(0);
      const pid = Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(processIsGone(pid)).toBe(true);
    },
    LIVE
  );

  it(
    'proves resume while capability requests are refused, then mounts the authorized supply',
    async () => {
      let allowCapability = true;
      const inference = await startSyntheticInference(() => ({ text: 'tool-turn' }));
      const mcp = await startSyntheticMcp(
        { alpha: 'alpha_tool', beta: 'beta_tool' },
        { allow: () => allowCapability }
      );
      closers.push(
        () => inference.close(),
        () => mcp.close()
      );
      const roots = tempRoots();
      const session = await open(roots, inference, null, mcp);
      await (await session.startTurn(turn(roots, inference, 'FIRSTWORD', ['alpha'], 'turn-1')))
        .settled;
      const handle = await session.nativeHandle();
      expect(handle.state).toBe('ready');
      await session.close();
      const deniedAt = mcp.requests.length;
      allowCapability = false;
      const resumed = await open(
        roots,
        inference,
        (handle as { reference: Uint8Array }).reference,
        mcp
      );
      expect(await resumed.nativeHandle()).toEqual(handle);
      expect(mcp.requests).toHaveLength(deniedAt);
      expect(resumed.childState()).toBe('running');
      allowCapability = true;
      const mounted = await resumed.startTurn(turn(roots, inference, 'next', ['beta'], 'turn-2'));
      expect(await mounted.settled).toMatchObject({
        assistantText: 'tool-turn',
        status: 'completed',
      });
      expect(toolNames(inference.requests.at(-1) as CapturedInference)).toContain(
        'mcp__beta__beta_tool'
      );
      expect(requestTexts(inference.requests.at(-1) as CapturedInference).join('\n')).toContain(
        'FIRSTWORD'
      );
      expect(await resumed.nativeHandle()).toEqual(handle);
    },
    LIVE
  );

  it(
    'refuses a changed Skill path before any native request',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'kept' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      await (await session.startTurn(turn(roots, inference, 'FIRSTWORD', [], 'turn-1'))).settled;
      const pid = Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'));
      const inferenceCount = inference.requests.length;
      const changed = turn(roots, inference, 'skills', [], 'turn-2');
      await expect(
        session.startTurn({
          ...changed,
          skillTargetPaths: [{ id: 'skill-1', targetPath: roots.work }],
        })
      ).rejects.toThrow(/supply does not match/);
      expect(inference.requests).toHaveLength(inferenceCount);
      expect(Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'))).toBe(pid);
      expect(session.childState()).toBe('running');
    },
    LIVE
  );

  it(
    'resumes a distinct successor with changed Skills and prior context',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'kept' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      mkdirSync(join(roots.work, 'successor-skill'));
      writeFileSync(
        join(roots.work, 'successor-skill', 'SKILL.md'),
        '---\nname: successor-skill\ndescription: Successor skill visible to the runtime\n---\nUse this skill for SECONDWORD.\n'
      );
      const first = await open(roots, inference, null);
      await (await first.startTurn(turn(roots, inference, 'FIRSTWORD', [], 'turn-1'))).settled;
      const handle = await first.nativeHandle();
      if (handle.state !== 'ready') throw new Error('expected ready handle');
      await first.close();
      const successor = await open(roots, inference, handle.reference);
      const changed = turn(roots, inference, 'SECONDWORD', [], 'turn-2');
      const active = await successor.startTurn({
        ...changed,
        skillTargetPaths: [{ id: 'skill-1', targetPath: roots.work }],
      });
      expect(await active.settled).toMatchObject({ status: 'completed' });
      expect(requestTexts(inference.requests.at(-1) as CapturedInference).join('\n')).toContain(
        'FIRSTWORD'
      );
      expect(requestTexts(inference.requests.at(-1) as CapturedInference).join('\n')).toContain(
        'successor-skill'
      );
      expect(await successor.nativeHandle()).toEqual(handle);
    },
    LIVE
  );

  it(
    'does not let a settled Turn cancel its successor',
    async () => {
      const inference = await startSyntheticInference((_request, n) => {
        if (n === 1) return { text: 'done' };
        return { hang: true };
      });
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const first = await session.startTurn(turn(roots, inference, 'one', [], 'turn-1'));
      expect(await first.settled).toMatchObject({ assistantText: 'done', status: 'completed' });
      const second = await session.startTurn(turn(roots, inference, 'two', [], 'turn-2'));
      await waitFor(() => inference.requests.length > 1);
      await first.interrupt();
      let settled = false;
      void second.settled.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      expect(inference.requests).toHaveLength(2);
      await second.interrupt();
      expect(await second.settled).toMatchObject({
        status: 'interrupted',
        stopReason: 'cancelled',
      });
    },
    LIVE
  );

  it(
    'rejects invalid sidecar core without starting native work and ignores an unknown field',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'seed' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      await (await session.startTurn(turn(roots, inference, 'seed', [], 'turn-1'))).settled;
      const handle = await session.nativeHandle();
      await session.close();
      const sidecar = join(roots.state, 'openkit-deepseek-binding.json');
      const original = readFileSync(sidecar, 'utf8');
      const reference = (handle as { reference: Uint8Array }).reference;
      const additive = JSON.parse(original) as Record<string, unknown>;
      additive.futureAdditive = 'ignored';
      writeFileSync(sidecar, JSON.stringify(additive));
      const kept = await open(roots, inference, reference);
      expect(await kept.nativeHandle()).toEqual(handle);
      await kept.close();
      const invalid: Array<(record: Record<string, unknown>) => void> = [
        (record) => {
          record.models = [];
        },
        (record) => {
          record.models = undefined;
        },
        (record) => {
          const models = record.models as unknown[];
          models.push(models[0]);
        },
        (record) => {
          record.model = 'absent-from-catalog';
        },
        (record) => {
          (record.models as Array<Record<string, unknown>>)[0]!.model = 'invalid model';
        },
        (record) => {
          (record.models as Array<Record<string, unknown>>)[0]!.input = ['future-core-value'];
        },
        (record) => {
          (record.models as Array<Record<string, unknown>>)[0]!.contextWindow = -5;
        },
        (record) => {
          (record.models as Array<Record<string, unknown>>)[0]!.maxTokens = 0;
        },
        (record) => {
          record.skillTargetPaths = ['relative/skill'];
        },
        (record) => {
          record.mcpServerIds = ['bad id'];
        },
        (record) => {
          delete record.model;
        },
      ];
      for (const mutate of invalid) {
        const record = JSON.parse(original) as Record<string, unknown>;
        mutate(record);
        writeFileSync(sidecar, JSON.stringify(record));
        const inferenceCount = inference.requests.length;
        rmSync(join(roots.control, 'deepseek-host.pid'), { force: true });
        const failed = await open(roots, inference, reference);
        expect(await failed.nativeHandle()).toEqual({ state: 'unknown' });
        expect(failed.childState()).toBe('absent');
        expect(existsSync(join(roots.control, 'deepseek-host.pid'))).toBe(false);
        expect(inference.requests).toHaveLength(inferenceCount);
        await failed.close();
      }
    },
    LIVE
  );

  it(
    'rejects a reasoning parameter the profile cannot represent before native work',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'should-not-run' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const input = turn(roots, inference, 'reason', [], 'turn-1');
      await expect(
        session.startTurn({
          ...input,
          llmRoute: {
            ...input.llmRoute,
            modelParameters: {
              contextWindow: 128_000,
              inputModalities: ['text'],
              maxOutputTokens: 8_192,
              reasoning: true,
            },
          },
        })
      ).rejects.toThrow(/not representable/);
      expect(session.childState()).toBe('absent');
      expect(inference.requests).toHaveLength(0);
    },
    LIVE
  );

  it(
    'rejects a different logical model before any native request',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'kept' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      await (await session.startTurn(turn(roots, inference, 'FIRSTWORD', [], 'turn-1'))).settled;
      const pid = Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'));
      const inferenceCount = inference.requests.length;
      const changed = turn(roots, inference, 'other-model', [], 'turn-2');
      await expect(
        session.startTurn({
          ...changed,
          llmRoute: { ...changed.llmRoute, model: 'second-model' },
        })
      ).rejects.toThrow(/model/);
      expect(inference.requests).toHaveLength(inferenceCount);
      expect(Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'))).toBe(pid);
      expect(session.childState()).toBe('running');
      const again = await session.startTurn(turn(roots, inference, 'still', [], 'turn-3'));
      expect(await again.settled).toMatchObject({ assistantText: 'kept', status: 'completed' });
    },
    LIVE
  );

  it(
    'fails invalid session content before the SDK logs it and ignores unknown updates',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'visible' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const logged: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(
          args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
        );
      };
      try {
        const started = session.startTurn(turn(roots, inference, 'seed', [], 'turn-1'));
        const active = await started;
        const sessionId = await nativeSessionId(session);
        deliver(
          session,
          sessionUpdate(sessionId, 'openkit_future_extension', { token: INFERENCE })
        );
        deliver(
          session,
          sessionUpdate(sessionId, 'agent_message_chunk', {
            content: { credential: INFERENCE, text: 'nope', type: 'secret' },
          })
        );
        const result = await active.settled;
        expect(result).toMatchObject({
          assistantText: null,
          status: 'failed',
          stopReason: 'unsupported_content',
        });
        const diagnostics = JSON.stringify(result.diagnostics ?? {});
        expect(diagnostics).not.toContain(INFERENCE);
        expect(logged.join('\n')).not.toContain(INFERENCE);
        expect(logged.join('\n')).not.toContain('"type":"secret"');
      } finally {
        console.error = original;
      }
    },
    LIVE
  );

  it(
    'ignores an unknown additive update and still completes the Turn',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'visible' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const logged: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(
          args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
        );
      };
      try {
        const active = await session.startTurn(turn(roots, inference, 'seed', [], 'turn-1'));
        const sessionId = await nativeSessionId(session);
        deliver(
          session,
          sessionUpdate(sessionId, 'openkit_future_extension', { token: INFERENCE })
        );
        const result = await active.settled;
        expect(result).toMatchObject({ assistantText: 'visible', status: 'completed' });
        expect(JSON.stringify(result.diagnostics ?? {})).not.toContain(INFERENCE);
        expect(logged.join('\n')).not.toContain(INFERENCE);
      } finally {
        console.error = original;
      }
    },
    LIVE
  );

  it(
    'fails the Turn when session updates pass 16 MiB and keeps no assistant candidate',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const single = await session.startTurn(turn(roots, inference, 'huge', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      const sessionId = await nativeSessionId(session);
      deliver(session, textChunk(sessionId, 'z'.repeat(DEEPSEEK_SESSION_UPDATE_LIMIT_BYTES)));
      expect(await single.settled).toMatchObject({
        assistantText: null,
        status: 'failed',
        stopReason: 'output_limit',
      });
      expect(session.childState()).toBe('absent');
      const aggregateRoots = tempRoots();
      const aggregateSession = await open(aggregateRoots, inference, null);
      const aggregate = await aggregateSession.startTurn(
        turn(aggregateRoots, inference, 'more', [], 'turn-2')
      );
      const aggregateId = await nativeSessionId(aggregateSession);
      const overhead = Buffer.byteLength(
        JSON.stringify({
          sessionId,
          update: {
            content: { text: '', type: 'text' },
            sessionUpdate: 'agent_message_chunk',
          },
        })
      );
      const first = 'y'.repeat(DEEPSEEK_SESSION_UPDATE_LIMIT_BYTES - overhead - 32);
      deliver(aggregateSession, textChunk(aggregateId, first));
      deliver(aggregateSession, textChunk(aggregateId, 'y'.repeat(64)));
      expect(await aggregate.settled).toMatchObject({
        assistantText: null,
        status: 'failed',
        stopReason: 'output_limit',
      });
      expect(aggregateSession.childState()).toBe('absent');
    },
    LIVE
  );

  it(
    'rejects close when a session update arrives after the drain boundary',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      await session.startTurn(turn(roots, inference, 'hang', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      const sessionId = await nativeSessionId(session);
      const internals = session as unknown as {
        drainBoundary: boolean;
        stopProcess(): Promise<boolean>;
      };
      const realStop = internals.stopProcess.bind(session);
      internals.stopProcess = async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return realStop();
      };
      const closing = session.close();
      await waitFor(() => internals.drainBoundary);
      deliver(session, textChunk(sessionId, 'late'));
      await expect(closing).rejects.toThrow(/did not drain/);
      await expect(session.close()).rejects.toThrow(/did not drain/);
      expect(session.childState()).toBe('absent');
    },
    LIVE
  );

  it(
    'cancels a Turn that is inside a tool call',
    async () => {
      const inference = await startSyntheticInference(() => ({
        toolCall: { arguments: {}, name: 'mcp__alpha__alpha_tool' },
      }));
      const mcp = await startSyntheticMcp({ alpha: 'alpha_tool' }, { hangToolCalls: true });
      closers.push(
        () => inference.close(),
        () => mcp.close()
      );
      const roots = tempRoots();
      const session = await open(roots, inference, null, mcp);
      const active = await session.startTurn(
        turn(roots, inference, 'use-tool', ['alpha'], 'turn-1')
      );
      await waitFor(() => mcp.requests.some((request) => request.method === 'tools/call'));
      await active.interrupt();
      expect(await active.settled).toMatchObject({
        assistantText: null,
        status: 'interrupted',
        stopReason: 'cancelled',
      });
      expect(session.childState()).toBe('running');
    },
    LIVE
  );

  it(
    'does not report cancellation when the prompt RPC rejects after cancel',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const active = await session.startTurn(turn(roots, inference, 'drop', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      const interrupting = active.interrupt();
      for (const id of [nativePromptId(session)]) {
        deliver(
          session,
          JSON.stringify({
            error: { code: -32603, message: 'prompt failed' },
            id,
            jsonrpc: '2.0',
          })
        );
      }
      const result = await active.settled;
      await interrupting;
      expect(result).toMatchObject({ status: 'failed', stopReason: 'host_ended' });
      expect(session.childState()).toBe('absent');
    },
    LIVE
  );

  it(
    'stops a live prompt before settling an unsolicited prompt RPC rejection',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const active = await session.startTurn(turn(roots, inference, 'drop', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      deliver(
        session,
        JSON.stringify({
          error: { code: -32603, message: 'prompt failed' },
          id: nativePromptId(session),
          jsonrpc: '2.0',
        })
      );
      const result = await active.settled;
      expect(result).toMatchObject({ status: 'failed', stopReason: 'host_ended' });
      expect(session.childState()).toBe('absent');
    },
    LIVE
  );

  it(
    'rejects settlement when a lost prompt and process stop are both unproved',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const active = await session.startTurn(turn(roots, inference, 'drop', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      const internals = session as unknown as { stopProcess(): Promise<boolean> };
      const realStop = internals.stopProcess.bind(session);
      internals.stopProcess = async () => false;
      deliver(
        session,
        JSON.stringify({
          error: { code: -32603, message: 'prompt failed' },
          id: nativePromptId(session),
          jsonrpc: '2.0',
        })
      );
      await expect(active.settled).rejects.toThrow(/runtime is unavailable/);
      expect(session.childState()).toBe('running');
      internals.stopProcess = realStop;
      await realStop();
    },
    LIVE
  );

  it(
    'fails a prompt on a malformed stdout frame before the SDK can discard it',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const active = await session.startTurn(turn(roots, inference, 'bad-frame', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      nativeStdout(session, Buffer.from('{broken-json\n'));
      const outcome = await Promise.race([
        active.settled,
        new Promise<string>((resolve) => setTimeout(() => resolve('unsettled'), 1_000)),
      ]);
      expect(outcome).toMatchObject({
        assistantText: null,
        status: 'failed',
        stopReason: 'host_ended',
      });
      expect(session.childState()).toBe('absent');
    },
    LIVE
  );

  it(
    'fails an unknown core stop reason in a correlated prompt response',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const active = await session.startTurn(turn(roots, inference, 'unknown-core', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      deliver(
        session,
        JSON.stringify({
          id: nativePromptId(session),
          jsonrpc: '2.0',
          result: { stopReason: 'future-required' },
        })
      );
      expect(await active.settled).toMatchObject({
        assistantText: null,
        status: 'failed',
        stopReason: 'host_ended',
      });
      expect(session.childState()).toBe('absent');
    },
    LIVE
  );

  it(
    'fails contradictory terminal responses for one prompt before publication',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const active = await session.startTurn(turn(roots, inference, 'contradict', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      nativeStdout(
        session,
        Buffer.from(
          [
            JSON.stringify({
              id: nativePromptId(session),
              jsonrpc: '2.0',
              result: { stopReason: 'end_turn' },
            }),
            JSON.stringify({
              id: nativePromptId(session),
              jsonrpc: '2.0',
              result: { stopReason: 'max_tokens' },
            }),
            '',
          ].join('\n')
        )
      );
      expect(await active.settled).toMatchObject({
        assistantText: null,
        status: 'failed',
        stopReason: 'host_ended',
      });
      expect(session.childState()).toBe('absent');
    },
    LIVE
  );

  it(
    'fences a duplicate prompt terminal that arrives after publication',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const active = await session.startTurn(turn(roots, inference, 'duplicate', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      deliver(
        session,
        JSON.stringify({
          id: nativePromptId(session),
          jsonrpc: '2.0',
          result: { stopReason: 'end_turn' },
        })
      );
      expect(await active.settled).toMatchObject({ status: 'completed' });
      deliver(
        session,
        JSON.stringify({
          id: nativePromptId(session),
          jsonrpc: '2.0',
          result: { stopReason: 'end_turn' },
        })
      );
      await waitFor(() => session.childState() === 'absent');
      expect((session as unknown as { unknownIdentity: boolean }).unknownIdentity).toBe(true);
      expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
      await expect(
        session.startTurn(turn(roots, inference, 'later', [], 'turn-2'))
      ).rejects.toThrow();
    },
    LIVE
  );

  it(
    'flushes a split UTF-8 tail at stdout end and refuses its invalid frame',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const active = await session.startTurn(turn(roots, inference, 'tail', [], 'turn-1'));
      await waitFor(() => inference.requests.length > 0);
      const internals = session as unknown as { classifyNativeLine(line: string): string | null };
      const admitted: string[] = [];
      const classify = internals.classifyNativeLine.bind(session);
      internals.classifyNativeLine = (line: string) => {
        admitted.push(line);
        return classify(line);
      };
      const valid = Buffer.from(
        JSON.stringify({
          id: nativePromptId(session),
          jsonrpc: '2.0',
          result: { stopReason: 'end_turn' },
        })
      );
      nativeStdout(session, Buffer.concat([valid, Buffer.from([0xe2])]));
      nativeStdout(session, Buffer.from([0x82]));
      nativeStdoutEnd(session);
      const outcome = await Promise.race([
        active.settled,
        new Promise<string>((resolve) => setTimeout(() => resolve('unsettled'), 1_000)),
      ]);
      expect(admitted.some((line) => line.endsWith('�'))).toBe(true);
      expect(outcome).toMatchObject({
        assistantText: null,
        status: 'failed',
        stopReason: 'host_ended',
      });
      expect(session.childState()).toBe('absent');
    },
    LIVE
  );

  it(
    'rejects close after native persistence flush fails and shares the rejection',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'done' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      await (await session.startTurn(turn(roots, inference, 'first', [], 'turn-1'))).settled;
      const internals = session as unknown as { agent: { closeSession(): Promise<unknown> } };
      internals.agent.closeSession = async () => {
        throw new Error('flush failure');
      };
      const closing = session.close();
      expect(session.close()).toBe(closing);
      await expect(closing).rejects.toThrow(/did not drain/);
      expect(session.childState()).toBe('absent');
    },
    LIVE
  );

  it(
    'rejects close when the native flush request times out',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'done' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      await (await session.startTurn(turn(roots, inference, 'first', [], 'turn-1'))).settled;
      const internals = session as unknown as { agent: { closeSession(): Promise<unknown> } };
      internals.agent.closeSession = async () => new Promise(() => undefined);
      const closing = session.close();
      expect(session.close()).toBe(closing);
      await expect(closing).rejects.toThrow(/did not drain/);
      expect(session.childState()).toBe('absent');
    },
    LIVE
  );

  it('bounds an interrupt whose cancel response and prompt never arrive', async () => {
    const inference = await startSyntheticInference(() => ({ hang: true }));
    closers.push(() => inference.close());
    const roots = tempRoots();
    const session = await open(roots, inference, null);
    const active = await session.startTurn(turn(roots, inference, 'hang', [], 'turn-1'));
    await waitFor(() => inference.requests.length > 0);
    const internals = session as unknown as { agent: { cancel(): Promise<unknown> } };
    internals.agent.cancel = async () => new Promise(() => undefined);
    await active.interrupt();
    expect(['interrupted', 'failed']).toContain((await active.settled).status);
    expect(session.childState()).toBe('absent');
  }, 12_000);

  it(
    'keeps multibyte text across every stdout byte split',
    async () => {
      for (const split of [1, 2]) {
        const inference = await startSyntheticInference(() => ({ hang: true }));
        closers.push(() => inference.close());
        const roots = tempRoots();
        const session = await open(roots, inference, null);
        const active = await session.startTurn(turn(roots, inference, 'utf8', [], 'turn-1'));
        await waitFor(() => inference.requests.length > 0);
        const sessionId = await nativeSessionId(session);
        const bytes = Buffer.from(
          `${textChunk(sessionId, 'before')}\n${textChunk(sessionId, '€')}\n`
        );
        const euro = bytes.indexOf(Buffer.from('€'));
        nativeStdout(session, bytes.subarray(0, euro + split));
        nativeStdout(session, bytes.subarray(euro + split));
        deliver(
          session,
          JSON.stringify({
            id: nativePromptId(session),
            jsonrpc: '2.0',
            result: { stopReason: 'end_turn' },
          })
        );
        expect(await active.settled).toMatchObject({
          assistantText: 'before€',
          status: 'completed',
        });
      }
    },
    LIVE
  );

  it(
    'records allow_once from permission requests delivered through the SDK without leaking option ids',
    async () => {
      const inference = await startSyntheticInference(() => ({ hang: true }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const logged: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(
          args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
        );
      };
      try {
        const active = await session.startTurn(turn(roots, inference, 'perm', [], 'turn-1'));
        await waitFor(() => inference.requests.length > 0);
        const sessionId = await nativeSessionId(session);
        const internals = session as unknown as { onPermission(params: unknown): unknown };
        const outcomes: unknown[] = [];
        const originalPermission = internals.onPermission.bind(session);
        internals.onPermission = (params: unknown) => {
          const outcome = originalPermission(params);
          outcomes.push(outcome);
          return outcome;
        };
        deliver(
          session,
          JSON.stringify({
            id: 77,
            jsonrpc: '2.0',
            method: 'session/request_permission',
            params: {
              options: [
                { kind: 'allow_once', name: 'Allow', optionId: INFERENCE },
                { kind: 'reject_once', name: 'Reject', optionId: 'reject-once' },
              ],
              sessionId,
              toolCall: { toolCallId: 'call-perm', title: 'read' },
            },
          })
        );
        await waitFor(() => outcomes.length === 1);
        expect(outcomes[0]).toEqual({ outcome: { outcome: 'selected', optionId: INFERENCE } });
        deliver(
          session,
          JSON.stringify({
            id: 78,
            jsonrpc: '2.0',
            method: 'session/request_permission',
            params: {
              options: [{ kind: 'allow_once', name: 'Allow', optionId: 'x'.repeat(20_000) }],
              sessionId,
              toolCall: { toolCallId: 'call-oversize', title: 'read' },
            },
          })
        );
        await waitFor(() => outcomes.length === 2);
        await active.interrupt();
        const result = await active.settled;
        expect(result.diagnostics?.permission).toBe('allow_once');
        expect(JSON.stringify(result.diagnostics ?? {})).not.toContain(INFERENCE);
        expect(JSON.stringify(result.diagnostics ?? {})).not.toContain('allow-once');
        expect(logged.join('\n')).not.toContain(sessionId);
      } finally {
        console.error = original;
      }
    },
    LIVE
  );

  it(
    'reports compaction when the runtime sends compaction updates',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'kept' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const active = await session.startTurn(turn(roots, inference, 'compact', [], 'turn-1'));
      const sessionId = await nativeSessionId(session);
      deliver(
        session,
        sessionUpdate(sessionId, 'compaction_update', {
          compactionId: 'compact-1',
          status: 'in_progress',
        })
      );
      deliver(
        session,
        sessionUpdate(sessionId, 'compaction_summary_chunk', {
          compactionId: 'compact-1',
          content: { text: 'summary', type: 'text' },
        })
      );
      const result = await active.settled;
      expect(result).toMatchObject({ assistantText: 'kept', status: 'completed' });
      expect(result.diagnostics?.compaction).toBe('observed');
    },
    LIVE
  );

  it(
    'resumes a session created before any prompt after the process is killed',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'should-not-run' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const sessionId = await resumeBeforePrompt(roots, inference.url);
      expect(inference.requests).toHaveLength(0);
      expect(sessionId.length).toBeGreaterThan(0);
    },
    LIVE
  );

  it(
    'does not read the operator home while the runtime is redirected',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'home' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const ambient = mkdtempSync(join(tmpdir(), 'deepseek-ambient-'));
      const canary = 'ambient-home-canary-deepseek-w5';
      writeFileSync(join(ambient, '.env'), `SECRET=${canary}\n`);
      writeFileSync(join(ambient, 'canary.txt'), canary);
      writeFileSync(join(roots.work, '.env'), 'workspace-env-canary-deepseek-w5\n');
      closers.push(async () => {
        rmSync(ambient, { force: true, recursive: true });
      });
      const input: WorkerResidentOpenInput = {
        agentSessionId: 'as-deepseek-test',
        controlRoot: roots.control,
        environment: {
          ACP_CLIENT_MODULE: '/tmp/not-the-production-client',
          HOME: ambient,
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          TMPDIR: tmpdir(),
        },
        loopback: {
          capabilityBaseUrl: 'http://127.0.0.1:9',
          capabilityCredential: CAPABILITY,
          inferenceBaseUrl: inference.url,
          inferenceCredential: INFERENCE,
        },
        resumeReference: null,
        stateRoot: roots.state,
      };
      const session = await deepseekResidentAdapter.openSession(input);
      sessions.push(session);
      await (await session.startTurn(turn(roots, inference, 'home', [], 'turn-1'))).settled;
      expect(treeHas(roots.state, canary)).toBe(false);
      expect(treeHas(roots.control, canary)).toBe(false);
    },
    LIVE
  );

  it(
    'selects different admitted models on one host without MCP remount and keeps descriptors',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'catalog-response' }));
      const mcp = await startSyntheticMcp({ alpha: 'alpha_tool' });
      closers.push(
        () => inference.close(),
        () => mcp.close()
      );
      const roots = tempRoots();
      const session = await open(roots, inference, null, mcp);
      const a = catalogRoute('catalog-a', 32_768, 1_024);
      const b = catalogRoute('catalog-b', 65_536, 2_048, ['text', 'image']);
      const first = catalogTurn(roots, inference, [a, b], b, 'CATALOGSEED', ['alpha']);
      expect(await (await session.startTurn(first)).settled).toMatchObject({ status: 'completed' });
      const handle = await session.nativeHandle();
      const pid = readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8');
      const calls = trackCatalogCalls(session);
      const mcpCount = mcp.requests.length;
      const second = catalogTurn(roots, inference, [b, a], a, 'catalog-second', ['alpha']);
      expect(await (await session.startTurn(second)).settled).toMatchObject({
        status: 'completed',
      });
      expect(inference.requests.map((request) => request.body.model)).toEqual([
        'catalog-b',
        'catalog-a',
      ]);
      expect(requestTexts(inference.requests[1] as CapturedInference).join('\n')).toContain(
        'CATALOGSEED'
      );
      expect(await session.nativeHandle()).toEqual(handle);
      expect(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8')).toBe(pid);
      expect(calls.map((call) => call.method)).toEqual(['setSessionConfigOption', 'prompt']);
      expect(calls[0]?.params).toMatchObject({
        configId: 'model',
        value: JSON.stringify(['openkit-loopback', 'catalog-a']),
      });
      expect(mcp.requests.length).toBe(mcpCount);
      const patch = readFileSync(join(roots.control, 'deepseek-loopback.patch.yml'), 'utf8');
      const models = JSON.parse(patch)
        .at(-1)
        .insert.find((row: { id: string }) => row.id === 'llm-pi-ai').config.providers[
        'openkit-loopback'
      ].models;
      expect(models).toEqual([
        {
          id: 'catalog-a',
          name: 'catalog-a',
          contextWindow: 32_768,
          maxTokens: 1_024,
          input: ['text'],
          reasoningEfforts: false,
        },
        {
          id: 'catalog-b',
          name: 'catalog-b',
          contextWindow: 65_536,
          maxTokens: 2_048,
          input: ['text', 'image'],
          reasoningEfforts: false,
        },
      ]);
      const retained = readFileSync(join(roots.state, 'openkit-deepseek-binding.json'), 'utf8');
      expect(retained).not.toContain(INFERENCE);
      expect(retained).not.toContain(CAPABILITY);
      expect(JSON.parse(retained).models).toHaveLength(2);
    },
    LIVE
  );

  it.each(['missing', 'empty'])(
    'rejects a %s admitted set before initial native work',
    async (kind) => {
      const inference = await startSyntheticInference(() => ({ text: 'must-not-run' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const a = catalogRoute('catalog-a', 32_768, 1_024);
      const input = catalogTurn(roots, inference, [a], a, 'refused');
      const candidate = {
        ...input,
        allowedLlmRoutes:
          kind === 'empty'
            ? []
            : (undefined as unknown as WorkerResidentTurnInput['allowedLlmRoutes']),
      };
      await expect(session.startTurn(candidate)).rejects.toThrow();
      expect(session.childState()).toBe('absent');
      expect(existsSync(join(roots.control, 'deepseek-host.pid'))).toBe(false);
      expect(inference.requests).toHaveLength(0);
    },
    LIVE
  );

  it(
    'refuses changed admitted catalogs and mismatched preference before any native call',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'kept' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const a = catalogRoute('catalog-a', 32_768, 1_024);
      const b = catalogRoute('catalog-b', 65_536, 2_048);
      await (await session.startTurn(catalogTurn(roots, inference, [a, b], a, 'seed'))).settled;
      const calls = trackCatalogCalls(session);
      const input = catalogTurn(roots, inference, [a, b], a, 'refused');
      const changedB = { ...b, modelParameters: { ...b.modelParameters!, contextWindow: 70_000 } };
      const invalid: WorkerResidentTurnInput[] = [
        { ...input, allowedLlmRoutes: [a] },
        { ...input, allowedLlmRoutes: [a, changedB] },
        { ...input, llmRoute: { ...a, providerInstanceId: 'wrong-provider' } },
        { ...input, llmRoute: catalogRoute('unadmitted', 32_768, 1_024) },
        { ...input, allowedLlmRoutes: [] },
        {
          ...input,
          allowedLlmRoutes: undefined as unknown as WorkerResidentTurnInput['allowedLlmRoutes'],
        },
      ];
      for (const candidate of invalid) {
        await expect(session.startTurn(candidate)).rejects.toThrow();
        expect(calls).toEqual([]);
        expect(inference.requests).toHaveLength(1);
        expect(session.childState()).toBe('running');
      }
      expect(
        await (await session.startTurn(catalogTurn(roots, inference, [b, a], b, 'usable'))).settled
      ).toMatchObject({ status: 'completed' });
      expect(inference.requests.at(-1)?.body.model).toBe('catalog-b');
    },
    LIVE
  );

  it.each(['reasoning', 'modality', 'bounds', 'endpoint', 'model-id', 'duplicate'])(
    'rejects an unsupported nonpreferred admitted member: %s',
    async (kind) => {
      const inference = await startSyntheticInference(() => ({ text: 'must-not-run' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const a = catalogRoute('catalog-a', 32_768, 1_024);
      let b = catalogRoute('catalog-b', 65_536, 2_048);
      if (kind === 'reasoning')
        b = { ...b, modelParameters: { ...b.modelParameters!, reasoning: true } };
      if (kind === 'modality')
        b = { ...b, modelParameters: { ...b.modelParameters!, inputModalities: ['audio'] } };
      if (kind === 'bounds')
        b = { ...b, modelParameters: { ...b.modelParameters!, maxOutputTokens: 0 } };
      if (kind === 'endpoint')
        b = {
          ...b,
          endpoint: { kind: 'provider-compatible', upstream: { kind: 'direct-provider' } },
        };
      if (kind === 'model-id') b = { ...b, model: 'invalid model id' };
      if (kind === 'duplicate') b = { ...b, model: a.model };
      await expect(
        session.startTurn(catalogTurn(roots, inference, [a, b], a, 'refused'))
      ).rejects.toThrow();
      expect(inference.requests).toHaveLength(0);
      expect(session.childState()).toBe('absent');
      expect(existsSync(join(roots.control, 'deepseek-host.pid'))).toBe(false);
    },
    LIVE
  );

  it.each(['old-data', 'deferred-eof', 'old-error-close', 'old-stderr', 'old-request-prefix'])(
    'isolates replaced host generation: %s',
    async (mode) => {
      type Host = import('node:child_process').ChildProcessWithoutNullStreams;
      let oldChild: Host;
      let successor: WorkerResidentSession;
      let deferredEnd: (() => void) | undefined;
      let endCount = 0;
      let callbackObservation: unknown[] = [];
      let oldRequests: import('node:stream').Readable | undefined;
      const inference = await startSyntheticInference((_request, index) => {
        if (index === 1) return { text: 'seed' };
        const session = successor as unknown as {
          child: Host;
          promptRequestId: number;
          stderr: Buffer;
        };
        if (mode === 'old-data')
          oldChild.stdout.emit('data', Buffer.from(`${textChunk(sessionId, 'OLD-GENERATION-')}\n`));
        if (mode === 'deferred-eof') {
          callbackObservation = [endCount];
          const current = session.child;
          current.stdout.emit('data', Buffer.from('{"jsonrpc":'));
          deferredEnd!();
          current.stdout.emit(
            'data',
            Buffer.from('"2.0","method":"future/notification","params":{}}\n')
          );
        }
        if (mode === 'old-error-close') {
          oldChild.stdout.emit('error', new Error('old pipe'));
          oldChild.stdout.emit('close');
        }
        if (mode === 'old-stderr') {
          const before = Buffer.from(session.stderr);
          oldChild.stderr.emit('data', Buffer.from('OLD-GENERATION-DIAGNOSTIC'));
          callbackObservation = [before, Buffer.from(session.stderr)];
        }
        if (mode === 'old-request-prefix') {
          if (!oldRequests) throw new Error('Expected retired request transport.');
          const before = session.promptRequestId;
          oldRequests!.emit(
            'data',
            Buffer.from('{"jsonrpc":"2.0","id":987654,"method":"session/prompt","params":{}}\n')
          );
          callbackObservation = [before, session.promptRequestId];
        }
        return { text: 'fresh' };
      });
      closers.push(() => inference.close());
      const roots = tempRoots();
      const first = await open(roots, inference, null);
      await (await first.startTurn(turn(roots, inference, 'GENERATIONCONTEXT', [], 'generation-1')))
        .settled;
      const handle = await first.nativeHandle();
      if (handle.state !== 'ready') throw new Error('Expected ready native reference.');
      const sessionId = new TextDecoder().decode(handle.reference);
      await first.close();
      successor = await open(roots, inference, handle.reference);
      oldChild = (successor as unknown as { child: Host }).child;
      oldChild.stdin.on('unpipe', (source) => {
        oldRequests = source;
      });
      if (mode === 'deferred-eof') {
        const emit = oldChild.stdout.emit.bind(oldChild.stdout);
        oldChild.stdout.emit = (event: string | symbol, ...args: unknown[]) => {
          if (event === 'end') {
            endCount++;
            deferredEnd = () => {
              emit(event, ...args);
            };
            return true;
          }
          return emit(event, ...args);
        };
      }
      let exited = false;
      void successor.exited.then(() => {
        exited = true;
      });
      const skillRoot = join(roots.other, 'generation-skill');
      mkdirSync(skillRoot);
      writeFileSync(
        join(skillRoot, 'SKILL.md'),
        '---\nname: generation-skill\ndescription: Replacement qualification.\n---\nUse this skill.\n'
      );
      const active = await successor.startTurn({
        ...turn(roots, inference, 'fresh-turn', [], 'generation-2'),
        skillTargetPaths: [{ id: 'generation-skill', targetPath: skillRoot }],
      });
      const current = (successor as unknown as { child: Host }).child;
      expect(current.pid).not.toBe(oldChild.pid);
      expect(await active.settled).toMatchObject({
        assistantText: 'fresh',
        status: 'completed',
        stopReason: 'end_turn',
      });
      expect(await successor.nativeHandle()).toEqual(handle);
      expect((successor as unknown as { child: Host }).child).toBe(current);
      expect(successor.childState()).toBe('running');
      expect(requestTexts(inference.requests.at(-1) as CapturedInference).join('\n')).toContain(
        'GENERATIONCONTEXT'
      );
      expect(exited).toBe(false);
      if (mode === 'deferred-eof') expect(callbackObservation).toEqual([1]);
      if (mode === 'old-stderr' || mode === 'old-request-prefix')
        expect(callbackObservation[1]).toEqual(callbackObservation[0]);
      await expect(successor.close()).resolves.toBeUndefined();
      expect(exited).toBe(false);
      if (mode === 'deferred-eof') expect(endCount).toBe(1);
    },
    LIVE
  );

  it.each(['retained'])(
    'reproves an admitted successor without Skills or MCP when predecessor model is %s',
    async (membership) => {
      const inference = await startSyntheticInference(() => ({ text: 'isolated-successor' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const a = catalogRoute('isolated-a', 32_768, 1_024);
      const b = catalogRoute('isolated-b', 65_536, 2_048);
      const predecessor = await open(roots, inference, null);
      await (await predecessor.startTurn(catalogTurn(roots, inference, [a], a, 'ISOLATEDCONTEXT')))
        .settled;
      const handle = await predecessor.nativeHandle();
      if (handle.state !== 'ready') throw new Error('Expected ready predecessor.');
      await predecessor.close();
      const successor = await open(roots, inference, handle.reference);
      expect(await successor.nativeHandle()).toEqual(handle);
      const next = catalogTurn(
        roots,
        inference,
        membership === 'retained' ? [a, b] : [b],
        b,
        'successor'
      );
      expect(await (await successor.startTurn(next)).settled).toMatchObject({
        status: 'completed',
      });
      expect(await successor.nativeHandle()).toEqual(handle);
      expect(inference.requests.at(-1)?.body.model).toBe('isolated-b');
      expect(requestTexts(inference.requests.at(-1) as CapturedInference).join('\n')).toContain(
        'ISOLATEDCONTEXT'
      );
    },
    LIVE
  );

  it.each(['catalog-only', 'catalog-and-skills-mcp'])(
    'explicitly refuses a removed recorded model successor: %s',
    async (mode) => {
      const inference = await startSyntheticInference(() => ({ text: 'retained-response' }));
      const mcp = await startSyntheticMcp({ alpha: 'alpha_tool', beta: 'beta_tool' });
      closers.push(
        () => inference.close(),
        () => mcp.close()
      );
      const roots = tempRoots();
      const a = catalogRoute('recorded-a', 32_768, 1_024);
      const b = catalogRoute('successor-b', 65_536, 2_048);
      const first = await open(roots, inference, null, mcp);
      // Startup metadata says B, but the latest logged Turn uses A; it cannot predict resume selection.
      await (await first.startTurn(catalogTurn(roots, inference, [a, b], b, 'STARTUP-B'))).settled;
      await (await first.startTurn(catalogTurn(roots, inference, [a, b], a, 'RETAINED-A-CONTEXT')))
        .settled;
      const handle = await first.nativeHandle();
      if (handle.state !== 'ready') throw new Error('Expected ready predecessor.');
      await first.close();
      const successor = await open(roots, inference, handle.reference, mcp);
      expect(await successor.nativeHandle()).toEqual(handle);
      const retained = snapshotRetainedBytes(roots.state);
      const count = inference.requests.length;
      const calls = trackCatalogCalls(successor);
      const skillRoot = join(roots.other, 'removed-model-skill');
      mkdirSync(skillRoot);
      writeFileSync(
        join(skillRoot, 'SKILL.md'),
        '---\nname: removed-model-skill\ndescription: Failed successor qualification.\n---\nUse this skill.\n'
      );
      const next = {
        ...catalogTurn(
          roots,
          inference,
          [b],
          b,
          'must-not-prompt',
          mode === 'catalog-only' ? [] : ['beta']
        ),
        skillTargetPaths:
          mode === 'catalog-only' ? [] : [{ id: 'removed-model-skill', targetPath: skillRoot }],
      };
      await expect(successor.startTurn(next)).rejects.toMatchObject({
        harnessReasonCode: 'dependency_failed',
      });
      expect(inference.requests).toHaveLength(count);
      expect(calls.some((call) => call.method === 'prompt' || call.method === 'newSession')).toBe(
        false
      );
      expect(successor.childState()).toBe('absent');
      const pid = Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(snapshotRetainedBytes(roots.state)).toEqual(retained);
      const recovered = await open(roots, inference, handle.reference, mcp);
      expect(await recovered.nativeHandle()).toEqual(handle);
      expect(
        await (await recovered.startTurn(catalogTurn(roots, inference, [a, b], a, 'recover')))
          .settled
      ).toMatchObject({ status: 'completed' });
      expect(requestTexts(inference.requests.at(-1) as CapturedInference).join('\n')).toContain(
        'RETAINED-A-CONTEXT'
      );
      expect(await recovered.nativeHandle()).toEqual(handle);
      await recovered.close();
    },
    LIVE
  );

  it(
    'ends admission after confirmed stop and recovers only through a separate successor',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'retained-response' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const a = catalogRoute('recorded-a', 32_768, 1_024);
      const b = catalogRoute('successor-b', 65_536, 2_048);
      const c = catalogRoute('extra-c', 32_768, 1_024);
      const first = await open(roots, inference, null);
      await (await first.startTurn(catalogTurn(roots, inference, [a, b], a, 'STOP-RETAINED-A')))
        .settled;
      const handle = await first.nativeHandle();
      if (handle.state !== 'ready') throw new Error('Expected ready predecessor.');
      await first.close();
      const refused = await open(roots, inference, handle.reference);
      await expect(
        refused.startTurn(catalogTurn(roots, inference, [b], b, 'must-not-prompt'))
      ).rejects.toMatchObject({ harnessReasonCode: 'dependency_failed' });
      expect(refused.childState()).toBe('absent');
      expect(await refused.nativeHandle()).toEqual({ state: 'unknown' });
      const pidPath = join(roots.control, 'deepseek-host.pid');
      const pidBytes = readFileSync(pidPath);
      expect(processIsGone(Number(pidBytes.toString()))).toBe(true);
      const patchPath = join(roots.control, 'deepseek-loopback.patch.yml');
      const patchBytes = readFileSync(patchPath);
      const retained = snapshotRetainedBytes(roots.state);
      const count = inference.requests.length;
      await expect(
        refused.startTurn(catalogTurn(roots, inference, [a, b, c], a, 'after-confirmed-stop'))
      ).rejects.toThrow('DeepSeek binding has ended.');
      expect(refused.childState()).toBe('absent');
      expect(readFileSync(pidPath)).toEqual(pidBytes);
      expect(readFileSync(patchPath)).toEqual(patchBytes);
      expect(inference.requests).toHaveLength(count);
      expect(snapshotRetainedBytes(roots.state)).toEqual(retained);
      await refused.close();
      const recovered = await open(roots, inference, handle.reference);
      expect(await recovered.nativeHandle()).toEqual(handle);
      expect(
        await (await recovered.startTurn(catalogTurn(roots, inference, [a, b, c], a, 'recover')))
          .settled
      ).toMatchObject({ status: 'completed' });
      expect(requestTexts(inference.requests.at(-1) as CapturedInference).join('\n')).toContain(
        'STOP-RETAINED-A'
      );
      expect(await recovered.nativeHandle()).toEqual(handle);
      await recovered.close();
    },
    LIVE
  );

  it.each(['rejected', 'wrong-model', 'missing-option', 'unknown-type', 'unproved-stop'])(
    'refuses prompting after admitted model selection is %s',
    async (kind) => {
      const inference = await startSyntheticInference(() => ({ text: 'before-selection-failure' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const a = catalogRoute('catalog-a', 32_768, 1_024);
      const b = catalogRoute('catalog-b', 65_536, 2_048);
      const session = await open(roots, inference, null);
      await (await session.startTurn(catalogTurn(roots, inference, [a, b], a, 'seed'))).settled;
      const calls = trackCatalogCalls(session);
      const internals = session as unknown as {
        agent: ClientSideConnection;
        stopProcess(): Promise<boolean>;
      };
      internals.agent.setSessionConfigOption = async () => {
        if (kind === 'rejected' || kind === 'unproved-stop') throw new Error('selection rejected');
        return {
          configOptions:
            kind === 'missing-option'
              ? []
              : [
                  {
                    id: 'model',
                    name: 'model',
                    type: kind === 'unknown-type' ? 'unknown-core' : 'select',
                    currentValue: JSON.stringify([
                      'openkit-loopback',
                      kind === 'unknown-type' ? 'catalog-b' : 'wrong-model',
                    ]),
                    options: [],
                  },
                ],
        } as unknown as Awaited<ReturnType<ClientSideConnection['setSessionConfigOption']>>;
      };
      const realStop = internals.stopProcess.bind(session);
      if (kind === 'unproved-stop') internals.stopProcess = async () => false;
      try {
        const pending = session.startTurn(
          catalogTurn(roots, inference, [a, b], b, 'must-not-prompt')
        );
        if (kind === 'unproved-stop') {
          const fenced = await pending;
          await expect(fenced.settled).rejects.toThrow();
          expect(session.childState()).toBe('running');
          await expect(session.close()).rejects.toThrow();
        } else {
          await expect(pending).rejects.toThrow();
          expect(session.childState()).toBe('absent');
          if (kind !== 'rejected') await expect(session.close()).rejects.toThrow();
        }
        expect(calls.some((call) => call.method === 'prompt')).toBe(false);
        expect(inference.requests).toHaveLength(1);
      } finally {
        internals.stopProcess = realStop;
        await realStop();
      }
    },
    LIVE
  );

  it(
    'does not publish a drain proof after native evidence is poisoned behind the close acknowledgement',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'seed' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      await (await session.startTurn(turn(roots, inference, 'seed', [], 'seed'))).settled;
      const native = session as unknown as { agent: ClientSideConnection };
      const close = native.agent.closeSession.bind(native.agent);
      let nativeClosed = false;
      native.agent.closeSession = async (input) => {
        const result = await close(input);
        nativeClosed = true;
        nativeStdout(session, Buffer.from('{"broken":true}\n'));
        return result;
      };
      await expect(session.close()).rejects.toThrow('DeepSeek close did not drain.');
      expect(nativeClosed).toBe(true);
      expect(session.childState()).toBe('absent');
      expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
    },
    LIVE
  );

  it(
    'does not certify a client RequestError without an observed native resume error response',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'seed' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const a = catalogRoute('catalog-a', 32_768, 1_024);
      const b = catalogRoute('catalog-b', 65_536, 2_048);
      const first = await open(roots, inference, null);
      await (await first.startTurn(catalogTurn(roots, inference, [a], a, 'seed'))).settled;
      const handle = await first.nativeHandle();
      await first.close();
      const resumed = await open(roots, inference, (handle as { reference: Uint8Array }).reference);
      const native = resumed as unknown as {
        agent: ClientSideConnection;
        spawnHost(record: unknown): Promise<void>;
      };
      const spawn = native.spawnHost.bind(resumed);
      let clientFailed = false;
      native.spawnHost = async (record) => {
        await spawn(record);
        native.agent.resumeSession = async () => {
          clientFailed = true;
          throw new RequestError(-32603, 'Injected client failure without a native response.');
        };
      };
      await expect(
        resumed.startTurn(catalogTurn(roots, inference, [a, b], a, 'must-not-prompt'))
      ).rejects.toThrow();
      expect(clientFailed).toBe(true);
      expect(inference.requests).toHaveLength(1);
      expect(resumed.childState()).toBe('absent');
      expect(await resumed.nativeHandle()).toEqual({ state: 'unknown' });
      await expect(resumed.close()).rejects.toThrow('DeepSeek close did not drain.');
    },
    LIVE
  );

  it(
    'retains failed close when a real successor resume acknowledgement is missing',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'seed' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const a = catalogRoute('catalog-a', 32_768, 1_024);
      const b = catalogRoute('catalog-b', 65_536, 2_048);
      const first = await open(roots, inference, null);
      await (await first.startTurn(catalogTurn(roots, inference, [a], a, 'seed'))).settled;
      const handle = await first.nativeHandle();
      await first.close();
      const resumed = await open(roots, inference, (handle as { reference: Uint8Array }).reference);
      const calls = withholdDeepSeekResumeAcknowledgement(resumed);
      await expect(
        resumed.startTurn(catalogTurn(roots, inference, [a, b], a, 'must-not-prompt'))
      ).rejects.toThrow();
      expect(calls).toEqual(['resumeAcknowledgement']);
      expect(inference.requests).toHaveLength(1);
      expect(resumed.childState()).toBe('absent');
      const pid = Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'));
      expect(processIsGone(pid)).toBe(true);
      expect(await resumed.nativeHandle()).toEqual({ state: 'unknown' });
      await expect(resumed.close()).rejects.toThrow('DeepSeek close did not drain.');
    },
    LIVE
  );

  it.each(['identity', 'identity-type', 'model'] as const)(
    'records unknown native evidence and rejected close for invalid creation result: %s',
    async (kind) => {
      const inference = await startSyntheticInference(() => ({ text: 'must-not-run' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const native = session as unknown as {
        agent: ClientSideConnection;
        spawnHost(record: unknown): Promise<void>;
      };
      const spawn = native.spawnHost.bind(session);
      let nativeCreated = false;
      native.spawnHost = async (record) => {
        await spawn(record);
        const create = native.agent.newSession.bind(native.agent);
        native.agent.newSession = async (input) => {
          const result = await create(input);
          nativeCreated = true;
          return {
            ...result,
            ...(kind === 'identity'
              ? { sessionId: '' }
              : kind === 'identity-type'
                ? { sessionId: 123 }
                : { configOptions: [] }),
          } as unknown as Awaited<ReturnType<ClientSideConnection['newSession']>>;
        };
      };
      await expect(
        session.startTurn(turn(roots, inference, 'must-not-prompt', [], 'invalid'))
      ).rejects.toThrow();
      expect(nativeCreated).toBe(true);
      expect(existsSync(join(roots.state, 'openkit-deepseek-binding.json'))).toBe(false);
      expect(inference.requests).toHaveLength(0);
      expect(session.childState()).toBe('absent');
      const pid = Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'));
      expect(processIsGone(pid)).toBe(true);
      const handle = await session.nativeHandle();
      const close = session.close();
      const outcome = await close.then(
        () => 'resolved',
        () => 'rejected'
      );
      expect({ handle, outcome }).toEqual({ handle: { state: 'unknown' }, outcome: 'rejected' });
      expect(session.close()).toBe(close);
      await expect(session.close()).rejects.toThrow('DeepSeek close did not drain.');
    },
    LIVE
  );

  it(
    'retains failed close for invalid native evidence before the first session id',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'must-not-run' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const session = await open(roots, inference, null);
      const internals = session as unknown as {
        agent: ClientSideConnection;
        spawnHost(record: unknown): Promise<void>;
      };
      const spawn = internals.spawnHost.bind(session);
      let requestedCreation = false;
      internals.spawnHost = async (record) => {
        await spawn(record);
        const create = internals.agent.newSession.bind(internals.agent);
        internals.agent.newSession = (input) => {
          requestedCreation = true;
          const pending = create(input);
          nativeStdout(session, Buffer.from('{"broken":true}\n'));
          return pending;
        };
      };
      await expect(
        session.startTurn(turn(roots, inference, 'must-not-prompt', [], 'invalid'))
      ).rejects.toThrow();
      expect(requestedCreation).toBe(true);
      expect(inference.requests).toHaveLength(0);
      expect(session.childState()).toBe('absent');
      expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
      await expect(session.close()).rejects.toThrow('DeepSeek close did not drain.');
    },
    LIVE
  );

  it(
    'retains failed close for invalid model evidence during successor reproof',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'seed' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const a = catalogRoute('catalog-a', 32_768, 1_024);
      const b = catalogRoute('catalog-b', 65_536, 2_048);
      const first = await open(roots, inference, null);
      await (await first.startTurn(catalogTurn(roots, inference, [a], a, 'seed'))).settled;
      const handle = await first.nativeHandle();
      await first.close();
      const resumed = await open(roots, inference, (handle as { reference: Uint8Array }).reference);
      const internals = resumed as unknown as {
        agent: ClientSideConnection;
        spawnHost(record: unknown): Promise<void>;
      };
      const spawn = internals.spawnHost.bind(resumed);
      let provedNativeResume = false;
      internals.spawnHost = async (record) => {
        await spawn(record);
        const resume = internals.agent.resumeSession.bind(internals.agent);
        internals.agent.resumeSession = async (input) => {
          const result = await resume(input);
          provedNativeResume = true;
          return { ...result, configOptions: [] };
        };
      };
      await expect(
        resumed.startTurn(catalogTurn(roots, inference, [a, b], a, 'must-not-prompt'))
      ).rejects.toThrow();
      expect(provedNativeResume).toBe(true);
      expect(inference.requests).toHaveLength(1);
      expect(resumed.childState()).toBe('absent');
      expect(await resumed.nativeHandle()).toEqual({ state: 'unknown' });
      await expect(resumed.close()).rejects.toThrow('DeepSeek close did not drain.');
    },
    LIVE
  );

  it.each(['channel-loss', 'close-flush'] as const)(
    'retains failed close after rejected admission: %s',
    async (kind) => {
      const inference = await startSyntheticInference(() => ({ text: 'seed' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const first = await open(roots, inference, null);
      await (await first.startTurn(turn(roots, inference, 'seed', [], 'seed'))).settled;
      const handle = await first.nativeHandle();
      await first.close();
      const resumed = await open(roots, inference, (handle as { reference: Uint8Array }).reference);
      expect(await resumed.nativeHandle()).toEqual(handle);
      const pid = Number(readFileSync(join(roots.control, 'deepseek-host.pid'), 'utf8'));
      const calls = failDeepSeekAdmission(resumed, kind);
      await expect(
        resumed.startTurn(
          turn(
            roots,
            inference,
            'must-not-prompt',
            kind === 'close-flush' ? ['alpha'] : [],
            'refused'
          )
        )
      ).rejects.toThrow();
      expect(calls).toEqual([kind === 'channel-loss' ? 'setSessionConfigOption' : 'closeSession']);
      expect(inference.requests).toHaveLength(1);
      expect(resumed.childState()).toBe('absent');
      expect(processIsGone(pid)).toBe(true);
      expect(await resumed.nativeHandle()).toEqual({ state: 'unknown' });
      const close = resumed.close();
      await expect(close).rejects.toThrow('DeepSeek close did not drain.');
      expect(resumed.close()).toBe(close);
      await expect(resumed.close()).rejects.toThrow('DeepSeek close did not drain.');
    },
    LIVE
  );

  it(
    'refuses resume metadata without the required current model catalog',
    async () => {
      const inference = await startSyntheticInference(() => ({ text: 'catalog-response' }));
      closers.push(() => inference.close());
      const roots = tempRoots();
      const a = catalogRoute('catalog-model', 32_768, 1_024);
      const first = await open(roots, inference, null);
      await (await first.startTurn(catalogTurn(roots, inference, [a], a, 'seed'))).settled;
      const handle = await first.nativeHandle();
      await first.close();
      const sidecar = join(roots.state, 'openkit-deepseek-binding.json');
      const record = JSON.parse(readFileSync(sidecar, 'utf8'));
      // Top-level descriptor fields cannot substitute for the required catalog.
      Object.assign(record, record.models[0]);
      delete record.models;
      const invalid = JSON.stringify(record);
      writeFileSync(sidecar, invalid);
      rmSync(join(roots.control, 'deepseek-host.pid'), { force: true });
      const successor = await open(
        roots,
        inference,
        (handle as { reference: Uint8Array }).reference
      );
      expect(await successor.nativeHandle()).toEqual({ state: 'unknown' });
      expect(successor.childState()).toBe('absent');
      expect(existsSync(join(roots.control, 'deepseek-host.pid'))).toBe(false);
      expect(inference.requests).toHaveLength(1);
      expect(readFileSync(sidecar, 'utf8')).toBe(invalid);
    },
    LIVE
  );
});

/** Injects one JSON-RPC line into the admitted native stream. */
function deliver(session: WorkerResidentSession, line: string): void {
  nativeStdout(session, Buffer.from(`${line}\n`));
}

/** Emits bytes at the real child stdout admission seam. */
function nativeStdout(session: WorkerResidentSession, bytes: Buffer): void {
  const child = (
    session as unknown as { child: { stdout: { emit(event: string, bytes: Buffer): void } } }
  ).child;
  child.stdout.emit('data', bytes);
}

/** Delivers a native stdout EOF after the preceding injected bytes. */
function nativeStdoutEnd(session: WorkerResidentSession): void {
  const child = (session as unknown as { child: { stdout: { emit(event: string): void } } }).child;
  child.stdout.emit('end');
}

/** Correlates injected responses with the actual prompt after model-selection RPCs. */
function nativePromptId(session: WorkerResidentSession): number {
  const id = (session as unknown as { promptRequestId: number | null }).promptRequestId;
  if (id === null) throw new Error('DeepSeek test expected an admitted prompt request.');
  return id;
}

/** Reads the ready native session id. */
async function nativeSessionId(session: WorkerResidentSession): Promise<string> {
  const handle = await session.nativeHandle();
  if (handle.state !== 'ready') throw new Error('DeepSeek test expected a ready handle.');
  return new TextDecoder().decode(handle.reference);
}

/** Builds one `session/update` notification. */
function sessionUpdate(
  sessionId: string,
  name: string,
  fields: Readonly<Record<string, unknown>>
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: name, ...fields } },
  });
}

/** Builds one text `agent_message_chunk`. */
function textChunk(sessionId: string, text: string): string {
  return sessionUpdate(sessionId, 'agent_message_chunk', {
    content: { text, type: 'text' },
  });
}

/**
 * Proves `session/new` is resumable before any prompt.
 * The process is killed after the new id is returned and a second process resumes it.
 */
async function resumeBeforePrompt(
  roots: { control: string; state: string; work: string },
  inferenceUrl: string
): Promise<string> {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve('@deepseek-ai/dsh/package.json');
  const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as {
    readonly bin?: Readonly<Record<string, string>> | string;
  };
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
  if (!relative) throw new Error('DeepSeek runtime is unavailable.');
  const executable = join(packageJson, '..', relative);
  const patchPath = join(roots.control, 'deepseek-loopback.patch.yml');
  writeFileSync(patchPath, probePatch(inferenceUrl), { mode: 0o600 });
  const privateHome = join(roots.state, 'private-home');
  mkdirSync(privateHome, { recursive: true });
  const env = {
    DSH_HOME: roots.state,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_MODE: 'DISABLED',
    HOME: privateHome,
    PATH: process.env.PATH ?? '',
    TMPDIR: tmpdir(),
  };
  const first = spawn(process.execPath, [...deepseekLaunchArgs(executable, patchPath)], {
    cwd: roots.work,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const created = await runAgent(first, async (agent) => {
    const session = await agent.newSession({ cwd: roots.work, mcpServers: [] });
    return session.sessionId;
  });
  if (typeof first.pid === 'number') process.kill(first.pid, 'SIGKILL');
  await onceExit(first);
  const second = spawn(process.execPath, [...deepseekLaunchArgs(executable, patchPath)], {
    cwd: roots.work,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await runAgent(second, async (agent) => {
      await agent.resumeSession({ cwd: roots.work, mcpServers: [], sessionId: created });
      await agent.closeSession({ sessionId: created });
    });
  } finally {
    if (second.exitCode === null && typeof second.pid === 'number') {
      process.kill(second.pid, 'SIGKILL');
    }
    await onceExit(second);
  }
  return created;
}

/** Initializes one ACP client and runs `body` without sending a prompt. */
async function runAgent<T>(
  child: ReturnType<typeof spawn>,
  body: (agent: ClientSideConnection) => Promise<T>
): Promise<T> {
  if (!child.stdin || !child.stdout) throw new Error('DeepSeek runtime is unavailable.');
  const agent = new ClientSideConnection(
    () => ({
      requestPermission: () => ({ outcome: { outcome: 'cancelled' as const } }),
      sessionUpdate: () => undefined,
    }),
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  );
  await agent.initialize({
    clientInfo: { name: 'openkit', version: '0' },
    protocolVersion: PROTOCOL_VERSION,
  });
  return body(agent);
}

/** Waits until the child has exited. */
function onceExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

/** Loopback patch used by the no-prompt resume probe. */
function probePatch(inferenceUrl: string): string {
  return [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      openkit-loopback:',
    '        api: openai-completions',
    `        baseURL: ${JSON.stringify(inferenceUrl)}`,
    '        headers:',
    `          Authorization: ${JSON.stringify(`Bearer ${INFERENCE}`)}`,
    '        models:',
    '          - id: "probe-model"',
    '            name: "probe-model"',
    '            contextWindow: 128000',
    '            maxTokens: 8192',
    '            input: [text]',
    '            reasoningEfforts: false',
    '- id: acp',
    '  config:',
    '    provider: openkit-loopback',
    '    model: "probe-model"',
    '- id: skill-filesystem',
    '  config:',
    '    includeDefaultRoots: false',
    '    watch: false',
    '',
  ].join('\n');
}

/** Creates disposable control, state, and workspace directories. */
function tempRoots(): { control: string; other: string; state: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), 'deepseek-adapter-'));
  const roots = {
    control: join(root, 'control'),
    other: join(root, 'other'),
    state: join(root, 'state'),
    work: join(root, 'work'),
  };
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true });
  closers.push(async () => {
    rmSync(root, { force: true, recursive: true });
  });
  return roots;
}

/** Opens one binding against the synthetic loopback. */
async function open(
  roots: { control: string; state: string; work: string },
  inference: SyntheticInference,
  resumeReference: Uint8Array | null,
  mcp?: SyntheticMcp
): Promise<WorkerResidentSession> {
  const input: WorkerResidentOpenInput = {
    agentSessionId: 'as-deepseek-test',
    controlRoot: roots.control,
    environment: {
      ACP_CLIENT_MODULE: '/tmp/not-the-production-client',
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      TMPDIR: tmpdir(),
    },
    loopback: {
      capabilityBaseUrl: mcp?.url ?? 'http://127.0.0.1:9',
      capabilityCredential: CAPABILITY,
      inferenceBaseUrl: inference.url,
      inferenceCredential: INFERENCE,
    },
    resumeReference,
    stateRoot: roots.state,
  };
  const session = await deepseekResidentAdapter.openSession(input);
  sessions.push(session);
  return session;
}

/** Builds one Turn input for the probe model. */
function turn(
  roots: { work: string },
  _inference: SyntheticInference,
  text: string,
  mcpServerIds: readonly string[],
  turnId: string
): WorkerResidentTurnInput {
  const route: WorkerResidentTurnInput['llmRoute'] = {
    credentialVisibility: 'none',
    endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
    id: 'route-deepseek',
    model: 'probe-model',
    providerInstanceId: 'provider-deepseek',
  };
  return {
    llmRoute: route,
    allowedLlmRoutes: [route],
    mcpServerIds,
    runtimeCapture: {
      captureCoverage: { scope: 'workspace', value: 'off' },
      credentialValues: [INFERENCE, CAPABILITY],
      emit: async () => undefined,
      packageSnapshotId: 'snapshot-deepseek',
    },
    skillTargetPaths: [],
    turnDirectory: roots.work,
    turnId,
    turnInput: text,
    workingDirectory: roots.work,
  };
}

/** Tool names the model was offered on one captured request. */
function toolNames(request: CapturedInference): string[] {
  return (request.body.tools ?? []).map((tool) => tool.function.name);
}

/** Whether any retained file, including a decompressed session log, contains the secret. */
function treeHas(root: string, secret: string): boolean {
  const needle = Buffer.from(secret);
  const walk = (directory: string): boolean => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        if (walk(path)) return true;
        continue;
      }
      const bytes = readFileSync(path);
      if (bytes.includes(needle)) return true;
      if (name.endsWith('.zst') || name.endsWith('.zstd')) {
        try {
          if (zstdDecompressSync(bytes).includes(needle)) return true;
        } catch {
          // Not every *.zstd name is a compressed frame.
        }
      }
    }
    return false;
  };
  return walk(root);
}

/** Whether the native session store kept a file after close. */
function existsSessionFile(root: string): boolean {
  const walk = (directory: string): boolean =>
    readdirSync(directory).some((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return walk(path);
      return name.includes('session') && statSync(path).size > 0;
    });
  return walk(root);
}

/** Whether a pid from a rejected DeepSeek effect is no longer running. */
function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'ESRCH'
    );
  }
}

/** Polls until a native effect is visible. */
async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('DeepSeek test timed out waiting for the runtime.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A representable admitted route with independently qualified native model bounds. */
function catalogRoute(
  model: string,
  contextWindow: number,
  maxOutputTokens: number,
  inputModalities: readonly ('text' | 'image')[] = ['text']
): WorkerResidentTurnInput['llmRoute'] {
  return {
    credentialVisibility: 'none',
    endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
    id: `route-${model}`,
    providerInstanceId: 'provider-deepseek',
    model,
    modelParameters: { contextWindow, maxOutputTokens, inputModalities, reasoning: false },
  };
}

/** Supplies the exact admitted routes independently of the preferred route. */
function catalogTurn(
  roots: { work: string },
  inference: SyntheticInference,
  allowedLlmRoutes: WorkerResidentTurnInput['allowedLlmRoutes'],
  llmRoute: WorkerResidentTurnInput['llmRoute'],
  text: string,
  mcpServerIds: readonly string[] = []
): WorkerResidentTurnInput {
  return { ...turn(roots, inference, text, mcpServerIds, text), allowedLlmRoutes, llmRoute };
}

/** Observes native SDK calls without replacing their real behavior. */
function trackCatalogCalls(session: WorkerResidentSession): { method: string; params: unknown }[] {
  const calls: { method: string; params: unknown }[] = [];
  const agent = (
    session as unknown as { agent: Record<string, (...args: unknown[]) => Promise<unknown>> }
  ).agent;
  for (const method of [
    'newSession',
    'resumeSession',
    'closeSession',
    'setSessionConfigOption',
    'prompt',
  ]) {
    const native = agent[method]!.bind(agent);
    agent[method] = (...args) => {
      calls.push({ method, params: args[0] });
      return native(...args);
    };
  }
  return calls;
}

/** Snapshots canonical conversation, sidecar, and profile bytes; native locks and derived cache are not retained authorities. */
function snapshotRetainedBytes(root: string): Record<string, string> {
  const bytes: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === 'session.lock' || prefix + name === 'dsh-home/storages/session_projcache')
        continue;
      const path = join(directory, name);
      const key = prefix + name;
      if (statSync(path).isDirectory()) walk(path, `${key}/`);
      else bytes[key] = readFileSync(path).toString('base64');
    }
  };
  walk(root, '');
  return bytes;
}
