import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CapabilityUsageResponseSchema } from '@openkit/app-api-schemas';
import {
  AgentIdSchema,
  AgentSessionIdSchema,
  ArtifactIdSchema,
  PROTOCOL_VERSION,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import {
  APP_OPENAPI_ROUTE_COVERAGE_EXCLUSIONS,
  APP_OPENAPI_ROUTE_METHODS,
  createAppOpenApiDocument,
  getRegisteredAppApiOperationIds,
  registerAppApiRoute,
} from './openapi.js';
import { validateAppOpenApiDocument } from './openapi-validation.js';

const OPENAPI_ROUTE_METHOD_SET = new Set<string>(
  APP_OPENAPI_ROUTE_METHODS.map((method) => method.toUpperCase())
);
const PROJECTED_APP_API_ROUTE_PATTERN = /^\/api\/(?:app|setup|admin)(?:\/|$)/;
const TURN_FEEDBACK_ROUTE = '/api/turns/:turnId/feedback';
const NON_APP_API_ROUTE_PATTERNS = [
  /^\/v1(?:\/|$)/,
  /^\/internal(?:\/|$)/,
  /^\/api\/worker-control(?:\/|$)/,
  /^\/api\/worker-capabilities(?:\/|$)/,
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
const FIRST_PARTY_CONSUMER_ROOTS = [
  '../../../apps/web/src/',
  '../../../mcp/src/',
  '../../../packages/core-client/src/',
];

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
      required: ['dataRoot', 'serverDb', 'users', 'quarantineEntries'],
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
    expect(document.components.schemas.CodexOAuthAccountsPayload).toMatchObject({
      type: 'object',
      required: ['accounts', 'defaultAccountSlotId'],
    });
    expect(document.paths['/api/app/oauth/openai-codex/accounts']?.get).toMatchObject({
      operationId: 'listOpenAICodexOAuthAccounts',
      tags: ['oauth'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CodexOAuthAccountsPayload',
              },
            },
          },
        },
      },
    });
    expect(document.paths['/api/app/oauth/openai-codex/accounts']?.post).toMatchObject({
      operationId: 'createOpenAICodexOAuthAccount',
      tags: ['oauth'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/CreateOpenAICodexOAuthAccountRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CodexOAuthAccountSummary',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/oauth/openai-codex/accounts/{accountSlotId}']?.patch
    ).toMatchObject({
      operationId: 'updateOpenAICodexOAuthAccount',
      tags: ['oauth'],
      parameters: [expect.objectContaining({ name: 'accountSlotId', in: 'path', required: true })],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/UpdateOpenAICodexOAuthAccountRequest',
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/oauth/openai-codex/accounts/{accountSlotId}']?.delete
    ).toMatchObject({
      operationId: 'deleteOpenAICodexOAuthAccount',
      tags: ['oauth'],
      responses: {
        '204': {
          description: 'OpenAI Codex OAuth account deleted.',
        },
      },
    });
    expect(
      document.paths['/api/app/oauth/openai-codex/accounts/{accountSlotId}/status']?.get
    ).toMatchObject({
      operationId: 'getOpenAICodexOAuthAccountStatus',
      tags: ['oauth'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CodexOAuthStatusPayload',
              },
            },
          },
        },
      },
    });
    for (const route of [
      [
        '/api/app/oauth/openai-codex/accounts/{accountSlotId}/start',
        'startOpenAICodexOAuthAccountLogin',
        'StartOpenAICodexOAuthRequest',
      ],
      [
        '/api/app/oauth/openai-codex/accounts/{accountSlotId}/cancel',
        'cancelOpenAICodexOAuthAccountLogin',
        'CancelOpenAICodexOAuthRequest',
      ],
    ] as const) {
      expect(document.paths[route[0]]?.post).toMatchObject({
        operationId: route[1],
        tags: ['oauth'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                $ref: `#/components/schemas/${route[2]}`,
              },
            },
          },
        },
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/CodexOAuthStatusPayload',
                },
              },
            },
          },
        },
      });
    }
    expect(
      document.paths['/api/app/oauth/openai-codex/accounts/{accountSlotId}/logout']?.post
    ).toMatchObject({
      operationId: 'logoutOpenAICodexOAuthAccount',
      tags: ['oauth'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CodexOAuthStatusPayload',
              },
            },
          },
        },
      },
    });
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
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/pending-user-turns'
      ]?.get
    ).toMatchObject({
      operationId: 'listRecoveryPendingUserTurns',
      tags: ['app-utils'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'threadId', in: 'path', required: true }),
      ],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListRecoveryPendingUserTurnsResponse',
              },
            },
          },
        },
      },
    });
    expect(document.components.schemas.ListRecoveryPendingUserTurnsResponse).toMatchObject({
      type: 'object',
      required: ['items'],
    });
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/interrupted-worker'
      ]?.post
    ).toMatchObject({
      operationId: 'createInterruptedRecoveryState',
      tags: ['app-utils'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'threadId', in: 'path', required: true }),
      ],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateInterruptedRecoveryStateResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/interrupted-worker/{turnId}/terminal'
      ]?.post
    ).toMatchObject({
      operationId: 'clearInterruptedWorkerCheckpoint',
      tags: ['app-utils'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'threadId', in: 'path', required: true }),
        expect.objectContaining({ name: 'turnId', in: 'path', required: true }),
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ClearInterruptedWorkerCheckpointRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ClearInterruptedWorkerCheckpointResponse',
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
      document.paths['/api/app/workspaces/{workspaceId}/threads/{threadId}/chat']?.post
    ).toMatchObject({
      operationId: 'startChatMode',
      tags: ['modes'],
      parameters: [
        expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
        expect.objectContaining({ name: 'threadId', in: 'path', required: true }),
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/StartChatModeRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/StartChatModeResponse',
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
        '200': {
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
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/knowledge/claims/{claimId}/promotion']
    ).toMatchObject({
      post: {
        operationId: 'promoteKnowledgeClaim',
        tags: ['knowledge'],
        parameters: [
          expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
          expect.objectContaining({ name: 'claimId', in: 'path', required: true }),
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/PromoteKnowledgeClaimRequest',
              },
            },
          },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/PromoteKnowledgeClaimResponse',
                },
              },
            },
          },
        },
      },
    });
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
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/knowledge/manager/context/{contextPackageId}'
      ]?.get
    ).toMatchObject({
      operationId: 'readKnowledgeContextPackageTrace',
      tags: ['knowledge'],
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: 'workspaceId' }),
        expect.objectContaining({ name: 'contextPackageId' }),
      ]),
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ReadKnowledgeManagerContextPackageTraceResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/knowledge/manager/context/{contextPackageId}/materialization'
      ]?.post
    ).toMatchObject({
      operationId: 'materializeKnowledgeContextPackage',
      tags: ['knowledge'],
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: 'workspaceId' }),
        expect.objectContaining({ name: 'contextPackageId' }),
      ]),
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/MaterializeKnowledgeContextPackageResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/knowledge/manager/context/{contextPackageId}/materialization'
      ]?.get
    ).toMatchObject({
      operationId: 'readKnowledgeContextPackageMaterialization',
      tags: ['knowledge'],
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: 'workspaceId' }),
        expect.objectContaining({ name: 'contextPackageId' }),
      ]),
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/MaterializeKnowledgeContextPackageResponse',
              },
            },
          },
        },
      },
    });
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
    ).toMatchObject({
      operationId: 'createEvidenceBundle',
      tags: ['diagnostics'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/CreateEvidenceBundleRequest',
            },
          },
        },
      },
      responses: {
        '201': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateEvidenceBundleResponse',
              },
            },
          },
        },
      },
    });
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
    ).toMatchObject({
      operationId: 'submitArtifactReviewDecision',
      tags: ['reviews'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/SubmitArtifactReviewDecisionRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SubmitArtifactReviewDecisionResponse',
              },
            },
          },
        },
      },
    });
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
        '/api/app/workspaces/{workspaceId}/workspace-sync/evidence-bundles',
        'listWorkspaceSyncEvidenceBundles',
        'ListWorkspaceSyncEvidenceBundlesResponse',
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
    expect(
      document.paths[
        '/api/app/workspaces/{workspaceId}/threads/{threadId}/agent-sessions/{agentSessionId}/terminal-commands'
      ]?.post
    ).toMatchObject({
      operationId: 'queueAgentSessionTerminalCommand',
      tags: ['app-utils'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/QueueAgentSessionTerminalCommandRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/QueueAgentSessionTerminalCommandResponse',
              },
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
      operationId: 'listWorkspaceInjectionPlans',
      tags: ['vault'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListWorkspaceInjectionPlansResponse',
              },
            },
          },
        },
      },
    });
    expect(
      document.paths['/api/app/workspaces/{workspaceId}/vault/injection-receipts']?.get
    ).toMatchObject({
      operationId: 'listWorkspaceInjectionReceipts',
      tags: ['vault'],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ListWorkspaceInjectionReceiptsResponse',
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
    ).toMatchObject({
      operationId: 'createDefaultWorkspaceRepository',
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
    });
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
  });

  it('enforces semantic invariants for every documented operation', () => {
    const document = createAppOpenApiDocument();
    const operations: Array<{
      operation: Readonly<Record<string, unknown>>;
      route: string;
    }> = [];

    for (const [name, schema] of Object.entries({
      AgentId: AgentIdSchema,
      AgentSessionId: AgentSessionIdSchema,
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

        return expectedRef && schema?.$ref !== expectedRef ? [`${route} ${name}`] : [];
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

  it('preserves the characterized handler registration order', () => {
    expect(getRegisteredAppApiOperationIds(createApp())).toEqual([
      'consumeOpenKitBootstrapToken',
      'listOpenKitAccessTokens',
      'createOpenKitAccessToken',
      'revokeOpenKitAccessToken',
      'rotateOpenKitAccessToken',
      'getVaultAdminStatus',
      'listServerVaultUseRecords',
      'unlockVaultAdminBackend',
      'bootstrapCodexAuthJsonVaultReference',
      'rebindWorkspaceVaultReference',
      'listWorkspaceVaultReferences',
      'listWorkspaceVaultUseRecords',
      'lockVaultAdminBackend',
      'listOpenAICodexOAuthAccounts',
      'createOpenAICodexOAuthAccount',
      'updateOpenAICodexOAuthAccount',
      'deleteOpenAICodexOAuthAccount',
      'getOpenAICodexOAuthAccountStatus',
      'startOpenAICodexOAuthAccountLogin',
      'cancelOpenAICodexOAuthAccountLogin',
      'logoutOpenAICodexOAuthAccount',
      'getAppDiagnostics',
      'getSetupDiagnostics',
      'getStorageLayoutReport',
      'createDataRootBackup',
      'verifyDataRootBackup',
      'exportWorkspace',
      'dryRunWorkspaceImport',
      'importWorkspace',
      'reloadRuntimeConfig',
      'listRuntimeConfigFiles',
      'getRuntimeConfigFile',
      'createRuntimeConfigFile',
      'updateRuntimeConfigFile',
      'getRuntimeConfigSchemas',
      'validateRuntimeConfig',
      'restartRuntimeConfigStaleSession',
      'quickChat',
      'startChatMode',
      'listThreadItems',
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
      'createDefaultWorkspaceRepository',
      'listHumanAttention',
      'listSchedulerAdmissions',
      'retrySchedulerAdmission',
      'cancelSchedulerAdmission',
      'getCapabilityUsage',
      'createEvidenceBundle',
      'listWorkspaceEvidenceBundles',
      'listWorkspaceRuntimeEvidence',
      'listWorkspaceAuditEvents',
      'listServerAuditEvents',
      'listWorkspacePermissionDecisions',
      'listWorkspaceVaultGrants',
      'listWorkspaceInjectionPlans',
      'listWorkspaceInjectionReceipts',
      'listServerPermissionDecisions',
      'getWorkspaceDashboard',
      'getThreadDashboard',
      'queueAgentSessionTerminalCommand',
      'startTaskMode',
      'getThreadGoalSummary',
      'startThreadGoal',
      'submitThreadGoalSteering',
      'createThreadGoalPlan',
      'approveThreadGoalPlan',
      'reviseThreadGoalPlan',
      'pauseThreadGoal',
      'resumeThreadGoal',
      'runThreadGoalStep',
      'createInterruptedRecoveryState',
      'listInterruptedWorkers',
      'listRecoveryPendingUserTurns',
      'editRecoveryPendingUserTurn',
      'convertRecoveryPendingUserTurnToFollowUp',
      'promoteRecoveryPendingUserTurnToInterrupt',
      'cancelRecoveryPendingUserTurn',
      'retryInterruptedWorkerCheckpoint',
      'clearInterruptedWorkerCheckpoint',
      'refreshAgentHealth',
      'registerKnowledgeSource',
      'listKnowledgeSources',
      'recordKnowledgeObservation',
      'listKnowledgeObservations',
      'recordKnowledgeClaim',
      'listKnowledgeClaims',
      'promoteKnowledgeClaim',
      'recordKnowledgeConflict',
      'listKnowledgeConflicts',
      'resolveKnowledgeConflict',
      'readKnowledgeIndexes',
      'retrieveKnowledge',
      'readKnowledgeSource',
      'answerKnowledgeManager',
      'prepareKnowledgeContext',
      'readKnowledgeContextPackageTrace',
      'materializeKnowledgeContextPackage',
      'readKnowledgeContextPackageMaterialization',
      'draftKnowledgeProposal',
      'suggestKnowledgeRepairs',
      'checkKnowledgeHealth',
      'submitTurnFeedback',
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
      'listWorkspaceSyncEvidenceBundles',
      'listWorkspaceApplyResults',
      'getWorkspaceApplyResult',
      'listAgentEnvironmentPackageSnapshots',
      'getAgentEnvironmentPackageSnapshot',
      'submitArtifactReviewDecision',
      'submitKnowledgeProposalDecision',
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
