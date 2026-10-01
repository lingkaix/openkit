// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { OpenCodeClient } from '@opencode/client';
import { workerSessionInputPaths } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeAdapter } from './adapters/opencode.js';
import { createPiResidentAdapter } from './adapters/pi.js';
import { WorkerHarness } from './harness.js';
import type { SandboxIntegrationClient } from './integration-client.js';

const children = vi.hoisted(
  () =>
    [] as (import('node:child_process').ChildProcess & {
      sample?: string;
    })[]
);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args) as (typeof children)[number];
      child.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().split('NENV_SAMPLE:')[1]?.split('\n')[0];
        if (line) child.sample = line;
      });
      children.push(child);
      return child;
    },
  };
});

/** Native-process instrumentation samples only benign test settings, never a process dump. */
const SAMPLE = `process.stderr.write('NENV_SAMPLE:' + JSON.stringify({ pid: process.pid, value: process.env.N_ENV_PUBLIC ?? null, empty: process.env.N_ENV_EMPTY ?? null, vendor: process.env.OPENCODE_BENIGN_SETTING ?? null, ambient: process.env.AMBIENT_SETTING ?? null, language: process.env.LANG ?? null }) + '\\n');`;

vi.mock('./adapters/opencode-plugin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapters/opencode-plugin.js')>();
  return {
    ...actual,
    OPENCODE_PLUGIN_SOURCE:
      actual.OPENCODE_PLUGIN_SOURCE +
      `\nprocess.stderr.write('NENV_SAMPLE:' + JSON.stringify({ pid: process.pid, value: process.env.N_ENV_PUBLIC ?? null, empty: process.env.N_ENV_EMPTY ?? null, vendor: process.env.OPENCODE_BENIGN_SETTING ?? null, ambient: process.env.AMBIENT_SETTING ?? null, language: process.env.LANG ?? null }) + '\\n');`,
  };
});

/** Only session loopback registration is needed before native work; no provider or network is used. */
function integration(): SandboxIntegrationClient {
  const bindings = new Set<string>();
  return {
    ready: Promise.resolve(),
    registerSessionLoopback: (id: string) => {
      if (bindings.has(id)) throw new Error('Duplicate binding');
      bindings.add(id);
    },
    destroySessionLoopback: (id: string) => {
      bindings.delete(id);
    },
  } as unknown as SandboxIntegrationClient;
}

const credential = (seed: string) => createHash('sha256').update(seed).digest('base64url');

describe('real native child environment through Harness', () => {
  it.each([
    'pi',
    'opencode',
  ] as const)('delivers public values only to the %s native child and isolates a sibling', async (adapterId) => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-real-native-env-'));
    const start = children.length;
    const harnessEnvironment = {
      HOME: join(root, 'bootstrap-home'),
      PATH: process.env.PATH ?? '',
      AMBIENT_SETTING: 'must-not-inherit',
      LANG: 'fixture-ambient-language',
    };
    await mkdir(harnessEnvironment.HOME, { recursive: true });
    await mkdir('/tmp/openkit-bootstrap', { recursive: true });
    const nativeClients: OpenCodeClient[] = [];
    const adapter =
      adapterId === 'pi'
        ? createPiResidentAdapter({
            hostCommand: [
              process.execPath,
              '--no-warnings',
              '--input-type=module',
              '--eval',
              SAMPLE +
                `\nawait import(${JSON.stringify(new URL('../../pi-runtime-host/src/bin/openkit-pi-runtime-host.ts', import.meta.url).href)});`,
            ],
          })
        : createOpenCodeAdapter({
            loadClient: async () => {
              const actual = await import('@opencode/client');
              return {
                OpenCode: {
                  make: (options) => {
                    const client = actual.OpenCode.make(options);
                    nativeClients.push(client);
                    return client;
                  },
                },
              };
            },
          });
    const harness = new WorkerHarness({
      adapters: { [adapterId]: adapter },
      environment: harnessEnvironment,
      integration: integration(),
      nativeDataRootDirectory: join(root, 'native'),
      rootDirectory: join(root, 'control'),
      sandboxRoot: join(root, 'sandbox'),
      turnOutputDirectory: join(root, 'sandbox', 'session'),
    });
    let sequence = 0;
    const send = (operation: 'session.open' | 'session.close', body: Record<string, unknown>) =>
      harness.handle({
        body,
        harnessInstanceId: `harness-${adapterId}`,
        operation,
        operationId: createHash('sha256').update(`${root}:${sequence}`).digest('hex'),
        schemaVersion: 2,
        sequence: sequence++,
      });
    const selector = (id: string) => ({
      agentSessionId: id,
      agentSessionRuntimeBindingId: `binding-${id}`,
    });
    const open = async (id: string, values: Record<string, string>) => {
      // Core imports the session's initial workspace package before opening its native runtime.
      const sandboxRoot = join(root, 'sandbox');
      const packagePath = join(
        sandboxRoot,
        relative('/openkit', workerSessionInputPaths(id).packagePath)
      );
      await mkdir(dirname(packagePath), { recursive: true });
      await writeFile(
        packagePath,
        JSON.stringify({
          scope: {
            agentSessionId: id,
            threadId: `thread-${id}`,
            workspaceId: 'workspace',
            turnId: 'initial',
          },
          workspace: { root: sandboxRoot, inputs: [] },
          runtime: {
            environment: {
              imageDigest: `sha256:${'a'.repeat(64)}`,
              defaultsDigest: `sha256:${'b'.repeat(64)}`,
              values,
            },
          },
          extensions: {
            openkit: {
              sessionWorkspace: {
                layout: {
                  slots: [
                    {
                      id: 'work',
                      kind: 'worktree',
                      path: join(sandboxRoot, 'worktrees', id),
                      access: 'read-write',
                    },
                  ],
                },
              },
            },
          },
        })
      );
      return await send('session.open', {
        ...selector(id),
        adapterId,
        agentSessionCompatibilityKey: 'a'.repeat(64),
        capabilityLoopbackCredential: credential(`capability-${id}`),
        inferenceLoopbackCredential: credential(`inference-${id}`),
        effectiveSetupGeneration: 1,
        resume: null,
        nativeEnvironment: values,
        threadId: `thread-${id}`,
        workspaceId: 'workspace',
      });
    };
    try {
      expect(
        (
          await open('as-primary', {
            N_ENV_PUBLIC: 'hello',
            N_ENV_EMPTY: '',
            OPENCODE_BENIGN_SETTING: 'yes',
          })
        ).disposition
      ).toBe('succeeded');
      const primary = children.slice(start).find((child) => child.pid && child.exitCode === null);
      expect(primary?.pid).toBeDefined();
      if (adapterId === 'opencode') {
        await nativeClients[0]!.location.reload();
        await nativeClients[0]!.model.list();
      }
      await expect
        .poll(() => JSON.parse(primary!.sample ?? '{}'), { timeout: 5000 })
        .toEqual({
          pid: primary!.pid!,
          value: 'hello',
          empty: '',
          vendor: 'yes',
          ambient: null,
          language: null,
        });
      const siblingStart = children.length;
      expect((await open('as-sibling', {})).disposition).toBe('succeeded');
      const sibling = children
        .slice(siblingStart)
        .find((child) => child.pid && child.exitCode === null);
      expect(sibling?.pid).toBeDefined();
      if (adapterId === 'opencode') {
        await nativeClients[1]!.location.reload();
        await nativeClients[1]!.model.list();
      }
      await expect
        .poll(() => JSON.parse(sibling!.sample ?? '{}'), { timeout: 5000 })
        .toEqual({
          pid: sibling!.pid!,
          value: null,
          empty: null,
          vendor: null,
          ambient: null,
          language: null,
        });
      expect(JSON.parse(primary!.sample ?? '{}').value).toBe('hello');
      expect(Object.hasOwn(harnessEnvironment, 'N_ENV_PUBLIC')).toBe(false);
      expect(process.env.N_ENV_PUBLIC).toBeUndefined();
    } finally {
      await send('session.close', selector('as-primary'));
      await send('session.close', selector('as-sibling'));
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
