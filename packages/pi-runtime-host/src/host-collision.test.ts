import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent, HostResponse } from './channel.ts';
import {
  createHostDirectories,
  mintLoopbackCredential,
  modelDescriptor,
} from './test-support/host-process.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Runs the reviewer's real-host counterexample without opening a listener or transmitting requests. */
describe('Pi connection-time MCP namespace admission', () => {
  it.each([
    false,
    true,
  ])('refuses session_start versus file collisions through cleanup (reversed=%s)', async (reverse) => {
    const directories = await createHostDirectories();
    vi.stubEnv('HOME', directories.home);
    vi.stubEnv('PI_OFFLINE', '1');
    vi.stubEnv('PI_SKIP_VERSION_CHECK', '1');
    vi.stubEnv('PI_TELEMETRY', '0');
    const requests: string[] = [];
    // Observe every attempted request, including initialize and provider traffic during failure cleanup.
    vi.stubGlobal('fetch', async (url: unknown) => {
      requests.push(String(url));
      throw new Error('Unexpected network request');
    });
    const { PiRuntimeHost } = await import('./host.ts');
    const [configured, registered]: readonly [string, string] = reverse
      ? ['work_files', 'work-files']
      : ['work-files', 'work_files'];
    const target = (name: string) => `http://127.0.0.1:32123/mcp/${name}`;
    await writeFile(
      join(directories.agentDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { [configured]: { url: target(configured) } } })
    );
    await mkdir(join(directories.agentDir, 'extensions'));
    await writeFile(
      join(directories.agentDir, 'extensions', 'collision.js'),
      `export default pi => {
          pi.on('session_start', async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            pi.registerMcpServer(${JSON.stringify(registered)}, { url: ${JSON.stringify(target(registered))} });
          });
        };`
    );
    const frames: (HostEvent | HostResponse)[] = [];
    const settled = Promise.withResolvers<Extract<HostEvent, { event: 'turn_settled' }>>();
    const host = new PiRuntimeHost({
      onClosed() {},
      send(frame) {
        frames.push(frame);
        if ('event' in frame && frame.event === 'turn_settled') settled.resolve(frame);
      },
    });
    try {
      await host.receive(
        JSON.stringify({
          id: 1,
          op: 'open',
          agentDir: directories.agentDir,
          stateRoot: directories.stateRoot,
          workingDirectory: directories.workingDirectory,
          skillTargetPaths: [],
          resume: null,
          mcpServers: [],
          capabilityBaseUrl: 'http://127.0.0.1:32123/capabilities',
          capabilityCredential: mintLoopbackCredential(),
          inferenceBaseUrl: 'http://127.0.0.1:32124/v1',
          inferenceCredential: mintLoopbackCredential(),
          model: modelDescriptor('logical-a'),
        })
      );
      expect(frames.find((frame) => 'id' in frame && frame.id === 1)).toMatchObject({
        ok: true,
      });
      await host.receive(
        JSON.stringify({ id: 2, op: 'turn', turnId: 'collision', prompt: 'must refuse' })
      );
      expect((await settled.promise).outcome).toEqual({
        status: 'failed',
        reason: 'pi-setup-failed',
      });
    } finally {
      await host.receive(JSON.stringify({ id: 3, op: 'close' }));
    }
    expect(frames.find((frame) => 'id' in frame && frame.id === 3)).toMatchObject({
      ok: true,
      result: { state: 'closed' },
    });
    // Flush queued connection work after both Turn settlement and host shutdown before the zero-request oracle.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requests).toEqual([]);
  }, 60_000);
});
