import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensureLayout } from '../storage/fs-layout.js';
import { loadAgentManifests } from './agents-loader.js';

/**
 * Creates a temporary data root with a agents config directory.
 *
 * @returns Agents directory and data-root paths.
 */
function createAgentRoot(): { dataRoot: string; agentsRoot: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-agents-'));
  const agentsRoot = join(dataRoot, 'config', 'agents');

  mkdirSync(agentsRoot, { recursive: true });

  return { dataRoot, agentsRoot };
}

describe('loadAgentManifests', () => {
  it('loads authored agent config templates copied by ensureLayout', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-agents-'));

    ensureLayout(dataRoot);

    const result = loadAgentManifests(dataRoot);

    expect(result.diagnostics).toEqual([]);
    expect(result.manifests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adapter: 'codex-app-server',
          displayName: 'Codex Agent',
          id: 'agent_codex_host',
          kind: 'custom',
          providerRef: 'openai',
          runtime: 'codex',
        }),
        expect.objectContaining({
          adapter: 'opencode-server',
          displayName: 'OpenCode Server Agent',
          id: 'agent_opencode_server',
          kind: 'custom',
          providerRef: 'openrouter',
          runtime: 'opencode',
        }),
      ])
    );
  });

  it('rejects compact agent manifests with a typed diagnostic', () => {
    const { dataRoot, agentsRoot } = createAgentRoot();
    writeFileSync(
      join(agentsRoot, 'compact.agent.jsonc'),
      JSON.stringify({
        adapter: 'custom-adapter',
        deployments: ['local'],
        displayName: 'Compact Agent',
        id: 'agent_compact',
        kind: 'custom',
        runtime: 'node',
        version: '0.0.2',
      })
    );

    const result = loadAgentManifests(dataRoot);

    expect(result.manifests).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'agent.invalid_manifest',
        message: expect.stringContaining('schemaVersion'),
        path: expect.stringContaining('compact.agent.jsonc'),
        severity: 'error',
        agentId: 'agent_compact',
      }),
    ]);
  });

  it('preserves unknown optional extension sections', () => {
    const { dataRoot, agentsRoot } = createAgentRoot();
    writeFileSync(
      join(agentsRoot, 'extended.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        displayName: 'Extended Agent',
        deployment: {
          local: {},
        },
        extensions: {
          vendorFeature: {
            enabled: true,
          },
        },
        id: 'agent_extended',
        mode: 'local',
        runtime: {
          adapter: 'custom-http',
          kind: 'custom',
          version: '0.0.1',
        },
      })
    );

    const result = loadAgentManifests(dataRoot);

    expect(result.diagnostics).toEqual([]);
    expect(result.manifests[0]?.extensions).toEqual({
      vendorFeature: {
        enabled: true,
      },
    });
  });

  it('loads the unified authored agent config shape with inferred transport', () => {
    const { dataRoot, agentsRoot } = createAgentRoot();
    writeFileSync(
      join(agentsRoot, 'codex-v004.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent_codex_host',
        displayName: 'Codex Agent',
        runtime: {
          kind: 'codex',
          adapter: 'codex-app-server',
          version: '0.130.0',
        },
        mode: 'local',
        deployment: {
          local: {
            command: 'codex',
            args: ['app-server', '--listen', 'stdio://'],
            cwdPolicy: 'workspace',
          },
          remote: {
            endpointRef: 'env:CODEX_REMOTE_ENDPOINT',
          },
          a2a: {
            enabled: false,
          },
        },
        provider: {
          ref: 'agent-openrouter',
          model: 'openai/gpt-5.1',
          fallbacks: [],
        },
        profiles: [
          {
            id: 'default',
            mode: 'primary',
            instructionsRef: 'codex-default',
            skills: ['repo-guidelines'],
            mcp: ['github'],
            permissionsRef: 'default-coder',
          },
        ],
        defaultProfileId: 'default',
        workspace: {
          root: 'workspace/',
          inputs: [
            {
              kind: 'git_repo',
              urlRef: 'env:USER_SOURCE_GIT_URL',
              target: 'repo/',
              snapshotPolicy: 'materialized',
            },
          ],
          filesystems: [
            {
              id: 'workspace',
              scope: 'workspace',
              mount: 'workspace/',
              access: 'read_write',
            },
            {
              id: 'shared',
              scope: 'user',
              mount: 'shared/',
              access: 'read_only',
            },
          ],
          env: {},
          ephemeralEnv: {},
        },
        mcp: [
          {
            id: 'github',
            mode: 'bridge.spawned',
          },
          {
            id: 'playwright',
            mode: 'agent.local',
            command: 'npx',
            args: ['@playwright/mcp@latest'],
          },
        ],
        skills: [
          {
            id: 'repo-guidelines',
            source: 'server:skills/repo-guidelines',
          },
        ],
        permissions: {
          shell: ['git *', 'pnpm *', 'npm *'],
          filesystem: [{ path: 'workspace/**', access: 'read_write' }],
          network: ['api.openrouter.ai', 'openrouter.ai'],
        },
        sandbox: {
          kind: 'codex',
          mode: 'workspace-write',
          approvalPolicy: 'on-request',
        },
        lifecycle: {
          initTimeoutMs: 30000,
          idleTimeoutMs: 600000,
          heartbeatIntervalMs: 30000,
        },
        resources: {
          maxConcurrentTurns: 1,
          maxToolCallsPerTurn: 100,
          maxLlmTokensPerHour: 200000,
        },
        observability: {
          logs: { level: 'info' },
          dashboard: { metrics: [] },
        },
        readiness: {
          requirements: [
            {
              id: 'codex-cli',
              kind: 'command',
              command: ['codex', '--version'],
              severity: 'blocking',
            },
          ],
        },
        runtimeConfig: {
          codex: {
            sandboxMode: 'workspace-write',
            approvalPolicy: 'on-request',
          },
        },
        extensions: {},
      })
    );

    const result = loadAgentManifests(dataRoot);

    expect(result.diagnostics).toEqual([]);
    expect(result.manifests).toEqual([
      expect.objectContaining({
        adapter: 'codex-app-server',
        displayName: 'Codex Agent',
        id: 'agent_codex_host',
        kind: 'custom',
        modelRef: 'openai/gpt-5.1',
        providerRef: 'agent-openrouter',
        runtime: 'codex',
      }),
    ]);
  });

  it('accepts supported explicit transport overrides', () => {
    const { dataRoot, agentsRoot } = createAgentRoot();
    writeFileSync(
      join(agentsRoot, 'codex-stdio.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent_codex_host',
        displayName: 'Codex Agent',
        runtime: { kind: 'codex', adapter: 'codex-app-server' },
        mode: 'local',
        transport: { kind: 'stdio' },
        deployment: { local: {} },
      })
    );

    const result = loadAgentManifests(dataRoot);

    expect(result.diagnostics).toEqual([]);
    expect(result.manifests).toEqual([
      expect.objectContaining({
        adapter: 'codex-app-server',
        id: 'agent_codex_host',
        runtime: 'codex',
      }),
    ]);
  });

  it('rejects unsupported explicit transport overrides', () => {
    const { dataRoot, agentsRoot } = createAgentRoot();
    writeFileSync(
      join(agentsRoot, 'codex-http.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent_codex_host',
        displayName: 'Codex Agent',
        runtime: { kind: 'codex', adapter: 'codex-app-server' },
        mode: 'local',
        transport: { kind: 'http' },
        deployment: { local: {} },
      })
    );

    const result = loadAgentManifests(dataRoot);

    expect(result.manifests).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'agent.invalid_manifest',
        message: expect.stringContaining('Unsupported transport override'),
        severity: 'error',
        agentId: 'agent_codex_host',
      }),
    ]);
  });

  it('rejects user-configured simulator agents', () => {
    const { dataRoot, agentsRoot } = createAgentRoot();
    writeFileSync(
      join(agentsRoot, 'simulator.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent_simulator',
        displayName: 'Simulator Agent',
        runtime: { kind: 'simulator', adapter: 'simulator' },
        mode: 'local',
        deployment: { local: {} },
      })
    );

    const result = loadAgentManifests(dataRoot);

    expect(result.manifests).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'agent.invalid_manifest',
        message: expect.stringContaining('Simulator agents are internal-only'),
        severity: 'error',
        agentId: 'agent_simulator',
      }),
    ]);
  });

  it('rejects unknown v0.0.4 top-level fields outside extensions', () => {
    const { dataRoot, agentsRoot } = createAgentRoot();
    writeFileSync(
      join(agentsRoot, 'unknown-field.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent_unknown',
        displayName: 'Unknown Agent',
        runtime: { kind: 'codex', adapter: 'codex-app-server' },
        mode: 'local',
        deployment: {},
        unsupportedTopLevel: true,
      })
    );

    const result = loadAgentManifests(dataRoot);

    expect(result.manifests).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'agent.invalid_manifest',
        message: expect.stringContaining('unsupportedTopLevel'),
        severity: 'error',
        agentId: 'agent_unknown',
      }),
    ]);
  });

  it('rejects unsafe workspace paths and overlapping targets', () => {
    const { dataRoot, agentsRoot } = createAgentRoot();
    writeFileSync(
      join(agentsRoot, 'unsafe-paths.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent_unsafe_paths',
        displayName: 'Unsafe Paths',
        runtime: { kind: 'codex', adapter: 'codex-app-server' },
        mode: 'local',
        deployment: {},
        workspace: {
          inputs: [
            { kind: 'dir', target: '/absolute' },
            { kind: 'dir', target: '../escape' },
            { kind: 'dir', target: 'repo/' },
            { kind: 'dir', target: 'repo/src/' },
          ],
        },
      })
    );

    const result = loadAgentManifests(dataRoot);

    expect(result.manifests).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toMatch(
      /absolute|parent-directory|overlap/
    );
  });

  it('rejects credential refs on agent.local MCP entries', () => {
    const { dataRoot, agentsRoot } = createAgentRoot();
    writeFileSync(
      join(agentsRoot, 'unsafe-mcp.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent_unsafe_mcp',
        displayName: 'Unsafe MCP',
        runtime: { kind: 'codex', adapter: 'codex-app-server' },
        mode: 'local',
        deployment: {},
        mcp: [{ id: 'github', mode: 'agent.local', credentialRef: 'env:GITHUB_TOKEN' }],
      })
    );

    const result = loadAgentManifests(dataRoot);

    expect(result.manifests).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'agent.invalid_manifest',
        message: expect.stringContaining('agent.local MCP entries must not declare credentials'),
        severity: 'error',
        agentId: 'agent_unsafe_mcp',
      }),
    ]);
  });
});
