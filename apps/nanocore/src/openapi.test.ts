import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CapabilityUsageResponseSchema,
  CreateProviderSubscriptionAccountRequestSchema,
  SubscriptionProviderIdSchema,
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
const TURN_FEEDBACK_ROUTE = '/api/turns/:turnId/feedback';
const NON_APP_API_ROUTE_PATTERNS = [
  /^\/v1(?:\/|$)/,
  /^\/internal(?:\/|$)/,
  /^\/api\/worker-control(?:\/|$)/,
  /^\/api\/worker-inference(?:\/|$)/,
  /^\/api\/worker-capabilities(?:\/|$)/,
  /^\/api\/nanohost\/transport\/session\/admit$/,
  /^\/api\/nanohost\/transport\/effects\/(?:sandbox\.(?:create|delete)|bridge\.(?:open|close)|image\.(?:acquire|build)|file\.export|reference\.import)(?:\/result)?$/,
  /^\/api\/workspaces(?:\/|$)/,
  /^\/api\/approvals(?:\/|$)/,
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
  'file.export',
  'reference.import',
].flatMap((operation) => [
  `POST /api/nanohost/transport/effects/${operation}`,
  `POST /api/nanohost/transport/effects/${operation}/result`,
]);
const SESSION_COOKIE_ONLY_ROUTES = new Set([
  'GET /api/app/workspace-invitations',
  'POST /api/app/workspace-invitations/{invitationId}/accept',
  'POST /api/app/workspace-invitations/{invitationId}/decline',
  'POST /api/app/workspaces/{workspaceId}/leave',
  'GET /api/app/auth/my-admin-tokens',
  'PUT /api/app/auth/my-admin-tokens/default',
  'POST /api/app/workspace-archives/import',
  'POST /api/app/workspace-archives/import-dry-run',
  'POST /api/app/workspace-deletions/{workspaceId}/recover',
]);
const FIRST_PARTY_CONSUMER_ROOTS = [
  '../../../apps/web/src/',
  '../../../packages/core-client/src/',
  '../../../skills/',
];
const DIRECT_CORE_GATEWAY_OPERATION_KEYS = [
  'GET /api/workspaces',
  'POST /api/workspaces',
  'GET /api/workspaces/:workspaceId',
  'GET /api/workspaces/:workspaceId/resources',
  'PATCH /api/workspaces/:workspaceId',
  'GET /api/workspaces/:workspaceId/threads',
  'POST /api/workspaces/:workspaceId/threads',
  'GET /api/workspaces/:workspaceId/threads/:threadId',
  'PATCH /api/workspaces/:workspaceId/threads/:threadId',
  'POST /api/workspaces/:workspaceId/threads/:threadId/archive',
  'GET /api/workspaces/:workspaceId/knowledge',
  'POST /api/workspaces/:workspaceId/knowledge',
  'PATCH /api/workspaces/:workspaceId/knowledge/:knowledgeEntryId',
  'DELETE /api/workspaces/:workspaceId/knowledge/:knowledgeEntryId',
  'GET /api/workspaces/:workspaceId/artifacts',
  'GET /api/workspaces/:workspaceId/artifacts/:artifactId',
  'GET /api/workspaces/:workspaceId/artifacts/:artifactId/content',
  'GET /api/workspaces/:workspaceId/threads/:threadId/events',
  'GET /api/workspaces/:workspaceId/threads/:threadId/turns/:turnId',
  'POST /api/workspaces/:workspaceId/threads/:threadId/turns/:turnId/interrupt',
  'POST /api/approvals/:approvalRequestId/respond',
  'POST /api/turns',
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
 * @param method Uppercase HTTP method from Hono.
 * @param path Hono route path.
 * @returns True when the route must have an OpenAPI operation.
 */
function isProjectedAppApiRoute(method: string, path: string): boolean {
  return (
    PROJECTED_APP_API_ROUTE_PATTERN.test(path) ||
    (method === 'POST' && path === TURN_FEEDBACK_ROUTE)
  );
}

describe('app api openapi projection', () => {
  it('keeps AgentSession continuity out of ordinary App API operations and schemas', () => {
    const document = createAppOpenApiDocument();
    const restartPath =
      '/api/app/workspaces/{workspaceId}/runtime-config/stale-sessions/{sessionId}/restart';

    expect(document.paths[restartPath]).toBeUndefined();
    expect(document.components.schemas.ThreadDashboardResponse).not.toHaveProperty(
      'properties.activeSession'
    );
    expect(JSON.stringify(document.components.schemas.ThreadDashboardResponse)).not.toContain(
      'agentSessionId'
    );
    expect(JSON.stringify(document.components.schemas.SubmitConversationResponse)).not.toContain(
      'agentSessionId'
    );
    expect(JSON.stringify(document.components.schemas.StartTaskModeResponse)).not.toContain(
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

    for (const name of ['QuickChatRequest', 'SubmitConversationRequest'] as const) {
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

  it('sources provider-subscription path parameters from shared schemas', () => {
    const document = createAppOpenApiDocument();
    const operation = jsonObject(
      document.paths[
        '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}'
      ]?.patch
    );
    const providerSchema = z.toJSONSchema(SubscriptionProviderIdSchema);
    const accountSlotSchema = z.toJSONSchema(
      CreateProviderSubscriptionAccountRequestSchema.shape.accountSlotId
    );
    delete providerSchema.$schema;
    delete accountSlotSchema.$schema;

    expect(operation?.parameters).toEqual([
      {
        name: 'subscriptionProviderId',
        in: 'path',
        required: true,
        schema: providerSchema,
      },
      {
        name: 'accountSlotId',
        in: 'path',
        required: true,
        schema: accountSlotSchema,
      },
    ]);

    const source = readFileSync(new URL('./openapi.ts', import.meta.url), 'utf8');
    const providerParameterSource = source.match(
      /const SUBSCRIPTION_PROVIDER_ID_PARAMETER = \{[\s\S]*?\n\};/u
    )?.[0];
    const accountSlotParameterSource = source.match(
      /const ACCOUNT_SLOT_ID_PARAMETER = \{[\s\S]*?\n\};/u
    )?.[0];
    const providerSchemaValue =
      /\bschema:\s*[A-Za-z_$][\w$]*\(\s*SubscriptionProviderIdSchema\s*\)\s*,?/u;
    const accountSlotSchemaValue =
      /\bschema:\s*[A-Za-z_$][\w$]*\(\s*CreateProviderSubscriptionAccountRequestSchema\.shape\.accountSlotId\s*\)\s*,?/u;
    const localProviderSchema = /\bz\.enum\s*\(/u;
    const localAccountSlotSchema = /\.regex\s*\(/u;
    const inlineProviderEnum = /\benum\s*:\s*\[\s*['"]openai-codex['"]\s*,\s*['"]xai['"]\s*\]/u;
    const inlineAccountSlotPattern = /\bpattern\s*:\s*(['"])\^\[a-z0-9\]\[a-z0-9_-\]\{0,63\}\$\1/u;
    const adversarialProviderParameter =
      "schema: project(z.enum(['openai-codex', 'xai'])), // SubscriptionProviderIdSchema";
    const adversarialAccountSlotParameter =
      'schema: project(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)), // CreateProviderSubscriptionAccountRequestSchema.shape.accountSlotId';

    expect({
      accountSlot:
        accountSlotSchemaValue.test(adversarialAccountSlotParameter) &&
        !localAccountSlotSchema.test(adversarialAccountSlotParameter) &&
        !inlineAccountSlotPattern.test(adversarialAccountSlotParameter),
      provider:
        providerSchemaValue.test(adversarialProviderParameter) &&
        !localProviderSchema.test(adversarialProviderParameter) &&
        !inlineProviderEnum.test(adversarialProviderParameter),
    }).toEqual({ accountSlot: false, provider: false });

    expect({
      accountSlot: Boolean(
        accountSlotParameterSource &&
          accountSlotSchemaValue.test(accountSlotParameterSource) &&
          !localAccountSlotSchema.test(accountSlotParameterSource) &&
          !inlineAccountSlotPattern.test(accountSlotParameterSource)
      ),
      provider: Boolean(
        providerParameterSource &&
          providerSchemaValue.test(providerParameterSource) &&
          !localProviderSchema.test(providerParameterSource) &&
          !inlineProviderEnum.test(providerParameterSource)
      ),
    }).toEqual({ accountSlot: true, provider: true });
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
    expect(document.components.schemas.StorageLayoutReportResponse).toMatchObject({
      type: 'object',
      required: ['dataRoot', 'serverDb', 'users', 'workspaces', 'quarantineEntries'],
    });
    expect(document.paths['/api/app/storage/layout-report']?.get).toMatchObject({
      operationId: 'getStorageLayoutReport',
      tags: ['storage'],
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/StorageLayoutReportResponse',
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
    expect(document.paths['/api/app/automations']?.get).toMatchObject({
      operationId: 'listAutomations',
      tags: ['automations'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListAutomationsResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/automations']?.post).toMatchObject({
      operationId: 'createAutomation',
      tags: ['automations'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/CreateAutomationRequest',
            },
          },
        },
      },
      responses: {
        '201': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/AutomationRecord',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/automations/{automationId}']?.patch).toMatchObject({
      operationId: 'updateAutomation',
      tags: ['automations'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/UpdateAutomationRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/AutomationRecord',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/automations/{automationId}']?.delete).toMatchObject({
      operationId: 'deleteAutomation',
      tags: ['automations'],
      responses: {
        '204': {
          description: 'Automation deleted.',
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
    expect(document.components.schemas.ProviderSubscriptionsResponse).toMatchObject({
      type: 'object',
      required: ['providers'],
    });
    expect(document.components.schemas.ProviderSubscriptionAccountsResponse).toMatchObject({
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
    for (const [path, method, operationId, requestSchema, responseSchema] of [
      [
        '/api/app/provider-subscriptions',
        'get',
        'listSubscriptionProviders',
        null,
        'ProviderSubscriptionsResponse',
      ],
      [
        '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts',
        'get',
        'listProviderSubscriptionAccounts',
        null,
        'ProviderSubscriptionAccountsResponse',
      ],
      [
        '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts',
        'post',
        'createProviderSubscriptionAccount',
        'CreateProviderSubscriptionAccountRequest',
        'ProviderSubscriptionAccount',
      ],
      [
        '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}',
        'patch',
        'updateProviderSubscriptionAccount',
        'UpdateProviderSubscriptionAccountRequest',
        'ProviderSubscriptionAccount',
      ],
      [
        '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}',
        'delete',
        'deleteProviderSubscriptionAccount',
        null,
        null,
      ],
      [
        '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/status',
        'get',
        'getProviderSubscriptionAccountStatus',
        null,
        'ProviderSubscriptionAccount',
      ],
      [
        '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/login',
        'post',
        'startProviderSubscriptionAccountLogin',
        'StartProviderSubscriptionAccountLoginRequest',
        'ProviderSubscriptionAccount',
      ],
      [
        '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/login/cancel',
        'post',
        'cancelProviderSubscriptionAccountLogin',
        'CancelProviderSubscriptionAccountLoginRequest',
        'ProviderSubscriptionAccount',
      ],
      [
        '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/logout',
        'post',
        'logoutProviderSubscriptionAccount',
        null,
        'ProviderSubscriptionAccount',
      ],
      [
        '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/quota',
        'get',
        'getProviderSubscriptionAccountQuota',
        null,
        'ProviderSubscriptionQuota',
      ],
    ] as const) {
      const operation = jsonObject(document.paths[path]?.[method]);
      const expectedParameterNames = [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => name);

      expect(operation?.parameters ?? []).toEqual(
        expectedParameterNames.map((name) =>
          expect.objectContaining({ in: 'path', name, required: true })
        )
      );
      expect(operation).toMatchObject({
        operationId,
        tags: ['provider-subscriptions'],
        ...(requestSchema
          ? {
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      $ref: `#/components/schemas/${requestSchema}`,
                    },
                  },
                },
              },
            }
          : {}),
        responses: responseSchema
          ? {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      $ref: `#/components/schemas/${responseSchema}`,
                    },
                  },
                },
              },
            }
          : {
              '204': {
                description: 'Provider-subscription account deleted.',
              },
            },
      });
    }
    expect(document.components.schemas.RuntimeConfigReloadResponse).toMatchObject({
      type: 'object',
      required: ['status', 'runtimeConfig', 'plan'],
    });
    expect(document.paths['/api/admin/config/reload']?.post).toMatchObject({
      operationId: 'reloadRuntimeConfig',
      tags: ['runtime-config'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/RuntimeConfigReloadRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RuntimeConfigReloadResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/admin/config/files']?.get).toMatchObject({
      operationId: 'listRuntimeConfigFiles',
      tags: ['runtime-config'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RuntimeConfigFileListResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/admin/config/file']?.get).toMatchObject({
      operationId: 'getRuntimeConfigFile',
      tags: ['runtime-config'],
      parameters: [expect.objectContaining({ name: 'id', in: 'query', required: true })],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RuntimeConfigFileReadResponse',
              },
            },
          },
        },
      },
    });
    for (const route of [
      ['post', 'createRuntimeConfigFile'],
      ['put', 'updateRuntimeConfigFile'],
    ] as const) {
      expect(document.paths['/api/admin/config/file']?.[route[0]]).toMatchObject({
        operationId: route[1],
        tags: ['runtime-config'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RuntimeConfigFileWriteRequest',
              },
            },
          },
        },
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/RuntimeConfigFileWriteResponse',
                },
              },
            },
          },
        },
      });
    }
    expect(document.paths['/api/admin/config/schemas']?.get).toMatchObject({
      operationId: 'getRuntimeConfigSchemas',
      tags: ['runtime-config'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RuntimeConfigSchemaCatalogResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/admin/config/validate']?.post).toMatchObject({
      operationId: 'validateRuntimeConfig',
      tags: ['runtime-config'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/RuntimeConfigValidationRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RuntimeConfigValidationResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/quick-chat']?.post).toMatchObject({
      operationId: 'quickChat',
      tags: ['app-utils'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/QuickChatRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/QuickChatResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/recovery/interrupted-workers']?.get).toMatchObject({
      operationId: 'listInterruptedWorkers',
      tags: ['app-utils'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListInterruptedWorkerStatesResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/interrupted-worker/{turnId}/retry'
      ]?.post
    ).toMatchObject({
      operationId: 'retryInterruptedWorkerCheckpoint',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/RetryInterruptedWorkerCheckpointRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RetryInterruptedWorkerCheckpointResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/scheduler/admissions']?.get
    ).toMatchObject({
      operationId: 'listSchedulerAdmissions',
      tags: ['app-utils'],
      parameters: [expect.objectContaining({ name: 'workspaceId', in: 'path', required: true })],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListSchedulerAdmissionsResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/scheduler/admissions/{queueEntryId}/retry']
        ?.post
    ).toMatchObject({
      operationId: 'retrySchedulerAdmission',
      tags: ['app-utils'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'queueEntryId', in: 'path', required: true }),
      ],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RetrySchedulerAdmissionResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/scheduler/admissions/{queueEntryId}/cancel']
        ?.post
    ).toMatchObject({
      operationId: 'cancelSchedulerAdmission',
      tags: ['app-utils'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'queueEntryId', in: 'path', required: true }),
      ],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CancelSchedulerAdmissionResponse',
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
    expect(document.paths['/api/turns/{turnId}/feedback']?.post).toMatchObject({
      operationId: 'submitTurnFeedback',
      tags: ['app-utils'],
      parameters: [expect.objectContaining({ name: 'turnId', in: 'path', required: true })],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/SubmitTurnFeedbackRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/TurnFeedbackResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/conversation-turns']
        ?.post
    ).toMatchObject({
      operationId: 'submitConversation',
      tags: ['modes'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'threadId', in: 'path', required: true }),
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/SubmitConversationRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SubmitConversationResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/task']?.post
    ).toMatchObject({
      operationId: 'startTaskMode',
      tags: ['modes'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/StartTaskModeRequest',
            },
          },
        },
      },
      responses: {
        '202': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/StartTaskModeResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/goal']?.get
    ).toMatchObject({
      operationId: 'getThreadGoalSummary',
      tags: ['modes'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ThreadGoalSummaryResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/goal']?.post
    ).toMatchObject({
      operationId: 'startThreadGoal',
      tags: ['modes'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/StartThreadGoalRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/StartThreadGoalResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/steering']?.post
    ).toMatchObject({
      operationId: 'submitThreadGoalSteering',
      tags: ['modes'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/SubmitThreadGoalSteeringRequest',
            },
          },
        },
      },
      responses: {
        '202': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SubmitThreadGoalSteeringResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/plan']?.post
    ).toMatchObject({
      operationId: 'createThreadGoalPlan',
      tags: ['modes'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/CreateThreadGoalPlanRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateThreadGoalPlanResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/plan/approve']?.post
    ).toMatchObject({
      operationId: 'approveThreadGoalPlan',
      tags: ['modes'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ApproveThreadGoalPlanRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ApproveThreadGoalPlanResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/plan/revise']?.post
    ).toMatchObject({
      operationId: 'reviseThreadGoalPlan',
      tags: ['modes'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ReviseThreadGoalPlanRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ReviseThreadGoalPlanResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/pause']?.post
    ).toMatchObject({
      operationId: 'pauseThreadGoal',
      tags: ['modes'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/PauseThreadGoalRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/PauseThreadGoalResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/resume']?.post
    ).toMatchObject({
      operationId: 'resumeThreadGoal',
      tags: ['modes'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ResumeThreadGoalRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ResumeThreadGoalResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/step']?.post
    ).toMatchObject({
      operationId: 'runThreadGoalStep',
      tags: ['modes'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/RunThreadGoalStepRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RunThreadGoalStepResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/knowledge/manager/answer']?.post
    ).toMatchObject({
      operationId: 'answerKnowledgeManager',
      tags: ['knowledge'],
      parameters: [expect.objectContaining({ name: 'workspaceId', in: 'path', required: true })],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/KnowledgeManagerAnswerRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/KnowledgeManagerAnswerResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/workspaces/{workspaceId}/knowledge/sources']).toMatchObject({
      get: {
        operationId: 'listKnowledgeSources',
        tags: ['knowledge'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ListKnowledgeSourcesResponse',
                },
              },
            },
          },
        },
      },
      post: {
        operationId: 'registerKnowledgeSource',
        tags: ['knowledge'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RegisterKnowledgeSourceRequest',
              },
            },
          },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/RegisterKnowledgeSourceResponse',
                },
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/knowledge/sources/{sourceId}']?.get
    ).toMatchObject({
      operationId: 'readKnowledgeSource',
      tags: ['knowledge'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'sourceId', in: 'path', required: true }),
      ],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ReadKnowledgeSourceResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/knowledge/observations']
    ).toMatchObject({
      get: {
        operationId: 'listKnowledgeObservations',
        tags: ['knowledge'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ListKnowledgeObservationsResponse',
                },
              },
            },
          },
        },
      },
      post: {
        operationId: 'recordKnowledgeObservation',
        tags: ['knowledge'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RecordKnowledgeObservationRequest',
              },
            },
          },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/RecordKnowledgeObservationResponse',
                },
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/workspaces/{workspaceId}/knowledge/claims']).toMatchObject({
      get: {
        operationId: 'listKnowledgeClaims',
        tags: ['knowledge'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ListKnowledgeClaimsResponse',
                },
              },
            },
          },
        },
      },
      post: {
        operationId: 'recordKnowledgeClaim',
        tags: ['knowledge'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RecordKnowledgeClaimRequest',
              },
            },
          },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/RecordKnowledgeClaimResponse',
                },
              },
            },
          },
        },
      },
    });
    expect(document.paths).not.toHaveProperty(
      '/api/app/workspaces/{workspaceId}/knowledge/claims/{claimId}/promotion'
    );
    expect(document.paths['/api/app/workspaces/{workspaceId}/knowledge/conflicts']).toMatchObject({
      get: {
        operationId: 'listKnowledgeConflicts',
        tags: ['knowledge'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ListKnowledgeConflictsResponse',
                },
              },
            },
          },
        },
      },
      post: {
        operationId: 'recordKnowledgeConflict',
        tags: ['knowledge'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RecordKnowledgeConflictRequest',
              },
            },
          },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/RecordKnowledgeConflictResponse',
                },
              },
            },
          },
        },
      },
    });
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/knowledge/conflicts/{conflictId}/resolution'
      ]?.post
    ).toMatchObject({
      operationId: 'resolveKnowledgeConflict',
      tags: ['knowledge'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ResolveKnowledgeConflictRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ResolveKnowledgeConflictResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/knowledge/indexes']?.get
    ).toMatchObject({
      operationId: 'readKnowledgeIndexes',
      tags: ['knowledge'],
      parameters: [expect.objectContaining({ name: 'workspaceId', in: 'path', required: true })],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/KnowledgeDerivedIndexesResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/knowledge/retrievals']?.post
    ).toMatchObject({
      operationId: 'retrieveKnowledge',
      tags: ['knowledge'],
      parameters: [expect.objectContaining({ name: 'workspaceId', in: 'path', required: true })],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/RetrieveKnowledgeRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/KnowledgeRetrievalResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/knowledge/manager/context']?.post
    ).toMatchObject({
      operationId: 'prepareKnowledgeContext',
      tags: ['knowledge'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/KnowledgeManagerPrepareContextRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/KnowledgeManagerPrepareContextResponse',
              },
            },
          },
        },
      },
    });
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
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/knowledge/manager/proposals']?.post
    ).toMatchObject({
      operationId: 'draftKnowledgeProposal',
      tags: ['knowledge'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/KnowledgeManagerDraftProposalRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/KnowledgeManagerDraftProposalResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/knowledge/manager/repairs']?.post
    ).toMatchObject({
      operationId: 'suggestKnowledgeRepairs',
      tags: ['knowledge'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/KnowledgeManagerSuggestRepairRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/KnowledgeManagerSuggestRepairResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/knowledge/manager/health']?.post
    ).toMatchObject({
      operationId: 'checkKnowledgeHealth',
      tags: ['knowledge'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/KnowledgeManagerHealthCheckRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/KnowledgeManagerHealthCheckResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/workspaces/{workspaceId}/dashboard']?.get).toMatchObject({
      operationId: 'getWorkspaceDashboard',
      tags: ['dashboards'],
      parameters: [expect.objectContaining({ name: 'workspaceId', in: 'path', required: true })],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/WorkspaceDashboardResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/dashboard']?.get
    ).toMatchObject({
      operationId: 'getThreadDashboard',
      tags: ['dashboards'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'threadId', in: 'path', required: true }),
      ],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ThreadDashboardResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/items']?.get
    ).toMatchObject({
      operationId: 'listThreadItems',
      tags: ['dashboards'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'threadId', in: 'path', required: true }),
        expect.objectContaining({ name: 'since', in: 'query', required: false }),
        expect.objectContaining({ name: 'limit', in: 'query', required: false }),
      ],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListThreadItemsResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/workspaces/{workspaceId}/action-center']?.get).toMatchObject({
      operationId: 'listHumanAttention',
      tags: ['dashboards'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListHumanAttentionResponse',
              },
            },
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
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/knowledge/proposals/{proposalId}/decision']
        ?.post
    ).toMatchObject({
      operationId: 'submitKnowledgeProposalDecision',
      tags: ['reviews'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/SubmitKnowledgeProposalDecisionRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SubmitKnowledgeProposalDecisionResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/goals/{goalId}/reviews/{reviewId}/decision'
      ]?.post
    ).toMatchObject({
      operationId: 'submitGoalReviewDecision',
      tags: ['reviews'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/SubmitGoalReviewDecisionRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SubmitGoalReviewDecisionResponse',
              },
            },
          },
        },
      },
    });
    expect(document.components.schemas.ListWorkspaceSyncReviewsResponse).toMatchObject({
      type: 'object',
      required: ['items'],
    });
    for (const route of [
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/reviews',
        'listWorkspaceSyncReviews',
        'ListWorkspaceSyncReviewsResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/reviews/{reviewId}',
        'getWorkspaceSyncReview',
        'GetWorkspaceSyncReviewResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/input-snapshots',
        'listWorkspaceInputSnapshots',
        'ListWorkspaceInputSnapshotsResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/materialization-records',
        'listWorkspaceMaterializationRecords',
        'ListWorkspaceMaterializationRecordsResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/backend-handles',
        'listBackendWorkspaceHandles',
        'ListBackendWorkspaceHandlesResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/output-manifests',
        'listWorkerOutputManifests',
        'ListWorkerOutputManifestsResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/change-sets',
        'listWorkspaceChangeSets',
        'ListWorkspaceChangeSetsResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/staged-reviews',
        'listStagedWorkspaceReviews',
        'ListStagedWorkspaceReviewsResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/apply-plans',
        'listWorkspaceApplyPlans',
        'ListWorkspaceApplyPlansResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/reconciliation-records',
        'listWorkspaceReconciliationRecords',
        'ListWorkspaceReconciliationRecordsResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/quarantine-records',
        'listWorkspaceQuarantineRecords',
        'ListWorkspaceQuarantineRecordsResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/apply-results',
        'listWorkspaceApplyResults',
        'ListWorkspaceApplyResultsResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/workspace-sync/apply-results/{applyResultId}',
        'getWorkspaceApplyResult',
        'GetWorkspaceApplyResultResponse',
      ],
    ] as const) {
      expect(document.paths[route[0]]?.get).toMatchObject({
        operationId: route[1],
        tags: ['workspace-sync'],
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
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/workspace-sync/reviews/{reviewId}/decision']
        ?.post
    ).toMatchObject({
      operationId: 'submitWorkspaceSyncReviewDecision',
      tags: ['workspace-sync'],
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SubmitWorkspaceSyncReviewDecisionRequest' },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SubmitWorkspaceSyncReviewDecisionResponse' },
            },
          },
        },
      },
    });
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/workspace-sync/reconciliation-records/{reconciliationRecordId}/decision'
      ]?.post
    ).toMatchObject({
      operationId: 'submitWorkspaceRecoveryDecision',
      tags: ['workspace-sync'],
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SubmitWorkspaceRecoveryDecisionRequest' },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SubmitWorkspaceRecoveryDecisionResponse' },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/data-root/backups']?.post).toMatchObject({
      operationId: 'createDataRootBackup',
      tags: ['storage'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/DataRootBackupCreateResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/data-root/backups/{backupId}/verify']?.post).toMatchObject({
      operationId: 'verifyDataRootBackup',
      tags: ['storage'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/DataRootBackupVerifyRequest',
            },
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
    expect(document.paths['/api/app/workspaces/{workspaceId}/repositories']?.get).toMatchObject({
      operationId: 'listWorkspaceRepositories',
      tags: ['repositories'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListWorkspaceRepositoriesResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/repositories/diagnostics']?.get
    ).toMatchObject({
      operationId: 'getWorkspaceRepositoryDiagnostics',
      tags: ['repositories'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/WorkspaceRepositoryDiagnosticsResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/repositories/default']?.put
    ).toMatchObject({
      operationId: 'setDefaultWorkspaceRepository',
      tags: ['repositories'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/SetWorkspaceRepositoryRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SetWorkspaceRepositoryResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/repositories/default']?.post
    ).toBeUndefined();
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/repositories/git-push-records']?.get
    ).toMatchObject({
      operationId: 'listGitPushRecords',
      tags: ['repositories'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListGitPushRecordsResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/repositories/git-push-records/{pushRecordId}'
      ]?.get
    ).toMatchObject({
      operationId: 'getGitPushRecord',
      tags: ['repositories'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'pushRecordId', in: 'path', required: true }),
      ],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/GetGitPushRecordResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/repositories/{resourceId}/git-push/approval'
      ]?.post
    ).toMatchObject({
      operationId: 'requestGitPushApproval',
      tags: ['repositories'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/RequestGitPushApprovalRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RequestGitPushApprovalResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/repositories/{resourceId}/git-push']?.post
    ).toMatchObject({
      operationId: 'executeGitPush',
      tags: ['repositories'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ExecuteGitPushRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ExecuteGitPushResponse',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/storage/layout-report']?.get.responses.default).toMatchObject({
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/ApiError',
          },
        },
      },
    });
  });

  it('projects the exact Stage 3 Goal steering terminal commands', () => {
    const document = createAppOpenApiDocument();
    const operations = [
      [
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/steering/{pendingTurnId}/follow-up',
        'convertGoalSteeringToFollowUp',
        'ConvertGoalSteeringToFollowUpRequest',
        'ConvertGoalSteeringToFollowUpResponse',
      ],
      [
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/steering/{pendingTurnId}/cancel',
        'cancelGoalSteering',
        'CancelGoalSteeringRequest',
        'CancelGoalSteeringResponse',
      ],
    ] as const;

    for (const [path, operationId, requestSchema, responseSchema] of operations) {
      expect(document.paths[path]?.post, path).toMatchObject({
        operationId,
        parameters: [
          { name: 'workspaceId', in: 'path', required: true },
          { name: 'threadId', in: 'path', required: true },
          { name: 'pendingTurnId', in: 'path', required: true },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${requestSchema}` },
            },
          },
        },
        responses: {
          '200': {
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
    }
  });

  it('projects the Stage 2 Artifact and Material operations from shared schemas', () => {
    const document = createAppOpenApiDocument();
    const operations = [
      [
        'post',
        '/api/app/workspaces/{workspaceId}/artifacts/imports',
        'importWorkspaceArtifact',
        'ImportWorkspaceArtifactRequest',
        '201',
        'ImportWorkspaceArtifactResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/artifacts/{artifactId}/introductions',
        'introduceWorkspaceArtifact',
        'IntroduceWorkspaceArtifactRequest',
        '201',
        'IntroduceWorkspaceArtifactResponse',
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

  it('projects the Stage 4 Artifact Review operations from shared schemas', () => {
    const document = createAppOpenApiDocument();

    expect(
      document.paths['/api/app/workspaces/{workspaceId}/artifacts/{artifactId}/reviews']?.get
    ).toMatchObject({
      operationId: 'listArtifactReviews',
      tags: ['reviews'],
      parameters: [
        { name: 'workspaceId', in: 'path', required: true },
        { name: 'artifactId', in: 'path', required: true },
      ],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ListArtifactReviewsResponse' },
            },
          },
        },
        default: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
          },
        },
      },
    });
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/artifacts/{artifactId}/versions/{artifactVersion}/review/decision'
      ]?.post
    ).toMatchObject({
      operationId: 'submitArtifactReviewDecision',
      tags: ['reviews'],
      parameters: [
        { name: 'workspaceId', in: 'path', required: true },
        { name: 'artifactId', in: 'path', required: true },
        {
          name: 'artifactVersion',
          in: 'path',
          required: true,
          schema: { type: 'integer', minimum: 1 },
        },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SubmitArtifactReviewDecisionRequest' },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SubmitArtifactReviewDecisionResponse' },
            },
          },
        },
        default: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
          },
        },
      },
    });
    expect(document.components.schemas.ListArtifactReviewsResponse).toBeDefined();
    expect(document.components.schemas.SubmitArtifactReviewDecisionRequest).toBeDefined();
    expect(document.components.schemas.SubmitArtifactReviewDecisionResponse).toBeDefined();
  });

  it('projects the closed Workspace sharing and lifecycle surface from shared schemas', () => {
    const document = createAppOpenApiDocument();
    const operations = [
      [
        'get',
        '/api/app/workspaces',
        'listAuthorizedWorkspaces',
        undefined,
        'ListAuthorizedWorkspacesResponse',
      ],
      [
        'get',
        '/api/app/workspaces/{workspaceId}/members',
        'listWorkspaceMembers',
        undefined,
        'ListWorkspaceMembersResponse',
      ],
      [
        'get',
        '/api/app/workspaces/{workspaceId}/invitations',
        'listWorkspaceInvitations',
        undefined,
        'ListWorkspaceInvitationsResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/invitations',
        'createWorkspaceInvitation',
        'CreateWorkspaceInvitationRequest',
        'WorkspaceInvitationMutationResponse',
      ],
      [
        'get',
        '/api/app/workspace-invitations',
        'listMyWorkspaceInvitations',
        undefined,
        'ListWorkspaceInvitationsResponse',
      ],
      [
        'post',
        '/api/app/workspace-invitations/{invitationId}/accept',
        'acceptWorkspaceInvitation',
        'AcceptWorkspaceInvitationRequest',
        'WorkspaceInvitationMutationResponse',
      ],
      [
        'post',
        '/api/app/workspace-invitations/{invitationId}/decline',
        'declineWorkspaceInvitation',
        'DeclineWorkspaceInvitationRequest',
        'WorkspaceInvitationMutationResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/invitations/{invitationId}/revoke',
        'revokeWorkspaceInvitation',
        'RevokeWorkspaceInvitationRequest',
        'WorkspaceInvitationMutationResponse',
      ],
      [
        'patch',
        '/api/app/workspaces/{workspaceId}/members/{userId}',
        'changeWorkspaceMemberAccess',
        'ChangeWorkspaceMemberAccessRequest',
        'WorkspaceMemberMutationResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/members/{userId}/remove',
        'removeWorkspaceMember',
        'RemoveWorkspaceMemberRequest',
        'WorkspaceMemberMutationResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/leave',
        'leaveWorkspace',
        'LeaveWorkspaceRequest',
        'WorkspaceMemberMutationResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/ownership/transfer',
        'transferWorkspaceOwnership',
        'TransferWorkspaceOwnershipRequest',
        'WorkspaceOwnershipMutationResponse',
      ],
      [
        'get',
        '/api/app/workspaces/{workspaceId}/access-recovery',
        'getWorkspaceAccessRecoveryState',
        undefined,
        'WorkspaceAccessRecoveryResponse',
      ],
      [
        'post',
        '/api/app/workspaces/{workspaceId}/access-recovery',
        'recoverWorkspaceAccess',
        'RecoverWorkspaceAccessRequest',
        'WorkspaceAccessRecoveryResponse',
      ],
      [
        'post',
        '/api/app/users/{userId}/disable',
        'disableUser',
        'DisableUserRequest',
        'DisableUserResponse',
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
          [operationId === 'createWorkspaceInvitation' ? '201' : '200']: {
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
      listMyWorkspaceInvitations: [{ sessionCookie: [] }],
      acceptWorkspaceInvitation: [{ sessionCookie: [] }],
      declineWorkspaceInvitation: [{ sessionCookie: [] }],
      leaveWorkspace: [{ sessionCookie: [] }],
      getWorkspaceAccessRecoveryState: [{ bearerAuth: [] }, { sessionCookie: [] }],
      recoverWorkspaceAccess: [{ bearerAuth: [] }, { sessionCookie: [] }],
      disableUser: [{ bearerAuth: [] }, { sessionCookie: [] }],
      listAuthorizedWorkspaces: [{ bearerAuth: [] }, { sessionCookie: [] }],
    });
  });

  it('keeps live public app api routes and openapi operations aligned', () => {
    const app = createApp();
    const unsupportedMethodRoutes = app.routes
      .filter(
        ({ method, path }) =>
          (method === 'ALL' && isProjectedAppApiRoute(method, path)) ||
          (method !== 'ALL' && !OPENAPI_ROUTE_METHOD_SET.has(method))
      )
      .map(({ method, path }) => `${method} ${path}`);
    const explicitRoutes = app.routes.filter(({ method }) => OPENAPI_ROUTE_METHOD_SET.has(method));
    const unclassifiedRoutes = explicitRoutes
      .filter(
        ({ method, path }) =>
          !isProjectedAppApiRoute(method, path) &&
          !NON_APP_API_ROUTE_PATTERNS.some((pattern) => pattern.test(path))
      )
      .map(({ method, path }) => `${method} ${path}`);
    const liveRoutes = explicitRoutes.filter(({ method, path }) =>
      isProjectedAppApiRoute(method, path)
    );
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
              : !Object.hasOwn(metadata, 'authentication');
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
    expect(PUBLIC_OPERATION_ACCESS.quickChat).toMatchObject({
      mutating: true,
      policyOperation: 'turn.run',
      resolver: 'actor-quick-chat-workspace',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS['GET /api/workspaces']).toMatchObject({
      mutating: false,
      policyOperation: 'workspace.read',
      resolver: 'authorized-workspace-set',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS['POST /api/turns']).toMatchObject({
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
    expect(PUBLIC_OPERATION_ACCESS['POST /api/approvals/:approvalRequestId/respond']).toMatchObject(
      {
        mutating: true,
        policyOperation: 'approval.respond',
        resolver: 'opaque-child-workspace',
        scope: 'workspace',
      }
    );
    expect(PUBLIC_OPERATION_ACCESS['GET /api/workspaces/:workspaceId']).toMatchObject({
      mutating: false,
      policyOperation: 'workspace.read',
      resolver: 'path-workspace',
      scope: 'workspace',
    });
    expect(
      PUBLIC_OPERATION_ACCESS['GET /api/workspaces/:workspaceId/threads/:threadId']
    ).toMatchObject({
      mutating: false,
      policyOperation: 'thread.read',
      resolver: 'workspace-child-lineage',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS['POST /api/workspaces']).toMatchObject({
      authentication: 'canonical-user',
      mutating: true,
      policyOperation: 'workspace.write',
      scope: 'user',
    });
    expect(PUBLIC_OPERATION_ACCESS.dryRunWorkspaceImport).toMatchObject({
      authentication: 'canonical-user',
      mutating: false,
      policyOperation: 'workspace.write',
      scope: 'user',
    });
    expect(PUBLIC_OPERATION_ACCESS.importWorkspace).toMatchObject({
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

    expect(PUBLIC_OPERATION_ACCESS.retrieveKnowledge?.mutating).toBe(true);
    expect(PUBLIC_OPERATION_ACCESS.prepareKnowledgeContext).toMatchObject({
      mutating: true,
      policyOperation: 'knowledge.read',
      resolver: 'path-workspace',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS.reverseKnowledgeProposal).toMatchObject({
      mutating: true,
      policyOperation: 'knowledge.write',
      resolver: 'workspace-child-lineage',
      scope: 'workspace',
    });
    expect(PUBLIC_OPERATION_ACCESS.answerKnowledgeManager?.mutating).toBe(false);
    expect(PUBLIC_OPERATION_ACCESS.suggestKnowledgeRepairs?.mutating).toBe(false);
    expect(PUBLIC_OPERATION_ACCESS.checkKnowledgeHealth?.mutating).toBe(false);
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
          !/^[a-z][A-Za-z0-9]*$/.test(operation.operationId)
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

    registerAppApiRoute(app, 'getStorageLayoutReport', (c) => c.json({ ok: true }));

    expect(app.routes.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/api/app/storage/layout-report' },
    ]);
    expect(getRegisteredAppApiOperationIds(app)).toEqual(['getStorageLayoutReport']);
    const response = await app.request('/api/app/storage/layout-report');
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(() =>
      registerAppApiRoute(app, 'getStorageLayoutReport', (c) => c.json({ ok: true }))
    ).toThrow('App API operation is already registered: getStorageLayoutReport');
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
      .filter(({ method, path }) => isProjectedAppApiRoute(method, path))
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
      'enrollNanoHost',
      'getNanoHostRuntimeTargetStatus',
      'listNanoHostTransportTokens',
      'issueNanoHostTransportToken',
      'revokeNanoHostTransportToken',
      'rotateNanoHostTransportToken',
      'abortNanoHostTransportTokenRotation',
      'decommissionNanoHost',
      'getVaultAdminStatus',
      'setProviderApiKey',
      'listServerVaultUseRecords',
      'unlockVaultAdminBackend',
      'bootstrapCodexAuthJsonVaultReference',
      'rebindWorkspaceVaultReference',
      'listWorkspaceVaultReferences',
      'listWorkspaceVaultUseRecords',
      'lockVaultAdminBackend',
      'listSubscriptionProviders',
      'listProviderSubscriptionAccounts',
      'createProviderSubscriptionAccount',
      'updateProviderSubscriptionAccount',
      'deleteProviderSubscriptionAccount',
      'getProviderSubscriptionAccountStatus',
      'startProviderSubscriptionAccountLogin',
      'cancelProviderSubscriptionAccountLogin',
      'logoutProviderSubscriptionAccount',
      'getProviderSubscriptionAccountQuota',
      'getAppDiagnostics',
      'getSetupDiagnostics',
      'getStorageLayoutReport',
      'createDataRootBackup',
      'verifyDataRootBackup',
      'exportWorkspace',
      'downloadWorkspaceExportArchive',
      'dryRunWorkspaceArchiveImport',
      'importWorkspaceArchive',
      'dryRunWorkspaceImport',
      'importWorkspace',
      'deleteWorkspace',
      'recoverDeletedWorkspace',
      'reloadRuntimeConfig',
      'listRuntimeConfigFiles',
      'getRuntimeConfigFile',
      'createRuntimeConfigFile',
      'updateRuntimeConfigFile',
      'getRuntimeConfigSchemas',
      'validateRuntimeConfig',
      'getConversationTargets',
      'quickChat',
      'submitConversation',
      'listThreadItems',
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
      'listAutomations',
      'createAutomation',
      'updateAutomation',
      'deleteAutomation',
      'searchApp',
      'listAgentCatalog',
      'getAgentCatalogEntry',
      'listWorkspaceRepositories',
      'getWorkspaceRepositoryDiagnostics',
      'listGitPushRecords',
      'requestGitPushApproval',
      'executeGitPush',
      'getGitPushRecord',
      'setDefaultWorkspaceRepository',
      'listHumanAttention',
      'listSchedulerAdmissions',
      'retrySchedulerAdmission',
      'cancelSchedulerAdmission',
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
      'getWorkspaceDashboard',
      'getThreadDashboard',
      'startTaskMode',
      'getThreadGoalSummary',
      'startThreadGoal',
      'submitThreadGoalSteering',
      'convertGoalSteeringToFollowUp',
      'cancelGoalSteering',
      'createThreadGoalPlan',
      'approveThreadGoalPlan',
      'reviseThreadGoalPlan',
      'pauseThreadGoal',
      'resumeThreadGoal',
      'runThreadGoalStep',
      'listInterruptedWorkers',
      'retryInterruptedWorkerCheckpoint',
      'refreshAgentHealth',
      'listAuthorizedWorkspaces',
      'listWorkspaceMembers',
      'listWorkspaceInvitations',
      'createWorkspaceInvitation',
      'listMyWorkspaceInvitations',
      'acceptWorkspaceInvitation',
      'declineWorkspaceInvitation',
      'revokeWorkspaceInvitation',
      'changeWorkspaceMemberAccess',
      'removeWorkspaceMember',
      'leaveWorkspace',
      'transferWorkspaceOwnership',
      'getWorkspaceAccessRecoveryState',
      'recoverWorkspaceAccess',
      'disableUser',
      'registerKnowledgeSource',
      'listKnowledgeSources',
      'recordKnowledgeObservation',
      'listKnowledgeObservations',
      'recordKnowledgeClaim',
      'listKnowledgeClaims',
      'recordKnowledgeConflict',
      'listKnowledgeConflicts',
      'resolveKnowledgeConflict',
      'readKnowledgeIndexes',
      'retrieveKnowledge',
      'readKnowledgeSource',
      'answerKnowledgeManager',
      'prepareKnowledgeContext',
      'draftKnowledgeProposal',
      'suggestKnowledgeRepairs',
      'checkKnowledgeHealth',
      'submitTurnFeedback',
      'listArtifactReviews',
      'submitArtifactReviewDecision',
      'importWorkspaceArtifact',
      'introduceWorkspaceArtifact',
      'listWorkspaceSyncReviews',
      'getWorkspaceSyncReview',
      'submitWorkspaceSyncReviewDecision',
      'listWorkspaceInputSnapshots',
      'listWorkspaceMaterializationRecords',
      'listBackendWorkspaceHandles',
      'listWorkerOutputManifests',
      'listWorkspaceChangeSets',
      'listStagedWorkspaceReviews',
      'listWorkspaceApplyPlans',
      'listWorkspaceReconciliationRecords',
      'submitWorkspaceRecoveryDecision',
      'listWorkspaceQuarantineRecords',
      'listWorkspaceApplyResults',
      'getWorkspaceApplyResult',
      'listAgentEnvironmentPackageSnapshots',
      'getAgentEnvironmentPackageSnapshot',
      'submitKnowledgeProposalDecision',
      'reverseKnowledgeProposal',
      'submitGoalReviewDecision',
    ]);
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
