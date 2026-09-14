import { PrepareWorkerEnvironmentRequestSchema } from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';

import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createAdministrationConfigurationTools } from './configuration-tools.js';

const CONFIG_REVISION = `sha256:${'a'.repeat(64)}`;

function configFiles(manifest: object, revision = CONFIG_REVISION) {
  return {
    listFiles: () => ({
      files: [{ id: 'agents/codex.agent.jsonc', kind: 'agent', exists: true, revision }],
    }),
    readFile: () => ({
      file: { id: 'agents/codex.agent.jsonc', kind: 'agent', exists: true, revision },
      content: JSON.stringify(manifest),
    }),
  } as never;
}

describe('administration configuration Tools', () => {
  it('discovers exact Server Agent sources and returns prepare-ready target and configuration', async () => {
    const manifest = {
      ...createTestAgentSetup().manifest,
      extensions: { privatePath: '/var/lib/openkit/private', token: 'provider-secret' },
      permissions: { hidden: 'tenant-row' },
    };
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      dataRoot: null,
      version: 7,
      agentManifests: [manifest],
    });
    const tools = createAdministrationConfigurationTools(snapshot, configFiles(manifest), {
      read: vi.fn(),
      schema: vi.fn(),
      propose: vi.fn(),
    });
    expect(tools[0].inputSchema).toEqual({
      additionalProperties: false,
      properties: {
        agentId: { minLength: 1, type: 'string' },
        targetFamily: { enum: ['agent', 'provider', 'gateway'] },
        targetId: { minLength: 1, type: 'string' },
      },
      required: ['targetFamily'],
      type: 'object',
    });

    const listed = await tools[0].execute(
      { targetFamily: 'agent' },
      { callId: 'call_list', signal: new AbortController().signal }
    );
    const catalog = JSON.parse(listed.content[0]!.type === 'text' ? listed.content[0]!.text : '{}');
    expect(catalog.agents).toEqual([
      {
        configuration: {
          expectedRevision: CONFIG_REVISION,
          fileId: 'agents/codex.agent.jsonc',
        },
        displayName: manifest.displayName,
        target: { agentId: manifest.id, kind: 'agent' },
      },
    ]);

    const result = await tools[0].execute(
      { targetFamily: 'agent', agentId: manifest.id },
      { callId: 'call_read', signal: new AbortController().signal }
    );
    const serialized = JSON.stringify(result.content);
    const payload = JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}');

    expect(serialized).not.toContain('expectedTargetRevision');
    expect(payload.runtimeConfig.version).toBe(7);
    expect(payload.target).toEqual({ agentId: manifest.id, kind: 'agent' });
    expect(payload.configuration).toEqual({
      expectedRevision: CONFIG_REVISION,
      fileId: 'agents/codex.agent.jsonc',
    });
    expect(serialized).toContain(manifest.runtime.image.ref);
    expect(serialized).not.toContain('worker-profile');
    expect(serialized).not.toContain('profileId');
    expect(serialized).not.toContain('/var/lib/openkit/private');
    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('tenant-row');
    expect(
      PrepareWorkerEnvironmentRequestSchema.parse({
        administrationThreadId: 'thread_administration',
        configuration: payload.configuration,
        declaration: payload.agent.runtime.image,
        mode: 'prepare',
        replaceNow: null,
        requestId: '11111111-1111-4111-8111-111111111111',
        target: payload.target,
      })
    ).toMatchObject({
      configuration: payload.configuration,
      declaration: payload.agent.runtime.image,
      target: payload.target,
    });
  });

  it('routes an authorized provider catalog proposal to its candidate owner', async () => {
    const snapshot = createInMemoryRuntimeConfigSnapshot({ dataRoot: null });
    const proposal = {
      targetFamily: 'provider',
      targetId: 'codex',
      expectedRevision: CONFIG_REVISION,
      changes: { models: ['gpt-6'] },
    };
    const tools = createAdministrationConfigurationTools(snapshot, configFiles({}), {
      propose: async (value: unknown) => ({ candidate: 'immutable-candidate', input: value }),
    } as never);
    const result = await tools[2].execute(proposal, {
      callId: 'catalog',
      signal: new AbortController().signal,
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('immutable-candidate');
  });

  it('returns the exact registered Agent schema', async () => {
    const snapshot = createInMemoryRuntimeConfigSnapshot({ dataRoot: null });
    const tools = createAdministrationConfigurationTools(snapshot, configFiles({}), {
      read: vi.fn(),
      schema: vi.fn(),
      propose: vi.fn(),
    });

    const schema = await tools[1].execute(
      { targetFamily: 'agent' },
      { callId: 'call_schema', signal: new AbortController().signal }
    );
    expect(JSON.stringify(schema.content)).toContain('OpenKit agent config');
    expect(JSON.stringify(schema.content)).toContain('pullPolicy');
  });
});
