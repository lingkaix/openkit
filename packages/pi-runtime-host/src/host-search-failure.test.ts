// openkit-test-platform: posix
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { HostEvent, HostResponse } from './channel.ts';
import { PiRuntimeHost } from './host.ts';
import { startSyntheticCapability } from './test-support/capability.ts';
import {
  createHostDirectories,
  mintLoopbackCredential,
  modelDescriptor,
} from './test-support/host-process.ts';
import { startSyntheticInference } from './test-support/inference.ts';

// Keep actual SDK resource resolution and binding while injecting faults at required native boundaries.
const fault = vi.hoisted(() => ({
  kind: 'factory' as 'factory' | 'activation' | 'registration' | 'global-disable',
}));
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...actual,
    DefaultResourceLoader: class extends actual.DefaultResourceLoader {
      constructor(options: ConstructorParameters<typeof actual.DefaultResourceLoader>[0]) {
        super(fault.kind === 'global-disable' ? { ...options, noExtensions: true } : options);
      }
    },
    createToolSearchExtension: () =>
      fault.kind === 'factory'
        ? () => {
            throw new Error('Required search factory load failed.');
          }
        : actual.createToolSearchExtension(),
    createAgentSession: async (...args: Parameters<typeof actual.createAgentSession>) => {
      const result = await actual.createAgentSession(...args);
      if (fault.kind === 'activation') result.session.setActiveToolsByName = () => {};
      if (fault.kind === 'registration') {
        const bind = result.session.bindExtensions.bind(result.session);
        result.session.bindExtensions = async (...input) => {
          await bind(...input);
          const definition = result.session.getToolDefinition.bind(result.session);
          result.session.getToolDefinition = (name) =>
            name === 'tool_search' ? undefined : definition(name);
        };
      }
      return result;
    },
  };
});

it.each([
  'factory',
  'activation',
  'registration',
  'global-disable',
] as const)('M4 failed required native %s refuses provider work', async (kind) => {
  fault.kind = kind;
  const directories = await createHostDirectories();
  const capabilityCredential = mintLoopbackCredential();
  const inferenceCredential = mintLoopbackCredential();
  const capability = await startSyntheticCapability(capabilityCredential, ['openkit-work']);
  capability.bound = true;
  const inference = await startSyntheticInference(() => ({ text: 'must not run' }));
  const marker = join(directories.root, 'session-start');
  const extension = join(directories.root, 'probe.js');
  await writeFile(
    extension,
    `import { writeFileSync } from 'node:fs';
export default function(pi) { pi.on('session_start', () => writeFileSync(${JSON.stringify(marker)}, 'effect')); }`
  );
  const settings = JSON.stringify({ extensions: [extension] });
  await writeFile(join(directories.agentDir, 'settings.json'), settings);
  const frames: (HostEvent | HostResponse)[] = [];
  const host = new PiRuntimeHost({
    onClosed: () => undefined,
    send: (frame) => frames.push(frame),
  });
  try {
    await host.receive(
      JSON.stringify({
        id: 1,
        op: 'open',
        skillTargetPaths: [],
        agentDir: directories.agentDir,
        stateRoot: directories.stateRoot,
        workingDirectory: directories.workingDirectory,
        inferenceBaseUrl: inference.url,
        inferenceCredential,
        capabilityBaseUrl: capability.base,
        capabilityCredential,
        mcpServers: ['openkit-work'],
        model: modelDescriptor('logical-a'),
        resume: null,
      })
    );
    await host.receive(
      JSON.stringify({ id: 2, op: 'turn', turnId: 'turn-factory', prompt: 'first' })
    );
    await vi.waitFor(() =>
      expect(
        frames.find((frame) => 'event' in frame && frame.event === 'turn_settled')
      ).toMatchObject({
        outcome: { status: 'failed', reason: 'pi-setup-failed' },
      })
    );
    expect(existsSync(marker)).toBe(kind === 'activation' || kind === 'registration');
    expect(inference.requests).toHaveLength(0);
    if (kind === 'factory' || kind === 'global-disable') expect(capability.log).toHaveLength(0);
    expect(await readFile(join(directories.agentDir, 'settings.json'), 'utf8')).toBe(settings);
  } finally {
    await host.abandon();
    await capability.close();
    await inference.close();
    await rm(directories.root, { force: true, recursive: true });
  }
});
