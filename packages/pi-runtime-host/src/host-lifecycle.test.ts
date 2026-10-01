// openkit-test-platform: posix
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HostEvent, HostResponse } from './channel.ts';
import { PiRuntimeHost } from './host.ts';
import {
  createHostDirectories,
  type HostDirectories,
  mintLoopbackCredential,
  modelDescriptor,
} from './test-support/host-process.ts';

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
