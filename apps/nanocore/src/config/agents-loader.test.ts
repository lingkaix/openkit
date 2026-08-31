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

/**
 * Creates one complete opaque runtime declaration for loader fixtures.
 *
 * @param kind Descriptive runtime kind.
 * @param adapter Opaque worker-side adapter id.
 * @returns Authored runtime declaration.
 */
function workerRuntime(kind = 'codex', adapter = 'codex-app-server'): Record<string, unknown> {
  return {
    adapter,
    binaries: [
      { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
      { id: kind, path: `/usr/local/bin/${kind}` },
    ],
    image: {
      kind: 'reference',
      pullPolicy: 'if-not-present',
      ref: `ghcr.io/openkit/worker-${kind}:test`,
    },
    kind,
  };
}

function logicalModels() {
  return { preferredLogicalModelId: 'reasoning', allowedLogicalModelIds: ['reasoning'] };
}

describe('loadAgentManifests', () => {
  it('loads authored agent config templates copied by ensureLayout', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-agents-'));

    ensureLayout(dataRoot);

    const result = loadAgentManifests(dataRoot);
    const codexManifest = result.manifests.find((manifest) => manifest.id === 'agent_codex_host');

    expect(result.diagnostics).toEqual([]);
    expect(result).not.toHaveProperty('configs');
    expect(result.manifests.every((manifest) => manifest.runtime.image.kind === 'reference')).toBe(
      true
    );
    expect(codexManifest?.sandbox?.backend?.requiredCapabilities).toEqual(
      expect.arrayContaining(['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'])
    );
    expect(result.manifests.every((manifest) => manifest.readiness?.status !== 'unknown')).toBe(
      true
    );
    expect(result.manifests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: 'Codex Agent',
          id: 'agent_codex_host',
          models: expect.objectContaining({ preferredLogicalModelId: 'reasoning' }),
          runtime: expect.objectContaining({ kind: 'codex' }),
        }),
        expect.objectContaining({
          displayName: 'OpenCode Agent',
          id: 'agent_opencode_server',
          models: expect.objectContaining({ preferredLogicalModelId: 'reasoning' }),
          runtime: expect.objectContaining({ kind: 'opencode' }),
        }),
        expect.objectContaining({
          displayName: 'Pi Agent',
          id: 'agent_pi',
          models: expect.objectContaining({ preferredLogicalModelId: 'claude' }),
          readiness: expect.objectContaining({ status: 'disabled' }),
          runtime: expect.objectContaining({ adapter: 'pi', kind: 'pi' }),
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
        extensions: {
          vendorFeature: {
            enabled: true,
          },
        },
        id: 'agent_extended',
        models: logicalModels(),
        runtime: { ...workerRuntime('custom', 'custom-http'), version: '0.0.1' },
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

  it('loads the unified authored AgentManifest without an execution-topology projection', () => {
    const { dataRoot, agentsRoot } = createAgentRoot();
    writeFileSync(
      join(agentsRoot, 'codex-v004.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent_codex_host',
        displayName: 'Codex Agent',
        models: logicalModels(),
        runtime: { ...workerRuntime(), version: '0.130.0' },
        sandbox: {
          backend: {
            allowedKinds: ['openshell'],
            preferred: 'openshell',
            requiredCapabilities: [],
          },
          credentialDeclarations: [],
          filesystem: [],
          network: [
            {
              id: 'openrouter',
              host: 'api.openrouter.ai',
              port: 443,
              protocol: 'https',
              access: 'read-write',
              purpose: 'Use a declared runtime endpoint.',
              binaries: ['/usr/local/bin/codex'],
            },
          ],
        },
      })
    );

    const result = loadAgentManifests(dataRoot);

    expect(result.diagnostics).toEqual([]);
    expect(result.manifests).toEqual([
      expect.objectContaining({
        displayName: 'Codex Agent',
        id: 'agent_codex_host',
        models: logicalModels(),
        runtime: expect.objectContaining({
          adapter: 'codex-app-server',
          kind: 'codex',
        }),
        sandbox: expect.objectContaining({
          backend: expect.objectContaining({ preferred: 'openshell' }),
        }),
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
        models: logicalModels(),
        runtime: workerRuntime(),
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
        models: logicalModels(),
        runtime: workerRuntime(),
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

  it('rejects executable or credential-bearing MCP entries', () => {
    const { dataRoot, agentsRoot } = createAgentRoot();
    writeFileSync(
      join(agentsRoot, 'unsafe-mcp.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent_unsafe_mcp',
        displayName: 'Unsafe MCP',
        models: logicalModels(),
        runtime: workerRuntime(),
        mcp: [{ id: 'github', mode: 'agent.local', credentialRef: 'env:GITHUB_TOKEN' }],
      })
    );

    const result = loadAgentManifests(dataRoot);

    expect(result.manifests).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'agent.invalid_manifest',
        message: expect.stringContaining('Unrecognized keys'),
        severity: 'error',
        agentId: 'agent_unsafe_mcp',
      }),
    ]);
  });
});
