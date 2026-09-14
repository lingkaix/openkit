import { ProposeAdministrationConfigurationRequestSchema } from '@openkit/app-api-schemas';
import { AuthoredAgentConfigSchema, getConfigSchemaCatalog } from '@openkit/config-schema';
import { z } from 'zod';

import type { createAdministrationConfiguration } from '../config/administration-configuration.js';
import { parseJsoncObject } from '../config/jsonc.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import {
  type RuntimeConfigFileService,
  RuntimeConfigFileServiceError,
} from '../config/runtime-config-files.js';
import type { AgentTool, AgentToolResult } from '../internal-agents/internal-agent-loop.js';

/** Configuration Tools fixed by the private administration contract. */
export type AdministrationConfigurationTools = readonly [AgentTool, AgentTool, AgentTool];

/**
 * Creates bounded administration configuration Tools for one admitted snapshot.
 *
 * @param snapshot Immutable runtime configuration admitted for this Turn.
 * @returns Read, schema, and immutable proposal Tools in stable order.
 */
export function createAdministrationConfigurationTools(
  snapshot: RuntimeConfigSnapshot,
  files: Pick<RuntimeConfigFileService, 'listFiles' | 'readFile'>,
  catalog: Pick<ReturnType<typeof createAdministrationConfiguration>, 'read' | 'schema'> & {
    propose: (value: unknown) => unknown;
  }
): AdministrationConfigurationTools {
  return [
    {
      name: 'administration.configuration.read',
      description:
        'List or read current Agent, Provider or Gateway configuration. Provider/Gateway reads return editable catalog fields and the exact revision; use targetId gateway for Gateway.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetFamily: { enum: ['agent', 'provider', 'gateway'] },
          targetId: { type: 'string', minLength: 1 },
          agentId: { type: 'string', minLength: 1 },
        },
        required: ['targetFamily'],
      },
      execute: async (value) => {
        const args = value as { targetFamily: string; targetId?: string };
        if (args.targetFamily === 'agent') return readAgentConfiguration(snapshot, files, value);
        if (args.targetFamily !== 'gateway' && args.targetFamily !== 'provider')
          return configurationFailure('configuration_target_not_found');
        return catalogResult(() =>
          catalog.read(args.targetFamily as 'gateway' | 'provider', args.targetId)
        );
      },
    },
    {
      name: 'administration.schema.read',
      description:
        'Read the registered Agent schema or allowed Provider/Gateway catalog change fields. Credential and endpoint changes are excluded.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { targetFamily: { enum: ['agent', 'provider', 'gateway'] } },
        required: ['targetFamily'],
      },
      execute: async (value) => {
        const family = (value as { targetFamily: string }).targetFamily;
        if (family !== 'agent') {
          if (family !== 'gateway' && family !== 'provider')
            return configurationFailure('configuration_schema_unavailable');
          return catalogResult(() => catalog.schema(family));
        }
        const entry = getConfigSchemaCatalog().find((candidate) => candidate.kind === 'agent');
        if (!entry) return configurationFailure('configuration_schema_unavailable');
        return configurationResult({
          targetFamily: 'agent',
          title: entry.title,
          schema: entry.schema,
        });
      },
    },
    {
      name: 'administration.configuration.propose',
      description:
        'Validate an update to an existing Provider catalog or Gateway logical-model bindings and publish an immutable candidate preview. A human confirms its digest through administration.configuration.apply; this Tool never writes configuration.',
      inputSchema: z.toJSONSchema(ProposeAdministrationConfigurationRequestSchema),
      execute: async (value) => catalogResult(() => catalog.propose(value)),
    },
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

/** Maps private owner failures without exposing raw validator input or configuration. */
async function catalogResult(operation: () => unknown): Promise<AgentToolResult> {
  try {
    return configurationResult(await operation());
  } catch (error) {
    return configurationFailure(
      error instanceof RuntimeConfigFileServiceError ? error.code : 'configuration_request_rejected'
    );
  }
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
        : 'Configuration request was rejected. Read the current target and allowed schema before proposing again.';
  return { content: [{ type: 'text', text: JSON.stringify({ code, message }) }], isError: true };
}
