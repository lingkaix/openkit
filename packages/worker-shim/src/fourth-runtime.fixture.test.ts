import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseWorkerShimArgs, runWorkerShim } from './cli.js';
import type { WorkerControlFetch } from './control-client.js';

const fourthAdapter = vi.hoisted(() => ({
  /** Returns a native Node launch plan without runtime-specific shared behavior. */
  prepare(input: { childEnvironment: Record<string, string> }) {
    return {
      argv: [process.execPath, '-e', 'process.stdout.write("fourth runtime")'],
      captureStdout: true,
      environment: input.childEnvironment,
    };
  },
  /** Projects the fixture's bounded stdout into one normalized assistant candidate. */
  collect(input: {
    processResult: { exitCode: number | null; interrupted: boolean; stdout: Uint8Array };
  }) {
    const completed = input.processResult.exitCode === 0 && !input.processResult.interrupted;

    return {
      assistantText: completed
        ? Buffer.from(input.processResult.stdout).toString('utf8').trim()
        : null,
      status: completed ? 'completed' : 'failed',
      stopReason: completed ? 'completed' : 'fixture-process-failed',
    };
  },
}));

vi.mock('./adapter-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapter-registry.js')>();

  return {
    ...actual,
    WORKER_ADAPTERS: {
      ...actual.WORKER_ADAPTERS,
      'fixture-fourth': fourthAdapter,
    },
  };
});

/**
 * Returns a successful direct worker-control response.
 *
 * @param url Worker-control route URL.
 * @returns Endpoint-specific response body.
 */
function workerControlResponse(url: string): Record<string, unknown> {
  if (url.endsWith('/commands/poll')) {
    return { commands: [] };
  }
  if (url.endsWith('/events/append') || url.endsWith('/final-status')) {
    return { accepted: true, diagnostics: [], schemaVersion: 1 };
  }

  return {};
}

describe('fourth worker runtime fixture', () => {
  it('crosses the unchanged shared supervisor through one static registry entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-fourth-runtime-'));
    const packagePath = join(root, 'package.json');
    const sessionDirectory = join(root, 'session');
    const fetch: WorkerControlFetch = async (url) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(workerControlResponse(url)),
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        agent: { runtimeKind: 'descriptive-value-that-must-not-select-code' },
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture-fourth' },
          mode: 'direct-nanocore',
        },
        extensions: { openkit: { turnInput: 'Run the fixture.' } },
        llm: {
          mode: 'gateway',
          routes: [
            {
              credentialVisibility: 'none',
              endpoint: {
                kind: 'openai-compatible',
                workerBaseUrl: 'https://inference.local/v1',
              },
              id: 'worker-inference',
              model: 'fixture-model',
              providerInstanceId: 'fixture-provider',
            },
          ],
        },
        runtime: {
          command: {
            argv: ['openkit-worker-shim', '--package', '/openkit/config/package.json'],
            workingDirectory: root,
          },
        },
      }),
      'utf8'
    );

    await expect(
      runWorkerShim({
        args: parseWorkerShimArgs(['--package', packagePath, '--session-dir', sessionDirectory]),
        controlToken: 'fixture-control-token',
        environment: {
          OPENKIT_AGENT_SESSION_ID: 'as_fixture',
          OPENKIT_CONTROL_BASE_URL: 'https://nanocore.local/api/worker-control',
          OPENKIT_PACKAGE_SNAPSHOT_ID: 'pkg_fixture',
          OPENKIT_THREAD_ID: 'th_fixture',
          OPENKIT_TURN_ID: 'turn_fixture',
          OPENKIT_WORKSPACE_ID: 'ws_fixture',
          PATH: process.env.PATH ?? '',
        },
        fetch,
      })
    ).resolves.toMatchObject({ status: 'completed' });

    expect(readFileSync(join(sessionDirectory, 'items.jsonl'), 'utf8')).toContain('fourth runtime');
    expect(existsSync(join(sessionDirectory, 'native-state'))).toBe(false);
  });
});
