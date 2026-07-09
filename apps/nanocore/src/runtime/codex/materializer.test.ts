import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ResolvedAgentSetup } from '../../agents/setup-resolver.js';
import { createCodexLaunchPayload, materializeCodexLaunchPayload } from './materializer.js';

const GOLDEN_PATH = join(import.meta.dirname, '__fixtures__', 'codex-launch-payload.golden.json');

/**
 * Reads the shared Codex launch payload golden file.
 *
 * @returns Serialized golden payload.
 */
function readGolden(): string {
  return readFileSync(GOLDEN_PATH, 'utf8');
}

/**
 * Serializes a launch payload for byte-identical golden comparisons.
 *
 * @param value Launch payload to serialize.
 * @returns Stable serialized launch payload.
 */
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Creates a resolved setup matching the current Codex local agent launch shape.
 *
 * @returns Resolved agent setup.
 */
function resolvedCodexSetup(): ResolvedAgentSetup {
  return {
    deployment: {
      mode: 'local',
      origin: 'agent-config',
      config: {
        command: 'codex',
        args: ['app-server', '--listen', 'stdio://'],
      },
    },
    origins: {
      deployment: 'agent-config',
      provider: null,
      runtime: 'agent-config',
      transport: 'agent-config',
    },
    provider: null,
    runtime: {
      adapter: 'codex-app-server',
      kind: 'codex',
      version: '0.130.0',
    },
    transport: {
      kind: 'stdio',
      origin: 'adapter-defaults',
    },
    agent: {
      displayName: 'Codex Host Agent',
      id: 'agent_codex_host',
    },
  };
}

describe('Codex launch materializer', () => {
  it('captures the current Codex local-adapter launch payload as a shared golden', () => {
    const payload = createCodexLaunchPayload({
      command: 'codex app-server --listen stdio://',
      environment: {
        OPENKIT_ENV: 'test',
      },
      workspaceRoot: '/workspace/openkit',
    });

    expect(serialize(payload)).toBe(readGolden());
  });

  it('materializes byte-identical Codex launch payloads from resolved setup', () => {
    const payload = materializeCodexLaunchPayload(resolvedCodexSetup(), {
      environment: {
        OPENKIT_ENV: 'test',
      },
      workspaceRoot: '/workspace/openkit',
    });

    expect(serialize(payload)).toBe(readGolden());
  });

  it('passes materialized workspace roots through the launch environment', () => {
    const payload = createCodexLaunchPayload(
      {
        command: 'codex app-server --listen stdio://',
        environment: {},
        workspaceRoot: '/workspace/openkit',
      },
      [
        {
          id: 'data',
          sourceKind: 'host-dir',
          sourcePath: '/workspace/openkit/data/input',
          workerPath: '/workspace/openkit/data/input',
          access: 'read-only',
        },
      ]
    );

    expect(JSON.parse(payload.transport.environment.OPENKIT_WORKSPACE_ROOTS ?? '[]')).toEqual([
      expect.objectContaining({ id: 'data', access: 'read-only' }),
    ]);
  });
});
