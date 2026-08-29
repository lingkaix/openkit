import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { isSurfaceLive } from '../../app/flags';
import { AppRoutes } from '../../app/routes';
import { surfaceById } from '../../app/surfaces';
import { useWorkspaceStore } from '../workspace-store';
import { AiInterfaceScreen } from './AiInterfaceScreen';
import { projectConnectedApps } from './data';
import { projectSafeValue, redactSecretShapedText, stripSecretFields } from './secret-safe';

const TIMESTAMP = '2026-07-21T12:00:00.000Z';
const POISON_SECRET = 'sk-secret-should-never-render';

const WORKSPACE = {
  id: 'ws1',
  name: 'Market research',
  kind: 'general',
  status: 'active',
  defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
  counts: { threadCount: 2, artifactCount: 0, knowledgeEntryCount: 3 },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const META = {
  protocolVersion: '0.4.0',
  capabilities: ['core.questions', 'core.artifacts'],
  eventFamilies: [],
};

const PROVIDERS = {
  providers: [
    {
      subscriptionProviderId: 'openai-codex' as const,
      displayName: 'OpenAI Codex' as const,
      loginModes: ['device_code'] as ['device_code'],
      quotaCapability: 'available' as const,
    },
    {
      subscriptionProviderId: 'xai' as const,
      displayName: 'xAI' as const,
      loginModes: ['device_code'] as ['device_code'],
      quotaCapability: 'unsupported' as const,
    },
  ] as const,
};

const CODEX_ACCOUNT = {
  subscriptionProviderId: 'openai-codex' as const,
  accountSlotId: 'primary',
  displayName: 'Codex primary',
  boundProviderIds: ['provider_codex'],
  status: 'logged_in' as const,
  accountLabel: 'Codex team',
  planLabel: 'Plus',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const XAI_ACCOUNT = {
  subscriptionProviderId: 'xai' as const,
  accountSlotId: 'primary',
  displayName: 'xAI primary',
  boundProviderIds: ['provider_xai'],
  status: 'logged_in' as const,
  accountLabel: 'Grok team',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const LIFECYCLE_ACCOUNTS = [
  {
    ...CODEX_ACCOUNT,
    accountSlotId: 'error',
    displayName: 'Error account',
    status: 'error' as const,
    message: 'A new login is required.',
  },
  {
    ...CODEX_ACCOUNT,
    accountSlotId: 'logged-out',
    displayName: 'Logged out account',
    status: 'logged_out' as const,
  },
  {
    ...CODEX_ACCOUNT,
    accountSlotId: 'pending',
    displayName: 'Pending account',
    status: 'pending' as const,
    interaction: {
      mode: 'device_code' as const,
      interactionId: 'interaction-pending',
      verificationUrl: 'https://example.com/device',
      userCode: 'ABCD-EFGH',
    },
  },
  CODEX_ACCOUNT,
  {
    ...CODEX_ACCOUNT,
    accountSlotId: 'unavailable',
    displayName: 'Unavailable account',
    status: 'unavailable' as const,
    message: 'Provider temporarily unavailable.',
  },
];

const CODEX_QUOTA = {
  subscriptionProviderId: 'openai-codex' as const,
  accountSlotId: 'primary',
  availability: 'available' as const,
  observedAt: TIMESTAMP,
  planType: 'plus',
  windows: [{ id: 'primary', usedPercent: 40, remainingPercent: 60 }],
};

const XAI_QUOTA = {
  subscriptionProviderId: 'xai' as const,
  accountSlotId: 'primary',
  availability: 'unsupported' as const,
  observedAt: TIMESTAMP,
};

const DIAGNOSTICS = {
  service: 'nanocore',
  boot: {
    bootId: 'boot_1',
    acceptingProductWork: true,
    overall: 'ready',
    subsystems: {
      config: { state: 'ready', reasons: [] },
      storage: { state: 'ready', reasons: [] },
      policy: { state: 'ready', reasons: [] },
      vault: { state: 'ready', reasons: [] },
      scheduler: { state: 'ready', reasons: [] },
      llmGateway: { state: 'ready', reasons: [] },
      knowledgeIndex: { state: 'ready', reasons: [] },
    },
  },
  gateway: { status: 'ok', endpoints: ['/v1/chat/completions'] },
  providers: { diagnostics: [], registry: [] },
  defaultProviders: {
    core: {
      configured: true,
      model: 'gpt-demo',
      origin: 'canonical',
      providerId: 'provider_demo',
    },
    gateway: { configured: false, origin: 'unset', reason: 'unset' },
  },
  defaults: {
    quickChat: { providerId: 'provider_demo', model: 'gpt-demo' },
    gateway: { providerId: null, model: null },
  },
  capabilities: META.capabilities,
  runtimeConfig: {
    currentVersion: 3,
    loadedAt: TIMESTAMP,
    lastReload: null,
    lastFailedReload: null,
    pendingRestart: [],
    staleSessions: [],
  },
};

const DEPLOYMENT_ADMIN_VAULT_STATUS = {
  backendKind: 'deployment-admin-backend-should-never-render',
  state: 'unavailable',
  diagnostic: `deployment-admin-diagnostic-should-never-render ${POISON_SECRET}`,
  token: 'status-field-poison-should-never-render',
};

const VAULT_REFERENCES = {
  workspaceId: WORKSPACE.id,
  apiKey: 'reference-field-poison-should-never-render',
  items: [
    {
      backendKind: 'encrypted-file',
      currentVersion: 2,
      ownerScope: 'workspace',
      referenceId: 'vault_ref_repository',
      secretKind: `repository-credential ${POISON_SECRET}`,
      status: 'active',
      workspaceId: WORKSPACE.id,
      accessToken: 'reference-row-poison-should-never-render',
    },
    {
      backendKind: 'encrypted-file',
      currentVersion: 1,
      ownerScope: 'workspace',
      referenceId: 'vault_ref_archive',
      secretKind: 'repository-credential',
      status: 'revoked',
      workspaceId: WORKSPACE.id,
    },
    {
      backendKind: 'encrypted-file',
      currentVersion: 0,
      ownerScope: 'workspace',
      referenceId: 'vault_ref_pending',
      secretKind: 'provider-credential',
      status: 'unbound',
      workspaceId: WORKSPACE.id,
    },
  ],
};

const VAULT_GRANTS = {
  workspaceId: WORKSPACE.id,
  password: 'grant-field-poison-should-never-render',
  items: [
    {
      grantId: 'grant_release_worker',
      vaultReferenceId: 'vault_ref_repository',
      ownerScope: 'workspace',
      workspaceId: WORKSPACE.id,
      userId: null,
      subjectSummary: `Release worker ${POISON_SECRET}`,
      targetAgentId: null,
      targetAgentSessionId: null,
      targetCapabilityId: null,
      allowedInjectionPaths: ['gateway-only'],
      lifetime: 'turn',
      policyDecisionId: null,
      approvalId: null,
      status: 'active',
      createdAt: TIMESTAMP,
      expiresAt: null,
      clientSecret: 'grant-row-poison-should-never-render',
    },
    {
      grantId: 'grant_archive_worker',
      vaultReferenceId: 'vault_ref_archive',
      ownerScope: 'workspace',
      workspaceId: WORKSPACE.id,
      userId: null,
      subjectSummary: 'Archive worker',
      targetAgentId: null,
      targetAgentSessionId: null,
      targetCapabilityId: null,
      allowedInjectionPaths: ['gateway-only'],
      lifetime: 'turn',
      policyDecisionId: null,
      approvalId: null,
      status: 'revoked',
      createdAt: TIMESTAMP,
      expiresAt: null,
    },
    {
      grantId: 'grant_history_worker',
      vaultReferenceId: 'vault_ref_pending',
      ownerScope: 'workspace',
      workspaceId: WORKSPACE.id,
      userId: null,
      subjectSummary: 'History worker',
      targetAgentId: null,
      targetAgentSessionId: null,
      targetCapabilityId: null,
      allowedInjectionPaths: ['gateway-only'],
      lifetime: 'turn',
      policyDecisionId: null,
      approvalId: null,
      status: 'expired',
      createdAt: TIMESTAMP,
      expiresAt: TIMESTAMP,
    },
  ],
};

const VAULT_USE_RECORDS = {
  workspaceId: WORKSPACE.id,
  secret: 'use-field-poison-should-never-render',
  vaultUseRecords: [
    {
      useId: 'vault_use_release',
      ownerScope: 'workspace',
      workspaceId: WORKSPACE.id,
      vaultReferenceId: 'vault_ref_repository',
      materialVersion: 2,
      backendKind: 'encrypted-file',
      resolvingPath: 'grant',
      grantId: 'grant_release_worker',
      planId: null,
      receiptId: null,
      agentSessionId: null,
      capabilityCallId: null,
      outcome: 'succeeded',
      failureCode: null,
      auditEventId: null,
      usedAt: TIMESTAMP,
      authorization: 'use-row-poison-should-never-render',
    },
    {
      useId: 'vault_use_policy',
      ownerScope: 'workspace',
      workspaceId: WORKSPACE.id,
      vaultReferenceId: 'vault_ref_policy',
      materialVersion: null,
      backendKind: 'encrypted-file',
      resolvingPath: 'grant',
      grantId: null,
      planId: null,
      receiptId: null,
      agentSessionId: null,
      capabilityCallId: null,
      outcome: 'denied',
      failureCode: 'policy',
      auditEventId: null,
      usedAt: TIMESTAMP,
    },
    {
      useId: 'vault_use_transport',
      ownerScope: 'workspace',
      workspaceId: WORKSPACE.id,
      vaultReferenceId: 'vault_ref_transport',
      materialVersion: null,
      backendKind: 'encrypted-file',
      resolvingPath: 'provider',
      grantId: null,
      planId: null,
      receiptId: null,
      agentSessionId: null,
      capabilityCallId: null,
      outcome: 'failed',
      failureCode: 'transport',
      auditEventId: null,
      usedAt: TIMESTAMP,
    },
  ],
};

const VAULT_INJECTION_PLANS = {
  workspaceId: WORKSPACE.id,
  token: 'plan-field-poison-should-never-render',
  items: [
    {
      planId: 'plan_release_worker',
      grantId: 'grant_release_worker',
      packageSnapshotId: 'aepsnap_1',
      capabilityId: null,
      injectionVisibility: 'gateway-only',
      targetPath: null,
      targetEnvVarName: null,
      expirationBehavior: `Expires with turn grant ${POISON_SECRET}`,
      revocationBehavior: 'Detach provider.',
      redactionRule: 'Do not expose token.',
      backendCapabilityRequirement: 'OpenShell provider attachment.',
      status: 'active',
      createdAt: TIMESTAMP,
      clientSecret: 'plan-row-poison-should-never-render',
    },
  ],
};

const VAULT_INJECTION_RECEIPTS = {
  workspaceId: WORKSPACE.id,
  password: 'receipt-field-poison-should-never-render',
  items: [
    {
      receiptId: 'receipt_release_worker',
      planId: 'plan_release_worker',
      grantId: 'grant_release_worker',
      agentSessionId: 'as_debug_1',
      capabilityCallId: null,
      backendSummary: `OpenShell attach ${POISON_SECRET}`,
      injectedAt: TIMESTAMP,
      expiresAt: null,
      revocationStatus: 'active',
      auditEventId: null,
      accessToken: 'receipt-row-poison-should-never-render',
    },
    {
      receiptId: 'receipt_stale_worker',
      planId: 'plan_release_worker',
      grantId: 'grant_release_worker',
      agentSessionId: 'as_debug_1',
      capabilityCallId: null,
      backendSummary: 'OpenShell attach remains reachable after revoke.',
      injectedAt: TIMESTAMP,
      expiresAt: null,
      revocationStatus: 'stale-session',
      auditEventId: null,
    },
  ],
};

const VAULT_FIELD_POISONS = [
  'status-field-poison-should-never-render',
  'reference-field-poison-should-never-render',
  'reference-row-poison-should-never-render',
  'grant-field-poison-should-never-render',
  'grant-row-poison-should-never-render',
  'use-field-poison-should-never-render',
  'use-row-poison-should-never-render',
  'plan-field-poison-should-never-render',
  'plan-row-poison-should-never-render',
  'receipt-field-poison-should-never-render',
  'receipt-row-poison-should-never-render',
] as const;

const CAPABILITY_USAGE = {
  workspaceId: WORKSPACE.id,
  password: 'usage-response-poison-should-never-render',
  capabilityCalls: [
    {
      id: 'cap_1',
      workspaceId: WORKSPACE.id,
      threadId: 'thread_1',
      turnId: 'turn_1',
      itemId: null,
      agentId: 'agent_1',
      agentSessionId: 'session_1',
      packageSnapshotId: null,
      runtimeOriginRef: null,
      runtimeCacheLineageRef: null,
      sourceIds: [],
      requestId: null,
      capabilityId: 'llm.chat_completions',
      family: 'llm',
      operation: 'chat_completions',
      providerRef: 'provider_openai',
      serviceRef: 'llm-gateway',
      redactionClass: 'metadata-only',
      status: 'succeeded',
      summary: `Model request completed with ${POISON_SECRET}.`,
      errorCode: null,
      startedAt: TIMESTAMP,
      completedAt: TIMESTAMP,
      accessToken: 'capability-row-poison-should-never-render',
    },
  ],
  usageRecords: [
    {
      id: 'usage_1',
      workspaceId: WORKSPACE.id,
      responsibleUserId: 'user_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      itemId: null,
      capabilityCallId: 'cap_1',
      requestId: null,
      agentId: 'agent_1',
      agentSessionId: 'session_1',
      sourceIds: [],
      category: 'llm',
      unit: 'tokens',
      quantity: 12,
      modelId: 'gpt-5',
      providerRef: 'provider_openai',
      source: 'gateway-reported:input',
      recordedAt: TIMESTAMP,
      apiKey: 'usage-row-poison-should-never-render',
    },
  ],
};

const WORKSPACE_AUDIT_EVENTS = {
  workspaceId: WORKSPACE.id,
  token: 'audit-response-poison-should-never-render',
  auditEvents: [
    {
      id: 'audit_1',
      workspaceId: WORKSPACE.id,
      protocolVersion: '0.5.0',
      threadId: 'thread_1',
      turnId: 'turn_1',
      itemId: null,
      capabilityCallId: 'cap_1',
      permissionDecisionId: null,
      vaultGrantId: null,
      requestId: null,
      actor: null,
      subject: null,
      agentId: 'agent_1',
      agentSessionId: 'session_1',
      category: 'capability',
      action: 'llm.chat_completions',
      resource: 'model:gpt-5',
      resourceRevision: null,
      outcome: 'succeeded',
      severity: 'info',
      summary: 'Model request completed.',
      errorCode: null,
      createdAt: TIMESTAMP,
      occurredAt: TIMESTAMP,
      authorization: 'audit-row-poison-should-never-render',
    },
  ],
};

const WORKSPACE_PERMISSION_DECISIONS = {
  workspaceId: WORKSPACE.id,
  secret: 'decision-response-poison-should-never-render',
  permissionDecisions: [
    {
      decisionId: 'decision_1',
      ownerScope: 'workspace',
      workspaceId: WORKSPACE.id,
      policyEngineVersion: 'policy:v1',
      policySnapshotId: 'workspace-policy',
      subjectSummary: { kind: 'agent', id: 'agent_1' },
      action: 'llm.gateway.use',
      resourceSummary: { kind: 'model', id: 'gpt-5' },
      contextSummary: { turnId: 'turn_1' },
      result: 'allow',
      reasonCode: 'workspace_policy_allowed',
      enforcementPoint: 'llm.gateway.policy',
      requiredApprovalKind: null,
      approvalId: null,
      auditEventId: 'audit_1',
      createdAt: TIMESTAMP,
      cookie: 'decision-row-poison-should-never-render',
    },
  ],
};

const SERVER_AUDIT_EVENTS = {
  auditEvents: [
    {
      id: 'audit_server_1',
      workspaceId: null,
      action: 'server.config.update',
      outcome: 'succeeded',
      severity: 'info',
      summary: `deployment-admin-audit-should-never-render ${POISON_SECRET}`,
    },
  ],
};

const USAGE_FIELD_POISONS = [
  'usage-response-poison-should-never-render',
  'capability-row-poison-should-never-render',
  'usage-row-poison-should-never-render',
  'audit-response-poison-should-never-render',
  'audit-row-poison-should-never-render',
  'decision-response-poison-should-never-render',
  'decision-row-poison-should-never-render',
  'deployment-admin-audit-should-never-render',
] as const;

const USAGE_NON_DISPLAY_FIELDS = [
  'thread_1',
  'session_1',
  'provider_openai',
  'gateway-reported:input',
  'policy:v1',
  'workspace-policy',
  'workspace_policy_allowed',
  'llm.gateway.policy',
] as const;

const EVIDENCE_BUNDLES = {
  workspaceId: WORKSPACE.id,
  apiKey: 'evidence-response-poison-should-never-render',
  evidenceBundles: [
    {
      id: 'evb_debug_1',
      workspaceId: WORKSPACE.id,
      threadId: 'thread_debug',
      goalId: null,
      turnId: 'turn_debug',
      agentSessionId: 'as_debug_1',
      backendType: null,
      sourceKind: 'manual',
      summary: `Goal evidence is ready with ${POISON_SECRET}.`,
      rawEvidenceRefs: [{ kind: 'backend-log', ref: 'raw-evidence-locator-should-never-render' }],
      redactedEvidenceRefs: [{ kind: 'artifact', ref: 'artifact_debug' }],
      contentDigests: ['sha256:evidence'],
      retentionClass: 'turn-evidence',
      sensitivityClass: 'product-safe',
      importStatus: 'collected',
      requiredFeatures: [],
      createdAt: TIMESTAMP,
      accessToken: 'evidence-row-poison-should-never-render',
    },
  ],
};

const RUNTIME_EVIDENCE = {
  workspaceId: WORKSPACE.id,
  token: 'runtime-response-poison-should-never-render',
  runtimeEvidence: [
    {
      id: 'rte_debug_1',
      workspaceId: WORKSPACE.id,
      threadId: 'thread_debug',
      turnId: 'turn_debug',
      goalId: null,
      taskId: null,
      agentSessionId: 'as_debug_1',
      backendType: 'openshell',
      backendVersion: null,
      placement: 'local',
      phase: 'teardown',
      summary: 'Worker checkpoint terminal: completed.',
      policyDigest: null,
      workerImage: null,
      sandboxSummary: null,
      capabilitySummary: 'worker turn checkpoint',
      uploadManifest: [],
      downloadManifest: [],
      transcriptSummary: null,
      workspaceChangeSummary: null,
      controlSummary: null,
      outcome: 'succeeded',
      exitCode: 0,
      signal: null,
      stopReason: 'completed',
      errorCode: null,
      errorMessage: null,
      redactedStdoutSummary: `stdout ${POISON_SECRET}`,
      redactedStderrSummary: null,
      evidenceBundleIds: ['evb_debug_1'],
      contentDigests: ['sha256:runtime'],
      requiredFeatures: [],
      createdAt: TIMESTAMP,
      startedAt: null,
      completedAt: TIMESTAMP,
      collectedAt: TIMESTAMP,
      authorization: 'runtime-row-poison-should-never-render',
    },
  ],
};

const AEP_SNAPSHOT_LIST_ITEM = {
  snapshotId: 'aepsnap_1',
  workspaceId: WORKSPACE.id,
  turnId: 'turn_debug',
  threadId: 'thread_debug',
  agentSessionId: 'as_debug_1',
  agentId: 'agent_1',
  packageId: 'aepkg_1',
  runtimeKind: 'coder',
  backendKind: 'openshell',
  contentDigest: '0123456789abcdef',
  snapshot: { snapshotId: 'aepsnap_1' },
  createdAt: TIMESTAMP,
};

const AEP_SNAPSHOTS = {
  items: [AEP_SNAPSHOT_LIST_ITEM],
};

const AEP_SNAPSHOT_DETAIL = {
  ...AEP_SNAPSHOT_LIST_ITEM,
  snapshot: {
    snapshotId: 'aepsnap_1',
    packageId: 'aepkg_1',
    scope: {
      workspaceId: WORKSPACE.id,
      threadId: 'thread_debug',
      turnId: 'turn_debug',
      agentSessionId: 'as_debug_1',
    },
    agent: {
      agentId: 'agent_1',
      runtimeKind: 'coder',
    },
    backend: {
      preferred: 'openshell',
    },
    apiKey: POISON_SECRET,
  },
};

const DEBUG_FIELD_POISONS = [
  'evidence-response-poison-should-never-render',
  'evidence-row-poison-should-never-render',
  'raw-evidence-locator-should-never-render',
  'runtime-response-poison-should-never-render',
  'runtime-row-poison-should-never-render',
  'as_debug_1',
] as const;

type MethodOverrides = Partial<Record<string, unknown>>;

/** Build a fake CoreClient; per-test overrides replace individual methods. */
function makeClient(
  overrides: {
    core?: MethodOverrides;
    app?: MethodOverrides;
    runtimeConfig?: MethodOverrides;
    providerSubscriptions?: MethodOverrides;
  } = {}
): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue(META),
      listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE] }),
      getWorkspace: vi.fn().mockResolvedValue(WORKSPACE),
      updateWorkspace: vi.fn().mockResolvedValue({ ...WORKSPACE, name: 'Renamed workspace' }),
      listKnowledge: vi.fn().mockResolvedValue({ items: [] }),
      ...overrides.core,
    },
    app: {
      listAuthorizedWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [] } satisfies Awaited<
          ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>
        >),
      getDiagnostics: vi.fn().mockResolvedValue(DIAGNOSTICS),
      getWorkspaceDashboard: vi.fn().mockResolvedValue({
        workspace: WORKSPACE,
        counts: WORKSPACE.counts,
        defaultContext: { modelId: null, agentId: null, skillIds: [] },
        agentHealth: [],
        recentThreads: [],
        activeWork: [],
        recentCompletions: [],
        attentionNeeded: [],
      }),
      getVaultAdminStatus: vi.fn().mockResolvedValue(DEPLOYMENT_ADMIN_VAULT_STATUS),
      listWorkspaceVaultReferences: vi.fn().mockResolvedValue(VAULT_REFERENCES),
      listWorkspaceVaultGrants: vi.fn().mockResolvedValue(VAULT_GRANTS),
      listWorkspaceVaultUseRecords: vi.fn().mockResolvedValue(VAULT_USE_RECORDS),
      listWorkspaceVaultInjectionPlans: vi.fn().mockResolvedValue(VAULT_INJECTION_PLANS),
      listWorkspaceVaultInjectionReceipts: vi.fn().mockResolvedValue(VAULT_INJECTION_RECEIPTS),
      listServerVaultUseRecords: vi.fn(),
      unlockVaultAdminBackend: vi.fn(),
      lockVaultAdminBackend: vi.fn(),
      bootstrapCodexAuthJsonVaultReference: vi.fn(),
      rebindWorkspaceVaultReference: vi.fn(),
      getCapabilityUsage: vi.fn().mockResolvedValue(CAPABILITY_USAGE),
      listWorkspaceAuditEvents: vi.fn().mockResolvedValue(WORKSPACE_AUDIT_EVENTS),
      listServerAuditEvents: vi.fn().mockResolvedValue(SERVER_AUDIT_EVENTS),
      listWorkspacePermissionDecisions: vi.fn().mockResolvedValue(WORKSPACE_PERMISSION_DECISIONS),
      listServerPermissionDecisions: vi.fn(),
      listWorkspaceEvidenceBundles: vi.fn().mockResolvedValue(EVIDENCE_BUNDLES),
      listWorkspaceRuntimeEvidence: vi.fn().mockResolvedValue(RUNTIME_EVIDENCE),
      listAgentEnvironmentPackageSnapshots: vi.fn().mockResolvedValue(AEP_SNAPSHOTS),
      getAgentEnvironmentPackageSnapshot: vi.fn().mockResolvedValue(AEP_SNAPSHOT_DETAIL),
      ...overrides.app,
    },
    runtimeConfig: {
      listFiles: vi.fn().mockResolvedValue({
        files: [
          {
            id: 'server',
            kind: 'server',
            path: 'config/server.jsonc',
            exists: true,
            revision: 'rev1',
            updatedAt: TIMESTAMP,
          },
          {
            id: 'provider_demo',
            kind: 'provider',
            path: 'config/providers/demo.provider.jsonc',
            exists: true,
            revision: 'rev2',
            updatedAt: TIMESTAMP,
          },
        ],
      }),
      getFile: vi.fn().mockResolvedValue({
        file: {
          id: 'server',
          kind: 'server',
          path: 'config/server.jsonc',
          exists: true,
          revision: 'rev1',
          updatedAt: TIMESTAMP,
        },
        content: JSON.stringify({ apiKey: POISON_SECRET }),
      }),
      ...overrides.runtimeConfig,
    },
    providerSubscriptions: {
      listProviders: vi.fn().mockResolvedValue(PROVIDERS),
      listAccounts: vi.fn().mockImplementation((providerId: string) =>
        Promise.resolve({
          accounts: providerId === 'openai-codex' ? [CODEX_ACCOUNT] : [XAI_ACCOUNT],
        })
      ),
      createAccount: vi.fn(),
      updateAccount: vi.fn(),
      deleteAccount: vi.fn(),
      getAccountStatus: vi.fn(),
      startAccountLogin: vi.fn(),
      cancelAccountLogin: vi.fn(),
      logoutAccount: vi.fn(),
      getAccountQuota: vi
        .fn()
        .mockImplementation((providerId: string) =>
          Promise.resolve(providerId === 'openai-codex' ? CODEX_QUOTA : XAI_QUOTA)
        ),
      ...overrides.providerSubscriptions,
    },
    auth: { email: { signUp: vi.fn(), signIn: vi.fn(), signOut: vi.fn() } },
    capabilities: {
      refresh: vi.fn(),
      snapshot: vi.fn().mockReturnValue(META),
      supports: vi.fn().mockReturnValue(true),
      require: vi.fn(),
    },
    agents: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      get: vi.fn(),
      refreshHealth: vi.fn(),
    },
    actionCenter: { listHumanAttention: vi.fn().mockResolvedValue({ items: [] }) },
    repositories: {},
  } as unknown as CoreClient;
}

function renderApp(path: string, client: CoreClient, content: ReactNode = <AppRoutes />) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  render(wrapper(content));
  return client;
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('secret-safe projection helpers', () => {
  it('redacts secret-shaped substrings', () => {
    expect(redactSecretShapedText(`token ${POISON_SECRET} ok`)).not.toContain(POISON_SECRET);
    expect(redactSecretShapedText(`token ${POISON_SECRET} ok`)).toContain('[redacted]');
  });

  it('strips known secret field names before projection', () => {
    const safe = stripSecretFields({
      displayName: 'ChatGPT',
      apiKey: POISON_SECRET,
      nested: { token: 'okt_should_go', status: 'logged_in' },
    }) as Record<string, unknown>;
    expect(safe.displayName).toBe('ChatGPT');
    expect(safe.apiKey).toBeUndefined();
    expect((safe.nested as Record<string, unknown>).status).toBe('logged_in');
    expect((safe.nested as Record<string, unknown>).token).toBeUndefined();
  });

  it('projectSafeValue never returns raw secret strings', () => {
    const projected = projectSafeValue({
      apiKey: POISON_SECRET,
      label: `Bearer ${POISON_SECRET}`,
      status: 'configured',
    }) as Record<string, unknown>;
    expect(JSON.stringify(projected)).not.toContain(POISON_SECRET);
    expect(projected.status).toBe('configured');
  });
});

describe('provider subscription projection', () => {
  it('fails closed when an account belongs to another provider', () => {
    expect(() =>
      projectConnectedApps(PROVIDERS.providers[0], { accounts: [XAI_ACCOUNT] }, [XAI_QUOTA])
    ).toThrow();
  });

  it.each([
    ['provider differs', XAI_QUOTA],
    ['account slot differs', { ...CODEX_QUOTA, accountSlotId: 'secondary' }],
  ])('fails closed when the quota %s from its account', (_dimension, quota) => {
    expect(() =>
      projectConnectedApps(PROVIDERS.providers[0], { accounts: [CODEX_ACCOUNT] }, [quota])
    ).toThrow();
  });
});

describe('Vault settings (board 15)', () => {
  it('is live in normal Settings navigation and renders only bounded secret-safe live metadata', async () => {
    const client = makeClient();
    const surface = surfaceById('vault');
    expect(surface).toMatchObject({ tier: 'A', nav: 'settings' });
    expect(isSurfaceLive(surface!)).toBe(true);

    renderApp('/settings/vault', client);

    expect(await screen.findByRole('heading', { level: 1, name: 'Vault' })).toBeInTheDocument();
    expect(screen.queryByText(/not yet backed by the kernel/i)).not.toBeInTheDocument();
    const references = await screen.findByRole('region', { name: 'References' });
    const grants = screen.getByRole('region', { name: 'Grants' });
    const uses = screen.getByRole('region', { name: 'Recent use' });
    const plans = screen.getByRole('region', { name: 'Injection plans' });
    const receipts = screen.getByRole('region', { name: 'Injection receipts' });
    expect(
      within(references).getByText('vault_ref_repository', { exact: true })
    ).toBeInTheDocument();
    expect(within(plans).getByText('plan_release_worker', { exact: true })).toBeInTheDocument();
    expect(within(plans).getByText('gateway-only', { exact: true })).toBeInTheDocument();
    expect(
      within(plans).getByText('Expires with turn grant [redacted]', { exact: true })
    ).toBeInTheDocument();
    expect(
      within(receipts).getByText('receipt_release_worker', { exact: true })
    ).toBeInTheDocument();
    expect(
      within(receipts).getByText('OpenShell attach [redacted]', { exact: true })
    ).toBeInTheDocument();

    const renderedText = document.body.textContent ?? '';
    expect(renderedText).toContain('vault_ref_repository');
    expect(renderedText).toContain('Release worker [redacted]');
    expect(screen.queryByText('Vault backend', { exact: true })).not.toBeInTheDocument();
    expect(
      screen.queryByText(DEPLOYMENT_ADMIN_VAULT_STATUS.backendKind, { exact: true })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('deployment-admin-diagnostic-should-never-render [redacted]', {
        exact: true,
      })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Error', { exact: true })).not.toBeInTheDocument();
    expect({
      references: [
        within(references).getByText('vault_ref_repository').parentElement!.parentElement!
          .lastElementChild?.textContent,
        within(references).getByText('vault_ref_archive').parentElement!.parentElement!
          .lastElementChild?.textContent,
        within(references).getByText('vault_ref_pending').parentElement!.parentElement!
          .lastElementChild?.textContent,
      ],
      grants: [
        within(grants).getByText('Release worker [redacted]', { exact: true }).parentElement!
          .parentElement!.lastElementChild?.textContent,
        within(grants).getByText('Archive worker').parentElement!.parentElement!.lastElementChild
          ?.textContent,
        within(grants).getByText('History worker').parentElement!.parentElement!.lastElementChild
          ?.textContent,
      ],
      uses: [
        within(uses).getByText('vault_ref_repository').parentElement!.parentElement!
          .lastElementChild?.textContent,
        within(uses).getByText('vault_ref_policy').parentElement!.parentElement!.lastElementChild
          ?.textContent,
        within(uses).getByText('vault_ref_transport').parentElement!.parentElement!.lastElementChild
          ?.textContent,
      ],
      plans: [
        within(plans).getByText('plan_release_worker').parentElement!.parentElement!
          .lastElementChild?.textContent,
      ],
      receipts: [
        within(receipts).getByText('receipt_release_worker').parentElement!.parentElement!
          .lastElementChild?.textContent,
      ],
    }).toEqual({
      references: ['Ready', 'Cancelled', 'Blocked'],
      grants: ['Ready', 'Cancelled', 'Cancelled'],
      uses: ['Done', 'Rejected', 'Failed'],
      plans: ['Ready'],
      receipts: ['Ready'],
    });
    const staleReceiptChip =
      within(receipts).getByText('receipt_stale_worker').parentElement!.parentElement!
        .lastElementChild?.textContent;
    expect(staleReceiptChip).toMatch(/review|stale|warning|attention/i);
    expect(staleReceiptChip).not.toMatch(/^(Failed|Ready|Cancelled|Done|Blocked|Rejected)$/);
    for (const [region, rawStatuses] of [
      [references, ['active', 'revoked', 'unbound']],
      [grants, ['active', 'revoked', 'expired']],
      [uses, ['succeeded', 'denied', 'failed']],
      [plans, ['active']],
      [receipts, ['active', 'stale-session']],
    ] as const) {
      for (const rawStatus of rawStatuses) {
        expect(within(region).queryByText(rawStatus, { exact: true })).not.toBeInTheDocument();
      }
    }
    const serializedDom = document.documentElement.outerHTML;
    expect(serializedDom).not.toContain(POISON_SECRET);
    for (const poison of VAULT_FIELD_POISONS) expect(serializedDom).not.toContain(poison);
    expect(screen.queryByRole('button', { name: /add secret/i })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /more actions/i })).toHaveLength(0);

    for (const excludedRead of [
      client.app.getVaultAdminStatus,
      client.app.listServerVaultUseRecords,
    ]) {
      expect(excludedRead).not.toHaveBeenCalled();
    }
    expect({
      plans: vi.mocked(client.app.listWorkspaceVaultInjectionPlans).mock.calls,
      receipts: vi.mocked(client.app.listWorkspaceVaultInjectionReceipts).mock.calls,
    }).toEqual({
      plans: [[WORKSPACE.id]],
      receipts: [[WORKSPACE.id]],
    });
    for (const mutation of [
      client.app.unlockVaultAdminBackend,
      client.app.lockVaultAdminBackend,
      client.app.bootstrapCodexAuthJsonVaultReference,
      client.app.rebindWorkspaceVaultReference,
    ]) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it('validates a persisted Workspace selection before Vault reads after discovery retry', async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws_stale' });
    const listWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(new Error('workspace-store-private failure'))
      .mockResolvedValue({ items: [WORKSPACE] });
    const client = makeClient({ core: { listWorkspaces } });
    renderApp('/settings/vault', client);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load workspaces/i);
    expect(alert).not.toHaveTextContent('workspace-store-private failure');
    expect(screen.queryByText('No workspace selected')).not.toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Done')).toBeInTheDocument();
    const validatedAt = listWorkspaces.mock.invocationCallOrder[1];
    expect({
      deploymentAdminStatusCalls: vi.mocked(client.app.getVaultAdminStatus).mock.calls,
      references: {
        calls: vi.mocked(client.app.listWorkspaceVaultReferences).mock.calls,
        afterValidation:
          vi.mocked(client.app.listWorkspaceVaultReferences).mock.invocationCallOrder[0] >
          validatedAt,
      },
      grants: {
        calls: vi.mocked(client.app.listWorkspaceVaultGrants).mock.calls,
        afterValidation:
          vi.mocked(client.app.listWorkspaceVaultGrants).mock.invocationCallOrder[0] > validatedAt,
      },
      uses: {
        calls: vi.mocked(client.app.listWorkspaceVaultUseRecords).mock.calls,
        afterValidation:
          vi.mocked(client.app.listWorkspaceVaultUseRecords).mock.invocationCallOrder[0] >
          validatedAt,
      },
    }).toEqual({
      deploymentAdminStatusCalls: [],
      references: { calls: [[WORKSPACE.id]], afterValidation: true },
      grants: { calls: [[WORKSPACE.id]], afterValidation: true },
      uses: { calls: [[WORKSPACE.id]], afterValidation: true },
    });
  });

  it('shows content-shaped loading skeletons while the live reads are pending', async () => {
    const pending = new Promise(() => {});
    renderApp(
      '/settings/vault',
      makeClient({
        app: {
          listWorkspaceVaultReferences: vi.fn().mockReturnValue(pending),
          listWorkspaceVaultGrants: vi.fn().mockReturnValue(pending),
          listWorkspaceVaultUseRecords: vi.fn().mockReturnValue(pending),
        },
      })
    );

    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
  });

  it('shows an explicit empty state for each Workspace Vault record family', async () => {
    const client = makeClient({
      app: {
        listWorkspaceVaultReferences: vi
          .fn()
          .mockResolvedValue({ workspaceId: WORKSPACE.id, items: [] }),
        listWorkspaceVaultGrants: vi
          .fn()
          .mockResolvedValue({ workspaceId: WORKSPACE.id, items: [] }),
        listWorkspaceVaultUseRecords: vi
          .fn()
          .mockResolvedValue({ workspaceId: WORKSPACE.id, vaultUseRecords: [] }),
      },
    });
    renderApp('/settings/vault', client);

    expect(
      await screen.findByText('No credential references', { exact: true })
    ).toBeInTheDocument();
    expect(screen.getByText('No active or historical grants', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('No credential use recorded', { exact: true })).toBeInTheDocument();
  });

  it('shows a plain error and retries the failed live read', async () => {
    const user = userEvent.setup();
    const listWorkspaceVaultReferences = vi
      .fn()
      .mockRejectedValueOnce(new Error('workspace-vault-private failure'))
      .mockResolvedValue(VAULT_REFERENCES);
    renderApp('/settings/vault', makeClient({ app: { listWorkspaceVaultReferences } }));

    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('workspace-vault-private failure');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listWorkspaceVaultReferences).toHaveBeenCalledTimes(2));
    const references = await screen.findByRole('region', { name: 'References' });
    expect(
      within(references).getByText('vault_ref_repository', { exact: true })
    ).toBeInTheDocument();
  });

  it('shows an explicit retry when injection-plan reads fail without dropping other Vault families after recovery', async () => {
    const user = userEvent.setup();
    const listWorkspaceVaultInjectionPlans = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiCallError(403, 'injection-plan-private failure', {
          code: 'workspace_access_denied',
        })
      )
      .mockResolvedValue(VAULT_INJECTION_PLANS);
    renderApp('/settings/vault', makeClient({ app: { listWorkspaceVaultInjectionPlans } }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load/i);
    expect(alert).not.toHaveTextContent('injection-plan-private failure');
    expect(alert).not.toHaveTextContent('workspace_access_denied');
    expect(screen.queryByText('plan_release_worker', { exact: true })).not.toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listWorkspaceVaultInjectionPlans).toHaveBeenCalledTimes(2));
    expect(listWorkspaceVaultInjectionPlans).toHaveBeenCalledWith(WORKSPACE.id);
    const plans = await screen.findByRole('region', { name: 'Injection plans' });
    expect(within(plans).getByText('plan_release_worker', { exact: true })).toBeInTheDocument();
    const references = screen.getByRole('region', { name: 'References' });
    expect(
      within(references).getByText('vault_ref_repository', { exact: true })
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Grants' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Recent use' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Injection receipts' })).toBeInTheDocument();
  });

  it('marks Workspace Vault metadata as stale while Core is disconnected', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
    });
    renderApp('/settings/vault', client);

    const references = await screen.findByRole('region', { name: 'References' });
    expect(
      within(references).getByText('vault_ref_repository', { exact: true })
    ).toBeInTheDocument();
    expect(await screen.findByText('Status may be stale', { exact: true })).toBeInTheDocument();
  });
});

describe('Debug settings (board 11)', () => {
  it('reads selected-Workspace evidence and AEP snapshots, then lazily loads one snapshot detail', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderApp('/settings/debug', client);

    expect(await screen.findByRole('heading', { level: 1, name: 'Debug' })).toBeInTheDocument();
    expect(screen.getByText('Buttons', { exact: true })).toBeInTheDocument();
    expect(
      await screen.findByText('Goal evidence is ready with [redacted].', { exact: true })
    ).toBeInTheDocument();
    expect(
      screen.getByText('Worker checkpoint terminal: completed.', { exact: true })
    ).toBeInTheDocument();
    expect(screen.getByText('aepsnap_1', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('coder', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('aepkg_1', { exact: true })).not.toBeInTheDocument();
    expect(client.app.getAgentEnvironmentPackageSnapshot).not.toHaveBeenCalled();

    const snapshotButton = screen.getByRole('button', { name: 'aepsnap_1' });
    expect(snapshotButton).not.toHaveAttribute('aria-pressed', 'true');
    await user.click(snapshotButton);
    await waitFor(() =>
      expect(client.app.getAgentEnvironmentPackageSnapshot).toHaveBeenCalledWith(
        WORKSPACE.id,
        'aepsnap_1'
      )
    );
    expect(await screen.findByText('coder', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('aepkg_1', { exact: true })).toBeInTheDocument();
    expect(snapshotButton).toHaveAttribute('aria-pressed', 'true');
    expect(client.app.getAgentEnvironmentPackageSnapshot).toHaveBeenCalledTimes(1);

    const serializedDom = document.documentElement.outerHTML;
    expect(serializedDom).not.toContain(POISON_SECRET);
    for (const poison of DEBUG_FIELD_POISONS) expect(serializedDom).not.toContain(poison);
    expect({
      bundles: vi.mocked(client.app.listWorkspaceEvidenceBundles).mock.calls,
      runtime: vi.mocked(client.app.listWorkspaceRuntimeEvidence).mock.calls,
      snapshots: vi.mocked(client.app.listAgentEnvironmentPackageSnapshots).mock.calls,
      diagnostics: vi.mocked(client.app.getDiagnostics).mock.calls,
      serverAudit: vi.mocked(client.app.listServerAuditEvents).mock.calls,
      vaultAdmin: vi.mocked(client.app.getVaultAdminStatus).mock.calls,
    }).toEqual({
      bundles: [[WORKSPACE.id]],
      runtime: [[WORKSPACE.id]],
      snapshots: [[WORKSPACE.id]],
      diagnostics: [],
      serverAudit: [],
      vaultAdmin: [],
    });
  });

  it('keeps other Debug sections visible and retries a typed evidence denial', async () => {
    const user = userEvent.setup();
    const listWorkspaceEvidenceBundles = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiCallError(403, 'evidence-bundle-private failure', {
          code: 'workspace_access_denied',
        })
      )
      .mockResolvedValue(EVIDENCE_BUNDLES);
    const client = makeClient({ app: { listWorkspaceEvidenceBundles } });
    renderApp('/settings/debug', client);

    expect(await screen.findByRole('heading', { level: 1, name: 'Debug' })).toBeInTheDocument();
    expect(screen.getByText('Buttons', { exact: true })).toBeInTheDocument();
    expect(
      await screen.findByText('Worker checkpoint terminal: completed.', { exact: true })
    ).toBeInTheDocument();
    expect(screen.getByText('aepsnap_1', { exact: true })).toBeInTheDocument();
    expect(
      screen.queryByText('Goal evidence is ready with [redacted].', { exact: true })
    ).not.toBeInTheDocument();

    const evidenceAlert = screen
      .getAllByRole('alert')
      .find((node) => /couldn't load/i.test(node.textContent ?? ''));
    expect(evidenceAlert).toBeTruthy();
    expect(evidenceAlert).not.toHaveTextContent('evidence-bundle-private failure');
    expect(evidenceAlert).not.toHaveTextContent('workspace_access_denied');
    await user.click(
      within(evidenceAlert as HTMLElement).getByRole('button', { name: 'Try again' })
    );
    await waitFor(() => expect(listWorkspaceEvidenceBundles).toHaveBeenCalledTimes(2));
    expect(listWorkspaceEvidenceBundles).toHaveBeenCalledWith(WORKSPACE.id);
    expect(
      await screen.findByText('Goal evidence is ready with [redacted].', { exact: true })
    ).toBeInTheDocument();
    expect(screen.getByText('Buttons', { exact: true })).toBeInTheDocument();
    expect(
      screen.getByText('Worker checkpoint terminal: completed.', { exact: true })
    ).toBeInTheDocument();
    expect(screen.getByText('aepsnap_1', { exact: true })).toBeInTheDocument();
  });

  it('shows content-shaped loading skeletons while Workspace discovery is pending', async () => {
    renderApp(
      '/settings/debug',
      makeClient({
        core: { listWorkspaces: vi.fn().mockReturnValue(new Promise(() => {})) },
      })
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Debug' })).toBeInTheDocument();
    expect(screen.getByText('Buttons', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Evidence bundles' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(1));
  });

  it('shows an empty state when no Workspace is selected', async () => {
    renderApp(
      '/settings/debug',
      makeClient({
        core: { listWorkspaces: vi.fn().mockResolvedValue({ items: [] }) },
      })
    );

    expect(await screen.findByText('No workspace selected', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Buttons', { exact: true })).toBeInTheDocument();
    expect(
      screen.queryByText('Goal evidence is ready with [redacted].', { exact: true })
    ).not.toBeInTheDocument();
  });

  it('clears the selected AEP snapshot when the Workspace switches and does not reread the old id', async () => {
    const user = userEvent.setup();
    const workspaceB = { ...WORKSPACE, id: 'ws2', name: 'Second workspace' };
    const listAgentEnvironmentPackageSnapshots = vi.fn().mockImplementation((workspaceId: string) =>
      Promise.resolve({
        items: workspaceId === WORKSPACE.id ? [AEP_SNAPSHOT_LIST_ITEM] : [],
      })
    );
    const getAgentEnvironmentPackageSnapshot = vi.fn().mockResolvedValue(AEP_SNAPSHOT_DETAIL);
    const client = makeClient({
      core: { listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE, workspaceB] }) },
      app: { listAgentEnvironmentPackageSnapshots, getAgentEnvironmentPackageSnapshot },
    });
    renderApp('/settings/debug', client);

    const snapshotButton = await screen.findByRole('button', { name: 'aepsnap_1' });
    await user.click(snapshotButton);
    await waitFor(() =>
      expect(getAgentEnvironmentPackageSnapshot).toHaveBeenCalledWith(WORKSPACE.id, 'aepsnap_1')
    );

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: workspaceB.id }));

    await waitFor(() =>
      expect(listAgentEnvironmentPackageSnapshots).toHaveBeenCalledWith(workspaceB.id)
    );
    expect(getAgentEnvironmentPackageSnapshot).not.toHaveBeenCalledWith(workspaceB.id, 'aepsnap_1');
    expect(getAgentEnvironmentPackageSnapshot.mock.calls).toEqual([[WORKSPACE.id, 'aepsnap_1']]);
    expect(screen.queryByRole('button', { name: 'aepsnap_1' })).not.toBeInTheDocument();
    expect(screen.queryByText('coder', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('aepkg_1', { exact: true })).not.toBeInTheDocument();
  });
});

describe('Usage and audit settings (board 17)', () => {
  it('is a selected-Workspace read-only surface with exact live reads and a bounded DOM', async () => {
    const client = makeClient();
    const surface = surfaceById('usage');
    expect(surface).toMatchObject({ tier: 'A', nav: 'settings' });
    expect(isSurfaceLive(surface!)).toBe(true);

    renderApp('/settings/usage', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Usage & audit' })
    ).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(screen.queryByText(/not yet backed by the kernel/i)).not.toBeInTheDocument();
    expect(within(main).getByText('Market research', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('chat_completions', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('12 tokens', { exact: true })).toBeInTheDocument();
    expect(
      screen.getByText('Model request completed with [redacted].', { exact: true })
    ).toBeInTheDocument();
    expect(screen.getByText('llm.gateway.use', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Approved', { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText('Done', { exact: true }).length).toBeGreaterThan(0);

    expect(screen.queryByText('succeeded', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('allow', { exact: true })).not.toBeInTheDocument();
    expect(
      within(main).queryByRole('button', {
        name: /approve|deny|delete|edit|export|re-run/i,
      })
    ).not.toBeInTheDocument();
    expect(main).not.toHaveTextContent(
      /so (?:this|the) (?:record|audit) is complete|complete across (?:the )?deployment/i
    );

    const serializedDom = document.documentElement.outerHTML;
    expect(serializedDom).not.toContain(POISON_SECRET);
    for (const poison of USAGE_FIELD_POISONS) expect(serializedDom).not.toContain(poison);
    for (const field of USAGE_NON_DISPLAY_FIELDS) expect(serializedDom).not.toContain(field);

    expect({
      usage: vi.mocked(client.app.getCapabilityUsage).mock.calls,
      audit: vi.mocked(client.app.listWorkspaceAuditEvents).mock.calls,
      decisions: vi.mocked(client.app.listWorkspacePermissionDecisions).mock.calls,
      serverAudit: vi.mocked(client.app.listServerAuditEvents).mock.calls,
      serverDecisions: vi.mocked(client.app.listServerPermissionDecisions).mock.calls,
    }).toEqual({
      usage: [[WORKSPACE.id]],
      audit: [[WORKSPACE.id]],
      decisions: [[WORKSPACE.id]],
      serverAudit: [],
      serverDecisions: [],
    });
  });

  it('validates a persisted Workspace selection before the three reads after discovery retry', async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws_stale' });
    const listWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(new Error('workspace-discovery-private failure'))
      .mockResolvedValue({ items: [WORKSPACE] });
    const client = makeClient({ core: { listWorkspaces } });
    renderApp('/settings/usage', client);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load workspaces/i);
    expect(alert).not.toHaveTextContent('workspace-discovery-private failure');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('chat_completions', { exact: true })).toBeInTheDocument();
    const validatedAt = listWorkspaces.mock.invocationCallOrder[1];
    expect({
      usage: {
        calls: vi.mocked(client.app.getCapabilityUsage).mock.calls,
        afterValidation:
          vi.mocked(client.app.getCapabilityUsage).mock.invocationCallOrder[0] > validatedAt,
      },
      audit: {
        calls: vi.mocked(client.app.listWorkspaceAuditEvents).mock.calls,
        afterValidation:
          vi.mocked(client.app.listWorkspaceAuditEvents).mock.invocationCallOrder[0] > validatedAt,
      },
      decisions: {
        calls: vi.mocked(client.app.listWorkspacePermissionDecisions).mock.calls,
        afterValidation:
          vi.mocked(client.app.listWorkspacePermissionDecisions).mock.invocationCallOrder[0] >
          validatedAt,
      },
      serverAudit: vi.mocked(client.app.listServerAuditEvents).mock.calls,
    }).toEqual({
      usage: { calls: [[WORKSPACE.id]], afterValidation: true },
      audit: { calls: [[WORKSPACE.id]], afterValidation: true },
      decisions: { calls: [[WORKSPACE.id]], afterValidation: true },
      serverAudit: [],
    });
  });

  it('shows content-shaped loading skeletons while the three live reads are pending', async () => {
    const pending = new Promise(() => {});
    renderApp(
      '/settings/usage',
      makeClient({
        app: {
          getCapabilityUsage: vi.fn().mockReturnValue(pending),
          listWorkspaceAuditEvents: vi.fn().mockReturnValue(pending),
          listWorkspacePermissionDecisions: vi.fn().mockReturnValue(pending),
        },
      })
    );

    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
  });

  it('shows a distinct empty state for usage, audit events, and permission decisions', async () => {
    renderApp(
      '/settings/usage',
      makeClient({
        app: {
          getCapabilityUsage: vi.fn().mockResolvedValue({
            workspaceId: WORKSPACE.id,
            capabilityCalls: [],
            usageRecords: [],
          }),
          listWorkspaceAuditEvents: vi
            .fn()
            .mockResolvedValue({ workspaceId: WORKSPACE.id, auditEvents: [] }),
          listWorkspacePermissionDecisions: vi
            .fn()
            .mockResolvedValue({ workspaceId: WORKSPACE.id, permissionDecisions: [] }),
        },
      })
    );

    expect(await screen.findByText('No usage recorded', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('No audit events', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('No permission decisions', { exact: true })).toBeInTheDocument();
  });

  it('shows one plain error and retries the failed projection without partial masking', async () => {
    const user = userEvent.setup();
    const listWorkspaceAuditEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error('workspace-audit-private failure'))
      .mockResolvedValue(WORKSPACE_AUDIT_EVENTS);
    const client = makeClient({ app: { listWorkspaceAuditEvents } });
    renderApp('/settings/usage', client);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load usage and audit/i);
    expect(alert).not.toHaveTextContent('workspace-audit-private failure');
    expect(screen.queryByText('chat_completions', { exact: true })).not.toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listWorkspaceAuditEvents).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('chat_completions', { exact: true })).toBeInTheDocument();
  });

  it('keeps the selected-Workspace projection visible but marks it stale when disconnected', async () => {
    const client = makeClient({ core: { meta: vi.fn().mockRejectedValue(new Error('down')) } });
    renderApp('/settings/usage', client);

    expect(await screen.findByText('chat_completions', { exact: true })).toBeInTheDocument();
    expect(await screen.findByText('Status may be stale', { exact: true })).toBeInTheDocument();
  });
});

describe('General settings (board 10)', () => {
  it('loads only Workspace-authorized settings and never requests deployment-admin data', async () => {
    const client = makeClient();
    renderApp('/settings', client);
    expect(await screen.findByRole('heading', { level: 1, name: 'General' })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Display name/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Knowledge/i, level: 2 })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Configuration', level: 2 })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Diagnostics', level: 2 })
    ).not.toBeInTheDocument();
    expect(client.runtimeConfig.listFiles).not.toHaveBeenCalled();
    expect(client.app.getDiagnostics).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /Appearance/i })).toHaveAttribute(
      'href',
      '/settings/appearance'
    );
  });

  it('shows a skeleton while workspace settings load', async () => {
    const client = makeClient({
      core: { getWorkspace: vi.fn().mockReturnValue(new Promise(() => {})) },
    });
    renderApp('/settings', client);
    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
  });

  it('shows an error banner with retry when settings fail to load', async () => {
    const user = userEvent.setup();
    const getWorkspace = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(WORKSPACE);
    const client = makeClient({ core: { getWorkspace } });
    renderApp('/settings', client);
    expect(await screen.findByText(/Couldn't load settings/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(2));
  });

  it('saves the workspace display name', async () => {
    const user = userEvent.setup();
    const updateWorkspace = vi.fn().mockResolvedValue({ ...WORKSPACE, name: 'Team workspace' });
    const client = makeClient({ core: { updateWorkspace } });
    renderApp('/settings', client);

    const nameField = await screen.findByLabelText(/Display name/i);
    await user.clear(nameField);
    await user.type(nameField, 'Team workspace');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateWorkspace).toHaveBeenCalledWith(
        'ws1',
        expect.objectContaining({ name: 'Team workspace' })
      )
    );
  });

  it('disables Save when disconnected', async () => {
    const client = makeClient({
      core: {
        meta: vi.fn().mockRejectedValue(new Error('down')),
        getWorkspace: vi.fn().mockResolvedValue(WORKSPACE),
      },
    });
    renderApp('/settings', client);
    expect(await screen.findByLabelText(/Display name/i)).toBeInTheDocument();
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
      },
      { timeout: 3000 }
    );
  });

  it('exposes page landmarks and section headings for a11y', async () => {
    renderApp('/settings', makeClient());
    expect(await screen.findByRole('heading', { level: 1, name: 'General' })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Display name/i)).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});

describe('AI interface (board 20)', () => {
  it('renders the fixed provider inventory, provider-scoped slots, and quota posture', async () => {
    const listProviders = vi.fn().mockResolvedValue(PROVIDERS);
    const listAccounts = vi.fn().mockImplementation((providerId: string) =>
      Promise.resolve({
        accounts: providerId === 'openai-codex' ? [CODEX_ACCOUNT] : [XAI_ACCOUNT],
      })
    );
    const getAccountQuota = vi
      .fn()
      .mockImplementation((providerId: string) =>
        Promise.resolve(providerId === 'openai-codex' ? CODEX_QUOTA : XAI_QUOTA)
      );
    const client = makeClient({
      providerSubscriptions: { listProviders, listAccounts, getAccountQuota },
    });

    renderApp(
      '/settings/ai-interface',
      client,
      <main>
        <AiInterfaceScreen />
      </main>
    );

    const codexProvider = await screen.findByText('OpenAI Codex');
    const xaiProvider = screen.getByText('xAI');
    expect(
      codexProvider.compareDocumentPosition(xaiProvider) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getByText('Codex primary')).toBeInTheDocument();
    expect(screen.getByText('xAI primary')).toBeInTheDocument();
    expect(screen.getByText('60% remaining')).toBeInTheDocument();
    expect(screen.getByText('Quota unsupported')).toBeInTheDocument();

    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(listAccounts).toHaveBeenCalledTimes(2);
    expect(listAccounts).toHaveBeenCalledWith('openai-codex');
    expect(listAccounts).toHaveBeenCalledWith('xai');
    expect(getAccountQuota).toHaveBeenCalledTimes(2);
    expect(getAccountQuota).toHaveBeenCalledWith('openai-codex', 'primary');
    expect(getAccountQuota).toHaveBeenCalledWith('xai', 'primary');
    for (const mutation of [
      client.providerSubscriptions.createAccount,
      client.providerSubscriptions.updateAccount,
      client.providerSubscriptions.deleteAccount,
      client.providerSubscriptions.startAccountLogin,
      client.providerSubscriptions.cancelAccountLogin,
      client.providerSubscriptions.logoutAccount,
    ]) {
      expect(mutation).not.toHaveBeenCalled();
    }
    expect(
      within(screen.getByRole('main'))
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Refresh status']);
    expect(within(screen.getByRole('main')).queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders all five provider-neutral account lifecycle states', async () => {
    const listAccounts = vi
      .fn()
      .mockImplementation((providerId: string) =>
        Promise.resolve({ accounts: providerId === 'openai-codex' ? LIFECYCLE_ACCOUNTS : [] })
      );
    const getAccountQuota = vi
      .fn()
      .mockImplementation((_providerId: string, accountSlotId: string) =>
        Promise.resolve({ ...CODEX_QUOTA, accountSlotId })
      );
    renderApp(
      '/settings/ai-interface',
      makeClient({ providerSubscriptions: { listAccounts, getAccountQuota } }),
      <main>
        <AiInterfaceScreen />
      </main>
    );

    expect(await screen.findByText('Logged out account')).toBeInTheDocument();
    for (const label of [
      'Not connected',
      'Connecting',
      'Connected',
      'Unavailable',
      'Needs attention',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('renders Codex quota as temporarily unavailable without changing account status', async () => {
    const getAccountQuota = vi.fn().mockImplementation((providerId: string) =>
      Promise.resolve(
        providerId === 'openai-codex'
          ? {
              subscriptionProviderId: 'openai-codex',
              accountSlotId: 'primary',
              availability: 'temporarily_unavailable',
              observedAt: TIMESTAMP,
            }
          : XAI_QUOTA
      )
    );
    renderApp(
      '/settings/ai-interface',
      makeClient({ providerSubscriptions: { getAccountQuota } }),
      <main>
        <AiInterfaceScreen />
      </main>
    );
    expect(await screen.findByText('Quota temporarily unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('Connected')).toHaveLength(2);
  });

  it('shows control-channel and Skills status sections', async () => {
    renderApp(
      '/settings/ai-interface',
      makeClient(),
      <main>
        <AiInterfaceScreen />
      </main>
    );
    expect(
      await screen.findByRole('heading', { name: /Control channel/i, level: 2 })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Skills', level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/0\.4\.0/)).toBeInTheDocument();
    expect(screen.getAllByText(/Healthy|Reachable/i).length).toBeGreaterThan(0);
  });

  it('never renders credential or provider-private values from poisoned payloads', async () => {
    const poisonedAccount = {
      ...CODEX_ACCOUNT,
      accessToken: POISON_SECRET,
      vaultReferenceId: 'vault-reference-should-never-render',
      rawProviderAccountId: 'raw-provider-id-should-never-render',
      accountLabel: `team ${POISON_SECRET}`,
      message: `credential ${POISON_SECRET}`,
      displayName: 'Poisoned app',
    };
    const client = makeClient({
      providerSubscriptions: {
        listAccounts: vi
          .fn()
          .mockImplementation((providerId: string) =>
            Promise.resolve({ accounts: providerId === 'openai-codex' ? [poisonedAccount] : [] })
          ),
        getAccountQuota: vi.fn().mockImplementation((providerId: string) =>
          Promise.resolve(
            providerId === 'openai-codex'
              ? {
                  ...CODEX_QUOTA,
                  planType: POISON_SECRET,
                  rawQuotaResponse: 'raw-quota-should-never-render',
                }
              : XAI_QUOTA
          )
        ),
      },
    });
    renderApp(
      '/settings/ai-interface',
      client,
      <main>
        <AiInterfaceScreen />
      </main>
    );
    expect(await screen.findByText('Poisoned app')).toBeInTheDocument();
    const rendered = document.body.textContent ?? '';
    expect(rendered).not.toContain(POISON_SECRET);
    expect(rendered).not.toContain('vault-reference-should-never-render');
    expect(rendered).not.toContain('raw-provider-id-should-never-render');
    expect(rendered).not.toContain('raw-quota-should-never-render');
  });

  it('re-runs the provider-neutral query after an error retry', async () => {
    const user = userEvent.setup();
    const listProviders = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(PROVIDERS);
    const client = makeClient({ providerSubscriptions: { listProviders } });
    renderApp(
      '/settings/ai-interface',
      client,
      <main>
        <AiInterfaceScreen />
      </main>
    );
    expect(await screen.findByText(/Couldn't load AI interface/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listProviders).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('OpenAI Codex')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load AI interface/i)).not.toBeInTheDocument();
    expect(screen.getByText('Codex primary')).toBeInTheDocument();
    expect(screen.getByText('xAI primary')).toBeInTheDocument();
    expect(screen.getByText('60% remaining')).toBeInTheDocument();
    expect(screen.getByText('Quota unsupported')).toBeInTheDocument();
  });

  it('disables reconnect actions when disconnected', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
    });
    renderApp(
      '/settings/ai-interface',
      client,
      <main>
        <AiInterfaceScreen />
      </main>
    );
    expect(await screen.findByRole('heading', { name: 'AI interface' })).toBeInTheDocument();
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: /Refresh status/i })).toBeDisabled();
      },
      { timeout: 3000 }
    );
  });

  it('exposes landmarks and headings for a11y', async () => {
    renderApp(
      '/settings/ai-interface',
      makeClient(),
      <main>
        <AiInterfaceScreen />
      </main>
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'AI interface' })
    ).toBeInTheDocument();
    expect(await screen.findByText('Codex primary')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
