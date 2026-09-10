import { AuthoredAgentConfigSchema, getConfigSchemaCatalog } from '@openkit/config-schema';

import { parseJsoncObject } from '../config/jsonc.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import type { AgentTool, AgentToolResult } from '../internal-agents/internal-agent-loop.js';

/** Configuration Tools fixed by the private administration contract. */
export type AdministrationConfigurationTools = readonly [AgentTool, AgentTool, AgentTool];

/**
 * Creates the redacted Server Agent configuration inspection Tools for one admitted snapshot.
 *
 * @param snapshot Immutable runtime configuration admitted for this Turn.
 * @returns Read, schema, and typed-unavailable proposal Tools in stable order.
 */
export function createAdministrationConfigurationTools(
  snapshot: RuntimeConfigSnapshot,
  files: Pick<RuntimeConfigFileService, 'listFiles' | 'readFile'>
): AdministrationConfigurationTools {
  return [
    {
      name: 'administration.configuration.read',
      description:
        'List current Server Agent configuration targets or read one exact target for environment preparation.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetFamily: { const: 'agent' },
          agentId: { type: 'string', minLength: 1 },
        },
        required: ['targetFamily'],
      },
      execute: async (value) => readAgentConfiguration(snapshot, files, value),
    },
    {
      name: 'administration.schema.read',
      description:
        'Read the registered Agent configuration schema used to validate a Server Agent and its runtime image declaration.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { targetFamily: { const: 'agent' } },
        required: ['targetFamily'],
      },
      execute: async () => {
        const entry = getConfigSchemaCatalog().find((candidate) => candidate.kind === 'agent');
        if (!entry) return configurationFailure('configuration_schema_unavailable');
        return configurationResult({
          targetFamily: 'agent',
          title: entry.title,
          schema: entry.schema,
        });
      },
    },
    unavailableProposalTool(),
  ];
}

function readAgentConfiguration(
  snapshot: RuntimeConfigSnapshot,
  files: Pick<RuntimeConfigFileService, 'listFiles' | 'readFile'>,
  value: unknown
): AgentToolResult {
  const args = value as { agentId?: string };
  if (!args.agentId) {
    return configurationResult({
      targetFamily: 'agent',
      agents: snapshot.agentManifests.flatMap((manifest) => {
        const source = findAgentSource(files, manifest.id);
        return source
          ? [
              {
                configuration: {
                  expectedRevision: source.revision,
                  fileId: source.fileId,
                },
                displayName: manifest.displayName,
                target: { agentId: manifest.id, kind: 'agent' },
              },
            ]
          : [];
      }),
    });
  }
  const manifest = snapshot.agentManifests.find((candidate) => candidate.id === args.agentId);
  if (!manifest) return configurationFailure('configuration_target_not_found');
  const source = findAgentSource(files, manifest.id);
  if (!source) return configurationFailure('configuration_target_not_found');

  return configurationResult({
    targetFamily: 'agent',
    target: { kind: 'agent', agentId: manifest.id },
    configuration: {
      expectedRevision: source.revision,
      fileId: source.fileId,
    },
    runtimeConfig: {
      version: snapshot.version,
      contentHash: snapshot.contentHash,
    },
    agent: {
      id: manifest.id,
      displayName: manifest.displayName,
      defaultProfileId: manifest.defaultProfileId ?? null,
      models: manifest.models,
      runtime: manifest.runtime,
      readiness: manifest.readiness ?? null,
    },
    excludedFields: [
      'credential declarations',
      'extensions',
      'host paths',
      'permissions',
      'raw configuration text',
    ],
  });
}

function findAgentSource(
  files: Pick<RuntimeConfigFileService, 'listFiles' | 'readFile'>,
  agentId: string
): { readonly fileId: string; readonly revision: string } | null {
  try {
    for (const file of files.listFiles().files) {
      if (file.kind !== 'agent') continue;
      const source = files.readFile(file.id);
      const parsed = AuthoredAgentConfigSchema.safeParse(parseJsoncObject(source.content, file.id));
      if (
        parsed.success &&
        parsed.data.id === agentId &&
        source.file.id === file.id &&
        source.file.kind === 'agent' &&
        typeof source.file.revision === 'string'
      ) {
        return { fileId: source.file.id, revision: source.file.revision };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function unavailableProposalTool(): AgentTool {
  return {
    name: 'administration.configuration.propose',
    description:
      'Configuration proposal creation is unavailable until its immutable candidate owner is implemented.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    execute: async () => configurationFailure('configuration_proposal_unavailable'),
  };
}

function configurationResult(value: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function configurationFailure(code: string): AgentToolResult {
  const message =
    code === 'configuration_target_not_found'
      ? 'The requested Server Agent configuration is unavailable.'
      : code === 'configuration_schema_unavailable'
        ? 'The registered Agent schema is unavailable.'
        : 'Configuration proposal creation is unavailable in the current NanoCore slice.';
  return { content: [{ type: 'text', text: JSON.stringify({ code, message }) }], isError: true };
}
