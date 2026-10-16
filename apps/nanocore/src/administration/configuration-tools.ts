import {
  ApplyDelegatedAdministrationConfigurationRequestSchema,
  ProposeAdministrationConfigurationRequestSchema,
  WorkerGitReadConfigurationProposalSchema,
} from '@openkit/app-api-schemas';
import { type AuthoredAgentConfig, getConfigSchemaCatalog } from '@openkit/config-schema';
import { z } from 'zod';

import type { createAdministrationConfiguration } from '../config/administration-configuration.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import {
  type RuntimeConfigFileService,
  RuntimeConfigFileServiceError,
} from '../config/runtime-config-files.js';
import { findRegisteredAgentConfiguration } from '../config/worker-git-read-correction.js';
import type { AgentTool, AgentToolResult } from '../internal-agents/internal-agent-loop.js';

/** Configuration Tools fixed by the private administration contract. */
export type AdministrationConfigurationTools = readonly [
  AgentTool,
  AgentTool,
  AgentTool,
  AgentTool,
];

/**
 * Creates bounded administration configuration Tools for one admitted snapshot.
 *
 * @param snapshot Immutable runtime configuration admitted for this Turn.
 * @returns Read, schema, immutable proposal and bounded delegated apply Tools in stable order.
 */
export function createAdministrationConfigurationTools(
  snapshot: RuntimeConfigSnapshot,
  files: Pick<RuntimeConfigFileService, 'listFiles' | 'readFile'>,
  catalog: Pick<ReturnType<typeof createAdministrationConfiguration>, 'read' | 'schema'> & {
    propose: (value: unknown) => unknown;
    applyDelegated: (value: unknown, context: Parameters<AgentTool['execute']>[1]) => unknown;
  }
): AdministrationConfigurationTools {
  return [
    {
      name: 'administration.configuration.read',
      description:
        'List or read current Agent, Provider or Gateway configuration. Agent detail includes its current network rules and exact source revision. Provider/Gateway reads return editable catalog fields and the exact revision; use targetId gateway for Gateway.',
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
        'Read the registered Agent schema for image preparation and its finite Git-read proposal shape, or allowed Provider/Gateway catalog change fields. Configuration application excludes credential and endpoint changes.',
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
          gitReadCorrection: z.toJSONSchema(WorkerGitReadConfigurationProposalSchema),
        });
      },
    },
    {
      name: 'administration.configuration.propose',
      description:
        'Publish an immutable registered Provider, Gateway or finite Worker Git-read candidate. Include the exact failed Turn for a Worker correction. This Tool never writes configuration.',
      inputSchema: z.toJSONSchema(ProposeAdministrationConfigurationRequestSchema),
      execute: async (value) => catalogResult(() => catalog.propose(value)),
    },
    {
      name: 'administration.configuration.apply',
      description:
        'Apply an exact Worker Git-read candidate only under the current finite Server Policy assignment. Provider and Gateway candidates require human confirmation through their public command. Inspect the receipt and source after an unknown outcome; do not regenerate a request to retry.',
      inputSchema: z.toJSONSchema(ApplyDelegatedAdministrationConfigurationRequestSchema),
      execute: async (value, context) => applyResult(() => catalog.applyDelegated(value, context)),
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
  if (!snapshot.agentManifests.some((candidate) => candidate.id === args.agentId))
    return configurationFailure('configuration_target_not_found');
  const source = findAgentSource(files, args.agentId);
  if (!source) return configurationFailure('configuration_target_not_found');
  // Inspection describes authored bytes at this revision, not the last loaded snapshot.
  const manifest = source.manifest;

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
      sandbox: { network: manifest.sandbox?.network ?? [] },
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

/** One validated registered source, with revision and fields from the same read. */
interface AgentConfigurationSource {
  readonly fileId: string;
  readonly revision: string;
  readonly manifest: AuthoredAgentConfig;
}

/** Finds one unambiguous registered Agent identity without accepting caller-selected paths. */
function findAgentSource(
  files: Pick<RuntimeConfigFileService, 'listFiles' | 'readFile'>,
  agentId: string
): AgentConfigurationSource | null {
  try {
    const source = findRegisteredAgentConfiguration(files, agentId);
    return {
      fileId: source.read.file.id,
      revision: source.read.file.revision!,
      manifest: source.value,
    };
  } catch {
    return null;
  }
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

/** A mutating owner can fail after CAS; unclassified failures must retain the existing inspection fence. */
async function applyResult(operation: () => unknown): Promise<AgentToolResult> {
  try {
    return configurationResult(await operation());
  } catch (error) {
    return configurationFailure(
      error instanceof RuntimeConfigFileServiceError
        ? error.code
        : 'configuration_recovery_required'
    );
  }
}

function configurationResult(value: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function configurationFailure(code: string): AgentToolResult {
  const message =
    code === 'configuration_recovery_required'
      ? 'Configuration application could not be confirmed. Inspect the exact receipt, start status Item, outcome Artifact, current source revision and loaded state before a new request. Do not repeat an unknown effect.'
      : code === 'configuration_target_not_found'
        ? 'The requested Server Agent configuration is unavailable.'
        : code === 'configuration_schema_unavailable'
          ? 'The registered Agent schema is unavailable.'
          : 'Configuration request was rejected. Read the current target and allowed schema before proposing again.';
  return { content: [{ type: 'text', text: JSON.stringify({ code, message }) }], isError: true };
}
