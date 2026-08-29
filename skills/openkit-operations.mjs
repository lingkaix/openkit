import * as appSchemas from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import * as protocol from '@openkit/protocol';
import { z } from 'zod';

const EMPTY_INPUT = z.object({}).strict();
const IDENTIFIER = z.string().min(1);
const SUBSCRIPTION_PROVIDER_ID = appSchemas.SubscriptionProviderIdSchema;
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
const providerSubscriptionAccountScope = {
  subscriptionProviderId: SUBSCRIPTION_PROVIDER_ID,
  accountSlotId: appSchemas.CreateProviderSubscriptionAccountRequestSchema.shape.accountSlotId,
};

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
 * Rejects content-bearing Agent Skill operations for one restricted Material.
 *
 * @param {unknown} sensitivity Material sensitivity read from the authoritative metadata route.
 * @returns {void}
 * @throws {ApiCallError} When canonical Material content must remain outside the Agent Skill.
 */
function requireAgentReadableMaterial(sensitivity) {
  if (sensitivity === 'restricted') {
    throw new ApiCallError(409, 'Restricted Material content is unavailable to the Agent Skill.', {
      code: 'sensitive_content',
    });
  }
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
    id: 'nanohost.enroll',
    source: 'app-api',
    appOperationId: 'enrollNanoHost',
    clientMethod: 'app.enrollNanoHost',
    group: 'nanohost',
    summary: 'Enroll the configured NanoHost identity and first named-slot transport token.',
    mutating: true,
    inputSchema: strictShared(appSchemas.EnrollNanoHostRequestSchema),
    handler: ({ client }, input) => client.app.enrollNanoHost(input),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'nanohost.token-list',
    source: 'app-api',
    appOperationId: 'listNanoHostTransportTokens',
    clientMethod: 'app.listNanoHostTransportTokens',
    group: 'nanohost',
    summary: 'List redacted NanoHost transport tokens.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.listNanoHostTransportTokens(),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'nanohost.token-issue',
    source: 'app-api',
    appOperationId: 'issueNanoHostTransportToken',
    clientMethod: 'app.issueNanoHostTransportToken',
    group: 'nanohost',
    summary: 'Issue one NanoHost transport token through a named execution-host slot.',
    mutating: true,
    inputSchema: strictShared(appSchemas.IssueNanoHostTransportTokenRequestSchema),
    handler: ({ client }, input) => client.app.issueNanoHostTransportToken(input),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'nanohost.token-revoke',
    source: 'app-api',
    appOperationId: 'revokeNanoHostTransportToken',
    clientMethod: 'app.revokeNanoHostTransportToken',
    group: 'nanohost',
    summary: 'Revoke one NanoHost transport token.',
    mutating: true,
    inputSchema: strictScope({ tokenId: IDENTIFIER }),
    handler: ({ client }, input) => client.app.revokeNanoHostTransportToken(input.tokenId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'nanohost.token-rotate',
    source: 'app-api',
    appOperationId: 'rotateNanoHostTransportToken',
    clientMethod: 'app.rotateNanoHostTransportToken',
    group: 'nanohost',
    summary: 'Rotate one NanoHost transport token through a named execution-host slot.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RotateNanoHostTransportTokenRequestSchema, {
      tokenId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.rotateNanoHostTransportToken(input.tokenId, bodyWithout(input, 'tokenId')),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'nanohost.token-rotation-abort',
    source: 'app-api',
    appOperationId: 'abortNanoHostTransportTokenRotation',
    clientMethod: 'app.abortNanoHostTransportTokenRotation',
    group: 'nanohost',
    summary: 'Abort one pending NanoHost transport token rotation.',
    mutating: true,
    inputSchema: strictScope({ tokenId: IDENTIFIER }),
    handler: ({ client }, input) => client.app.abortNanoHostTransportTokenRotation(input.tokenId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'nanohost.decommission',
    source: 'app-api',
    appOperationId: 'decommissionNanoHost',
    clientMethod: 'app.decommissionNanoHost',
    group: 'nanohost',
    summary: 'Decommission the configured NanoHost identity and clear both credential slots.',
    mutating: true,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.decommissionNanoHost(),
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
    id: 'provider-subscription.provider-list',
    source: 'app-api',
    appOperationId: 'listSubscriptionProviders',
    clientMethod: 'providerSubscriptions.listProviders',
    group: 'provider-subscription',
    summary: 'List supported provider subscriptions.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.providerSubscriptions.listProviders(),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'provider-subscription.account-list',
    source: 'app-api',
    appOperationId: 'listProviderSubscriptionAccounts',
    clientMethod: 'providerSubscriptions.listAccounts',
    group: 'provider-subscription',
    summary: 'List provider-subscription account slots.',
    mutating: false,
    inputSchema: strictScope({ subscriptionProviderId: SUBSCRIPTION_PROVIDER_ID }),
    handler: ({ client }, input) =>
      client.providerSubscriptions.listAccounts(input.subscriptionProviderId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'provider-subscription.account-create',
    source: 'app-api',
    appOperationId: 'createProviderSubscriptionAccount',
    clientMethod: 'providerSubscriptions.createAccount',
    group: 'provider-subscription',
    summary: 'Create one provider-subscription account slot.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.CreateProviderSubscriptionAccountRequestSchema, {
      subscriptionProviderId: SUBSCRIPTION_PROVIDER_ID,
    }),
    handler: ({ client }, input) =>
      client.providerSubscriptions.createAccount(
        input.subscriptionProviderId,
        bodyWithout(input, 'subscriptionProviderId')
      ),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'provider-subscription.account-update',
    source: 'app-api',
    appOperationId: 'updateProviderSubscriptionAccount',
    clientMethod: 'providerSubscriptions.updateAccount',
    group: 'provider-subscription',
    summary: 'Update one provider-subscription account slot.',
    mutating: true,
    inputSchema: flatRequest(
      appSchemas.UpdateProviderSubscriptionAccountRequestSchema,
      providerSubscriptionAccountScope
    ),
    handler: ({ client }, input) =>
      client.providerSubscriptions.updateAccount(
        input.subscriptionProviderId,
        input.accountSlotId,
        bodyWithout(input, 'subscriptionProviderId', 'accountSlotId')
      ),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'provider-subscription.account-delete',
    source: 'app-api',
    appOperationId: 'deleteProviderSubscriptionAccount',
    clientMethod: 'providerSubscriptions.deleteAccount',
    group: 'provider-subscription',
    summary: 'Delete one provider-subscription account slot.',
    mutating: true,
    inputSchema: strictScope(providerSubscriptionAccountScope),
    handler: ({ client }, input) =>
      client.providerSubscriptions.deleteAccount(input.subscriptionProviderId, input.accountSlotId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'provider-subscription.account-status',
    source: 'app-api',
    appOperationId: 'getProviderSubscriptionAccountStatus',
    clientMethod: 'providerSubscriptions.getAccountStatus',
    group: 'provider-subscription',
    summary: 'Read one provider-subscription account status.',
    mutating: false,
    inputSchema: strictScope(providerSubscriptionAccountScope),
    handler: ({ client }, input) =>
      client.providerSubscriptions.getAccountStatus(
        input.subscriptionProviderId,
        input.accountSlotId
      ),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'provider-subscription.account-login-start',
    source: 'app-api',
    appOperationId: 'startProviderSubscriptionAccountLogin',
    clientMethod: 'providerSubscriptions.startAccountLogin',
    group: 'provider-subscription',
    summary: 'Start one provider-subscription account login.',
    mutating: true,
    inputSchema: flatRequest(
      appSchemas.StartProviderSubscriptionAccountLoginRequestSchema,
      providerSubscriptionAccountScope
    ),
    handler: ({ client }, input) =>
      client.providerSubscriptions.startAccountLogin(
        input.subscriptionProviderId,
        input.accountSlotId,
        bodyWithout(input, 'subscriptionProviderId', 'accountSlotId')
      ),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'provider-subscription.account-login-cancel',
    source: 'app-api',
    appOperationId: 'cancelProviderSubscriptionAccountLogin',
    clientMethod: 'providerSubscriptions.cancelAccountLogin',
    group: 'provider-subscription',
    summary: 'Cancel one pending provider-subscription account login.',
    mutating: true,
    inputSchema: flatRequest(
      appSchemas.CancelProviderSubscriptionAccountLoginRequestSchema,
      providerSubscriptionAccountScope
    ),
    handler: ({ client }, input) =>
      client.providerSubscriptions.cancelAccountLogin(
        input.subscriptionProviderId,
        input.accountSlotId,
        bodyWithout(input, 'subscriptionProviderId', 'accountSlotId')
      ),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'provider-subscription.account-logout',
    source: 'app-api',
    appOperationId: 'logoutProviderSubscriptionAccount',
    clientMethod: 'providerSubscriptions.logoutAccount',
    group: 'provider-subscription',
    summary: 'Log out one provider-subscription account.',
    mutating: true,
    inputSchema: strictScope(providerSubscriptionAccountScope),
    handler: ({ client }, input) =>
      client.providerSubscriptions.logoutAccount(input.subscriptionProviderId, input.accountSlotId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'provider-subscription.account-quota',
    source: 'app-api',
    appOperationId: 'getProviderSubscriptionAccountQuota',
    clientMethod: 'providerSubscriptions.getAccountQuota',
    group: 'provider-subscription',
    summary: 'Read one provider-subscription account quota.',
    mutating: false,
    inputSchema: strictScope(providerSubscriptionAccountScope),
    handler: ({ client }, input) =>
      client.providerSubscriptions.getAccountQuota(
        input.subscriptionProviderId,
        input.accountSlotId
      ),
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
    inputSensitivity: 'workspace content',
    id: 'goal.steering-send',
    source: 'app-api',
    appOperationId: 'submitThreadGoalSteering',
    clientMethod: 'app.submitThreadGoalSteering',
    group: 'goal',
    summary: 'Queue one message or exact Material revision for the active Goal.',
    mutating: true,
    inputSchema: z.union([
      flatRequest(appSchemas.SubmitThreadGoalSteeringMessageRequestSchema, threadScope),
      flatRequest(appSchemas.SubmitThreadGoalSteeringMaterialRequestSchema, threadScope),
    ]),
    handler: ({ client }, input) =>
      client.app.submitThreadGoalSteering(
        input.workspaceId,
        input.threadId,
        bodyWithout(input, 'workspaceId', 'threadId')
      ),
  },
  {
    ...STANDARD,
    id: 'goal.steering-follow-up',
    source: 'app-api',
    appOperationId: 'convertGoalSteeringToFollowUp',
    clientMethod: 'app.convertGoalSteeringToFollowUp',
    group: 'goal',
    summary: 'Convert one terminal Goal steering input into Thread follow-up history.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.ConvertGoalSteeringToFollowUpRequestSchema, {
      ...threadScope,
      pendingTurnId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.convertGoalSteeringToFollowUp(
        input.workspaceId,
        input.threadId,
        input.pendingTurnId,
        bodyWithout(input, 'workspaceId', 'threadId', 'pendingTurnId')
      ),
  },
  {
    ...STANDARD,
    id: 'goal.steering-cancel',
    source: 'app-api',
    appOperationId: 'cancelGoalSteering',
    clientMethod: 'app.cancelGoalSteering',
    group: 'goal',
    summary: 'Cancel one terminal Goal steering input.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.CancelGoalSteeringRequestSchema, {
      ...threadScope,
      pendingTurnId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.cancelGoalSteering(
        input.workspaceId,
        input.threadId,
        input.pendingTurnId,
        bodyWithout(input, 'workspaceId', 'threadId', 'pendingTurnId')
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
    summary: 'Prepare one bounded governed knowledge selection.',
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
    id: 'knowledge.proposal-reverse',
    source: 'app-api',
    appOperationId: 'reverseKnowledgeProposal',
    clientMethod: 'app.reverseKnowledgeProposal',
    group: 'knowledge',
    summary: 'Remove one unchanged proposal-created knowledge page.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.ReverseKnowledgeProposalRequestSchema, {
      ...workspaceScope,
      proposalId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.reverseKnowledgeProposal(
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
    requiredAccess:
      'current Workspace owner through implicit local access or a Workspace-bound bearer token',
    id: 'workspace.member-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceMembers',
    clientMethod: 'app.listWorkspaceMembers',
    group: 'workspace',
    summary: 'List Workspace members and their effective roles.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceMembers(input.workspaceId),
  },
  {
    ...STANDARD,
    requiredAccess:
      'current Workspace owner through implicit local access or a Workspace-bound bearer token',
    id: 'workspace.invitation-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceInvitations',
    clientMethod: 'app.listWorkspaceInvitations',
    group: 'workspace',
    summary: 'List owner-visible Workspace invitations.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceInvitations(input.workspaceId),
  },
  {
    ...SECRET_INPUT,
    requiredAccess:
      'current Workspace owner through implicit local access or a mutable Workspace bearer token',
    id: 'workspace.invitation-create',
    source: 'app-api',
    appOperationId: 'createWorkspaceInvitation',
    clientMethod: 'app.createWorkspaceInvitation',
    group: 'workspace',
    summary: 'Invite one registered user to a Workspace.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.CreateWorkspaceInvitationRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.createWorkspaceInvitation(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    requiredAccess:
      'current Workspace owner through implicit local access or a mutable Workspace bearer token',
    id: 'workspace.invitation-revoke',
    source: 'app-api',
    appOperationId: 'revokeWorkspaceInvitation',
    clientMethod: 'app.revokeWorkspaceInvitation',
    group: 'workspace',
    summary: 'Revoke one pending Workspace invitation.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RevokeWorkspaceInvitationRequestSchema, {
      ...workspaceScope,
      invitationId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.revokeWorkspaceInvitation(
        input.workspaceId,
        input.invitationId,
        bodyWithout(input, 'workspaceId', 'invitationId')
      ),
  },
  {
    ...STANDARD,
    requiredAccess:
      'current Workspace owner through implicit local access or a mutable Workspace bearer token',
    id: 'workspace.member-access-change',
    source: 'app-api',
    appOperationId: 'changeWorkspaceMemberAccess',
    clientMethod: 'app.changeWorkspaceMemberAccess',
    group: 'workspace',
    summary: 'Change one Workspace member between editor and viewer access.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.ChangeWorkspaceMemberAccessRequestSchema, {
      ...workspaceScope,
      userId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.changeWorkspaceMemberAccess(
        input.workspaceId,
        input.userId,
        bodyWithout(input, 'workspaceId', 'userId')
      ),
  },
  {
    ...STANDARD,
    requiredAccess:
      'current Workspace owner through implicit local access or a mutable Workspace bearer token',
    id: 'workspace.member-remove',
    source: 'app-api',
    appOperationId: 'removeWorkspaceMember',
    clientMethod: 'app.removeWorkspaceMember',
    group: 'workspace',
    summary: 'Remove one non-owner Workspace member.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RemoveWorkspaceMemberRequestSchema, {
      ...workspaceScope,
      userId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.removeWorkspaceMember(
        input.workspaceId,
        input.userId,
        bodyWithout(input, 'workspaceId', 'userId')
      ),
  },
  {
    ...STANDARD,
    requiredAccess:
      'current Workspace owner through implicit local access or a mutable Workspace bearer token',
    id: 'workspace.ownership-transfer',
    source: 'app-api',
    appOperationId: 'transferWorkspaceOwnership',
    clientMethod: 'app.transferWorkspaceOwnership',
    group: 'workspace',
    summary: 'Transfer Workspace ownership to one active member.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.TransferWorkspaceOwnershipRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.transferWorkspaceOwnership(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'workspace.access-recovery-read',
    source: 'app-api',
    appOperationId: 'getWorkspaceAccessRecoveryState',
    clientMethod: 'app.getWorkspaceAccessRecoveryState',
    group: 'workspace',
    summary: 'Read the content-free Workspace access recovery state.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.getWorkspaceAccessRecoveryState(input.workspaceId),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'workspace.access-recover',
    source: 'app-api',
    appOperationId: 'recoverWorkspaceAccess',
    clientMethod: 'app.recoverWorkspaceAccess',
    group: 'workspace',
    summary: 'Perform one bounded Workspace access recovery action.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RecoverWorkspaceAccessRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.recoverWorkspaceAccess(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'user.disable',
    source: 'app-api',
    appOperationId: 'disableUser',
    clientMethod: 'app.disableUser',
    group: 'user',
    summary: 'Disable one exact canonical user while preserving history.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.DisableUserRequestSchema, { userId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.disableUser(input.userId, bodyWithout(input, 'userId')),
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
    ...DEPLOYMENT_ADMIN_ACCESS,
    id: 'vault.provider-api-key-set',
    source: 'app-api',
    appOperationId: 'setProviderApiKey',
    clientMethod: 'app.setProviderApiKey',
    group: 'vault',
    summary: 'Store or replace one provider profile API key in the unlocked vault.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.SetProviderApiKeyRequestSchema, {
      providerId: appSchemas.ProviderApiKeyProfileIdSchema,
    }),
    handler: ({ client }, input) =>
      client.app.setProviderApiKey(input.providerId, bodyWithout(input, 'providerId')),
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
    appOperationId: 'listWorkspaceVaultInjectionPlans',
    clientMethod: 'app.listWorkspaceVaultInjectionPlans',
    group: 'vault',
    summary: 'List non-secret vault injection plans for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceVaultInjectionPlans(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'vault.injection-receipt-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceVaultInjectionReceipts',
    clientMethod: 'app.listWorkspaceVaultInjectionReceipts',
    group: 'vault',
    summary: 'List non-secret vault injection receipts for one workspace.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) =>
      client.app.listWorkspaceVaultInjectionReceipts(input.workspaceId),
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
    requiredAccess: 'implicit local access or a Workspace-bound bearer token',
    id: 'workspace.list',
    source: 'app-api',
    appOperationId: 'listAuthorizedWorkspaces',
    clientMethod: 'app.listAuthorizedWorkspaces',
    group: 'workspace',
    summary: 'List authorized Workspaces with effective access and revisions.',
    mutating: false,
    inputSchema: EMPTY_INPUT,
    handler: ({ client }) => client.app.listAuthorizedWorkspaces(),
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
    protocolSchema: 'TurnReadProjectionSchema',
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
    ...STANDARD,
    inputSensitivity: 'workspace content',
    id: 'artifact.import',
    source: 'app-api',
    appOperationId: 'importWorkspaceArtifact',
    clientMethod: 'app.importWorkspaceArtifact',
    group: 'artifact',
    summary: 'Import one immutable Workspace Artifact version.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.ImportWorkspaceArtifactRequestSchema, workspaceScope),
    handler: ({ client }, input) =>
      client.app.importWorkspaceArtifact(input.workspaceId, bodyWithout(input, 'workspaceId')),
  },
  {
    ...STANDARD,
    id: 'artifact.introduce',
    source: 'app-api',
    appOperationId: 'introduceWorkspaceArtifact',
    clientMethod: 'app.introduceWorkspaceArtifact',
    group: 'artifact',
    summary: 'Introduce one exact Artifact version into an idle Thread.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.IntroduceWorkspaceArtifactRequestSchema, {
      ...threadScope,
      artifactId: protocol.ArtifactIdSchema,
    }),
    handler: ({ client }, input) =>
      client.app.introduceWorkspaceArtifact(
        input.workspaceId,
        input.threadId,
        input.artifactId,
        bodyWithout(input, 'workspaceId', 'threadId', 'artifactId')
      ),
  },
  {
    ...STANDARD,
    id: 'artifact.review-list',
    source: 'app-api',
    appOperationId: 'listArtifactReviews',
    clientMethod: 'app.listArtifactReviews',
    group: 'artifact',
    summary: 'List version-keyed Reviews for one Artifact.',
    mutating: false,
    inputSchema: strictScope({ ...workspaceScope, artifactId: protocol.ArtifactIdSchema }),
    handler: ({ client }, input) =>
      client.app.listArtifactReviews(input.workspaceId, input.artifactId),
  },
  {
    ...STANDARD,
    id: 'artifact.review-decide',
    source: 'app-api',
    appOperationId: 'submitArtifactReviewDecision',
    clientMethod: 'app.submitArtifactReviewDecision',
    group: 'artifact',
    summary: 'Decide one exact version-keyed Artifact Review.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.SubmitArtifactReviewDecisionRequestSchema, {
      ...workspaceScope,
      artifactId: protocol.ArtifactIdSchema,
      artifactVersion: z.number().int().positive(),
    }),
    handler: ({ client }, input) =>
      client.app.submitArtifactReviewDecision(
        input.workspaceId,
        input.artifactId,
        input.artifactVersion,
        bodyWithout(input, 'workspaceId', 'artifactId', 'artifactVersion')
      ),
  },
  {
    ...STANDARD,
    id: 'material.list',
    source: 'app-api',
    appOperationId: 'listWorkspaceMaterials',
    clientMethod: 'app.listWorkspaceMaterials',
    group: 'material',
    summary: 'List Workspace Material metadata.',
    mutating: false,
    inputSchema: strictScope(workspaceScope),
    handler: ({ client }, input) => client.app.listWorkspaceMaterials(input.workspaceId),
  },
  {
    ...STANDARD,
    id: 'material.create',
    source: 'app-api',
    appOperationId: 'createWorkspaceMaterial',
    clientMethod: 'app.createWorkspaceMaterial',
    group: 'material',
    summary: 'Create one public or internal Workspace Material.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.CreateWorkspaceMaterialRequestSchema, workspaceScope),
    handler: ({ client }, input) => {
      requireAgentReadableMaterial(input.sensitivity);
      return client.app.createWorkspaceMaterial(
        input.workspaceId,
        bodyWithout(input, 'workspaceId')
      );
    },
  },
  {
    ...STANDARD,
    id: 'material.read',
    source: 'app-api',
    appOperationId: 'getWorkspaceMaterial',
    clientMethod: 'app.getWorkspaceMaterial',
    group: 'material',
    summary: 'Read one Workspace Material metadata record.',
    mutating: false,
    inputSchema: strictScope({ ...workspaceScope, materialId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.getWorkspaceMaterial(input.workspaceId, input.materialId),
  },
  {
    ...STANDARD,
    id: 'material.revision-list',
    source: 'app-api',
    appOperationId: 'listWorkspaceMaterialRevisions',
    clientMethod: 'app.listWorkspaceMaterialRevisions',
    group: 'material',
    summary: 'List immutable Workspace Material revision metadata.',
    mutating: false,
    inputSchema: strictScope({ ...workspaceScope, materialId: IDENTIFIER }),
    handler: ({ client }, input) =>
      client.app.listWorkspaceMaterialRevisions(input.workspaceId, input.materialId),
  },
  {
    ...STANDARD,
    outputSensitivity: 'workspace content',
    id: 'material.revision-read',
    source: 'app-api',
    appOperationId: 'getWorkspaceMaterialRevision',
    clientMethod: 'app.getWorkspaceMaterialRevision',
    group: 'material',
    summary: 'Read one exact public or internal Workspace Material revision.',
    mutating: false,
    inputSchema: strictScope({
      ...workspaceScope,
      materialId: IDENTIFIER,
      revisionId: IDENTIFIER,
    }),
    async handler({ client }, input) {
      const { material } = await client.app.getWorkspaceMaterial(
        input.workspaceId,
        input.materialId
      );
      requireAgentReadableMaterial(material.sensitivity);
      return client.app.getWorkspaceMaterialRevision(
        input.workspaceId,
        input.materialId,
        input.revisionId
      );
    },
  },
  {
    ...STANDARD,
    inputSensitivity: 'workspace content',
    id: 'material.revision-save',
    source: 'app-api',
    appOperationId: 'saveWorkspaceMaterialRevision',
    clientMethod: 'app.saveWorkspaceMaterialRevision',
    group: 'material',
    summary: 'Save one immutable public or internal Workspace Material revision.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.SaveWorkspaceMaterialRevisionRequestSchema, {
      ...workspaceScope,
      materialId: IDENTIFIER,
    }),
    async handler({ client }, input) {
      const { material } = await client.app.getWorkspaceMaterial(
        input.workspaceId,
        input.materialId
      );
      requireAgentReadableMaterial(material.sensitivity);
      return client.app.saveWorkspaceMaterialRevision(
        input.workspaceId,
        input.materialId,
        bodyWithout(input, 'workspaceId', 'materialId')
      );
    },
  },
  {
    ...STANDARD,
    id: 'material.thread-read',
    source: 'app-api',
    appOperationId: 'getThreadMaterial',
    clientMethod: 'app.getThreadMaterial',
    group: 'material',
    summary: 'Read one Thread Material projection.',
    mutating: false,
    inputSchema: strictScope(threadScope),
    handler: ({ client }, input) => client.app.getThreadMaterial(input.workspaceId, input.threadId),
  },
  {
    ...STANDARD,
    id: 'material.bind',
    source: 'app-api',
    appOperationId: 'bindThreadMaterial',
    clientMethod: 'app.bindThreadMaterial',
    group: 'material',
    summary: 'Bind one Workspace Material to a Thread.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.BindThreadMaterialRequestSchema, {
      ...threadScope,
      materialId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.bindThreadMaterial(
        input.workspaceId,
        input.threadId,
        input.materialId,
        bodyWithout(input, 'workspaceId', 'threadId', 'materialId')
      ),
  },
  {
    ...STANDARD,
    id: 'material.unbind',
    source: 'app-api',
    appOperationId: 'unbindThreadMaterial',
    clientMethod: 'app.unbindThreadMaterial',
    group: 'material',
    summary: 'Unbind one Workspace Material from a Thread.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.UnbindThreadMaterialRequestSchema, {
      ...threadScope,
      materialId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.unbindThreadMaterial(
        input.workspaceId,
        input.threadId,
        input.materialId,
        bodyWithout(input, 'workspaceId', 'threadId', 'materialId')
      ),
  },
  {
    ...STANDARD,
    id: 'material.exclude',
    source: 'app-api',
    appOperationId: 'excludeThreadMaterial',
    clientMethod: 'app.excludeThreadMaterial',
    group: 'material',
    summary: 'Exclude one bound Workspace Material from worker context.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.ExcludeThreadMaterialRequestSchema, {
      ...threadScope,
      materialId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.excludeThreadMaterial(
        input.workspaceId,
        input.threadId,
        input.materialId,
        bodyWithout(input, 'workspaceId', 'threadId', 'materialId')
      ),
  },
  {
    ...STANDARD,
    id: 'material.restore',
    source: 'app-api',
    appOperationId: 'restoreThreadMaterial',
    clientMethod: 'app.restoreThreadMaterial',
    group: 'material',
    summary: 'Restore one bound Workspace Material to worker context.',
    mutating: true,
    inputSchema: flatRequest(appSchemas.RestoreThreadMaterialRequestSchema, {
      ...threadScope,
      materialId: IDENTIFIER,
    }),
    handler: ({ client }, input) =>
      client.app.restoreThreadMaterial(
        input.workspaceId,
        input.threadId,
        input.materialId,
        bodyWithout(input, 'workspaceId', 'threadId', 'materialId')
      ),
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
    name: 'listMyWorkspaceInvitations',
    reason:
      'The server-mode CLI has no Better Auth session-cookie credential, and this user-scoped collection rejects OpenKit bearer tokens.',
    owner: 'docs/specs/20260715-multi_user_workspace_system.md',
  },
  {
    source: 'app-api',
    name: 'acceptWorkspaceInvitation',
    reason:
      'The server-mode CLI has no Better Auth session-cookie credential, and invitation acceptance rejects OpenKit bearer tokens.',
    owner: 'docs/specs/20260715-multi_user_workspace_system.md',
  },
  {
    source: 'app-api',
    name: 'declineWorkspaceInvitation',
    reason:
      'The server-mode CLI has no Better Auth session-cookie credential, and invitation decline rejects OpenKit bearer tokens.',
    owner: 'docs/specs/20260715-multi_user_workspace_system.md',
  },
  {
    source: 'app-api',
    name: 'leaveWorkspace',
    reason:
      'The server-mode CLI has no Better Auth session-cookie credential; leave and exact own-receipt replay require a canonical session or implicit local user.',
    owner: 'docs/specs/20260715-multi_user_workspace_system.md',
  },
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
    name: 'getNanoHostRuntimeTargetStatus',
    reason:
      'Host bring-up uses the App API RuntimeTarget route directly; no accepted Skill or Core Client caller exists.',
    owner: 'docs/specs/20260802-nanohost_runtime_and_transport.md',
  },
  {
    source: 'app-api',
    name: 'searchApp',
    reason: 'App search is a Web presentation route, not operation-catalog discovery.',
    owner: 'docs/specs/20260704-app_api_openapi_projection.md',
  },
  {
    source: 'core-projection',
    name: 'listWorkspaces',
    reason:
      'workspace.list uses the richer authorized App API summary; exposing this lower-fidelity projection would duplicate one user intent.',
    owner: 'docs/specs/20260715-multi_user_workspace_system.md',
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
