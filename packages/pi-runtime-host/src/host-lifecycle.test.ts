// openkit-test-platform: posix
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { HostEvent, HostResponse } from './channel.ts';
import { PiRuntimeHost } from './host.ts';
import {
  createHostDirectories,
  type HostDirectories,
  mintLoopbackCredential,
  modelDescriptor,
} from './test-support/host-process.ts';
import { startSyntheticInference } from './test-support/inference.ts';

/** An `open` line whose loopback endpoints are never contacted. */
function openLine(id: number, directories: HostDirectories): string {
  return JSON.stringify({
    agentDir: directories.agentDir,
    capabilityBaseUrl: 'http://127.0.0.1:9/capabilities',
    capabilityCredential: mintLoopbackCredential(),
    id,
    inferenceBaseUrl: 'http://127.0.0.1:9/inference/v1',
    inferenceCredential: mintLoopbackCredential(),
    mcpServers: [],
    model: modelDescriptor('logical-a'),
    op: 'open',
    skillTargetPaths: [],
    resume: null,
    stateRoot: directories.stateRoot,
    workingDirectory: directories.workingDirectory,
  });
}

function recorder() {
  const frames: (HostEvent | HostResponse)[] = [];
  let closed = 0;
  const host = new PiRuntimeHost({
    onClosed: () => {
      closed += 1;
    },
    send: (frame) => frames.push(frame),
  });
  return { closed: () => closed, frames, host };
}

const closing = (id: number) => ({
  error: { code: 'invalid_state', message: 'Host is closing.' },
  id,
  ok: false,
});

describe('PiRuntimeHost lifecycle races', () => {
  it('does not prompt after native effort selection throws and fences the established binding', async () => {
    const directories = await createHostDirectories();
    const inference = await startSyntheticInference(() => ({ text: 'established' }));
    const { closed, frames, host } = recorder();
    try {
      await host.receive(
        JSON.stringify({
          ...JSON.parse(openLine(1, directories)),
          inferenceBaseUrl: inference.url,
          model: modelDescriptor('logical-a', { reasoning: true, reasoningEffortLevels: [] }),
        })
      );
      await host.receive(
        JSON.stringify({
          id: 2,
          op: 'turn',
          prompt: 'first',
          turnId: 'first',
          reasoningEffort: 'low',
        })
      );
      const settlements = () =>
        frames.filter(
          (frame): frame is Extract<HostEvent, { event: 'turn_settled' }> =>
            'event' in frame && frame.event === 'turn_settled'
        );
      expect(settlements()).toHaveLength(1);
      expect(settlements()[0]).toMatchObject({
        nativeHandle: { state: 'ready' },
        outcome: { status: 'completed' },
        reasoningEffort: 'low',
      });
      const nativeHandle = settlements()[0]!.nativeHandle;
      if (nativeHandle.state !== 'ready') throw new Error('Expected an established native handle.');
      const thinking = vi.spyOn(AgentSession.prototype, 'setThinkingLevel');
      const prompt = vi.spyOn(AgentSession.prototype, 'prompt');
      // The installed setter mutates native thinking before synchronously appending
      // its transcript entry; an append I/O failure must fence before prompt admission.
      const append = vi
        .spyOn(SessionManager.prototype, 'appendThinkingLevelChange')
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('One-time transcript append failure.'), { code: 'EIO' });
        });
      await host.receive(
        JSON.stringify({
          id: 3,
          op: 'turn',
          prompt: 'must not run',
          turnId: 'failed',
          reasoningEffort: 'high',
        })
      );
      expect(thinking).toHaveBeenCalledExactlyOnceWith('high');
      expect(append).toHaveBeenCalledExactlyOnceWith('high');
      expect(settlements()).toHaveLength(2);
      expect(settlements()[1]).toMatchObject({
        nativeHandle,
        outcome: { reason: 'pi-setup-failed', status: 'failed' },
        turnId: 'failed',
      });
      expect(prompt).not.toHaveBeenCalled();
      expect(inference.requests).toHaveLength(1);
      await host.receive(JSON.stringify({ id: 4, op: 'inspect' }));
      expect(frames.at(-1)).toEqual({
        id: 4,
        ok: true,
        result: { nativeHandle, state: 'failed', turnId: null },
      });
      await host.receive(JSON.stringify({ id: 5, op: 'turn', prompt: 'fenced', turnId: 'fenced' }));
      expect(frames.at(-1)).toMatchObject({ id: 5, ok: false, error: { code: 'invalid_state' } });
      const sessionPath = (JSON.parse(nativeHandle.handle) as { path: string }).path;
      const retained = await readFile(sessionPath);
      await host.receive(JSON.stringify({ id: 6, op: 'close' }));
      expect(frames.at(-1)).toEqual({
        id: 6,
        ok: true,
        result: { nativeHandle, state: 'closed' },
      });
      expect(closed()).toBe(1);
      expect(await readFile(sessionPath)).toEqual(retained);
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      await host.abandon();
      vi.restoreAllMocks();
      await inference.close();
      await rm(directories.root, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses an open that a close overtakes and never admits it afterwards', async () => {
    const directories = await createHostDirectories();
    const { closed, frames, host } = recorder();
    const opening = host.receive(openLine(1, directories));
    await host.receive(JSON.stringify({ id: 2, op: 'close' }));
    await opening;
    await host.receive(JSON.stringify({ id: 3, op: 'inspect' }));
    await host.receive(JSON.stringify({ id: 4, op: 'turn', prompt: 'work', turnId: 't' }));
    expect(frames).toEqual([
      closing(1),
      { id: 2, ok: true, result: { nativeHandle: { state: 'pending' }, state: 'closed' } },
      closing(3),
      closing(4),
    ]);
    expect(closed()).toBe(1);
    expect(host.secrets()).toEqual([]);
    expect(await readdir(join(directories.stateRoot, 'sessions'))).toEqual([]);
  });

  it('refuses an open that channel loss overtakes', async () => {
    const directories = await createHostDirectories();
    const { closed, frames, host } = recorder();
    const opening = host.receive(openLine(1, directories));
    await host.abandon();
    await opening;
    await host.receive(JSON.stringify({ id: 2, op: 'inspect' }));
    expect(frames).toEqual([closing(1), closing(2)]);
    expect(closed()).toBe(0);
    expect(host.secrets()).toEqual([]);
    expect(await readdir(join(directories.stateRoot, 'sessions'))).toEqual([]);
  });
});
