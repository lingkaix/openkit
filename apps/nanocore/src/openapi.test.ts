import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { APP_OPENAPI_ROUTE_COVERAGE_EXCLUSIONS, createAppOpenApiDocument } from './openapi.js';
import { validateAppOpenApiDocument } from './openapi-validation.js';

const ROUTE_METHOD_PATTERN =
  /app\.(get|post|put|patch|delete)\s*\(\s*['"](\/api\/(?:(?:app|setup|admin|turns)(?:\/|$))[^'"]+)['"]/g;
const FIRST_PARTY_CONSUMER_ROOTS = [
  '../../../apps/web/src/',
  '../../../mcp/src/',
  '../../../packages/core-client/src/',
];

function normalizeHonoRoutePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

describe('app api openapi projection', () => {
  it('projects the storage layout report route from shared schemas', () => {
    const document = createAppOpenApiDocument();

    expect(document.openapi).toBe('3.1.0');
    expect(document.info.version).toBe(PROTOCOL_VERSION);
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

  it('registers every public app api route in the openapi projection', () => {
    const appSource = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');
    const document = createAppOpenApiDocument();
    const excludedOperations = new Set<string>(APP_OPENAPI_ROUTE_COVERAGE_EXCLUSIONS);
    const missingOperations: string[] = [];

    for (const match of appSource.matchAll(ROUTE_METHOD_PATTERN)) {
      const [, method, path] = match;
      const normalizedPath = normalizeHonoRoutePath(path);
      const operation = `${method.toUpperCase()} ${normalizedPath}`;

      if (!excludedOperations.has(operation) && !document.paths[normalizedPath]?.[method]) {
        missingOperations.push(operation);
      }
    }

    expect(missingOperations).toEqual([]);
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
