import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CapabilityUsageResponseSchema,
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
  KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
  KNOWLEDGE_OPERATION_DEFINITIONS,
  OPERATION_DEFINITIONS,
  operationHttpPath,
  PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS,
  RUNTIME_CONFIG_OPERATION_DEFINITIONS,
  SYNC_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import {
  AgentIdSchema,
  ArtifactIdSchema,
  PROTOCOL_VERSION,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import Ajv2020 from 'ajv/dist/2020.js';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PUBLIC_OPERATION_ACCESS } from './auth/operation-access.js';
import {
  APP_OPENAPI_ROUTE_COVERAGE_EXCLUSIONS,
  APP_OPENAPI_ROUTE_METHODS,
  createAppOpenApiDocument,
  getRegisteredAppApiOperationIds,
  registerAppApiRoute,
} from './openapi.js';
import { validateAppOpenApiDocument } from './openapi-validation.js';
import { createApp } from './test-support/app.js';

const OPENAPI_ROUTE_METHOD_SET = new Set<string>(
  APP_OPENAPI_ROUTE_METHODS.map((method) => method.toUpperCase())
);
const PROJECTED_APP_API_ROUTE_PATTERN = /^\/api\/(?:app|setup|admin)(?:\/|$)/;
const NON_APP_API_ROUTE_PATTERNS = [
  /^\/v1(?:\/|$)/,
  /^\/internal(?:\/|$)/,
  /^\/api\/worker-control(?:\/|$)/,
  /^\/api\/worker-inference(?:\/|$)/,
  /^\/api\/worker-capabilities(?:\/|$)/,
  /^\/api\/nanohost\/transport\/session\/admit$/,
  /^\/api\/nanohost\/transport\/effects\/(?:sandbox\.(?:create|delete)|storage\.(?:inspect|purge)|bridge\.(?:open|close)|image\.(?:acquire|build|inspect)|file\.export|reference\.import|workspace\.collect)(?:\/result)?$/,
  /^\/api\/workspaces(?:\/|$)/,
  /^\/api\/approvals(?:\/|$)/,
  /^\/api\/user-input-requests(?:\/|$)/,
  /^\/api\/pending-requests(?:\/|$)/,
  /^\/(?:api\/)?health$/,
  /^\/api\/(?:meta|diagnostics|openapi\.json)$/,
  /^\/api\/turns$/,
];
const CANONICAL_PATH_PARAMETER_REFS: Record<string, string> = {
  agentId: '#/components/schemas/AgentId',
  agentSessionId: '#/components/schemas/AgentSessionId',
  artifactId: '#/components/schemas/ArtifactId',
  threadId: '#/components/schemas/ThreadId',
  turnId: '#/components/schemas/TurnId',
  workspaceId: '#/components/schemas/WorkspaceId',
};
const PRIVATE_NANOHOST_EFFECT_ROUTES = [
  'sandbox.create',
  'sandbox.delete',
  'bridge.open',
  'bridge.close',
  'image.acquire',
  'image.build',
  'image.inspect',
  'storage.inspect',
  'storage.purge',
  'file.export',
  'reference.import',
  'workspace.collect',
].flatMap((operation) => [
  `POST /api/nanohost/transport/effects/${operation}`,
  `POST /api/nanohost/transport/effects/${operation}/result`,
]);
const SESSION_COOKIE_ONLY_ROUTES = new Set([
  'GET /api/app/auth/my-admin-tokens',
  'PUT /api/app/auth/my-admin-tokens/default',
  'POST /api/app/workspace-archives/import',
  'POST /api/app/workspace-archives/import-dry-run',
]);
const FIRST_PARTY_CONSUMER_ROOTS = [
  '../../../apps/web/src/',
  '../../../packages/core-client/src/',
  '../../../skills/',
];
const DIRECT_CORE_GATEWAY_OPERATION_KEYS = [
  'GET /api/workspaces/:workspaceId/threads/:threadId/events',
  'POST /v1/chat/completions',
  'POST /v1/responses',
] as const;
const PRODUCT_POLICY_OPERATIONS = new Set([
  'api.call',
  'workspace.read',
  'workspace.write',
  'thread.read',
  'turn.run',
  'artifact.read',
  'artifact.write',
  'review.apply',
  'approval.respond',
  'knowledge.read',
  'knowledge.write',
  'knowledge.propose',
  'audit.read',
  'workspace.configure',
  'workspace.export',
  'workspace.lifecycle',
  'membership.manage',
  'invitation.respond',
  'workspace.leave',
  'deployment.recover',
  'vault.use',
  'vault.admin',
  'tool.use',
  'tool.grant',
  'runtime.launch',
  'network.egress',
  'llm.gateway.use',
  'repo.push',
]);
const WORKSPACE_OPERATION_RESOLVERS = new Set([
  'actor-quick-chat-workspace',
  'authorized-workspace-set',
  'body-workspace',
  'opaque-child-workspace',
  'path-workspace',
  'workspace-child-lineage',
]);

function normalizeHonoRoutePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * Checks whether one runtime route belongs to the projected public App API.
 *
 * @param path Hono route path.
 * @returns True when the route must have an OpenAPI operation.
 */
function isProjectedAppApiRoute(path: string): boolean {
  return PROJECTED_APP_API_ROUTE_PATTERN.test(path);
}

describe('app api openapi projection', () => {
  it('projects the three JSON transfer definitions and removes their former bindings', () => {
    const document = createAppOpenApiDocument();
    for (const id of [
      'workspace.export',
      'workspace.import-dry-run',
      'workspace.import',
    ] as const) {
      const operation = document.paths[operationHttpPath(id)]!.post!;
      expect(operation.operationId).toBe(id);
      expect(operation.responses).toHaveProperty('200');
      expect(operation.requestBody).toHaveProperty('required', true);
    }
    for (const path of [
      '/api/app/workspaces/{workspaceId}/export',
      '/api/app/workspace-imports/dry-run',
      '/api/app/workspace-imports',
    ])
      expect(document.paths).not.toHaveProperty(path);
    expect(document.components.schemas['workspace.export.input']).toMatchObject({
      required: ['workspaceId'],
      additionalProperties: false,
    });
  });

  it('keeps AgentSession continuity out of ordinary App API operations and schemas', () => {
    const document = createAppOpenApiDocument();
    const restartPath =
      '/api/app/workspaces/{workspaceId}/runtime-config/stale-sessions/{sessionId}/restart';

    expect(document.paths[restartPath]).toBeUndefined();
    expect(document.components.schemas['thread.dashboard.output']).not.toHaveProperty(
      'properties.activeSession'
    );
    expect(JSON.stringify(document.components.schemas['thread.dashboard.output'])).not.toContain(
      'agentSessionId'
    );
    expect(JSON.stringify(document.components.schemas['conversation.submit.output'])).not.toContain(
      'agentSessionId'
    );
    expect(JSON.stringify(document.components.schemas['task.start.output'])).not.toContain(
      'agentSessionId'
    );
    expect(
      JSON.stringify(document.components.schemas.ListWorkspaceRuntimeEvidenceResponse)
    ).toContain('agentSessionId');
    expect(JSON.stringify(document)).not.toContain('"staleSessions"');
    expect(JSON.stringify(document)).not.toContain('restartRuntimeConfigStaleSession');
  });

  it('keeps AgentSession identity out of ordinary agent health refresh OpenAPI', () => {
    const schema = createAppOpenApiDocument().components.schemas.AgentHealthRefreshResponse;

    expect(schema).not.toHaveProperty('properties.sessions');
    expect(JSON.stringify(schema)).not.toContain('AgentSession');
  });

  it('does not expose arbitrary worker terminal commands', () => {
    const document = createAppOpenApiDocument();
    const serialized = JSON.stringify(document);

    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/agent-sessions/{agentSessionId}/terminal-commands'
      ]
    ).toBeUndefined();
    expect(document.components.schemas).not.toHaveProperty(
      'QueueAgentSessionTerminalCommandRequest'
    );
    expect(document.components.schemas).not.toHaveProperty(
      'QueueAgentSessionTerminalCommandResponse'
    );
    expect(serialized).not.toContain('queueAgentSessionTerminalCommand');
    expect(serialized).not.toContain('terminalResultCount');
  });

  it('does not publish caller provider or model authority for Internal Core Role requests', () => {
    const schemas = createAppOpenApiDocument().components.schemas;

    for (const name of ['chat.quick.input', 'conversation.submit.input'] as const) {
      expect(schemas[name]).toMatchObject({ additionalProperties: false });
      expect(schemas[name]).not.toHaveProperty('properties.providerId');
      expect(schemas[name]).not.toHaveProperty('properties.model');
    }
  });

  it('projects encrypted-file as the only Vault backend kind', () => {
    const schemas = createAppOpenApiDocument().components.schemas;

    for (const name of [
      'VaultAdminStatusResponse',
      'VaultAdminUnlockResponse',
      'VaultAdminLockResponse',
      'VaultAdminBootstrapCodexAuthJsonResponse',
      'VaultAdminRebindWorkspaceReferenceResponse',
    ] as const) {
      expect(schemas[name]).toMatchObject({
        properties: { backendKind: { enum: ['encrypted-file'] } },
      });
    }
    expect(schemas.VaultAdminListWorkspaceReferencesResponse).toMatchObject({
      properties: {
        items: {
          items: { properties: { backendKind: { enum: ['encrypted-file'] } } },
        },
      },
    });
    for (const name of [
      'ListWorkspaceVaultUseRecordsResponse',
      'ListServerVaultUseRecordsResponse',
    ] as const) {
      expect(schemas[name]).toMatchObject({
        properties: {
          vaultUseRecords: {
            items: { properties: { backendKind: { enum: ['encrypted-file'] } } },
          },
        },
      });
    }
  });

  it('projects all runtime and provider-subscription logical schemas and bodyless success dispositions', () => {
    const document = createAppOpenApiDocument();
    const definitions = {
      ...RUNTIME_CONFIG_OPERATION_DEFINITIONS,
      ...PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS,
    };
    expect(Object.keys(definitions)).toHaveLength(21);
    for (const [id, definition] of Object.entries(definitions)) {
      const operation = jsonObject(document.paths[operationHttpPath(id)]?.post);
      expect(operation).toMatchObject({
        operationId: id,
        tags: [id.split('.')[0]],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${id}.input` } } },
        },
      });
      expect(operation?.parameters ?? []).toEqual([]);
      const input = z.toJSONSchema(definition.inputSchema);
      const output = z.toJSONSchema(definition.outputSchema);
      expect(document.components.schemas[`${id}.input`]).toEqual(input);
      expect(document.components.schemas[`${id}.output`]).toEqual(output);
      const responses = jsonObject(operation?.responses);
      if (definition.successStatus === 204) {
        expect(responses?.['204']).toEqual({ description: expect.any(String) });
        expect(responses).not.toHaveProperty('200');
      } else {
        expect(responses?.['200']).toMatchObject({
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${id}.output` } },
          },
        });
      }
    }
    expect(
      Object.keys(document.paths).filter(
        (path) =>
          path.startsWith('/api/admin/config') || path.startsWith('/api/app/provider-subscriptions')
      )
    ).toEqual([]);
  });

  it('projects the storage layout report route from shared schemas', () => {
    const document = createAppOpenApiDocument();

    expect(document.openapi).toBe('3.1.0');
    expect(document.info.version).toBe('0.1.0');
    expect((document as Record<string, unknown>)['x-openkit-protocol-version']).toBe(
      PROTOCOL_VERSION
    );
    expect(document.info.description).toContain('Generated projection from OpenKit Zod schemas');
    expect(document['x-openkit-source-digest']).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(document.components.schemas['storage.layout-report.output']).toMatchObject({
      type: 'object',
      required: ['dataRoot', 'serverDb', 'users', 'workspaces', 'quarantineEntries'],
    });
    expect(document.paths['/api/app/operations/storage.layout-report']?.post).toMatchObject({
      operationId: 'storage.layout-report',
      tags: ['storage'],
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/storage.layout-report.output',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/diagnostics']?.get).toMatchObject({
      operationId: 'getAppDiagnostics',
      tags: ['diagnostics'],
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/AppDiagnosticsResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/setup/diagnostics']?.get).toMatchObject({
      operationId: 'getSetupDiagnostics',
      tags: ['diagnostics'],
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SetupDiagnosticsResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/agents/health/refresh']?.post
    ).toMatchObject({
      operationId: 'refreshAgentHealth',
      tags: ['app-utils'],
      parameters: [expect.objectContaining({ name: 'workspaceId', in: 'path', required: true })],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/AgentHealthRefreshResponse',
              },
            },
          },
        },
      },
    });
    expect(document.components.schemas.ListAgentCatalogResponse).toMatchObject({
      type: 'object',
      required: ['items'],
    });
    expect(document.paths['/api/app/agents']?.get).toMatchObject({
      operationId: 'listAgentCatalog',
      tags: ['agents'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListAgentCatalogResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/agents/{agentId}']?.get).toMatchObject({
      operationId: 'getAgentCatalogEntry',
      tags: ['agents'],
      parameters: [expect.objectContaining({ name: 'agentId', in: 'path', required: true })],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/GetAgentCatalogEntryResponse',
              },
            },
          },
        },
      },
    });
    expect(document.components.schemas['provider-subscription.provider-list.output']).toMatchObject(
      {
        type: 'object',
        required: ['providers'],
      }
    );
    expect(document.components.schemas['provider-subscription.account-list.output']).toMatchObject({
      type: 'object',
      required: ['accounts'],
    });
    for (const schemaName of [
      'CancelOpenAICodexOAuthRequest',
      'CodexOAuthAccountSummary',
      'CodexOAuthAccountsPayload',
      'CodexOAuthStatusPayload',
      'CreateOpenAICodexOAuthAccountRequest',
      'StartOpenAICodexOAuthRequest',
      'UpdateOpenAICodexOAuthAccountRequest',
    ]) {
      expect(document.components.schemas).not.toHaveProperty(schemaName);
    }
    expect(document.paths['/api/app/quick-chat']).toBeUndefined();
    expect(document.paths['/api/app/operations/chat.quick']?.post).toMatchObject({
      operationId: 'chat.quick',
      tags: ['chat'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/chat.quick.input',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/chat.quick.output',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/workspaces/{workspaceId}/workers']?.get).toMatchObject({
      operationId: 'listWorkspaceWorkers',
      tags: ['agents'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/WorkspaceWorkersResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/search']?.get).toMatchObject({
      operationId: 'searchApp',
      tags: ['app-utils'],
      parameters: [expect.objectContaining({ name: 'q', in: 'query', required: false })],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/AppSearchResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/turns/{turnId}/feedback']).toBeUndefined();
    expect(document.paths['/api/app/operations/turn.feedback']?.post).toMatchObject({
      operationId: 'turn.feedback',
      tags: ['turn'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/turn.feedback.input',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/turn.feedback.output',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/operations/conversation.submit']?.post).toMatchObject({
      operationId: 'conversation.submit',
      tags: ['conversation'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/conversation.submit.output' },
            },
          },
        },
        '202': {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/conversation.submit.output' },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/operations/task.start']?.post).toMatchObject({
      operationId: 'task.start',
      tags: ['task'],
      responses: {
        '202': {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/task.start.output' } },
          },
        },
      },
    });

    expect(document.paths).not.toHaveProperty(
      '/api/app/workspaces/{workspaceId}/knowledge/claims/{claimId}/promotion'
    );

    for (const path of [
      '/api/app/workspaces/{workspaceId}/knowledge/manager/context/{contextPackageId}',
      '/api/app/workspaces/{workspaceId}/knowledge/manager/context/{contextPackageId}/materialization',
    ]) {
      expect(document.paths).not.toHaveProperty(path);
    }
    const serializedDocument = JSON.stringify(document);
    for (const operationId of [
      'readKnowledgeContextPackageTrace',
      'materializeKnowledgeContextPackage',
      'readKnowledgeContextPackageMaterialization',
    ]) {
      expect(serializedDocument).not.toContain(`"operationId":"${operationId}"`);
    }
    for (const schemaName of [
      'ReadKnowledgeManagerContextPackageTraceResponse',
      'MaterializeKnowledgeContextPackageResponse',
    ]) {
      expect(document.components.schemas).not.toHaveProperty(schemaName);
    }

    expect(document.paths['/api/app/workspaces/{workspaceId}/dashboard']).toBeUndefined();
    expect(document.paths['/api/app/operations/workspace.dashboard']?.post).toMatchObject({
      operationId: 'workspace.dashboard',
      tags: ['workspace'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/workspace.dashboard.output',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/operations/thread.dashboard']?.post).toMatchObject({
      operationId: 'thread.dashboard',
      tags: ['thread'],
      requestBody: {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/thread.dashboard.input' } },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/thread.dashboard.output' },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/operations/thread.items']?.post).toMatchObject({
      operationId: 'thread.items',
      tags: ['thread'],
      requestBody: {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/thread.items.input' } },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/thread.items.output' } },
          },
        },
      },
    });
    expect(document.paths['/api/app/operations/attention.list']?.post).toMatchObject({
      operationId: 'attention.list',
      tags: ['attention'],
      responses: {
        '200': {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/attention.list.output' } },
          },
        },
      },
    });
    expect(document.paths['/api/app/workspaces/{workspaceId}/capability-usage']?.get).toMatchObject(
      {
        operationId: 'getCapabilityUsage',
        tags: ['diagnostics'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/CapabilityUsageResponse',
                },
              },
            },
          },
        },
      }
    );
    expect(document.components.schemas.CapabilityUsageResponse).toEqual(
      z.toJSONSchema(CapabilityUsageResponseSchema)
    );
    const capabilityUsage = CapabilityUsageResponseSchema.parse({
      capabilityCalls: [
        {
          agentSessionId: null,
          capabilityId: 'llm.responses',
          completedAt: '2026-07-05T00:00:02.000Z',
          errorCode: null,
          family: 'llm',
          id: 'cap_openapi',
          operation: 'responses.create',
          redactionClass: 'metadata-only',
          startedAt: '2026-07-05T00:00:01.000Z',
          status: 'succeeded',
          summary: null,
          threadId: null,
          turnId: null,
          workspaceId: 'ws_demo',
        },
      ],
      usageRecords: [],
      workspaceId: 'ws_demo',
    });
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
    const validateCapabilityUsage = ajv.compile(
      document.components.schemas.CapabilityUsageResponse
    );
    expect(validateCapabilityUsage(capabilityUsage)).toBe(true);
    expect(
      validateCapabilityUsage({
        ...capabilityUsage,
        capabilityCalls: [{ ...capabilityUsage.capabilityCalls[0], completedAt: null }],
      })
    ).toBe(false);
    expect(document.paths['/api/app/workspaces/{workspaceId}/audit/events']?.get).toMatchObject({
      operationId: 'listWorkspaceAuditEvents',
      tags: ['diagnostics'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListWorkspaceAuditEventsResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/evidence-bundles']?.post
    ).toBeUndefined();
    expect(document.components.schemas).not.toHaveProperty('CreateEvidenceBundleRequest');
    expect(document.components.schemas).not.toHaveProperty('CreateEvidenceBundleResponse');
    expect(document.paths['/api/app/workspaces/{workspaceId}/evidence-bundles']?.get).toMatchObject(
      {
        operationId: 'listWorkspaceEvidenceBundles',
        tags: ['diagnostics'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ListWorkspaceEvidenceBundlesResponse',
                },
              },
            },
          },
        },
      }
    );
    expect(document.paths['/api/app/workspaces/{workspaceId}/runtime-evidence']?.get).toMatchObject(
      {
        operationId: 'listWorkspaceRuntimeEvidence',
        tags: ['diagnostics'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ListWorkspaceRuntimeEvidenceResponse',
                },
              },
            },
          },
        },
      }
    );
    expect(document.paths['/api/app/audit/events']?.get).toMatchObject({
      operationId: 'listServerAuditEvents',
      tags: ['diagnostics'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListServerAuditEventsResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/permission-decisions']?.get
    ).toMatchObject({
      operationId: 'listWorkspacePermissionDecisions',
      tags: ['diagnostics'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListWorkspacePermissionDecisionsResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/permission-decisions']?.get).toMatchObject({
      operationId: 'listServerPermissionDecisions',
      tags: ['diagnostics'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListServerPermissionDecisionsResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/artifacts/{artifactId}/review']?.post
    ).toBeUndefined();
    expect(document.components.schemas['sync.review-list.output']).toMatchObject({
      type: 'object',
      required: ['items'],
    });
    for (const [id, definition] of Object.entries(SYNC_OPERATION_DEFINITIONS)) {
      expect(document.paths[operationHttpPath(id)]?.post).toMatchObject({
        operationId: id,
        tags: ['sync'],
        requestBody: {
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${id}.input` } } },
        },
        responses: {
          '200': {
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${id}.output` } },
            },
          },
        },
      });
      expect(document.components.schemas[`${id}.input`]).toHaveProperty('properties.workspaceId');
      if (definition.mutating)
        expect(document.paths[operationHttpPath(id)]?.post?.parameters).toContainEqual(
          expect.objectContaining({ name: 'x-openkit-request-id', in: 'header' })
        );
    }
    expect(Object.keys(document.paths).filter((path) => path.includes('/workspace-sync/'))).toEqual(
      []
    );
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/workspace-sync/evidence-bundles']
    ).toBeUndefined();
    expect(document.components.schemas).not.toHaveProperty(
      'ListWorkspaceSyncEvidenceBundlesResponse'
    );
    for (const route of [
      [
        '/api/app/workspaces/{workspaceId}/agent-environment/snapshots',
        'listAgentEnvironmentPackageSnapshots',
        'ListAgentEnvironmentPackageSnapshotsResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/agent-environment/snapshots/{snapshotId}',
        'getAgentEnvironmentPackageSnapshot',
        'GetAgentEnvironmentPackageSnapshotResponse',
      ],
    ] as const) {
      expect(document.paths[route[0]]?.get).toMatchObject({
        operationId: route[1],
        tags: ['agent-environment'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  $ref: `#/components/schemas/${route[2]}`,
                },
              },
            },
          },
        },
      });
    }
    expect(document.paths['/api/app/operations/backup.create']?.post).toMatchObject({
      operationId: 'backup.create',
      tags: ['backup'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/backup.create.output',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/operations/backup.verify']?.post).toMatchObject({
      operationId: 'backup.verify',
      tags: ['backup'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/backup.verify.input',
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/app-update/prepare']?.post).toMatchObject({
      operationId: 'prepareAppUpdate',
      tags: ['app-update'],
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/PrepareAppUpdateRequest' },
          },
        },
      },
    });
    expect(document.paths['/api/app/vault/status']?.get).toMatchObject({
      operationId: 'getVaultAdminStatus',
      tags: ['vault'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/VaultAdminStatusResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/vault/unlock']?.post).toMatchObject({
      operationId: 'unlockVaultAdminBackend',
      tags: ['vault'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/VaultAdminUnlockRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/VaultAdminUnlockResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/vault/lock']?.post).toMatchObject({
      operationId: 'lockVaultAdminBackend',
      tags: ['vault'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/VaultAdminLockResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/vault/bootstrap/codex-auth-json']?.post).toMatchObject({
      operationId: 'bootstrapCodexAuthJsonVaultReference',
      tags: ['vault'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/VaultAdminBootstrapCodexAuthJsonRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/VaultAdminBootstrapCodexAuthJsonResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/providers/{providerId}/api-key']?.put).toMatchObject({
      operationId: 'setProviderApiKey',
      tags: ['providers', 'vault'],
      parameters: [expect.objectContaining({ name: 'providerId', in: 'path', required: true })],
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SetProviderApiKeyRequest' },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SetProviderApiKeyResponse' },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/vault/references/{referenceId}/rebind']
        ?.post
    ).toMatchObject({
      operationId: 'rebindWorkspaceVaultReference',
      tags: ['vault'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'referenceId', in: 'path', required: true }),
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/VaultAdminRebindWorkspaceReferenceRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/VaultAdminRebindWorkspaceReferenceResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/workspaces/{workspaceId}/vault/references']?.get).toMatchObject(
      {
        operationId: 'listWorkspaceVaultReferences',
        tags: ['vault'],
        parameters: [expect.objectContaining({ name: 'workspaceId', in: 'path', required: true })],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/VaultAdminListWorkspaceReferencesResponse',
                },
              },
            },
          },
        },
      }
    );
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/vault/use-records']?.get
    ).toMatchObject({
      operationId: 'listWorkspaceVaultUseRecords',
      tags: ['vault'],
      parameters: [expect.objectContaining({ name: 'workspaceId', in: 'path', required: true })],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListWorkspaceVaultUseRecordsResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/workspaces/{workspaceId}/vault/grants']?.get).toMatchObject({
      operationId: 'listWorkspaceVaultGrants',
      tags: ['vault'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListWorkspaceVaultGrantsResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/vault/injection-plans']?.get
    ).toMatchObject({
      operationId: 'listWorkspaceVaultInjectionPlans',
      tags: ['vault'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListWorkspaceVaultInjectionPlansResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/vault/injection-receipts']?.get
    ).toMatchObject({
      operationId: 'listWorkspaceVaultInjectionReceipts',
      tags: ['vault'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListWorkspaceVaultInjectionReceiptsResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/vault/use-records']?.get).toMatchObject({
      operationId: 'listServerVaultUseRecords',
      tags: ['vault'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListServerVaultUseRecordsResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/operations/storage.layout-report']?.post.responses.default
    ).toMatchObject({
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/ApiError',
          },
        },
      },
    });
  });

  it('projects the Stage 2 Artifact and Material operations from shared schemas', () => {
    const document = createAppOpenApiDocument();
    const operations = [
      [
        'post',
        '/api/app/operations/artifact.import',
        'artifact.import',
        'artifact.import.input',
        '201',
        'artifact.import.output',
      ],
      [
        'post',
        '/api/app/operations/artifact.introduce',
        'artifact.introduce',
        'artifact.introduce.input',
        '201',
        'artifact.introduce.output',
      ],
      [
        'get',
        '/api/app/workspaces/{workspaceId}/materials',
        'listWorkspaceMaterials',
        null,
        '200',
        'ListWorkspaceMaterialsResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/materials',
        'createWorkspaceMaterial',
        'CreateWorkspaceMaterialRequest',
        '201',
        'CreateWorkspaceMaterialResponse',
      ],
      [
        'get',
        '/api/app/workspaces/{workspaceId}/materials/{materialId}',
        'getWorkspaceMaterial',
        null,
        '200',
        'GetWorkspaceMaterialResponse',
      ],
      [
        'get',
        '/api/app/workspaces/{workspaceId}/materials/{materialId}/revisions',
        'listWorkspaceMaterialRevisions',
        null,
        '200',
        'ListWorkspaceMaterialRevisionsResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/materials/{materialId}/revisions',
        'saveWorkspaceMaterialRevision',
        'SaveWorkspaceMaterialRevisionRequest',
        '201',
        'SaveWorkspaceMaterialRevisionResponse',
      ],
      [
        'get',
        '/api/app/workspaces/{workspaceId}/materials/{materialId}/revisions/{revisionId}',
        'getWorkspaceMaterialRevision',
        null,
        '200',
        'GetWorkspaceMaterialRevisionResponse',
      ],
      [
        'get',
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/material',
        'getThreadMaterial',
        null,
        '200',
        'GetThreadMaterialResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/materials/{materialId}/bind',
        'bindThreadMaterial',
        'BindThreadMaterialRequest',
        '200',
        'BindThreadMaterialResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/materials/{materialId}/unbind',
        'unbindThreadMaterial',
        'UnbindThreadMaterialRequest',
        '200',
        'UnbindThreadMaterialResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/materials/{materialId}/exclude',
        'excludeThreadMaterial',
        'ExcludeThreadMaterialRequest',
        '200',
        'ExcludeThreadMaterialResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/materials/{materialId}/restore',
        'restoreThreadMaterial',
        'RestoreThreadMaterialRequest',
        '200',
        'RestoreThreadMaterialResponse',
      ],
    ] as const;

    for (const [method, path, operationId, requestSchema, status, responseSchema] of operations) {
      const operation = document.paths[path]?.[method];

      expect(operation, `${method.toUpperCase()} ${path}`).toMatchObject({
        operationId,
        responses: {
          [status]: {
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${responseSchema}` },
              },
            },
          },
          default: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApiError' },
              },
            },
          },
        },
      });

      if (requestSchema === null) {
        expect(operation).not.toHaveProperty('requestBody');
      } else {
        expect(operation).toMatchObject({
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${requestSchema}` },
              },
            },
          },
        });
      }
    }

    expect(document.components?.schemas?.BindThreadMaterialRequest).toMatchObject({
      properties: {
        expectedBindingState: { enum: ['not_bound'] },
      },
    });
  });

  it('projects Artifact Review inputs, outputs and header request identity from definitions', () => {
    const document = createAppOpenApiDocument();
    for (const [id, parameters] of [
      ['artifact.review-list', undefined],
      ['artifact.review.decide', [{ name: 'x-openkit-request-id', in: 'header', required: true }]],
    ] as const) {
      const operation = document.paths[`/api/app/operations/${id}`].post;
      expect(operation).toMatchObject({
        operationId: id,
        tags: ['artifact'],
        requestBody: {
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${id}.input` } } },
        },
        responses: {
          '200': {
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${id}.output` } },
            },
          },
          default: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      });
      if (parameters) expect(operation.parameters).toMatchObject(parameters);
      expect(document.components.schemas[`${id}.input`]).toBeDefined();
      expect(document.components.schemas[`${id}.output`]).toBeDefined();
    }
  });

  it('projects all remaining Kernel and Generative UI definitions and removes their former paths', () => {
    const document = createAppOpenApiDocument();
    for (const [id, definition] of Object.entries({
      ...KERNEL_REMAINING_OPERATION_DEFINITIONS,
      ...GENERATIVE_UI_OPERATION_DEFINITIONS,
    })) {
      const operation = document.paths[operationHttpPath(id)].post;
      const status = 'successStatus' in definition ? definition.successStatus : 200;
      expect(operation).toMatchObject({
        operationId: id,
        requestBody: {
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${id}.input` } } },
        },
        responses: {
          [status]: {
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${id}.output` } },
            },
          },
        },
      });
      expect(document.components.schemas[`${id}.input`]).toBeDefined();
      expect(document.components.schemas[`${id}.output`]).toBeDefined();
      if (definition.mutating)
        expect(operation.parameters).toMatchObject([
          { name: 'x-openkit-request-id', in: 'header', required: true },
        ]);
    }
    expect(
      Object.keys(document.paths).filter(
        (path) => path.includes('/light-apps') || path.includes('/generative-presentations')
      )
    ).toEqual([]);
  });

  it('projects the closed Workspace sharing and lifecycle surface from shared schemas', () => {
    const document = createAppOpenApiDocument();
    const operations = [
      [
        'post',
        '/api/app/operations/workspace.list',
        'workspace.list',
        'workspace.list.input',
        'workspace.list.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.member-list',
        'workspace.member-list',
        'workspace.member-list.input',
        'workspace.member-list.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.invitation-list',
        'workspace.invitation-list',
        'workspace.invitation-list.input',
        'workspace.invitation-list.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.invitation-create',
        'workspace.invitation-create',
        'workspace.invitation-create.input',
        'workspace.invitation-create.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.my-invitation-list',
        'workspace.my-invitation-list',
        'workspace.my-invitation-list.input',
        'workspace.my-invitation-list.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.my-invitation-accept',
        'workspace.my-invitation-accept',
        'workspace.my-invitation-accept.input',
        'workspace.my-invitation-accept.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.my-invitation-decline',
        'workspace.my-invitation-decline',
        'workspace.my-invitation-decline.input',
        'workspace.my-invitation-decline.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.invitation-revoke',
        'workspace.invitation-revoke',
        'workspace.invitation-revoke.input',
        'workspace.invitation-revoke.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.member-access-change',
        'workspace.member-access-change',
        'workspace.member-access-change.input',
        'workspace.member-access-change.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.member-remove',
        'workspace.member-remove',
        'workspace.member-remove.input',
        'workspace.member-remove.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.leave',
        'workspace.leave',
        'workspace.leave.input',
        'workspace.leave.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.ownership-transfer',
        'workspace.ownership-transfer',
        'workspace.ownership-transfer.input',
        'workspace.ownership-transfer.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.access-recovery-read',
        'workspace.access-recovery-read',
        'workspace.access-recovery-read.input',
        'workspace.access-recovery-read.output',
      ],
      [
        'post',
        '/api/app/operations/workspace.access-recover',
        'workspace.access-recover',
        'workspace.access-recover.input',
        'workspace.access-recover.output',
      ],
      [
        'post',
        '/api/app/operations/user.disable',
        'user.disable',
        'user.disable.input',
        'user.disable.output',
      ],
    ] as const;

    for (const [method, path, operationId, requestSchema, responseSchema] of operations) {
      const operation = document.paths[path]?.[method];

      expect(operation).toMatchObject({
        operationId,
        ...(requestSchema
          ? {
              requestBody: {
                content: {
                  'application/json': {
                    schema: { $ref: `#/components/schemas/${requestSchema}` },
                  },
                },
              },
            }
          : {}),
        responses: {
          [operationId === 'workspace.invitation-create' ? '201' : '200']: {
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${responseSchema}` },
              },
            },
          },
        },
      });
    }

    expect(
      Object.fromEntries(
        operations.map(([method, path, operationId]) => [
          operationId,
          document.paths[path]?.[method]?.security,
        ])
      )
    ).toMatchObject({
      'workspace.my-invitation-list': [{ bearerAuth: [] }, { sessionCookie: [] }],
      'workspace.my-invitation-accept': [{ bearerAuth: [] }, { sessionCookie: [] }],
      'workspace.my-invitation-decline': [{ bearerAuth: [] }, { sessionCookie: [] }],
      'workspace.leave': [{ bearerAuth: [] }, { sessionCookie: [] }],
      'workspace.access-recovery-read': [{ bearerAuth: [] }, { sessionCookie: [] }],
      'workspace.access-recover': [{ bearerAuth: [] }, { sessionCookie: [] }],
      'user.disable': [{ bearerAuth: [] }, { sessionCookie: [] }],
      'workspace.list': [{ bearerAuth: [] }, { sessionCookie: [] }],
    });
  });

  it('projects the bounded Worker environment and private administration operations', () => {
    const document = createAppOpenApiDocument();
    const operations = [
      ['get', '/api/app/workspaces/{workspaceId}/worker-environments', 'listWorkerEnvironments'],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/worker-environments/select',
        'selectWorkerEnvironment',
      ],
      ['post', '/api/app/worker-environments/prepare', 'prepareWorkerEnvironment'],
      ['post', '/api/app/worker-environments/activate', 'activateWorkerEnvironment'],
      [
        'get',
        '/api/app/workspaces/{workspaceId}/worker-environments/{storageRef}/status',
        'getWorkerEnvironmentStatus',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/worker-environments/{storageRef}/purge',
        'purgeWorkerEnvironment',
      ],
      ['post', '/api/app/administration/configuration/apply', 'applyAdministrationConfiguration'],
      ['post', '/api/app/administration/conversation-turns', 'submitAdministrationConversation'],
    ] as const;

    for (const [method, path, operationId] of operations) {
      expect(document.paths[path]?.[method]).toMatchObject({ operationId });
    }
    const serialized = JSON.stringify(
      Object.fromEntries(
        Object.entries(document.components.schemas).filter(
          ([name]) =>
            name.includes('WorkerEnvironment') || name.includes('AdministrationConversation')
        )
      )
    );
    expect(serialized).not.toContain('adminToken');
    expect(serialized).not.toContain('hostPath');
  });

  it('keeps live public app api routes and openapi operations aligned', () => {
    const app = createApp();
    const unsupportedMethodRoutes = app.routes
      .filter(
        ({ method, path }) =>
          (method === 'ALL' && isProjectedAppApiRoute(path)) ||
          (method !== 'ALL' && !OPENAPI_ROUTE_METHOD_SET.has(method))
      )
      .map(({ method, path }) => `${method} ${path}`);
    const explicitRoutes = app.routes.filter(({ method }) => OPENAPI_ROUTE_METHOD_SET.has(method));
    const unclassifiedRoutes = explicitRoutes
      .filter(
        ({ path }) =>
          !isProjectedAppApiRoute(path) &&
          !NON_APP_API_ROUTE_PATTERNS.some((pattern) => pattern.test(path))
      )
      .map(({ method, path }) => `${method} ${path}`);
    const liveRoutes = explicitRoutes.filter(({ path }) => isProjectedAppApiRoute(path));
    const document = createAppOpenApiDocument();
    const unsupportedRoutes = liveRoutes
      .filter(
        ({ path }) => path.includes('?') || path.includes('*') || /:[A-Za-z0-9_]+\{/.test(path)
      )
      .map(({ method, path }) => `${method} ${path}`);
    const rawLiveOperations = liveRoutes.map(
      ({ method, path }) => `${method} ${normalizeHonoRoutePath(path)}`
    );
    const sortedRawLiveOperations = [...rawLiveOperations].sort();
    const duplicateLiveOperations = sortedRawLiveOperations.filter(
      (operation, index) => operation === sortedRawLiveOperations[index - 1]
    );
    const staleExclusions = APP_OPENAPI_ROUTE_COVERAGE_EXCLUSIONS.filter(
      (operation) => !rawLiveOperations.includes(operation)
    );
    const exclusions = new Set<string>(APP_OPENAPI_ROUTE_COVERAGE_EXCLUSIONS);
    const projectedLiveOperations = rawLiveOperations
      .filter((operation) => !exclusions.has(operation))
      .sort();
    const documentedOperations = Object.entries(document.paths)
      .flatMap(([path, pathItem]) =>
        APP_OPENAPI_ROUTE_METHODS.flatMap((method) =>
          method in pathItem ? [`${method.toUpperCase()} ${path}`] : []
        )
      )
      .sort();

    expect(unsupportedMethodRoutes).toEqual([]);
    expect(unclassifiedRoutes).toEqual([]);
    expect(unsupportedRoutes).toEqual([]);
    expect(duplicateLiveOperations).toEqual([]);
    expect(staleExclusions).toEqual([]);
    expect(projectedLiveOperations).toEqual(documentedOperations);
    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).not.toContain(
      'POST /api/nanohost/transport/session/fence'
    );
    expect(
      app.routes
        .filter(({ path }) => path.startsWith('/api/nanohost/transport/effects/'))
        .map(({ method, path }) => `${method} ${path}`)
        .sort()
    ).toEqual([...PRIVATE_NANOHOST_EFFECT_ROUTES].sort());
  });

  it('keeps the direct Core and Gateway access inventory aligned with live routes', () => {
    const liveOperationKeys = createApp()
      .routes.filter(
        ({ method, path }) =>
          OPENAPI_ROUTE_METHOD_SET.has(method) &&
          (path === '/api/workspaces' ||
            path.startsWith('/api/workspaces/') ||
            (method === 'POST' && path === '/api/approvals/:approvalRequestId/respond') ||
            (method === 'POST' && path === '/api/user-input-requests/:userInputRequestId/answer') ||
            (method === 'POST' && path === '/api/pending-requests/:pendingRequestId/withdraw') ||
            (method === 'POST' && path === '/api/turns') ||
            (method === 'POST' && path === '/v1/chat/completions') ||
            (method === 'POST' && path === '/v1/responses'))
      )
      .map(({ method, path }) => `${method} ${path}`)
      .sort();

    expect(liveOperationKeys).toEqual([...DIRECT_CORE_GATEWAY_OPERATION_KEYS].sort());
  });

  it('requires one canonical access classification for every public operation', () => {
    const document = createAppOpenApiDocument();
    const appOperationIds = Object.entries(document.paths).flatMap(([, pathItem]) =>
      APP_OPENAPI_ROUTE_METHODS.flatMap((method) => {
        const operation = (pathItem as Readonly<Record<string, unknown>>)[method];

        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
          return [];
        }

        const operationId = (operation as Readonly<Record<string, unknown>>).operationId;
        return typeof operationId === 'string' ? [operationId] : [];
      })
    );
    const operationKeys = [...appOperationIds, ...DIRECT_CORE_GATEWAY_OPERATION_KEYS];
    const knownKeys = new Set(operationKeys);
    const duplicateOperationKeys = operationKeys.filter(
      (operationKey, index) => operationKeys.indexOf(operationKey) !== index
    );
    const missingMetadata = operationKeys.filter(
      (operationKey) => !Object.hasOwn(PUBLIC_OPERATION_ACCESS, operationKey)
    );
    const staleMetadata = Object.keys(PUBLIC_OPERATION_ACCESS).filter(
      (operationKey) => !knownKeys.has(operationKey)
    );
    const invalidMetadata = Object.entries(PUBLIC_OPERATION_ACCESS).flatMap(
      ([operationKey, value]) => {
        const metadata = value as unknown as Readonly<Record<string, unknown>>;
        const scope = metadata.scope;
        const resolver = metadata.resolver;
        const workspaceResolver = metadata.workspaceResolver;
        const authentication = metadata.authentication;
        const scopeIsValid = scope === 'server' || scope === 'user' || scope === 'workspace';
        const resolverIsValid =
          scope === 'workspace'
            ? typeof resolver === 'string' && WORKSPACE_OPERATION_RESOLVERS.has(resolver)
            : !Object.hasOwn(metadata, 'resolver');
        const workspaceResolverIsValid =
          scope === 'user'
            ? !Object.hasOwn(metadata, 'workspaceResolver') ||
              workspaceResolver === 'gateway-metadata-workspace'
            : !Object.hasOwn(metadata, 'workspaceResolver');
        const authenticationIsValid =
          scope === 'server'
            ? authentication === 'bootstrap-secret' || authentication === 'deployment-admin'
            : scope === 'user'
              ? authentication === 'canonical-user' || authentication === 'gateway-actor'
              : !Object.hasOwn(metadata, 'authentication') || authentication === 'deployment-admin';
        const gatewayAuthenticationIsConsistent =
          authentication === 'gateway-actor'
            ? workspaceResolver === 'gateway-metadata-workspace'
            : !Object.hasOwn(metadata, 'workspaceResolver');

        return scopeIsValid &&
          resolverIsValid &&
          workspaceResolverIsValid &&
          authenticationIsValid &&
          gatewayAuthenticationIsConsistent &&
          typeof metadata.mutating === 'boolean' &&
          typeof metadata.policyOperation === 'string' &&
          PRODUCT_POLICY_OPERATIONS.has(metadata.policyOperation)
          ? []
          : [operationKey];
      }
    );

    expect({ duplicateOperationKeys, invalidMetadata, missingMetadata, staleMetadata }).toEqual({
      duplicateOperationKeys: [],
      invalidMetadata: [],
      missingMetadata: [],
      staleMetadata: [],
    });
  });

  it('pins one representative for every Workspace resolver and each non-Workspace exception', () => {
    expect(PUBLIC_OPERATION_ACCESS['chat.quick']).toMatchObject({
      mutating: true,
      policyOperation: 'turn.run',
      resolver: 'actor-quick-chat-workspace',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS['workspace.list']).toMatchObject({
      mutating: false,
      policyOperation: 'workspace.read',
      resolver: 'authorized-workspace-set',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS['turn.start']).toMatchObject({
      mutating: true,
      policyOperation: 'turn.run',
      resolver: 'body-workspace',
      scope: 'workspace',
    });
    for (const operationKey of ['POST /v1/chat/completions', 'POST /v1/responses'] as const) {
      expect(PUBLIC_OPERATION_ACCESS[operationKey]).toMatchObject({
        authentication: 'gateway-actor',
        mutating: true,
        policyOperation: 'llm.gateway.use',
        scope: 'user',
        workspaceResolver: 'gateway-metadata-workspace',
      });
    }
    expect(PUBLIC_OPERATION_ACCESS['approval.respond']).toMatchObject({
      mutating: true,
      policyOperation: 'approval.respond',
      resolver: 'opaque-child-workspace',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS['workspace.read']).toMatchObject({
      mutating: false,
      policyOperation: 'workspace.read',
      resolver: 'body-workspace',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS['thread.read']).toMatchObject({
      mutating: false,
      policyOperation: 'thread.read',
      resolver: 'body-workspace',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS['workspace.create']).toMatchObject({
      authentication: 'canonical-user',
      mutating: true,
      policyOperation: 'workspace.write',
      scope: 'user',
    });
    expect(PUBLIC_OPERATION_ACCESS['workspace.import-dry-run']).toMatchObject({
      authentication: 'canonical-user',
      mutating: false,
      policyOperation: 'workspace.write',
      scope: 'user',
    });
    expect(PUBLIC_OPERATION_ACCESS['workspace.import']).toMatchObject({
      authentication: 'canonical-user',
      mutating: true,
      policyOperation: 'workspace.write',
      scope: 'user',
    });
    expect(PUBLIC_OPERATION_ACCESS.consumeOpenKitBootstrapToken).toMatchObject({
      authentication: 'bootstrap-secret',
      mutating: true,
      policyOperation: 'api.call',
      scope: 'server',
    });
    expect(PUBLIC_OPERATION_ACCESS.listMyAdminAccessTokens).toMatchObject({
      authentication: 'canonical-user',
      mutating: false,
      policyOperation: 'api.call',
      scope: 'user',
    });
    expect(PUBLIC_OPERATION_ACCESS.setMyAdminAccessTokenDefault).toMatchObject({
      authentication: 'canonical-user',
      mutating: true,
      policyOperation: 'api.call',
      scope: 'user',
    });

    expect(PUBLIC_OPERATION_ACCESS['knowledge.retrieval']?.mutating).toBe(true);
    expect(PUBLIC_OPERATION_ACCESS['knowledge.context.prepare']).toMatchObject({
      mutating: true,
      policyOperation: 'knowledge.read',
      resolver: 'body-workspace',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS['knowledge.proposal.reverse']).toMatchObject({
      mutating: true,
      policyOperation: 'knowledge.write',
      resolver: 'body-workspace',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS['knowledge.answer']?.mutating).toBe(false);
    expect(PUBLIC_OPERATION_ACCESS['knowledge.repair.suggest']?.mutating).toBe(false);
    expect(PUBLIC_OPERATION_ACCESS['knowledge.health.check']?.mutating).toBe(false);
  });

  it('enforces semantic invariants for every documented operation', () => {
    const document = createAppOpenApiDocument();
    const operations: Array<{
      operation: Readonly<Record<string, unknown>>;
      route: string;
    }> = [];

    for (const [name, schema] of Object.entries({
      AgentId: AgentIdSchema,
      ArtifactId: ArtifactIdSchema,
      ThreadId: ThreadIdSchema,
      TurnId: TurnIdSchema,
      WorkspaceId: WorkspaceIdSchema,
    })) {
      expect(document.components.schemas[name]).toEqual(z.toJSONSchema(schema));
    }

    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const method of APP_OPENAPI_ROUTE_METHODS) {
        const operation = jsonObject((pathItem as Readonly<Record<string, unknown>>)[method]);
        if (operation) {
          operations.push({ operation, route: `${method.toUpperCase()} ${path}` });
        }
      }
    }

    const operationIds = operations.map(({ operation }) => operation.operationId);
    const invalidOperationIds = operations
      .filter(
        ({ operation }) =>
          typeof operation.operationId !== 'string' ||
          (!/^[a-z][A-Za-z0-9]*$/.test(operation.operationId) &&
            !Object.hasOwn(OPERATION_DEFINITIONS, operation.operationId))
      )
      .map(({ route }) => route);
    const duplicateOperationIds = operationIds.filter(
      (operationId, index) => operationIds.indexOf(operationId) !== index
    );
    const missingDefaultErrors = operations
      .filter(({ operation }) => {
        const responses = jsonObject(operation.responses);
        const fallback = jsonObject(responses?.default);
        const content = jsonObject(fallback?.content);
        const json = jsonObject(content?.['application/json']);
        const schema = jsonObject(json?.schema);
        return schema?.$ref !== '#/components/schemas/ApiError';
      })
      .map(({ route }) => route);
    const invalidSecurity = operations
      .filter(({ operation, route }) => {
        const expected =
          route === 'POST /api/app/auth/bootstrap/consume'
            ? []
            : SESSION_COOKIE_ONLY_ROUTES.has(route)
              ? [{ sessionCookie: [] }]
              : [{ bearerAuth: [] }, { sessionCookie: [] }];
        return JSON.stringify(operation.security) !== JSON.stringify(expected);
      })
      .map(({ route }) => route);
    const nonCanonicalPathParameters = operations.flatMap(({ operation, route }) => {
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];

      return parameters.flatMap((value) => {
        const parameter = jsonObject(value);
        const name = typeof parameter?.name === 'string' ? parameter.name : '';
        const expectedRef = CANONICAL_PATH_PARAMETER_REFS[name];
        const schema = jsonObject(parameter?.schema);

        return parameter?.in === 'path' && expectedRef && schema?.$ref !== expectedRef
          ? [`${route} ${name}`]
          : [];
      });
    });
    const schemaNames = new Set(Object.keys(document.components.schemas));
    const unresolvedSchemaRefs = [
      ...JSON.stringify(document).matchAll(/"#\/components\/schemas\/([^"]+)"/g),
    ]
      .map((match) => match[1])
      .filter((schemaName) => !schemaNames.has(schemaName));

    expect({
      duplicateOperationIds,
      invalidOperationIds,
      invalidSecurity,
      missingDefaultErrors,
      nonCanonicalPathParameters,
      unresolvedSchemaRefs,
    }).toEqual({
      duplicateOperationIds: [],
      invalidOperationIds: [],
      invalidSecurity: [],
      missingDefaultErrors: [],
      nonCanonicalPathParameters: [],
      unresolvedSchemaRefs: [],
    });
  });

  it('registers runtime handlers from shared openapi route definitions', async () => {
    const app = new Hono();

    registerAppApiRoute(app, 'storage.layout-report', (c) => c.json({ ok: true }));

    expect(app.routes.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'POST', path: '/api/app/operations/storage.layout-report' },
    ]);
    expect(getRegisteredAppApiOperationIds(app)).toEqual(['storage.layout-report']);
    const response = await app.request('/api/app/operations/storage.layout-report', {
      method: 'POST',
    });
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(() =>
      registerAppApiRoute(app, 'storage.layout-report', (c) => c.json({ ok: true }))
    ).toThrow('App API operation is already registered: storage.layout-report');
    expect(() =>
      registerAppApiRoute(app, 'missingOperation' as never, (c) => c.json({ ok: true }))
    ).toThrow('Unknown App API operationId: missingOperation');
  });

  it('binds every registered handler to its documented operation route', () => {
    const app = createApp();
    const document = createAppOpenApiDocument();
    const documentedRouteByOperationId = new Map<string, string>();

    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const method of APP_OPENAPI_ROUTE_METHODS) {
        const operation = (pathItem as Readonly<Record<string, unknown>>)[method];

        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
          continue;
        }

        const operationId = (operation as Readonly<Record<string, unknown>>).operationId;
        if (typeof operationId === 'string') {
          documentedRouteByOperationId.set(operationId, `${method.toUpperCase()} ${path}`);
        }
      }
    }

    const exclusions = new Set<string>(APP_OPENAPI_ROUTE_COVERAGE_EXCLUSIONS);
    const liveOperations = app.routes
      .filter(({ path }) => isProjectedAppApiRoute(path))
      .map(({ method, path }) => `${method} ${normalizeHonoRoutePath(path)}`)
      .filter((operation) => !exclusions.has(operation));
    const registeredOperations = getRegisteredAppApiOperationIds(app).map((operationId) =>
      documentedRouteByOperationId.get(operationId)
    );

    expect(registeredOperations).toEqual(liveOperations);
  });

  it('does not document generic pending-input recovery operations', () => {
    const document = createAppOpenApiDocument();
    const schemas = document.components.schemas as Readonly<Record<string, unknown>>;
    const operationIds = Object.values(document.paths).flatMap((pathItem) =>
      APP_OPENAPI_ROUTE_METHODS.flatMap((method) => {
        const operation = (pathItem as Readonly<Record<string, unknown>>)[method];
        const operationId =
          operation && typeof operation === 'object' && !Array.isArray(operation)
            ? (operation as Readonly<Record<string, unknown>>).operationId
            : null;
        return typeof operationId === 'string' ? [operationId] : [];
      })
    );

    expect(document.paths).not.toHaveProperty(
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/pending-user-turns/{requestId}/edit'
    );
    expect(document.paths).not.toHaveProperty(
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/pending-user-turns/{requestId}/interrupt'
    );
    expect(document.paths).not.toHaveProperty(
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/pending-user-turns'
    );
    expect(document.paths).not.toHaveProperty(
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/pending-user-turns/{requestId}/cancel'
    );
    expect(document.paths).not.toHaveProperty(
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/pending-user-turns/{requestId}/follow-up'
    );
    expect(document.paths).not.toHaveProperty(
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/interrupted-worker'
    );
    expect(document.paths).not.toHaveProperty(
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/interrupted-worker/{turnId}/terminal'
    );
    expect(operationIds).not.toContain('editRecoveryPendingUserTurn');
    expect(operationIds).not.toContain('promoteRecoveryPendingUserTurnToInterrupt');
    expect(operationIds).not.toContain('createInterruptedRecoveryState');
    expect(operationIds).not.toContain('listRecoveryPendingUserTurns');
    expect(operationIds).not.toContain('cancelRecoveryPendingUserTurn');
    expect(operationIds).not.toContain('convertRecoveryPendingUserTurnToFollowUp');
    expect(schemas).not.toHaveProperty('EditRecoveryPendingUserTurnRequest');
    expect(schemas).not.toHaveProperty('EditRecoveryPendingUserTurnResponse');
    expect(schemas).not.toHaveProperty('PromoteRecoveryPendingUserTurnToInterruptResponse');
    expect(schemas).not.toHaveProperty('RecoveryPendingUserTurn');
    expect(schemas).not.toHaveProperty('CreateInterruptedRecoveryStateResponse');
    expect(schemas).not.toHaveProperty('ListRecoveryPendingUserTurnsResponse');
    expect(schemas).not.toHaveProperty('CancelRecoveryPendingUserTurnResponse');
    expect(schemas).not.toHaveProperty('ConvertRecoveryPendingUserTurnToFollowUpResponse');
  });

  it('preserves the characterized handler registration order', () => {
    expect(getRegisteredAppApiOperationIds(createApp())).toEqual([
      'consumeOpenKitBootstrapToken',
      'listOpenKitAccessTokens',
      'createOpenKitAccessToken',
      'revokeOpenKitAccessToken',
      'rotateOpenKitAccessToken',
      'listMyAdminAccessTokens',
      'setMyAdminAccessTokenDefault',
      'createWorkspaceVaultSecret',
      'rotateWorkspaceVaultSecret',
      'revokeWorkspaceVaultSecret',
      'createWorkspaceVaultGrant',
      'revokeWorkspaceVaultGrant',
      'getVaultAdminStatus',
      'setProviderApiKey',
      'listServerVaultUseRecords',
      'unlockVaultAdminBackend',
      'bootstrapCodexAuthJsonVaultReference',
      'rebindWorkspaceVaultReference',
      'listWorkspaceVaultReferences',
      'listWorkspaceVaultUseRecords',
      'lockVaultAdminBackend',
      'getAppDiagnostics',
      'getSetupDiagnostics',
      'prepareAppUpdate',
      'startAppUpdate',
      'getAppUpdateStatus',
      'downloadWorkspaceExportArchive',
      'dryRunWorkspaceArchiveImport',
      'importWorkspaceArchive',
      'applyAdministrationConfiguration',
      'submitAdministrationConversation',
      'listWorkspaceMaterials',
      'createWorkspaceMaterial',
      'getWorkspaceMaterial',
      'listWorkspaceMaterialRevisions',
      'saveWorkspaceMaterialRevision',
      'getWorkspaceMaterialRevision',
      'getThreadMaterial',
      'bindThreadMaterial',
      'unbindThreadMaterial',
      'excludeThreadMaterial',
      'restoreThreadMaterial',
      'searchApp',
      'listAgentCatalog',
      'getAgentCatalogEntry',
      'listWorkspaceWorkers',
      'getWorkspaceCatalog',
      'listSkillCatalog',
      'importSkill',
      'submitSkillCandidate',
      'decideSkillCandidate',
      'selectSkillDefault',
      'setSkillPin',
      'listMcpCatalog',
      'createMcpConfig',
      'selectMcpVersion',
      'updateMcpBinding',
      'listPluginCatalog',
      'importPlugin',
      'getCapabilityUsage',
      'listWorkspaceEvidenceBundles',
      'listWorkspaceRuntimeEvidence',
      'listWorkspaceAuditEvents',
      'listServerAuditEvents',
      'listWorkspacePermissionDecisions',
      'listWorkspaceVaultGrants',
      'listWorkspaceVaultInjectionPlans',
      'listWorkspaceVaultInjectionReceipts',
      'listServerPermissionDecisions',
      'refreshAgentHealth',
      ...Object.keys(OPERATION_DEFINITIONS),
      'listAgentEnvironmentPackageSnapshots',
      'getAgentEnvironmentPackageSnapshot',
      'listWorkerEnvironments',
      'selectWorkerEnvironment',
      'getWorkerEnvironmentStatus',
      'purgeWorkerEnvironment',
      'prepareWorkerEnvironment',
      'activateWorkerEnvironment',
    ]);
  });

  it('projects the App Diagnostics process sample including nested process.telemetry', () => {
    const diagnostics = jsonObject(
      createAppOpenApiDocument().components.schemas.AppDiagnosticsResponse
    );
    const process = jsonObject(jsonObject(diagnostics?.properties)?.process);
    const processProperties = jsonObject(process?.properties);
    const memory = jsonObject(processProperties?.memory);
    const telemetry = jsonObject(processProperties?.telemetry);

    expect(diagnostics?.required).toEqual(
      expect.arrayContaining(['service', 'boot', 'process', 'gateway'])
    );
    expect(process).toMatchObject({
      type: 'object',
      required: ['observedAt', 'nodeVersion', 'uptimeSeconds', 'memory', 'telemetry'],
      additionalProperties: false,
    });
    expect(processProperties).not.toHaveProperty('hostHealthy');
    expect(processProperties).not.toHaveProperty('buildId');
    expect(memory).toMatchObject({
      type: 'object',
      required: ['rssBytes', 'heapUsedBytes', 'heapTotalBytes'],
      additionalProperties: false,
    });
    expect(telemetry).toMatchObject({
      type: 'object',
      required: ['enabled', 'exportConfigured'],
      additionalProperties: false,
    });
    expect(jsonObject(telemetry?.properties)).not.toHaveProperty('delivered');
  });

  it('keeps the committed openapi artifact in sync with the projection', () => {
    const artifact = JSON.parse(
      readFileSync(new URL('../openapi/app-api.openapi.json', import.meta.url), 'utf8')
    );

    expect(artifact).toEqual(createAppOpenApiDocument());
  });

  it('validates the openapi projection against the official OpenAPI 3.1 schema', async () => {
    const schema = JSON.parse(
      readFileSync(new URL('../openapi/oas-3.1-schema-2022-10-07.json', import.meta.url), 'utf8')
    );

    await expect(validateAppOpenApiDocument(createAppOpenApiDocument(), schema)).resolves.toEqual(
      []
    );
  });

  it('keeps first-party consumers from reading the generated openapi artifact', () => {
    const offenders: string[] = [];

    for (const root of FIRST_PARTY_CONSUMER_ROOTS) {
      for (const filePath of listSourceFiles(new URL(root, import.meta.url))) {
        const source = readFileSync(filePath, 'utf8');

        if (source.includes('app-api.openapi.json') || source.includes('openapi/app-api')) {
          offenders.push(filePath);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * Narrows one unknown JSON value to a non-array object.
 *
 * @param value Candidate JSON value.
 * @returns Object value, or null for primitives, arrays, and null.
 */
function jsonObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function listSourceFiles(root: URL): string[] {
  const rootPath = root.pathname;
  const files: string[] = [];

  for (const entry of readdirSync(rootPath)) {
    const entryPath = join(rootPath, entry);
    const stat = statSync(entryPath);

    if (stat.isDirectory()) {
      files.push(...listSourceFiles(new URL(`${entry}/`, root)));
    } else if (/\.(cjs|js|jsx|mjs|ts|tsx)$/.test(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
}

/** Knowledge bindings preserve exact schemas through definition derivation after legacy descriptors are removed. */
describe('Knowledge OpenAPI derivation', () => {
  it('projects every retained Knowledge input and output with no old operation descriptor', () => {
    const document = createAppOpenApiDocument();
    const definitions = {
      ...KNOWLEDGE_OPERATION_DEFINITIONS,
      ...KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
    };
    expect(Object.keys(definitions)).toHaveLength(23);
    for (const [id, definition] of Object.entries(definitions)) {
      const route = document.paths[operationHttpPath(id)] as unknown as {
        post: Record<string, unknown>;
      };
      expect(route.post).toMatchObject({
        operationId: id,
        tags: ['knowledge'],
        requestBody: {
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${id}.input` } } },
        },
        responses: {
          '200': {
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${id}.output` } },
            },
          },
        },
      });
      const components = document.components.schemas as Record<string, unknown>;
      expect(components[`${id}.input`]).toEqual(
        z.toJSONSchema(
          'requestId' in definition.inputSchema.shape
            ? definition.inputSchema.omit({ requestId: true } as never)
            : definition.inputSchema
        )
      );
      expect(components[`${id}.output`]).toEqual(z.toJSONSchema(definition.outputSchema));
    }
    expect(Object.keys(document.paths).filter((path) => /\/knowledge(?:\/|$)/.test(path))).toEqual(
      []
    );
  });
});

describe('automation, scheduler and recovery OpenAPI projection', () => {
  it('derives nine exact contracts and bodyless deletion without former bindings', () => {
    const document = createAppOpenApiDocument();
    for (const [id, status] of [
      ['automation.list', '200'],
      ['automation.create', '201'],
      ['automation.update', '200'],
      ['automation.delete', '204'],
      ['recovery.worker-list', '200'],
      ['recovery.checkpoint-retry', '200'],
      ['scheduler.list', '200'],
      ['scheduler.retry', '200'],
      ['scheduler.cancel', '200'],
    ] as const) {
      const operation = document.paths[`/api/app/operations/${id}`].post;
      expect(operation.operationId).toBe(id);
      expect(operation.requestBody.content['application/json'].schema).toEqual({
        $ref: `#/components/schemas/${id}.input`,
      });
      const response = operation.responses[status];
      if (status === '204') expect(response).not.toHaveProperty('content');
      else
        expect(response).toMatchObject({
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${id}.output` } },
          },
        });
    }
    for (const path of [
      '/api/app/automations',
      '/api/app/automations/{automationId}',
      '/api/app/recovery/interrupted-workers',
      '/api/app/workspaces/{workspaceId}/scheduler/admissions',
      '/api/app/workspaces/{workspaceId}/scheduler/admissions/{queueEntryId}/retry',
      '/api/app/workspaces/{workspaceId}/scheduler/admissions/{queueEntryId}/cancel',
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/interrupted-worker/{turnId}/retry',
    ])
      expect(document.paths).not.toHaveProperty(path);
  });
});
