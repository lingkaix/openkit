import { MetaResponseSchema, StopReasonSchema } from '@openkit/protocol';
import { z } from 'zod';
import { CodexOAuthAccountsPayloadSchema } from './oauth.js';
import { addRawSecretIssues } from './raw-secrets.js';
import { RuntimeConfigStatusSchema } from './runtime-config.js';

const GatewayCapabilitiesSchema = z
  .object({
    chatCompletions: z.enum(['native', 'bridged', 'unsupported']),
    responses: z.enum(['native', 'bridged', 'unsupported']),
  })
  .strict();

const ProviderDiagnosticStatusSchema = z.enum([
  'ready',
  'degraded',
  'blocked',
  'disabled',
  'unknown',
]);

/** Provider diagnostic row returned by App Diagnostics. */
export const ProviderDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    profileId: z.string().min(1).optional(),
    source: z.string().min(1),
    status: ProviderDiagnosticStatusSchema,
  })
  .strict();

/** Provider registry row returned by App Diagnostics. */
export const ProviderRegistryEntrySchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    kind: z.string().min(1),
    gatewayCapabilities: GatewayCapabilitiesSchema,
    models: z.array(z.string().min(1)),
    baseUrl: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    readiness: z
      .object({
        status: z.string().min(1),
        message: z.string().nullable().optional(),
        checkedAt: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Strict provider diagnostics response shape returned by NanoCore. */
export const ProvidersDiagnosticsSchema = z
  .object({
    diagnostics: z.array(ProviderDiagnosticSchema),
    registry: z.array(ProviderRegistryEntrySchema),
  })
  .strict();

/** Gateway usage summary returned by App Diagnostics. */
export const GatewayUsageSummarySchema = z
  .object({
    cachedInputTokens: z.number(),
    cacheHitRate: z.number(),
    completionTokens: z.number(),
    endpoint: z.enum(['chat_completions', 'responses', 'quick_chat']),
    inputTokens: z.number(),
    lastObservedAt: z.string().min(1),
    model: z.string().min(1),
    providerId: z.string().min(1),
    requestCount: z.number(),
    totalTokens: z.number(),
  })
  .strict();

/** Gateway usage snapshot returned by App Diagnostics. */
export const GatewayUsageSnapshotSchema = z
  .object({
    summaries: z.array(GatewayUsageSummarySchema),
  })
  .strict();

const DefaultProviderOriginSchema = z.literal('canonical');

/** Role-scoped default provider diagnostic. */
export const RoleDefaultProviderDiagnosticsSchema = z.union([
  z
    .object({
      configured: z.literal(true),
      model: z.string().nullable(),
      origin: DefaultProviderOriginSchema,
      providerId: z.string().min(1),
      reason: z.never().optional(),
    })
    .strict(),
  z
    .object({
      configured: z.literal(false),
      origin: z.literal('unset'),
      providerId: z.never().optional(),
      reason: z.literal('unset'),
    })
    .strict(),
  z
    .object({
      configured: z.literal(false),
      model: z.string().nullable(),
      origin: DefaultProviderOriginSchema,
      providerId: z.string().min(1),
      reason: z.enum(['unknown-id', 'credentials-missing']),
    })
    .strict(),
]);

/** Role-scoped default provider diagnostics. */
export const DefaultProvidersDiagnosticsSchema = z.object({
  core: RoleDefaultProviderDiagnosticsSchema,
  gateway: RoleDefaultProviderDiagnosticsSchema,
});

/** Secret marker safe for setup diagnostics. */
export const SetupSecretMarkerSchema = z.object({
  configured: z.boolean(),
  marker: z.enum(['none', 'redacted', 'secret-ref']),
  ref: z.string().nullable(),
});

/** Setup diagnostics response schema for /api/setup/diagnostics. */
export const SetupDiagnosticsResponseSchema = z
  .object({
    service: z.literal('nanocore'),
    server: z.object({
      mode: z.enum(['local', 'server']),
      dataRoot: z.literal('configured').nullable(),
      config: z.object({
        schemaVersion: z.number().nullable(),
        defaults: z.object({
          coreProviderId: z.string().nullable(),
          gatewayProviderId: z.string().nullable(),
        }),
        gateway: z.object({
          openaiCompatible: z.object({
            enabled: z.boolean().nullable(),
          }),
        }),
      }),
    }),
    providers: z.array(
      z.object({
        id: z.string().min(1),
        displayName: z.string().min(1),
        kind: z.string().min(1),
        vendor: z.string().min(1),
        role: z.enum(['core', 'gateway', 'core+gateway', 'available']),
        defaultModel: z.string().nullable(),
        secret: SetupSecretMarkerSchema,
      })
    ),
    agents: z.array(
      z.object({
        id: z.string().min(1),
        displayName: z.string().min(1),
        readiness: z.object({
          status: z.enum(['ready', 'degraded', 'blocked', 'disabled']),
          reasons: z.array(z.string()),
        }),
        setup: z.object({
          status: z.enum(['ready', 'degraded', 'blocked', 'disabled']),
          deploymentMode: z.string().nullable(),
          providerId: z.string().nullable(),
          diagnostics: z.array(
            z.object({
              code: z.string().min(1),
              message: z.string().min(1),
              severity: z.string().min(1),
              agentId: z.string().min(1),
            })
          ),
        }),
      })
    ),
    runtimeConfig: RuntimeConfigStatusSchema,
  })
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Internal agent mode exposed through App Diagnostics. */
export const InternalAgentModeSchema = z.enum([
  'chat',
  'automation',
  'plan',
  'review',
  'organize',
  'delegation',
]);

/** Internal Core tool exposed through App Diagnostics. */
export const InternalCoreToolSchema = z.enum([
  'readWorkspaceSummary',
  'readThreadSummary',
  'readAgentReadiness',
  'searchWorkspaceItems',
  'searchKnowledge',
  'webSearch',
  'fetchPageText',
  'draftWorkerDelegation',
  'proposeKnowledgeEntry',
  'summarizeArtifacts',
]);

/** Internal agent provider diagnostics. */
export const InternalAgentProviderDiagnosticSchema = z.union([
  z.object({
    configured: z.literal(true),
    model: z.string().min(1),
    providerId: z.string().min(1),
    reason: z.never().optional(),
  }),
  z.object({
    configured: z.literal(false),
    model: z.never().optional(),
    providerId: z.string().min(1).optional(),
    reason: z.enum(['provider-missing', 'model-missing']),
  }),
]);

/** Internal agent diagnostics. */
export const InternalAgentDiagnosticsSchema = z.object({
  agents: z.array(
    z.object({
      allowedTools: z.array(InternalCoreToolSchema),
      defaultProviderUse: z.enum(['quickChat', 'internalTasks']),
      displayName: z.string().min(1),
      id: z.string().min(1),
      provider: InternalAgentProviderDiagnosticSchema,
      supportedModes: z.array(InternalAgentModeSchema),
    })
  ),
  recentFailures: z.array(
    z.object({
      agentId: z.string().min(1),
      code: z.string().min(1),
      details: z.unknown(),
      message: z.string(),
      occurredAt: z.string(),
      status: z.enum(['completed', 'error', 'aborted']),
      stopReason: StopReasonSchema,
    })
  ),
  recentHookFailures: z.array(
    z.object({
      eventType: z.enum([
        'agent_start',
        'turn_start',
        'message_start',
        'message_update',
        'message_end',
        'turn_end',
        'agent_end',
      ]),
      hookId: z.string().min(1),
      message: z.string(),
      mode: z.enum(['observational', 'critical']),
    })
  ),
});

const BootReadinessStateSchema = z.enum(['ready', 'degraded', 'failed']);

/** Machine-readable reason for one boot readiness subsystem state. */
export const BootReadinessReasonSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    blocks: z.array(z.string().min(1)),
  })
  .strict();

/** Boot readiness state for one NanoCore subsystem. */
export const BootSubsystemReadinessSchema = z
  .object({
    state: BootReadinessStateSchema,
    reasons: z.array(BootReadinessReasonSchema),
  })
  .strict();

/** Boot readiness projection returned by App Diagnostics. */
export const BootReadinessSnapshotSchema = z
  .object({
    bootId: z.string().min(1),
    acceptingProductWork: z.boolean(),
    overall: BootReadinessStateSchema,
    subsystems: z
      .object({
        config: BootSubsystemReadinessSchema,
        storage: BootSubsystemReadinessSchema,
        policy: BootSubsystemReadinessSchema,
        vault: BootSubsystemReadinessSchema,
        scheduler: BootSubsystemReadinessSchema,
        llmGateway: BootSubsystemReadinessSchema,
        knowledgeIndex: BootSubsystemReadinessSchema,
      })
      .strict(),
  })
  .strict();

/** App-facing diagnostics response schema for /api/app/diagnostics. */
export const AppDiagnosticsResponseSchema = z
  .object({
    service: z.string().min(1),
    boot: BootReadinessSnapshotSchema,
    gateway: z.object({
      status: z.string().min(1),
      endpoints: z.array(z.string().min(1)),
      usage: GatewayUsageSnapshotSchema.optional(),
    }),
    providers: ProvidersDiagnosticsSchema,
    defaultProviders: DefaultProvidersDiagnosticsSchema,
    defaults: z.object({
      quickChat: z.object({ providerId: z.string().nullable(), model: z.string().nullable() }),
      internalTasks: z.object({ providerId: z.string().nullable(), model: z.string().nullable() }),
      gateway: z.object({ providerId: z.string().nullable(), model: z.string().nullable() }),
    }),
    oauth: z
      .object({
        openaiCodexAccounts: CodexOAuthAccountsPayloadSchema,
      })
      .strict(),
    capabilities: MetaResponseSchema.shape.capabilities,
    runtimeConfig: RuntimeConfigStatusSchema,
    internalAgents: InternalAgentDiagnosticsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Provider diagnostic row returned by App Diagnostics. */
export type ProviderDiagnostic = z.infer<typeof ProviderDiagnosticSchema>;
/** Provider registry row returned by App Diagnostics. */
export type ProviderRegistryEntry = z.infer<typeof ProviderRegistryEntrySchema>;
/** Strict provider diagnostics response shape returned by NanoCore. */
export type ProvidersDiagnostics = z.infer<typeof ProvidersDiagnosticsSchema>;
/** Role-scoped default provider diagnostic. */
export type RoleDefaultProviderDiagnostics = z.infer<typeof RoleDefaultProviderDiagnosticsSchema>;
/** Role-scoped default provider diagnostics. */
export type DefaultProvidersDiagnostics = z.infer<typeof DefaultProvidersDiagnosticsSchema>;
/** Setup diagnostics response. */
export type SetupDiagnosticsResponse = z.infer<typeof SetupDiagnosticsResponseSchema>;
/** Boot readiness projection returned by App Diagnostics. */
export type BootReadinessSnapshot = z.infer<typeof BootReadinessSnapshotSchema>;
/** App-facing diagnostics response. */
export type AppDiagnosticsResponse = z.infer<typeof AppDiagnosticsResponseSchema>;
