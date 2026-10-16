import type { WorkerSandboxAccess } from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';

import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { AgentToolResult } from '../internal-agents/internal-agent-loop.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createAdministrationConfigurationTools } from './configuration-tools.js';

const FILE_ID = 'agents/codex.agent.jsonc';
const LIST_REVISION = `sha256:${'a'.repeat(64)}`;
const CURRENT_REVISION = `sha256:${'b'.repeat(64)}`;
const NEXT_REVISION = `sha256:${'c'.repeat(64)}`;
const PRIVATE_CANARY = 'private-diagnostic-canary';
const RAW_CANARY = 'raw-jsonc-comment-canary';
const FILESYSTEM_CANARY = '/private-filesystem-canary';
const CREDENTIAL_CANARY = 'credential-declaration-canary';

const CURRENT_NETWORK: WorkerSandboxAccess['network'] = [
  {
    id: 'git-read',
    host: 'git.example.com',
    port: 443,
    protocol: 'rest',
    purpose: 'Read the requested Git commit',
    binaries: ['/usr/local/bin/codex'],
    scope: 'session',
    rules: [
      { method: 'GET', path: '/team/project.git/info/refs?service=git-upload-pack' },
      { method: 'POST', path: '/team/project.git/git-upload-pack' },
    ],
    publicAccess: { kind: 'credential-free-non-llm' },
  },
];

/** Supplies only the registered source boundary; parsing and Tool execution remain real. */
function registeredFiles(content: string, revision = CURRENT_REVISION) {
  return {
    listFiles: vi.fn(() => ({
      files: [{ id: FILE_ID, kind: 'agent', exists: true, revision: LIST_REVISION }],
    })),
    readFile: vi.fn((_id: string) => ({
      file: { id: FILE_ID, kind: 'agent', exists: true, revision },
      content,
    })),
  };
}

/** Builds a stale loaded snapshot separately from the current authored source. */
function readFixture(
  files: ReturnType<typeof registeredFiles>,
  loadedNetwork: WorkerSandboxAccess['network'] = []
) {
  const loaded = createTestAgentSetup({
    displayName: 'Loaded Agent name',
    imageRef: 'openkit/worker-codex:loaded',
    network: loadedNetwork,
  }).manifest;
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot: null,
    version: 17,
    agentManifests: [loaded],
  });
  const tools = createAdministrationConfigurationTools(snapshot, files as never, {
    read: vi.fn(),
    schema: vi.fn(),
    propose: vi.fn(),
  });
  return {
    files,
    snapshot,
    read: () =>
      tools[0].execute(
        { targetFamily: 'agent', agentId: loaded.id },
        { callId: 'network-read', toolOccurrence: 1, signal: new AbortController().signal }
      ),
  };
}

/** Reads the Tool's JSON text result without hiding malformed responses. */
function payload(result: AgentToolResult) {
  const content = result.content[0];
  if (content?.type !== 'text') throw new Error('Expected a JSON text Tool result.');
  return JSON.parse(content.text);
}

function currentManifest(network = CURRENT_NETWORK) {
  return createTestAgentSetup({
    displayName: 'Current authored Agent name',
    imageRef: 'openkit/worker-codex:current',
    network,
  }).manifest;
}

describe('registered Worker network configuration inspection', () => {
  it('returns the exact validated authored network with the existing Agent read metadata', async () => {
    const current = currentManifest();
    const fixture = readFixture(registeredFiles(JSON.stringify(current)));
    const result = await fixture.read();

    expect(result.isError).not.toBe(true);
    expect(payload(result)).toEqual({
      targetFamily: 'agent',
      target: { kind: 'agent', agentId: current.id },
      configuration: { fileId: FILE_ID, expectedRevision: CURRENT_REVISION },
      runtimeConfig: { version: 17, contentHash: fixture.snapshot.contentHash },
      agent: {
        id: current.id,
        displayName: current.displayName,
        defaultProfileId: current.defaultProfileId,
        models: current.models,
        runtime: current.runtime,
        readiness: null,
        sandbox: { network: CURRENT_NETWORK },
      },
      excludedFields: [
        'credential declarations',
        'extensions',
        'host paths',
        'permissions',
        'raw configuration text',
      ],
    });
    expect(fixture.files.readFile).toHaveBeenCalledExactlyOnceWith(FILE_ID);
  });

  it('binds each current network to the revision from the same registered source read', async () => {
    const current = currentManifest();
    const nextNetwork = [{ ...CURRENT_NETWORK[0]!, host: 'mirror.example.com' }];
    const files = registeredFiles(JSON.stringify(current));
    const fixture = readFixture(files);
    const first = payload(await fixture.read());
    files.readFile.mockReturnValue({
      file: { id: FILE_ID, kind: 'agent', exists: true, revision: NEXT_REVISION },
      content: JSON.stringify(currentManifest(nextNetwork)),
    });
    const second = payload(await fixture.read());

    expect(first.configuration.expectedRevision).toBe(CURRENT_REVISION);
    expect(first.agent.sandbox).toEqual({ network: CURRENT_NETWORK });
    expect(second.configuration.expectedRevision).toBe(NEXT_REVISION);
    expect(second.agent.sandbox).toEqual({ network: nextNetwork });
    expect(files.readFile.mock.calls).toEqual([[FILE_ID], [FILE_ID]]);
  });

  it('reports an empty current network without substituting loaded network rules', async () => {
    const fixture = readFixture(
      registeredFiles(JSON.stringify(currentManifest([]))),
      CURRENT_NETWORK
    );
    const result = await fixture.read();

    expect(result.isError).not.toBe(true);
    expect(payload(result).agent.sandbox).toEqual({ network: [] });
  });

  it('excludes unrelated source fields, credential declarations and raw JSONC', async () => {
    const current = {
      ...currentManifest(),
      extensions: { private: PRIVATE_CANARY },
      permissions: { private: PRIVATE_CANARY },
    };
    current.sandbox.filesystem = [
      {
        id: 'private-filesystem',
        targetPath: FILESYSTEM_CANARY,
        access: 'read-only',
        purpose: PRIVATE_CANARY,
        scope: 'session',
      },
    ];
    current.sandbox.credentialDeclarations = [
      {
        id: CREDENTIAL_CANARY,
        vaultGrantId: CREDENTIAL_CANARY,
        visibility: 'runtime-env',
        targetEnvVarName: 'PRIVATE_CREDENTIAL_CANARY',
      },
    ];
    const fixture = readFixture(registeredFiles(`// ${RAW_CANARY}\n${JSON.stringify(current)}`));
    const result = await fixture.read();
    const serialized = JSON.stringify(result);

    expect(result.isError).not.toBe(true);
    for (const canary of [PRIVATE_CANARY, FILESYSTEM_CANARY, CREDENTIAL_CANARY, RAW_CANARY]) {
      expect(serialized).not.toContain(canary);
    }
    expect(payload(result).agent.sandbox).toEqual({ network: CURRENT_NETWORK });
  });

  it.each([
    ['malformed JSONC', `{ "private": "${PRIVATE_CANARY}",`],
    [
      'invalid network authority',
      JSON.stringify(
        currentManifest([
          { ...CURRENT_NETWORK[0]!, host: '*.example.com', purpose: PRIVATE_CANARY },
        ])
      ),
    ],
    [
      'invalid unrelated source field',
      JSON.stringify({
        ...currentManifest(),
        runtime: { kind: PRIVATE_CANARY },
      }),
    ],
    ['changed Agent identity', JSON.stringify({ ...currentManifest(), id: PRIVATE_CANARY })],
  ])('fails safely for %s', async (_reason, content) => {
    const fixture = readFixture(registeredFiles(content));
    const result = await fixture.read();

    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('configuration_target_not_found');
    expect(JSON.stringify(result)).not.toContain(PRIVATE_CANARY);
    expect(payload(result)).not.toHaveProperty('agent');
  });

  it('fails safely when the registered source is missing', async () => {
    const files = registeredFiles(JSON.stringify(currentManifest()));
    files.readFile.mockImplementation(() => {
      throw new Error(PRIVATE_CANARY);
    });
    const result = await readFixture(files).read();

    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('configuration_target_not_found');
    expect(JSON.stringify(result)).not.toContain(PRIVATE_CANARY);
  });

  it('does not read an unregistered source', async () => {
    const files = registeredFiles(JSON.stringify(currentManifest()));
    files.listFiles.mockReturnValue({ files: [] });
    const result = await readFixture(files).read();

    expect(result.isError).toBe(true);
    expect(files.readFile).not.toHaveBeenCalled();
  });

  it('fails safely when two registered files claim the same Agent identity', async () => {
    const files = registeredFiles(JSON.stringify(currentManifest()));
    const secondFileId = 'agents/duplicate.agent.jsonc';
    files.listFiles.mockReturnValue({
      files: [FILE_ID, secondFileId].map((id) => ({
        id,
        kind: 'agent',
        exists: true,
        revision: LIST_REVISION,
      })),
    });
    files.readFile.mockImplementation((id: string) => ({
      file: { id, kind: 'agent', exists: true, revision: CURRENT_REVISION },
      content: JSON.stringify(currentManifest()),
    }));
    const result = await readFixture(files).read();

    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('configuration_target_not_found');
    expect(payload(result)).not.toHaveProperty('agent');
  });
});
