import { describe, expect, it, vi } from 'vitest';

import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import {
  ADMINISTRATION_TOOL_NAMES,
  type AdministrationEnvironmentTools,
  createAdministrationTools,
} from './administration-tools.js';
import type { AdministrationConfigurationTools } from './configuration-tools.js';

function configurationTools(
  execute = vi.fn(async () => ({ content: [] }))
): AdministrationConfigurationTools {
  return ADMINISTRATION_TOOL_NAMES.slice(0, 3).map((name) => ({
    name,
    description: `Execute ${name}.`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    execute,
  })) as unknown as AdministrationConfigurationTools;
}

function environmentTools(
  execute = vi.fn(async () => ({ content: [] }))
): AdministrationEnvironmentTools {
  return ADMINISTRATION_TOOL_NAMES.slice(3, 6).map((name) => ({
    name,
    description: `Execute ${name}.`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    execute,
  })) as unknown as AdministrationEnvironmentTools;
}

function runtimeTargetTool(execute = vi.fn(async () => ({ content: [] }))): AgentTool {
  return {
    name: 'nanohost.runtime-target',
    description: 'Execute nanohost.runtime-target.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    execute,
  };
}

describe('administration Tool assembly', () => {
  it('keeps the accepted fixed order and rechecks current administrator authority per call', async () => {
    const requireCurrentAdministrator = vi.fn();
    const execute = vi.fn(async () => ({ content: [] }));
    const tools = createAdministrationTools({
      configurationTools: configurationTools(),
      requireCurrentAdministrator,
      environmentTools: environmentTools(execute),
      runtimeTargetTool: runtimeTargetTool(),
    });

    expect(tools.map((tool) => tool.name)).toEqual(ADMINISTRATION_TOOL_NAMES);
    await tools[3]!.execute({}, { callId: 'call_1', signal: new AbortController().signal });
    await tools[3]!.execute({}, { callId: 'call_2', signal: new AbortController().signal });

    expect(requireCurrentAdministrator).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('keeps configuration operations present and authority guarded', async () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const tools = createAdministrationTools({
      configurationTools: configurationTools(execute),
      requireCurrentAdministrator: vi.fn(),
      environmentTools: environmentTools(),
      runtimeTargetTool: runtimeTargetTool(),
    });
    const result = await tools[0]!.execute(
      {},
      { callId: 'call_configuration', signal: new AbortController().signal }
    );

    expect(result).toEqual({ content: [] });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('denies nanohost.runtime-target after administrator authority is revoked', async () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const requireCurrentAdministrator = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error('Current deployment administrator authority is required.');
      });
    const tools = createAdministrationTools({
      configurationTools: configurationTools(),
      requireCurrentAdministrator,
      environmentTools: environmentTools(),
      runtimeTargetTool: runtimeTargetTool(execute),
    });

    await tools[6]!.execute({}, { callId: 'call_ready', signal: new AbortController().signal });
    await expect(
      tools[6]!.execute({}, { callId: 'call_revoked', signal: new AbortController().signal })
    ).rejects.toThrow('Current deployment administrator authority is required.');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects renamed or effectful environment slots before provider contact', () => {
    const invalid = environmentTools().map((tool) => ({ ...tool })) as AgentTool[];
    invalid[2] = { ...invalid[2]!, name: 'worker_environment.activate' };

    expect(() =>
      createAdministrationTools({
        configurationTools: configurationTools(),
        requireCurrentAdministrator: vi.fn(),
        environmentTools: invalid as unknown as AdministrationEnvironmentTools,
        runtimeTargetTool: runtimeTargetTool(),
      })
    ).toThrow('Administration environment Tool assembly is invalid.');
  });

  it('rejects a renamed NanoHost RuntimeTarget Tool before provider contact', () => {
    expect(() =>
      createAdministrationTools({
        configurationTools: configurationTools(),
        requireCurrentAdministrator: vi.fn(),
        environmentTools: environmentTools(),
        runtimeTargetTool: { ...runtimeTargetTool(), name: 'nanohost.enroll' },
      })
    ).toThrow('Administration NanoHost RuntimeTarget Tool assembly is invalid.');
  });
});
