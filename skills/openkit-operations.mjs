import * as appSchemas from '@openkit/app-api-schemas';
import * as protocol from '@openkit/protocol';
import { z } from 'zod';

const EMPTY_INPUT = z.object({}).strict();
const IDENTIFIER = z.string().min(1);
const STANDARD = Object.freeze({
  inputSensitivity: 'standard',
  outputSensitivity: 'redacted public response',
  requiredAccess: 'authenticated user',
  redaction: 'recursive secrets and local paths',
});
const SECRET_INPUT = Object.freeze({
  ...STANDARD,
  inputSensitivity: 'secret stdin',
});
const LOCAL_CREDENTIAL = Object.freeze({
  ...SECRET_INPUT,
  outputSensitivity: 'credential storage metadata only',
  requiredAccess: 'local credential-store access; no NanoCore actor',
});
const DEPLOYMENT_ADMIN_ACCESS = Object.freeze({
  requiredAccess: 'deployment admin: implicit local actor or server-admin bearer token',
});
const SERVER_ADMIN_TOKEN_ACCESS = Object.freeze({
  requiredAccess: 'server-admin bearer token in server mode',
});

const workspaceScope = { workspaceId: protocol.WorkspaceIdSchema };
const threadScope = { ...workspaceScope, threadId: protocol.ThreadIdSchema };
const turnScope = { ...threadScope, turnId: protocol.TurnIdSchema };

/**
 * Creates one strict flat input schema by combining URL scope fields with a shared request body.
 *
 * @param {import('zod').ZodObject} requestSchema Shared request body schema.
 * @param {Record<string, import('zod').ZodType>} [scope] URL or query fields owned by the client method.
 * @returns {import('zod').ZodObject} Strict flat CLI input schema.
 */
function flatRequest(requestSchema, scope = {}) {
  return requestSchema.safeExtend(scope).strict();
}

/**
 * Creates one strict input schema from client-method scope fields.
 *
 * @param {Record<string, import('zod').ZodType>} scope URL or query fields owned by the client method.
 * @returns {import('zod').ZodObject} Strict flat CLI input schema.
 */
function strictScope(scope) {
  return z.object(scope).strict();
}

/**
 * Preserves a shared object schema while enforcing the CLI's strict unknown-key boundary.
 *
 * @param {import('zod').ZodObject} requestSchema Shared request schema.
 * @returns {import('zod').ZodObject} Strict shared request schema.
 */
function strictShared(requestSchema) {
  return requestSchema.strict();
}

/**
 * Removes client-method scope fields before forwarding a shared request body.
 *
 * @param {Record<string, unknown>} input Validated flat input.
 * @param {...string} keys Scope keys to remove.
 * @returns {Record<string, unknown>} Shared request body.
 */
function bodyWithout(input, ...keys) {
  const body = { ...input };
  for (const key of keys) {
    delete body[key];
  }
  return body;
}

/**
 * Creates a typed local CLI failure.
 *
 * @param {string} code Stable error code.
 * @param {string} message Public error message.
 * @param {unknown} [cause] Optional internal cause.
 * @returns {Error & {code: string, cause?: unknown}} Typed error.
 */
function localError(code, message, cause) {
  return Object.assign(new Error(message), { code, ...(cause === undefined ? {} : { cause }) });
}

/**
 * The single transport-neutral OpenKit operation inventory.
 *
 * Each network handler invokes exactly one public Core Client operation. Local-only handlers touch
 * only the configured endpoint credential store.
 */
export const operationCatalog = [
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'storage.layout-report',
    source: 'app-api',
    appOperationId: 'getStorageLayoutReport',
    clientMethod: 'app.getStorageLayoutReport',
    group: 'storage',
    summary: 'Read the NanoCore storage layout report.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.getStorageLayoutReport(),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'diagnostics.app',
    source: 'app-api',
    appOperationId: 'getAppDiagnostics',
    clientMethod: 'app.getDiagnostics',
    group: 'diagnostics',
    summary: 'Read application runtime diagnostics.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.getDiagnostics(),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'diagnostics.setup',
    source: 'app-api',
    appOperationId: 'getSetupDiagnostics',
    clientMethod: 'app.getSetupDiagnostics',
    group: 'diagnostics',
    summary: 'Read setup diagnostics.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.getSetupDiagnostics(),
  },
  {
    ...STANDARD,
    ...SERVER_ADMIN_TOKEN_ACCESS,
    id: 'token.list',
    source: 'app-api',
    appOperationId: 'listOpenKitAccessTokens',
    clientMethod: 'app.listOpenKitAccessTokens',
    group: 'token',
    summary: 'List redacted OpenKit access tokens.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.listOpenKitAccessTokens(),
  },
  {
    ...SECRET_INPUT,
    requiredAccess:
      'one-time server bootstrap token over HTTPS or loopback; no authenticated actor',
    id: 'bootstrap.consume',
    source: 'app-api',
    appOperationId: 'consumeOpenKitBootstrapToken',
    clientMethod: 'app.consumeBootstrapToken',
    group: 'bootstrap',
    summary: 'Consume the bootstrap token and store the returned endpoint credential.',
    mutating: true,
    inputSchema: strictShared(appSchemas.ConsumeOpenKitBootstrapTokenRequestSchema),
    async handler({ client, credentialStore, endpoint }, input) {
      if (
        typeof credentialStore?.preflightWrite !== 'function' ||
        typeof credentialStore.writeToken !== 'function' ||
        !endpoint
      ) {
        throw localError(
          'credential_storage_unavailable',
          'Endpoint credential storage must be available before bootstrap consumption.'
        );
      }
      try {
        credentialStore.preflightWrite({ baseUrl: endpoint });
      } catch (cause) {
        throw localError(
          'credential_storage_unavailable',
          'Endpoint credential storage must be writable before bootstrap consumption.',
          cause
        );
      }
      const { token, record } = await client.app.consumeBootstrapToken(input);
      try {
        const credentialStorageBackend = credentialStore.writeToken({ baseUrl: endpoint, token });
        return { record, credentialStorageBackend };
      } catch (cause) {
        throw localError(
          'credential_storage_failed',
          'The bootstrap token was consumed, but the returned endpoint credential could not be stored.',
          cause
        );
      }
    },
  },
  {
    ...STANDARD,
    ...SERVER_ADMIN_TOKEN_ACCESS,
    id: 'token.revoke',
    source: 'app-api',
    appOperationId: 'revokeOpenKitAccessToken',
    clientMethod: 'app.revokeOpenKitAccessToken',
    group: 'token',
    summary: 'Revoke one OpenKit access token.',
    mutating: true,
    inputSchema: strictScope({ tokenId: IDENTIFIER }),
    handler: ({ client }, input) => client.app.revokeOpenKitAccessToken(input.tokenId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'runtime.reload',
    source: 'app-api',
    appOperationId: 'reloadRuntimeConfig',
    clientMethod: 'runtimeConfig.reload',
    group: 'runtime',
    summary: 'Reload supported runtime configuration.',
    mutating: true,
    inputSchema: strictShared(appSchemas.RuntimeConfigReloadRequestSchema),
    handler: ({ client }, input) => client.runtimeConfig.reload(input),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'runtime.file-list',
    source: 'app-api',
    appOperationId: 'listRuntimeConfigFiles',
    clientMethod: 'runtimeConfig.listFiles',
    group: 'runtime',
    summary: 'List editable runtime configuration files.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.runtimeConfig.listFiles(),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'runtime.file-read',
    source: 'app-api',
    appOperationId: 'getRuntimeConfigFile',
    clientMethod: 'runtimeConfig.getFile',
    group: 'runtime',
    summary: 'Read one runtime configuration file.',
    mutating: false,
    inputSchema: strictScope({ id: IDENTIFIER }),
    handler: ({ client }, input) => client.runtimeConfig.getFile(input.id),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'runtime.file-create',
    source: 'app-api',
    appOperationId: 'createRuntimeConfigFile',
    clientMethod: 'runtimeConfig.createFile',
    group: 'runtime',
    summary: 'Create one supported runtime configuration file.',
    mutating: true,
    inputSchema: strictShared(appSchemas.RuntimeConfigFileWriteRequestSchema),
    handler: ({ client }, input) => client.runtimeConfig.createFile(input),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'runtime.file-update',
    source: 'app-api',
    appOperationId: 'updateRuntimeConfigFile',
    clientMethod: 'runtimeConfig.updateFile',
    group: 'runtime',
    summary: 'Update one runtime configuration file.',
    mutating: true,
    inputSchema: strictShared(appSchemas.RuntimeConfigFileWriteRequestSchema),
    handler: ({ client }, input) => client.runtimeConfig.updateFile(input),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'runtime.schemas',
    source: 'app-api',
    appOperationId: 'getRuntimeConfigSchemas',
    clientMethod: 'runtimeConfig.getSchemas',
    group: 'runtime',
    summary: 'Read runtime configuration schemas.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.runtimeConfig.getSchemas(),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'runtime.validate',
    source: 'app-api',
    appOperationId: 'validateRuntimeConfig',
    clientMethod: 'runtimeConfig.validate',
    group: 'runtime',
    summary: 'Validate runtime configuration without writing it.',
    mutating: false,
    inputSchema: strictShared(appSchemas.RuntimeConfigValidationRequestSchema),
    handler: ({ client }, input) => client.runtimeConfig.validate(input),
  },
  {
    ...STANDARD,
    id: 'runtime.restart-stale-session',
    source: 'app-api',
    appOperationId: 'restartRuntimeConfigStaleSession',
    clientMethod: 'runtimeConfig.restartStaleSession',
    group: 'runtime',
    summary: 'Retire one stale runtime session.',
    mutating: true,
    inputSchema: strictScope({ ...workspaceScope, sessionId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.runtimeConfig.restartStaleSession(input.workspaceId, input.sessionId),
  },
  {
    ...STANDARD,
    id: 'automation.list',
    source: 'app-api',
    appOperationId: 'listAutomations',
    clientMethod: 'app.listAutomations',
    group: 'automation',
    summary: 'List automations.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.listAutomations(),
  },
  {
    ...STANDARD,
    id: 'automation.create',
    source: 'app-api',
    appOperationId: 'createAutomation',
    clientMethod: 'app.createAutomation',
    group: 'automation',
    summary: 'Create one automation.',
    mutating: true,
    inputSchema: strictShared(appSchemas.CreateAutomationRequestSchema),
    handler: ({ client }, input) => client.app.createAutomation(input),
  },
  {
    ...STANDARD,
    id: 'automation.update',
    source: 'app-api',
    appOperationId: 'updateAutomation',
    clientMethod: 'app.updateAutomation',
    group: 'automation',
    summary: 'Update one automation.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.UpdateAutomationRequestSchema, {
      automationId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.updateAutomation(input.automationId, bodyWithout(input, 'automationId')),
  },
  {
    ...STANDARD,
    id: 'automation.delete',
    source: 'app-api',
    appOperationId: 'deleteAutomation',
    clientMethod: 'app.deleteAutomation',
    group: 'automation',
    summary: 'Delete one automation.',
    mutating: true,
    inputSchema: strictScope({ automationId: IDENTIFIER }),
    handler: ({ client }, input) => client.app.deleteAutomation(input.automationId),
  },
  {
    ...STANDARD,
    id: 'agent.health-refresh',
    source: 'app-api',
    appOperationId: 'refreshAgentHealth',
    clientMethod: 'agents.refreshHealth',
    group: 'agent',
    summary: 'Refresh agent health for one workspace.',
    mutating: true,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.agents.refreshHealth(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'agent.list',
    source: 'app-api',
    appOperationId: 'listAgentCatalog',
    clientMethod: 'agents.list',
    group: 'agent',
    summary: 'List product-visible agents.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.agents.list(),
  },
  {
    ...STANDARD,
    id: 'agent.read',
    source: 'app-api',
    appOperationId: 'getAgentCatalogEntry',
    clientMethod: 'agents.get',
    group: 'agent',
    summary: 'Read one product-visible agent.',
    mutating: false,
    inputSchema: strictScope({ agentId: protocol.AgentIdSchema }),
    handler: ({ client }, input) => client.agents.get(input.agentId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'oauth.account-list',
    source: 'app-api',
    appOperationId: 'listOpenAICodexOAuthAccounts',
    clientMethod: 'oauth.openaiCodex.listAccounts',
    group: 'oauth',
    summary: 'List OpenAI Codex OAuth account slots.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.oauth.openaiCodex.listAccounts(),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'oauth.account-create',
    source: 'app-api',
    appOperationId: 'createOpenAICodexOAuthAccount',
    clientMethod: 'oauth.openaiCodex.createAccount',
    group: 'oauth',
    summary: 'Create one OpenAI Codex OAuth account slot.',
    mutating: true,
    inputSchema: strictShared(appSchemas.CreateOpenAICodexOAuthAccountRequestSchema),
    handler: ({ client }, input) => client.oauth.openaiCodex.createAccount(input),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'oauth.account-update',
    source: 'app-api',
    appOperationId: 'updateOpenAICodexOAuthAccount',
    clientMethod: 'oauth.openaiCodex.updateAccount',
    group: 'oauth',
    summary: 'Rename one OpenAI Codex OAuth account slot.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.UpdateOpenAICodexOAuthAccountRequestSchema, {
      accountSlotId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.oauth.openaiCodex.updateAccount(
        input.accountSlotId,
        bodyWithout(input, 'accountSlotId')
      ),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'oauth.account-delete',
    source: 'app-api',
    appOperationId: 'deleteOpenAICodexOAuthAccount',
    clientMethod: 'oauth.openaiCodex.deleteAccount',
    group: 'oauth',
    summary: 'Delete one OpenAI Codex OAuth account slot.',
    mutating: true,
    inputSchema: strictScope({ accountSlotId: IDENTIFIER }),
    handler: ({ client }, input) => client.oauth.openaiCodex.deleteAccount(input.accountSlotId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'oauth.status',
    source: 'app-api',
    appOperationId: 'getOpenAICodexOAuthAccountStatus',
    clientMethod: 'oauth.openaiCodex.getAccountStatus',
    group: 'oauth',
    summary: 'Read one OpenAI Codex OAuth account status.',
    mutating: false,
    inputSchema: strictScope({ accountSlotId: IDENTIFIER }),
    handler: ({ client }, input) => client.oauth.openaiCodex.getAccountStatus(input.accountSlotId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'oauth.start',
    source: 'app-api',
    appOperationId: 'startOpenAICodexOAuthAccountLogin',
    clientMethod: 'oauth.openaiCodex.startAccount',
    group: 'oauth',
    summary: 'Start one OpenAI Codex OAuth login.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.StartOpenAICodexOAuthRequestSchema, {
      accountSlotId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.oauth.openaiCodex.startAccount(
        input.accountSlotId,
        bodyWithout(input, 'accountSlotId')
      ),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'oauth.cancel',
    source: 'app-api',
    appOperationId: 'cancelOpenAICodexOAuthAccountLogin',
    clientMethod: 'oauth.openaiCodex.cancelAccount',
    group: 'oauth',
    summary: 'Cancel one pending OpenAI Codex OAuth login.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.CancelOpenAICodexOAuthRequestSchema, {
      accountSlotId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.oauth.openaiCodex.cancelAccount(
        input.accountSlotId,
        bodyWithout(input, 'accountSlotId')
      ),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'oauth.logout',
    source: 'app-api',
    appOperationId: 'logoutOpenAICodexOAuthAccount',
    clientMethod: 'oauth.openaiCodex.logoutAccount',
    group: 'oauth',
    summary: 'Log out one OpenAI Codex OAuth account.',
    mutating: true,
    inputSchema: strictScope({ accountSlotId: IDENTIFIER }),
    handler: ({ client }, input) => client.oauth.openaiCodex.logoutAccount(input.accountSlotId),
  },
  {
    ...STANDARD,
    id: 'chat.quick',
    source: 'app-api',
    appOperationId: 'quickChat',
    clientMethod: 'app.quickChat',
    group: 'chat',
    summary: 'Run one bounded quick chat request.',
    mutating: true,
    inputSchema: strictShared(appSchemas.QuickChatRequestSchema),
    handler: ({ client }, input) => client.app.quickChat(input),
  },
  {
    ...STANDARD,
    id: 'recovery.worker-list',
    source: 'app-api',
    appOperationId: 'listInterruptedWorkers',
    clientMethod: 'app.listInterruptedWorkers',
    group: 'recovery',
    summary: 'List interrupted worker checkpoints.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.listInterruptedWorkers(),
  },
  {
    ...STANDARD,
    id: 'recovery.checkpoint-retry',
    source: 'app-api',
    appOperationId: 'retryInterruptedWorkerCheckpoint',
    clientMethod: 'app.retryInterruptedWorkerCheckpoint',
    group: 'recovery',
    summary: 'Retry one interrupted worker checkpoint.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RetryInterruptedWorkerCheckpointRequestSchema, turnScope),
    handler: ({ client }, input) =>
      client.app.retryInterruptedWorkerCheckpoint(
        input.workspaceId,
        input.threadId,
        input.turnId,
        bodyWithout(input, 'workspaceId', 'threadId', 'turnId')
      ),
  },
  {
    ...STANDARD,
    id: 'scheduler.list',
    source: 'app-api',
    appOperationId: 'listSchedulerAdmissions',
    clientMethod: 'app.listSchedulerAdmissions',
    group: 'scheduler',
    summary: 'List scheduler admissions for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listSchedulerAdmissions(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'scheduler.retry',
    source: 'app-api',
    appOperationId: 'retrySchedulerAdmission',
    clientMethod: 'app.retrySchedulerAdmission',
    group: 'scheduler',
    summary: 'Retry one denied scheduler admission.',
    mutating: true,
    inputSchema: strictScope({ ...workspaceScope, queueEntryId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.retrySchedulerAdmission(input.workspaceId, input.queueEntryId),
  },
  {
    ...STANDARD,
    id: 'scheduler.cancel',
    source: 'app-api',
    appOperationId: 'cancelSchedulerAdmission',
    clientMethod: 'app.cancelSchedulerAdmission',
    group: 'scheduler',
    summary: 'Cancel one scheduler admission.',
    mutating: true,
    inputSchema: strictScope({ ...workspaceScope, queueEntryId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.cancelSchedulerAdmission(input.workspaceId, input.queueEntryId),
  },
  {
    ...STANDARD,
    id: 'turn.feedback',
    source: 'app-api',
    appOperationId: 'submitTurnFeedback',
    clientMethod: 'app.submitTurnFeedback',
    group: 'turn',
    summary: 'Submit feedback for one turn.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.SubmitTurnFeedbackRequestSchema, {
      turnId: protocol.TurnIdSchema,
    }),
    handler: ({ client }, input) =>
      client.app.submitTurnFeedback(input.turnId, bodyWithout(input, 'turnId')),
  },
  {
    ...STANDARD,
    id: 'chat.start',
    source: 'app-api',
    appOperationId: 'startChatMode',
    clientMethod: 'app.startChatMode',
    group: 'chat',
    summary: 'Start one thread-scoped Chat Mode turn.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.StartChatModeRequestSchema, threadScope),
    handler: ({ client }, input) =>
      client.app.startChatMode(
        input.workspaceId,
        input.threadId,
        bodyWithout(input, 'workspaceId', 'threadId')
      ),
  },
  {
    ...STANDARD,
    id: 'task.start',
    source: 'app-api',
    appOperationId: 'startTaskMode',
    clientMethod: 'app.startTaskMode',
    group: 'task',
    summary: 'Start one bounded Task Mode delegation.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.StartTaskModeRequestSchema, threadScope),
    handler: ({ client }, input) =>
      client.app.startTaskMode(
        input.workspaceId,
        input.threadId,
        bodyWithout(input, 'workspaceId', 'threadId')
      ),
  },
  {
    ...STANDARD,
    id: 'goal.read',
    source: 'app-api',
    appOperationId: 'getThreadGoalSummary',
    clientMethod: 'app.getThreadGoalSummary',
    group: 'goal',
    summary: 'Read the Goal Mode summary for one thread.',
    mutating: false,
    inputSchema: strictScope(threadScope),
    handler: ({ client }, input) =>
      client.app.getThreadGoalSummary(input.workspaceId, input.threadId),
  },
  {
    ...STANDARD,
    id: 'goal.start',
    source: 'app-api',
    appOperationId: 'startThreadGoal',
    clientMethod: 'app.startThreadGoal',
    group: 'goal',
    summary: 'Start Goal Mode for one thread.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.StartThreadGoalRequestSchema, threadScope),
    handler: ({ client }, input) =>
      client.app.startThreadGoal(
        input.workspaceId,
        input.threadId,
        bodyWithout(input, 'workspaceId', 'threadId')
      ),
  },
  {
    ...STANDARD,
    id: 'goal.plan',
    source: 'app-api',
    appOperationId: 'createThreadGoalPlan',
    clientMethod: 'app.createThreadGoalPlan',
    group: 'goal',
    summary: 'Create the deterministic plan for one goal.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.CreateThreadGoalPlanRequestSchema, threadScope),
    handler: ({ client }, input) =>
      client.app.createThreadGoalPlan(
        input.workspaceId,
        input.threadId,
        bodyWithout(input, 'workspaceId', 'threadId')
      ),
  },
  {
    ...STANDARD,
    id: 'goal.approve',
    source: 'app-api',
    appOperationId: 'approveThreadGoalPlan',
    clientMethod: 'app.approveThreadGoalPlan',
    group: 'goal',
    summary: 'Approve one Goal Mode plan.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.ApproveThreadGoalPlanRequestSchema, threadScope),
    handler: ({ client }, input) =>
      client.app.approveThreadGoalPlan(
        input.workspaceId,
        input.threadId,
        bodyWithout(input, 'workspaceId', 'threadId')
      ),
  },
  {
    ...STANDARD,
    id: 'goal.revise',
    source: 'app-api',
    appOperationId: 'reviseThreadGoalPlan',
    clientMethod: 'app.reviseThreadGoalPlan',
    group: 'goal',
    summary: 'Request revisions to one Goal Mode plan.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.ReviseThreadGoalPlanRequestSchema, threadScope),
    handler: ({ client }, input) =>
      client.app.reviseThreadGoalPlan(
        input.workspaceId,
        input.threadId,
        bodyWithout(input, 'workspaceId', 'threadId')
      ),
  },
  {
    ...STANDARD,
    id: 'goal.pause',
    source: 'app-api',
    appOperationId: 'pauseThreadGoal',
    clientMethod: 'app.pauseThreadGoal',
    group: 'goal',
    summary: 'Pause one active Goal Mode workflow.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.PauseThreadGoalRequestSchema, threadScope),
    handler: ({ client }, input) =>
      client.app.pauseThreadGoal(
        input.workspaceId,
        input.threadId,
        bodyWithout(input, 'workspaceId', 'threadId')
      ),
  },
  {
    ...STANDARD,
    id: 'goal.resume',
    source: 'app-api',
    appOperationId: 'resumeThreadGoal',
    clientMethod: 'app.resumeThreadGoal',
    group: 'goal',
    summary: 'Resume one paused Goal Mode workflow.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.ResumeThreadGoalRequestSchema, threadScope),
    handler: ({ client }, input) =>
      client.app.resumeThreadGoal(
        input.workspaceId,
        input.threadId,
        bodyWithout(input, 'workspaceId', 'threadId')
      ),
  },
  {
    ...STANDARD,
    id: 'goal.step',
    source: 'app-api',
    appOperationId: 'runThreadGoalStep',
    clientMethod: 'app.runThreadGoalStep',
    group: 'goal',
    summary: 'Run one bounded Goal Mode worker step.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RunThreadGoalStepRequestSchema, threadScope),
    handler: ({ client }, input) =>
      client.app.runThreadGoalStep(
        input.workspaceId,
        input.threadId,
        bodyWithout(input, 'workspaceId', 'threadId')
      ),
  },
  {
    ...STANDARD,
    id: 'knowledge.answer',
    source: 'app-api',
    appOperationId: 'answerKnowledgeManager',
    clientMethod: 'app.answerKnowledgeManager',
    group: 'knowledge',
    summary: 'Answer one question from workspace knowledge.',
    mutating: false,
    inputSchema: flatRequest(appSchemas.KnowledgeManagerAnswerRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.answerKnowledgeManager(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'knowledge.source-list',
    source: 'app-api',
    appOperationId: 'listKnowledgeSources',
    clientMethod: 'app.listKnowledgeSources',
    group: 'knowledge',
    summary: 'List workspace knowledge sources.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listKnowledgeSources(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'knowledge.source-register',
    source: 'app-api',
    appOperationId: 'registerKnowledgeSource',
    clientMethod: 'app.registerKnowledgeSource',
    group: 'knowledge',
    summary: 'Register one workspace knowledge source.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RegisterKnowledgeSourceRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.registerKnowledgeSource(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'knowledge.source-read',
    source: 'app-api',
    appOperationId: 'readKnowledgeSource',
    clientMethod: 'app.readKnowledgeSource',
    group: 'knowledge',
    summary: 'Read one workspace knowledge source.',
    mutating: false,
    inputSchema: strictScope({ ...workspaceScope, sourceId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.readKnowledgeSource(input.workspaceId, input.sourceId),
  },
  {
    ...STANDARD,
    id: 'knowledge.observation-list',
    source: 'app-api',
    appOperationId: 'listKnowledgeObservations',
    clientMethod: 'app.listKnowledgeObservations',
    group: 'knowledge',
    summary: 'List workspace knowledge observations.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listKnowledgeObservations(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'knowledge.observation-record',
    source: 'app-api',
    appOperationId: 'recordKnowledgeObservation',
    clientMethod: 'app.recordKnowledgeObservation',
    group: 'knowledge',
    summary: 'Record one workspace knowledge observation.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RecordKnowledgeObservationRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.recordKnowledgeObservation(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'knowledge.claim-list',
    source: 'app-api',
    appOperationId: 'listKnowledgeClaims',
    clientMethod: 'app.listKnowledgeClaims',
    group: 'knowledge',
    summary: 'List workspace knowledge claims.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listKnowledgeClaims(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'knowledge.claim-record',
    source: 'app-api',
    appOperationId: 'recordKnowledgeClaim',
    clientMethod: 'app.recordKnowledgeClaim',
    group: 'knowledge',
    summary: 'Record one workspace knowledge claim.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RecordKnowledgeClaimRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.recordKnowledgeClaim(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'knowledge.claim-promote',
    source: 'app-api',
    appOperationId: 'promoteKnowledgeClaim',
    clientMethod: 'app.promoteKnowledgeClaim',
    group: 'knowledge',
    summary: 'Promote one knowledge claim for review.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.PromoteKnowledgeClaimRequestSchema, {
      ...workspaceScope,
      claimId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.promoteKnowledgeClaim(
        input.workspaceId,
        input.claimId,
        bodyWithout(input, 'workspaceId', 'claimId')
      ),
  },
  {
    ...STANDARD,
    id: 'knowledge.conflict-list',
    source: 'app-api',
    appOperationId: 'listKnowledgeConflicts',
    clientMethod: 'app.listKnowledgeConflicts',
    group: 'knowledge',
    summary: 'List workspace knowledge conflicts.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listKnowledgeConflicts(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'knowledge.conflict-record',
    source: 'app-api',
    appOperationId: 'recordKnowledgeConflict',
    clientMethod: 'app.recordKnowledgeConflict',
    group: 'knowledge',
    summary: 'Record one workspace knowledge conflict.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RecordKnowledgeConflictRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.recordKnowledgeConflict(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'knowledge.conflict-resolve',
    source: 'app-api',
    appOperationId: 'resolveKnowledgeConflict',
    clientMethod: 'app.resolveKnowledgeConflict',
    group: 'knowledge',
    summary: 'Resolve one workspace knowledge conflict.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.ResolveKnowledgeConflictRequestSchema, {
      ...workspaceScope,
      conflictId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.resolveKnowledgeConflict(
        input.workspaceId,
        input.conflictId,
        bodyWithout(input, 'workspaceId', 'conflictId')
      ),
  },
  {
    ...STANDARD,
    id: 'knowledge.indexes',
    source: 'app-api',
    appOperationId: 'readKnowledgeIndexes',
    clientMethod: 'app.readKnowledgeIndexes',
    group: 'knowledge',
    summary: 'Read derived workspace knowledge indexes.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.readKnowledgeIndexes(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'knowledge.retrieve',
    source: 'app-api',
    appOperationId: 'retrieveKnowledge',
    clientMethod: 'app.retrieveKnowledge',
    group: 'knowledge',
    summary: 'Retrieve ranked workspace knowledge and persist its trace.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RetrieveKnowledgeRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.retrieveKnowledge(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'knowledge.context-prepare',
    source: 'app-api',
    appOperationId: 'prepareKnowledgeContext',
    clientMethod: 'app.prepareKnowledgeContext',
    group: 'knowledge',
    summary: 'Prepare and persist one knowledge context package trace.',
    mutating: true,
    inputSchema: flatRequest(
      appSchemas.KnowledgeManagerPrepareContextRequestSchema,
      workspaceScope
    ),
    handler: ({ client }, input) =>
      client.app.prepareKnowledgeContext(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'knowledge.context-trace',
    source: 'app-api',
    appOperationId: 'readKnowledgeContextPackageTrace',
    clientMethod: 'app.readKnowledgeContextPackageTrace',
    group: 'knowledge',
    summary: 'Read one persisted knowledge context package trace.',
    mutating: false,
    inputSchema: strictScope({ ...workspaceScope, contextPackageId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.readKnowledgeContextPackageTrace(input.workspaceId, input.contextPackageId),
  },
  {
    ...STANDARD,
    id: 'knowledge.context-materialization',
    source: 'app-api',
    appOperationId: 'readKnowledgeContextPackageMaterialization',
    clientMethod: 'app.readKnowledgeContextPackageMaterialization',
    group: 'knowledge',
    summary: 'Read one materialized knowledge context package.',
    mutating: false,
    inputSchema: strictScope({ ...workspaceScope, contextPackageId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.readKnowledgeContextPackageMaterialization(
        input.workspaceId,
        input.contextPackageId
      ),
  },
  {
    ...STANDARD,
    id: 'knowledge.context-materialize',
    source: 'app-api',
    appOperationId: 'materializeKnowledgeContextPackage',
    clientMethod: 'app.materializeKnowledgeContextPackage',
    group: 'knowledge',
    summary: 'Materialize one knowledge context package.',
    mutating: true,
    inputSchema: strictScope({ ...workspaceScope, contextPackageId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.materializeKnowledgeContextPackage(input.workspaceId, input.contextPackageId),
  },
  {
    ...STANDARD,
    id: 'knowledge.proposal-draft',
    source: 'app-api',
    appOperationId: 'draftKnowledgeProposal',
    clientMethod: 'app.draftKnowledgeProposal',
    group: 'knowledge',
    summary: 'Draft one knowledge proposal for review.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.KnowledgeManagerDraftProposalRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.draftKnowledgeProposal(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'knowledge.repair-suggest',
    source: 'app-api',
    appOperationId: 'suggestKnowledgeRepairs',
    clientMethod: 'app.suggestKnowledgeRepairs',
    group: 'knowledge',
    summary: 'Suggest review-required knowledge repairs.',
    mutating: false,
    inputSchema: flatRequest(appSchemas.KnowledgeManagerSuggestRepairRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.suggestKnowledgeRepairs(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'knowledge.health-check',
    source: 'app-api',
    appOperationId: 'checkKnowledgeHealth',
    clientMethod: 'app.checkKnowledgeHealth',
    group: 'knowledge',
    summary: 'Read one bounded knowledge health report.',
    mutating: false,
    inputSchema: flatRequest(appSchemas.KnowledgeManagerHealthCheckRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.checkKnowledgeHealth(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'thread.items',
    source: 'app-api',
    appOperationId: 'listThreadItems',
    clientMethod: 'core.listThreadItems',
    group: 'thread',
    summary: 'List durable items for one thread.',
    mutating: false,
    inputSchema: strictScope({
      ...threadScope,
      since: z.number().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }),
    handler: ({ client }, input) =>
      client.core.listThreadItems(input.workspaceId, input.threadId, {
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
  },
  {
    ...STANDARD,
    id: 'attention.list',
    source: 'app-api',
    appOperationId: 'listHumanAttention',
    clientMethod: 'actionCenter.listHumanAttention',
    group: 'attention',
    summary: 'List unified human-attention rows for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.actionCenter.listHumanAttention(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'usage.read',
    source: 'app-api',
    appOperationId: 'getCapabilityUsage',
    clientMethod: 'app.getCapabilityUsage',
    group: 'usage',
    summary: 'Read capability-call and usage evidence for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.getCapabilityUsage(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'audit.workspace-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceAuditEvents',
    clientMethod: 'app.listWorkspaceAuditEvents',
    group: 'audit',
    summary: 'List audit events for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceAuditEvents(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'evidence.bundle-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceEvidenceBundles',
    clientMethod: 'app.listWorkspaceEvidenceBundles',
    group: 'evidence',
    summary: 'List evidence bundles for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceEvidenceBundles(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'evidence.runtime-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceRuntimeEvidence',
    clientMethod: 'app.listWorkspaceRuntimeEvidence',
    group: 'evidence',
    summary: 'List runtime evidence for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceRuntimeEvidence(input.workspaceId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'audit.server-list',
    source: 'app-api',
    appOperationId: 'listServerAuditEvents',
    clientMethod: 'app.listServerAuditEvents',
    group: 'audit',
    summary: 'List server audit events.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.listServerAuditEvents(),
  },
  {
    ...STANDARD,
    id: 'permission.workspace-list',
    source: 'app-api',
    appOperationId: 'listWorkspacePermissionDecisions',
    clientMethod: 'app.listWorkspacePermissionDecisions',
    group: 'permission',
    summary: 'List permission decisions for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspacePermissionDecisions(input.workspaceId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'permission.server-list',
    source: 'app-api',
    appOperationId: 'listServerPermissionDecisions',
    clientMethod: 'app.listServerPermissionDecisions',
    group: 'permission',
    summary: 'List server permission decisions.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.listServerPermissionDecisions(),
  },
  {
    ...STANDARD,
    id: 'knowledge.proposal-decide',
    source: 'app-api',
    appOperationId: 'submitKnowledgeProposalDecision',
    clientMethod: 'app.submitKnowledgeProposalDecision',
    group: 'knowledge',
    summary: 'Decide one knowledge proposal.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.SubmitKnowledgeProposalDecisionRequestSchema, {
      ...workspaceScope,
      proposalId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.submitKnowledgeProposalDecision(
        input.workspaceId,
        input.proposalId,
        bodyWithout(input, 'workspaceId', 'proposalId')
      ),
  },
  {
    ...STANDARD,
    id: 'goal.review-decide',
    source: 'app-api',
    appOperationId: 'submitGoalReviewDecision',
    clientMethod: 'app.submitGoalReviewDecision',
    group: 'goal',
    summary: 'Decide one Goal review.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.SubmitGoalReviewDecisionRequestSchema, {
      ...threadScope,
      goalId: IDENTIFIER,
      reviewId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.submitGoalReviewDecision(
        input.workspaceId,
        input.threadId,
        input.goalId,
        input.reviewId,
        bodyWithout(input, 'workspaceId', 'threadId', 'goalId', 'reviewId')
      ),
  },
  {
    ...STANDARD,
    id: 'sync.review-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceSyncReviews',
    clientMethod: 'app.listWorkspaceSyncReviews',
    group: 'sync',
    summary: 'List workspace synchronization reviews.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceSyncReviews(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'sync.review-read',
    source: 'app-api',
    appOperationId: 'getWorkspaceSyncReview',
    clientMethod: 'app.getWorkspaceSyncReview',
    group: 'sync',
    summary: 'Read one workspace synchronization review.',
    mutating: false,
    inputSchema: strictScope({ ...workspaceScope, reviewId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.getWorkspaceSyncReview(input.workspaceId, input.reviewId),
  },
  {
    ...STANDARD,
    id: 'sync.review-decide',
    source: 'app-api',
    appOperationId: 'submitWorkspaceSyncReviewDecision',
    clientMethod: 'app.submitWorkspaceSyncReviewDecision',
    group: 'sync',
    summary: 'Decide one workspace synchronization review.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.SubmitWorkspaceSyncReviewDecisionRequestSchema, {
      ...workspaceScope,
      reviewId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.submitWorkspaceSyncReviewDecision(
        input.workspaceId,
        input.reviewId,
        bodyWithout(input, 'workspaceId', 'reviewId')
      ),
  },
  {
    ...STANDARD,
    id: 'sync.input-snapshot-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceInputSnapshots',
    clientMethod: 'app.listWorkspaceInputSnapshots',
    group: 'sync',
    summary: 'List durable workspace input snapshots.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceInputSnapshots(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'sync.materialization-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceMaterializationRecords',
    clientMethod: 'app.listWorkspaceMaterializationRecords',
    group: 'sync',
    summary: 'List durable workspace materialization records.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) =>
      client.app.listWorkspaceMaterializationRecords(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'sync.backend-handle-list',
    source: 'app-api',
    appOperationId: 'listBackendWorkspaceHandles',
    clientMethod: 'app.listBackendWorkspaceHandles',
    group: 'sync',
    summary: 'List durable backend workspace handles.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listBackendWorkspaceHandles(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'sync.output-manifest-list',
    source: 'app-api',
    appOperationId: 'listWorkerOutputManifests',
    clientMethod: 'app.listWorkerOutputManifests',
    group: 'sync',
    summary: 'List durable worker output manifests.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkerOutputManifests(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'sync.change-set-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceChangeSets',
    clientMethod: 'app.listWorkspaceChangeSets',
    group: 'sync',
    summary: 'List durable workspace change sets.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceChangeSets(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'sync.staged-review-list',
    source: 'app-api',
    appOperationId: 'listStagedWorkspaceReviews',
    clientMethod: 'app.listStagedWorkspaceReviews',
    group: 'sync',
    summary: 'List durable staged workspace reviews.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listStagedWorkspaceReviews(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'sync.apply-result-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceApplyResults',
    clientMethod: 'app.listWorkspaceApplyResults',
    group: 'sync',
    summary: 'List durable workspace apply results.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceApplyResults(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'sync.apply-plan-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceApplyPlans',
    clientMethod: 'app.listWorkspaceApplyPlans',
    group: 'sync',
    summary: 'List durable workspace apply plans.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceApplyPlans(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'sync.reconciliation-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceReconciliationRecords',
    clientMethod: 'app.listWorkspaceReconciliationRecords',
    group: 'sync',
    summary: 'List durable workspace reconciliation records.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) =>
      client.app.listWorkspaceReconciliationRecords(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'sync.recovery-decide',
    source: 'app-api',
    appOperationId: 'submitWorkspaceRecoveryDecision',
    clientMethod: 'app.submitWorkspaceRecoveryDecision',
    group: 'sync',
    summary: 'Decide one workspace reconciliation recovery.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.SubmitWorkspaceRecoveryDecisionRequestSchema, {
      ...workspaceScope,
      reconciliationRecordId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.submitWorkspaceRecoveryDecision(
        input.workspaceId,
        input.reconciliationRecordId,
        bodyWithout(input, 'workspaceId', 'reconciliationRecordId')
      ),
  },
  {
    ...STANDARD,
    id: 'sync.quarantine-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceQuarantineRecords',
    clientMethod: 'app.listWorkspaceQuarantineRecords',
    group: 'sync',
    summary: 'List durable workspace quarantine records.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceQuarantineRecords(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'sync.apply-result-read',
    source: 'app-api',
    appOperationId: 'getWorkspaceApplyResult',
    clientMethod: 'app.getWorkspaceApplyResult',
    group: 'sync',
    summary: 'Read one durable workspace apply result.',
    mutating: false,
    inputSchema: strictScope({ ...workspaceScope, applyResultId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.getWorkspaceApplyResult(input.workspaceId, input.applyResultId),
  },
  {
    ...STANDARD,
    id: 'environment.snapshot-list',
    source: 'app-api',
    appOperationId: 'listAgentEnvironmentPackageSnapshots',
    clientMethod: 'app.listAgentEnvironmentPackageSnapshots',
    group: 'environment',
    summary: 'List durable Agent Environment Package snapshots.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) =>
      client.app.listAgentEnvironmentPackageSnapshots(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'environment.snapshot-read',
    source: 'app-api',
    appOperationId: 'getAgentEnvironmentPackageSnapshot',
    clientMethod: 'app.getAgentEnvironmentPackageSnapshot',
    group: 'environment',
    summary: 'Read one Agent Environment Package snapshot.',
    mutating: false,
    inputSchema: strictScope({ ...workspaceScope, snapshotId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.getAgentEnvironmentPackageSnapshot(input.workspaceId, input.snapshotId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'backup.create',
    source: 'app-api',
    appOperationId: 'createDataRootBackup',
    clientMethod: 'app.createDataRootBackup',
    group: 'backup',
    summary: 'Create one server-managed data-root backup.',
    mutating: true,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.createDataRootBackup(),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'backup.verify',
    source: 'app-api',
    appOperationId: 'verifyDataRootBackup',
    clientMethod: 'app.verifyDataRootBackup',
    group: 'backup',
    summary: 'Verify one server-managed data-root backup.',
    mutating: false,
    inputSchema: strictShared(appSchemas.DataRootBackupVerifyRequestSchema),
    handler: ({ client }, input) => client.app.verifyDataRootBackup(input.backupId),
  },
  {
    ...STANDARD,
    id: 'workspace.export',
    source: 'app-api',
    appOperationId: 'exportWorkspace',
    clientMethod: 'app.exportWorkspace',
    group: 'workspace',
    summary: 'Create one server-managed workspace export.',
    mutating: true,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.exportWorkspace(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'workspace.import-dry-run',
    source: 'app-api',
    appOperationId: 'dryRunWorkspaceImport',
    clientMethod: 'app.dryRunWorkspaceImport',
    group: 'workspace',
    summary: 'Verify a server-managed workspace export without importing it.',
    mutating: false,
    inputSchema: strictShared(appSchemas.WorkspaceImportDryRunRequestSchema),
    handler: ({ client }, input) => client.app.dryRunWorkspaceImport(input),
  },
  {
    ...STANDARD,
    id: 'workspace.import',
    source: 'app-api',
    appOperationId: 'importWorkspace',
    clientMethod: 'app.importWorkspace',
    group: 'workspace',
    summary: 'Import one server-managed workspace export.',
    mutating: true,
    inputSchema: strictShared(appSchemas.WorkspaceImportRequestSchema),
    handler: ({ client }, input) => client.app.importWorkspace(input),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'vault.status',
    source: 'app-api',
    appOperationId: 'getVaultAdminStatus',
    clientMethod: 'app.getVaultAdminStatus',
    group: 'vault',
    summary: 'Read redacted vault administration status.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.getVaultAdminStatus(),
  },
  {
    ...SECRET_INPUT,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'vault.unlock',
    source: 'app-api',
    appOperationId: 'unlockVaultAdminBackend',
    clientMethod: 'app.unlockVaultAdminBackend',
    group: 'vault',
    summary: 'Unlock the configured vault backend.',
    mutating: true,
    inputSchema: strictShared(appSchemas.VaultAdminUnlockRequestSchema),
    handler: ({ client }, input) => client.app.unlockVaultAdminBackend(input),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'vault.lock',
    source: 'app-api',
    appOperationId: 'lockVaultAdminBackend',
    clientMethod: 'app.lockVaultAdminBackend',
    group: 'vault',
    summary: 'Lock the configured vault backend.',
    mutating: true,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.lockVaultAdminBackend(),
  },
  {
    ...SECRET_INPUT,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'vault.bootstrap-codex-auth',
    source: 'app-api',
    appOperationId: 'bootstrapCodexAuthJsonVaultReference',
    clientMethod: 'app.bootstrapCodexAuthJsonVaultReference',
    group: 'vault',
    summary: 'Store Codex authentication material in the unlocked vault.',
    mutating: true,
    inputSchema: strictShared(appSchemas.VaultAdminBootstrapCodexAuthJsonRequestSchema),
    handler: ({ client }, input) => client.app.bootstrapCodexAuthJsonVaultReference(input),
  },
  {
    ...SECRET_INPUT,
    id: 'vault.reference-rebind',
    source: 'app-api',
    appOperationId: 'rebindWorkspaceVaultReference',
    clientMethod: 'app.rebindWorkspaceVaultReference',
    group: 'vault',
    summary: 'Rebind one imported workspace vault reference.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.VaultAdminRebindWorkspaceReferenceRequestSchema, {
      ...workspaceScope,
      referenceId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.rebindWorkspaceVaultReference(
        input.workspaceId,
        input.referenceId,
        bodyWithout(input, 'workspaceId', 'referenceId')
      ),
  },
  {
    ...STANDARD,
    id: 'vault.reference-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceVaultReferences',
    clientMethod: 'app.listWorkspaceVaultReferences',
    group: 'vault',
    summary: 'List redacted vault references for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceVaultReferences(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'vault.grant-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceVaultGrants',
    clientMethod: 'app.listWorkspaceVaultGrants',
    group: 'vault',
    summary: 'List non-secret vault grants for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceVaultGrants(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'vault.injection-plan-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceInjectionPlans',
    clientMethod: 'app.listWorkspaceInjectionPlans',
    group: 'vault',
    summary: 'List non-secret vault injection plans for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceInjectionPlans(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'vault.injection-receipt-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceInjectionReceipts',
    clientMethod: 'app.listWorkspaceInjectionReceipts',
    group: 'vault',
    summary: 'List non-secret vault injection receipts for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceInjectionReceipts(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'vault.use-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceVaultUseRecords',
    clientMethod: 'app.listWorkspaceVaultUseRecords',
    group: 'vault',
    summary: 'List redacted vault use records for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceVaultUseRecords(input.workspaceId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'vault.server-use-list',
    source: 'app-api',
    appOperationId: 'listServerVaultUseRecords',
    clientMethod: 'app.listServerVaultUseRecords',
    group: 'vault',
    summary: 'List redacted server vault use records.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.listServerVaultUseRecords(),
  },
  {
    ...STANDARD,
    id: 'repository.list',
    source: 'app-api',
    appOperationId: 'listWorkspaceRepositories',
    clientMethod: 'repositories.list',
    group: 'repository',
    summary: 'List linked repositories for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.repositories.list(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'repository.diagnostics',
    source: 'app-api',
    appOperationId: 'getWorkspaceRepositoryDiagnostics',
    clientMethod: 'repositories.diagnostics',
    group: 'repository',
    summary: 'Read repository diagnostics for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.repositories.diagnostics(input.workspaceId),
  },
  {
    ...STANDARD,
    inputSensitivity: 'host-local path',
    id: 'repository.set-default',
    source: 'app-api',
    appOperationId: 'setDefaultWorkspaceRepository',
    clientMethod: 'repositories.setDefault',
    group: 'repository',
    summary: 'Create or update the default repository for one workspace.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.SetWorkspaceRepositoryRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.repositories.setDefault(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'repository.push-list',
    source: 'app-api',
    appOperationId: 'listGitPushRecords',
    clientMethod: 'repositories.listGitPushRecords',
    group: 'repository',
    summary: 'List durable Git push records for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.repositories.listGitPushRecords(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'repository.push-read',
    source: 'app-api',
    appOperationId: 'getGitPushRecord',
    clientMethod: 'repositories.getGitPushRecord',
    group: 'repository',
    summary: 'Read one durable Git push record.',
    mutating: false,
    inputSchema: strictScope({ ...workspaceScope, pushRecordId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.repositories.getGitPushRecord(input.workspaceId, input.pushRecordId),
  },
  {
    ...STANDARD,
    id: 'repository.push-request-approval',
    source: 'app-api',
    appOperationId: 'requestGitPushApproval',
    clientMethod: 'repositories.requestGitPushApproval',
    group: 'repository',
    summary: 'Open one approval gate for a Git push.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RequestGitPushApprovalRequestSchema, {
      ...workspaceScope,
      resourceId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.repositories.requestGitPushApproval(
        input.workspaceId,
        input.resourceId,
        bodyWithout(input, 'workspaceId', 'resourceId')
      ),
  },
  {
    ...STANDARD,
    id: 'repository.push-execute',
    source: 'app-api',
    appOperationId: 'executeGitPush',
    clientMethod: 'repositories.executeGitPush',
    group: 'repository',
    summary: 'Execute one approved Git push.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.ExecuteGitPushRequestSchema, {
      ...workspaceScope,
      resourceId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.repositories.executeGitPush(
        input.workspaceId,
        input.resourceId,
        bodyWithout(input, 'workspaceId', 'resourceId')
      ),
  },
  {
    ...STANDARD,
    requiredAccess: 'public metadata read; no authenticated actor',
    id: 'connection.meta',
    source: 'core-projection',
    clientMethod: 'core.meta',
    protocolSchema: 'MetaResponseSchema',
    group: 'connection',
    summary: 'Read NanoCore protocol metadata and capabilities.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.core.meta(),
  },
  {
    ...STANDARD,
    id: 'workspace.list',
    source: 'core-projection',
    clientMethod: 'core.listWorkspaces',
    protocolSchema: 'ListWorkspacesResponseSchema',
    group: 'workspace',
    summary: 'List workspaces.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.core.listWorkspaces(),
  },
  {
    ...STANDARD,
    id: 'workspace.create',
    source: 'core-projection',
    clientMethod: 'core.createWorkspace',
    protocolSchema: 'CreateWorkspaceRequestSchema',
    group: 'workspace',
    summary: 'Create one workspace.',
    mutating: true,
    inputSchema: strictShared(protocol.CreateWorkspaceRequestSchema),
    handler: ({ client }, input) => client.core.createWorkspace(input),
  },
  {
    ...STANDARD,
    id: 'workspace.read',
    source: 'core-projection',
    clientMethod: 'core.getWorkspace',
    protocolSchema: 'WorkspaceIdSchema',
    group: 'workspace',
    summary: 'Read one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.core.getWorkspace(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'workspace.resources',
    source: 'core-projection',
    clientMethod: 'core.getWorkspaceResources',
    protocolSchema: 'WorkspaceResourcesResponseSchema',
    group: 'workspace',
    summary: 'Read one workspace resource bundle.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.core.getWorkspaceResources(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'workspace.update',
    source: 'core-projection',
    clientMethod: 'core.updateWorkspace',
    protocolSchema: 'UpdateWorkspaceRequestSchema',
    group: 'workspace',
    summary: 'Update one workspace.',
    mutating: true,
    inputSchema: flatRequest(protocol.UpdateWorkspaceRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.core.updateWorkspace(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'knowledge-entry.list',
    source: 'core-projection',
    clientMethod: 'core.listKnowledge',
    protocolSchema: 'ListKnowledgeEntriesResponseSchema',
    group: 'knowledge-entry',
    summary: 'List Core knowledge entries for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.core.listKnowledge(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'knowledge-entry.create',
    source: 'core-projection',
    clientMethod: 'core.createKnowledge',
    protocolSchema: 'CreateKnowledgeEntryRequestSchema',
    group: 'knowledge-entry',
    summary: 'Create one Core knowledge entry.',
    mutating: true,
    inputSchema: flatRequest(protocol.CreateKnowledgeEntryRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.core.createKnowledge(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'knowledge-entry.update',
    source: 'core-projection',
    clientMethod: 'core.updateKnowledge',
    protocolSchema: 'UpdateKnowledgeEntryRequestSchema',
    group: 'knowledge-entry',
    summary: 'Update one Core knowledge entry.',
    mutating: true,
    inputSchema: flatRequest(protocol.UpdateKnowledgeEntryRequestSchema, {
      ...workspaceScope,
      knowledgeEntryId: protocol.KnowledgeEntryIdSchema,
    }),
    handler: ({ client }, input) =>
      client.core.updateKnowledge(
        input.workspaceId,
        input.knowledgeEntryId,
        bodyWithout(input, 'workspaceId', 'knowledgeEntryId')
      ),
  },
  {
    ...STANDARD,
    id: 'knowledge-entry.delete',
    source: 'core-projection',
    clientMethod: 'core.deleteKnowledge',
    protocolSchema: 'DeleteKnowledgeEntryRequestSchema',
    group: 'knowledge-entry',
    summary: 'Delete one Core knowledge entry.',
    mutating: true,
    inputSchema: flatRequest(protocol.DeleteKnowledgeEntryRequestSchema, {
      ...workspaceScope,
      knowledgeEntryId: protocol.KnowledgeEntryIdSchema,
    }),
    handler: ({ client }, input) =>
      client.core.deleteKnowledge(
        input.workspaceId,
        input.knowledgeEntryId,
        bodyWithout(input, 'workspaceId', 'knowledgeEntryId')
      ),
  },
  {
    ...STANDARD,
    id: 'thread.list',
    source: 'core-projection',
    clientMethod: 'core.listThreads',
    protocolSchema: 'ListThreadsResponseSchema',
    group: 'thread',
    summary: 'List threads for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.core.listThreads(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'thread.create',
    source: 'core-projection',
    clientMethod: 'core.createThread',
    protocolSchema: 'CreateThreadRequestSchema',
    group: 'thread',
    summary: 'Create one thread.',
    mutating: true,
    inputSchema: strictShared(protocol.CreateThreadRequestSchema),
    handler: ({ client }, input) => client.core.createThread(input),
  },
  {
    ...STANDARD,
    id: 'thread.read',
    source: 'core-projection',
    clientMethod: 'core.getThread',
    protocolSchema: 'ThreadSchema',
    group: 'thread',
    summary: 'Read one thread.',
    mutating: false,
    inputSchema: strictScope(threadScope),
    handler: ({ client }, input) => client.core.getThread(input.workspaceId, input.threadId),
  },
  {
    ...STANDARD,
    id: 'thread.update',
    source: 'core-projection',
    clientMethod: 'core.updateThread',
    protocolSchema: 'UpdateThreadRequestSchema',
    group: 'thread',
    summary: 'Update one thread.',
    mutating: true,
    inputSchema: strictShared(protocol.UpdateThreadRequestSchema),
    handler: ({ client }, input) => client.core.updateThread(input),
  },
  {
    ...STANDARD,
    id: 'thread.archive',
    source: 'core-projection',
    clientMethod: 'core.archiveThread',
    protocolSchema: 'ArchiveThreadRequestSchema',
    group: 'thread',
    summary: 'Archive one thread.',
    mutating: true,
    inputSchema: strictShared(protocol.ArchiveThreadRequestSchema),
    handler: ({ client }, input) => client.core.archiveThread(input),
  },
  {
    ...STANDARD,
    id: 'turn.start',
    source: 'core-projection',
    clientMethod: 'core.startTurn',
    protocolSchema: 'SubmitTurnInputRequestSchema',
    group: 'turn',
    summary: 'Start or resume one turn.',
    mutating: true,
    inputSchema: protocol.SubmitTurnInputRequestSchema,
    handler: ({ client }, input) => client.core.startTurn(input),
  },
  {
    ...STANDARD,
    id: 'turn.read',
    source: 'core-projection',
    clientMethod: 'core.getTurn',
    protocolSchema: 'TurnSchema',
    group: 'turn',
    summary: 'Read one turn.',
    mutating: false,
    inputSchema: strictScope(turnScope),
    handler: ({ client }, input) =>
      client.core.getTurn(input.workspaceId, input.threadId, input.turnId),
  },
  {
    ...STANDARD,
    id: 'turn.interrupt',
    source: 'core-projection',
    clientMethod: 'core.interruptTurn',
    protocolSchema: 'InterruptTurnRequestSchema',
    group: 'turn',
    summary: 'Interrupt one active turn.',
    mutating: true,
    inputSchema: strictShared(protocol.InterruptTurnRequestSchema),
    handler: ({ client }, input) => client.core.interruptTurn(input),
  },
  {
    ...STANDARD,
    id: 'approval.respond',
    source: 'core-projection',
    clientMethod: 'core.respondApproval',
    protocolSchema: 'RespondToApprovalRequestSchema',
    group: 'approval',
    summary: 'Respond to one approval request.',
    mutating: true,
    inputSchema: strictShared(protocol.RespondToApprovalRequestSchema),
    handler: ({ client }, input) =>
      client.core.respondApproval(input.approvalRequestId, bodyWithout(input, 'approvalRequestId')),
  },
  {
    ...STANDARD,
    id: 'artifact.list',
    source: 'core-projection',
    clientMethod: 'core.listArtifacts',
    protocolSchema: 'ListArtifactsResponseSchema',
    group: 'artifact',
    summary: 'List artifacts for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.core.listArtifacts(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'artifact.read',
    source: 'core-projection',
    clientMethod: 'core.getArtifact',
    protocolSchema: 'GetArtifactResponseSchema',
    group: 'artifact',
    summary: 'Read one artifact.',
    mutating: false,
    inputSchema: strictScope({ ...workspaceScope, artifactId: protocol.ArtifactIdSchema }),
    handler: ({ client }, input) => client.core.getArtifact(input.workspaceId, input.artifactId),
  },
  {
    ...LOCAL_CREDENTIAL,
    id: 'credential.store',
    source: 'local-only',
    clientMethod: null,
    localReason: 'Stores the configured endpoint credential without a NanoCore request.',
    group: 'credential',
    summary: 'Store one endpoint credential from stdin.',
    mutating: true,
    inputSchema: strictScope({ token: z.string().regex(/^okt_[A-Za-z0-9._~-]+$/) }),
    handler: ({ credentialStore, endpoint }, input) => {
      if (typeof credentialStore?.writeToken !== 'function' || !endpoint) {
        throw localError(
          'credential_storage_unavailable',
          'Endpoint credential storage is unavailable.'
        );
      }
      return {
        credentialStorageBackend: credentialStore.writeToken({
          baseUrl: endpoint,
          token: input.token,
        }),
      };
    },
  },
  {
    ...LOCAL_CREDENTIAL,
    inputSensitivity: 'standard',
    id: 'credential.delete',
    source: 'local-only',
    clientMethod: null,
    localReason: 'Deletes the configured endpoint credential without a NanoCore request.',
    group: 'credential',
    summary: 'Delete the configured endpoint credential.',
    mutating: true,
    inputSchema: EMPTY_INPUT,
    handler: ({ credentialStore, endpoint }) => {
      if (typeof credentialStore?.deleteToken !== 'function' || !endpoint) {
        throw localError(
          'credential_storage_unavailable',
          'Endpoint credential storage is unavailable.'
        );
      }
      return { deleted: credentialStore.deleteToken({ baseUrl: endpoint }) };
    },
  },
];

/** Public capability exclusions that keep unsupported scope out of the operation catalog. */
export const operationExclusions = [
  {
    source: 'app-api',
    name: 'createOpenKitAccessToken',
    reason:
      'No safe named credential destination exists; issuing would risk replacing the endpoint administration credential.',
    owner: 'docs/specs/20260713-openkit_agent_skill_interface.md',
  },
  {
    source: 'app-api',
    name: 'rotateOpenKitAccessToken',
    reason:
      'No safe named credential destination exists; rotation would risk replacing the endpoint administration credential.',
    owner: 'docs/specs/20260713-openkit_agent_skill_interface.md',
  },
  {
    source: 'app-api',
    name: 'submitThreadGoalSteering',
    reason: 'No accepted durable delivery proof exists for active-turn steering.',
    owner: 'docs/specs/20260713-work_resource_interaction_model.md',
  },
  {
    source: 'app-api',
    name: 'getWorkspaceDashboard',
    reason: 'The workspace dashboard is a Web-only presentation read model.',
    owner: 'docs/specs/20260704-app_api_openapi_projection.md',
  },
  {
    source: 'app-api',
    name: 'getThreadDashboard',
    reason: 'The thread dashboard is a Web-only presentation read model.',
    owner: 'docs/specs/20260704-app_api_openapi_projection.md',
  },
  {
    source: 'app-api',
    name: 'searchApp',
    reason: 'App search is a Web presentation route, not operation-catalog discovery.',
    owner: 'docs/specs/20260704-app_api_openapi_projection.md',
  },
  {
    source: 'core-projection',
    name: 'subscribeTurnEvents',
    reason: 'The V1 CLI has no streaming or subscription mode; durable reads remain available.',
    owner: 'docs/specs/20260713-openkit_agent_skill_interface.md',
  },
];

/**
 * Searches operation identity, capability group, and summary with native substring matching.
 *
 * @param {string} query Search query.
 * @returns {Array<Record<string, unknown>>} Concise operation metadata without handlers or schemas.
 */
export function searchOperations(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  return operationCatalog
    .filter((operation) =>
      `${operation.id} ${operation.group} ${operation.summary}`.toLowerCase().includes(normalized)
    )
    .map(publicMetadata);
}

/**
 * Describes one operation with a machine-readable JSON input schema.
 *
 * @param {string} id Stable operation id.
 * @returns {Record<string, unknown> | null} Public operation description, or null when unknown.
 */
export function describeOperation(id) {
  const operation = operationCatalog.find((candidate) => candidate.id === id);
  return operation
    ? {
        ...publicMetadata(operation),
        inputSchema: z.toJSONSchema(operation.inputSchema, { target: 'draft-7' }),
      }
    : null;
}

/**
 * Removes executable implementation fields from one catalog entry.
 *
 * @param {Record<string, unknown>} operation Catalog entry.
 * @returns {Record<string, unknown>} Public operation metadata.
 */
function publicMetadata(operation) {
  const { handler: _handler, inputSchema: _inputSchema, ...metadata } = operation;
  return metadata;
}
