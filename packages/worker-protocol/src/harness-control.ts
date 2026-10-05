import { GitFailureExplanationReaderSchema, GitFailureExplanationSchema } from '@openkit/protocol';
import { z } from 'zod';
import { NativeEnvironmentValuesSchema } from './native-environment.js';

/**
 * Private Harness control vocabulary owned by `docs/specs/20260703-worker_control_protocol.md` (section Harness Control Operations). Exact producer assertions and descriptive readers share the known field definitions; effect-bearing command bodies remain exact.
 */

/** Value-free pre-native startup diagnostics carried by a private Harness refusal. */
export const WorkerStartupFailureSchema = z
  .object({
    explanation: GitFailureExplanationSchema.optional(),
    stage: z.enum([
      'package_validation',
      'runtime_supply',
      'workspace_materialization',
      'adapter_prepare',
      'integration_ready',
      'worker_control_ready',
      'native_spawn',
    ]),
    reason: z.enum([
      'failed',
      'missing_file',
      'permission_denied',
      'invalid_json',
      'retained_baseline_unavailable',
      'retained_baseline_conflict',
      'retained_source_unavailable',
      'retained_source_conflict',
      'git_init_failed',
      'git_fetch_failed',
      'git_fetch_commit_unavailable',
      'git_fetch_tls_failed',
      'git_fetch_http_refused',
      'git_fetch_transport_failed',
      'git_checkout_failed',
      'control_timeout',
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.explanation &&
      (value.stage !== value.explanation.stage || value.reason !== value.explanation.code)
    ) {
      context.addIssue({ code: 'custom', message: 'Startup failure and explanation must agree.' });
    }
    if (value.reason === 'git_fetch_http_refused' && !value.explanation) {
      context.addIssue({
        code: 'custom',
        message: 'HTTP refusal requires a normalized observation.',
      });
    }
  });

/** Closed startup failure metadata; arbitrary exception text is never transport data. */
export type WorkerStartupFailure = z.infer<typeof WorkerStartupFailureSchema>;

/** The six fixed private Harness operation literals. */
export const HarnessOperationSchema = z.enum([
  'session.open',
  'session.inspect',
  'turn.start',
  'turn.interrupt',
  'session.close',
  'harness.drain',
]);

/** One fixed private Harness operation. */
export type HarnessOperation = z.infer<typeof HarnessOperationSchema>;

/** Bounded opaque protocol identity without control separators. */
export const HarnessIdentitySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\0\r\n]+$/);

/** Lowercase SHA-256 hex digest used by operation ids, handle digests, and compatibility keys. */
export const HarnessSha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** A 43-character unpadded base64url encoding of 32 CSPRNG bytes. */
export const HarnessRouteCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Resume pair recorded for the predecessor AgentSession: its id and its accepted handle digest. */
export const HarnessResumeSchema = z
  .object({ digest: HarnessSha256HexSchema, locator: HarnessIdentitySchema })
  .strict();

/** Resume pair carried by `session.open`. */
export type HarnessResume = z.infer<typeof HarnessResumeSchema>;

/**
 * Session-static private Vault runtime environment delivered only with `session.open`.
 * Names and bounds follow Session-Static Vault Runtime Environment in the NanoHost owner.
 */
export const HarnessRuntimeEnvironmentSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z
      .string()
      .min(1)
      .regex(/^[^\0]*$/)
      .refine((value) => Buffer.byteLength(value) <= 64 * 1024)
  )
  .refine((value) => Object.keys(value).length <= 128);

const AgentSessionSelectorShape = {
  agentSessionId: HarnessIdentitySchema,
  agentSessionRuntimeBindingId: HarnessIdentitySchema,
};

/** `session.open` fields NanoCore queues; the two loopback credentials are minted at dispatch. */
const HarnessSessionOpenQueuedBodyCoreSchema = z
  .object({
    ...AgentSessionSelectorShape,
    adapterId: HarnessIdentitySchema,
    nativeEnvironment: NativeEnvironmentValuesSchema.optional(),
    agentSessionCompatibilityKey: HarnessSha256HexSchema,
    effectiveSetupGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    resume: HarnessResumeSchema.nullable(),
    threadId: HarnessIdentitySchema,
    workspaceId: HarnessIdentitySchema,
  })
  .strict();

/** `turn.start` fields NanoCore queues; the three upstream route tokens are minted at dispatch. */
const HarnessTurnStartQueuedBodyCoreSchema = z
  .object({
    ...AgentSessionSelectorShape,
    aepRef: HarnessIdentitySchema,
    contextPackageId: HarnessIdentitySchema,
    contextRef: HarnessIdentitySchema,
    deadline: HarnessIdentitySchema.refine((value) => !Number.isNaN(Date.parse(value))),
    leaseId: HarnessIdentitySchema,
    packageSnapshotId: HarnessIdentitySchema,
    threadId: HarnessIdentitySchema,
    turnId: HarnessIdentitySchema,
    turnSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    workspaceId: HarnessIdentitySchema,
  })
  .strict();

/** Exact `session.open` wire body delivered in the live dispatch response. */
const HarnessSessionOpenBodyCoreSchema = HarnessSessionOpenQueuedBodyCoreSchema.extend({
  capabilityLoopbackCredential: HarnessRouteCredentialSchema,
  inferenceLoopbackCredential: HarnessRouteCredentialSchema,
  runtimeEnvironment: HarnessRuntimeEnvironmentSchema.optional(),
})
  .strict()
  .refine((body) => body.capabilityLoopbackCredential !== body.inferenceLoopbackCredential, {
    message: 'Session loopback credentials must be distinct.',
  });

/** Exact `turn.start` wire body delivered in the live dispatch response. */
const HarnessTurnStartBodyCoreSchema = HarnessTurnStartQueuedBodyCoreSchema.extend({
  capabilityToken: HarnessRouteCredentialSchema,
  inferenceToken: HarnessRouteCredentialSchema,
  workerControlToken: HarnessRouteCredentialSchema,
})
  .strict()
  .refine(
    (body) =>
      new Set([body.capabilityToken, body.inferenceToken, body.workerControlToken]).size === 3,
    { message: 'Turn route tokens must be distinct.' }
  );

/** Exact `session.inspect` and `session.close` body. */
const HarnessSessionSelectorBodyCoreSchema = z.object(AgentSessionSelectorShape).strict();

/** Exact `turn.interrupt` body; the purpose is never inferred and has one value. */
const HarnessTurnInterruptBodyCoreSchema = z
  .object({
    ...AgentSessionSelectorShape,
    leaseId: HarnessIdentitySchema,
    purpose: z.literal('interrupt'),
    turnId: HarnessIdentitySchema,
  })
  .strict();

/** Exact `harness.drain` body. */
const HarnessDrainBodyCoreSchema = z.object({}).strict();

/** Exact queued session-open instruction. */
export const HarnessSessionOpenQueuedBodySchema = HarnessSessionOpenQueuedBodyCoreSchema;
/** Exact queued Turn-start instruction. */
export const HarnessTurnStartQueuedBodySchema = HarnessTurnStartQueuedBodyCoreSchema;
/** Exact AgentSession selector instruction. */
export const HarnessSessionSelectorBodySchema = HarnessSessionSelectorBodyCoreSchema;
/** Exact Turn interruption instruction. */
export const HarnessTurnInterruptBodySchema = HarnessTurnInterruptBodyCoreSchema;
/** Exact drain instruction. */
export const HarnessDrainBodySchema = HarnessDrainBodyCoreSchema;
/** Exact live session-open instruction, including its two credentials. */
export const HarnessSessionOpenBodySchema = HarnessSessionOpenBodyCoreSchema;
/** Exact live Turn-start instruction, including its three credentials. */
export const HarnessTurnStartBodySchema = HarnessTurnStartBodyCoreSchema;

/** Parsed `session.open` wire body. */
export type HarnessSessionOpenBody = z.infer<typeof HarnessSessionOpenBodySchema>;
/** Parsed `turn.start` wire body. */
export type HarnessTurnStartBody = z.infer<typeof HarnessTurnStartBodySchema>;
/** Parsed `session.inspect` or `session.close` body. */
export type HarnessSessionSelectorBody = z.infer<typeof HarnessSessionSelectorBodySchema>;
/** Parsed `turn.interrupt` body. */
export type HarnessTurnInterruptBody = z.infer<typeof HarnessTurnInterruptBodySchema>;

/** Closed wire command-body schema for each operation. */
export const HarnessCommandBodySchemas = {
  'harness.drain': HarnessDrainBodySchema,
  'session.close': HarnessSessionSelectorBodySchema,
  'session.inspect': HarnessSessionSelectorBodySchema,
  'session.open': HarnessSessionOpenBodySchema,
  'turn.interrupt': HarnessTurnInterruptBodySchema,
  'turn.start': HarnessTurnStartBodySchema,
} as const satisfies Record<HarnessOperation, z.ZodType>;

/** Closed queued command-body schema for each operation; secrets are absent until dispatch. */
export const HarnessQueuedCommandBodySchemas = {
  ...HarnessCommandBodySchemas,
  'session.open': HarnessSessionOpenQueuedBodySchema,
  'turn.start': HarnessTurnStartQueuedBodySchema,
} as const satisfies Record<HarnessOperation, z.ZodType>;

/** Exact private command envelope returned by the pull route. */
export const HarnessCommandEnvelopeSchema = z
  .object({
    body: z.record(z.string(), z.unknown()),
    harnessInstanceId: HarnessIdentitySchema,
    operation: HarnessOperationSchema,
    operationId: HarnessSha256HexSchema,
    schemaVersion: z.literal(2),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** One private Harness command. */
export type HarnessCommandEnvelope = z.infer<typeof HarnessCommandEnvelopeSchema>;

/** Closed refusal reason vocabulary. */
export const HarnessRefusalReasonSchema = z.enum([
  'missing',
  'stale',
  'conflict',
  'unsupported',
  'busy',
  'dependency_failed',
  'cleanup_required',
]);

/** One refusal reason. */
export type HarnessRefusalReason = z.infer<typeof HarnessRefusalReasonSchema>;

/**
 * Refusal body. `startupFailure` is the value-free pre-native stage and reason that a dependency-failed `turn.start` or workspace-materialization `session.open` refusal may carry.
 */
export const HarnessRefusedBodySchema = z
  .object({
    reasonCode: HarnessRefusalReasonSchema,
    startupFailure: WorkerStartupFailureSchema.optional(),
  })
  .strict();

/** Exact unknown-outcome body. */
export const HarnessUnknownBodySchema = z
  .object({ reasonCode: z.literal('outcome_unknown') })
  .strict();

const NativeHandleShape = {
  nativeHandleDigest: HarnessSha256HexSchema.nullable(),
};

/** Requires a digest exactly when the handle is ready. */
function readyHasDigest(body: {
  readonly nativeHandleDigest: string | null;
  readonly nativeHandleState: string;
}): boolean {
  return (body.nativeHandleState === 'ready') === (body.nativeHandleDigest !== null);
}

const ChildStateSchema = z.enum(['absent', 'running', 'stopping', 'unknown']);

/** Sandbox Git client's new-checkout evidence; retained slots never establish another baseline. */
export const WorkspaceGitBaselineSchema = z
  .object({
    commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    tree: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  })
  .strict();

/** Closed success-body schema for each operation. */
export const HarnessSuccessBodySchemas = {
  'harness.drain': z
    .object({
      activeTurns: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      openSessions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      state: z.literal('draining'),
    })
    .strict(),
  'session.close': z
    .object({
      childState: ChildStateSchema.optional(),
      privateState: z.literal('absent'),
      state: z.literal('closed'),
    })
    .strict(),
  'session.inspect': z
    .object({
      ...NativeHandleShape,
      childState: ChildStateSchema,
      cleanupState: z.enum(['clean', 'pending', 'unknown']),
      nativeHandleState: z.enum(['pending', 'ready', 'absent', 'unknown']),
      state: z.enum(['open', 'active', 'closing', 'closed', 'failed']),
    })
    .strict()
    .refine(readyHasDigest),
  'session.open': z
    .object({
      ...NativeHandleShape,
      workspaceGitBaseline: WorkspaceGitBaselineSchema.optional(),
      maxActiveTurns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      nativeHandleState: z.enum(['pending', 'ready']),
      state: z.literal('open'),
    })
    .strict()
    .refine(readyHasDigest),
  'turn.interrupt': z
    .object({ childState: ChildStateSchema.optional(), state: z.literal('interrupted') })
    .strict(),
  'turn.start': z
    .object({
      ...NativeHandleShape,
      nativeHandleState: z.enum(['pending', 'ready']),
      state: z.literal('started'),
    })
    .strict()
    .refine(readyHasDigest),
} as const satisfies Record<HarnessOperation, z.ZodType>;

/** Exact result envelope posted by Sandbox Integration. */
export const HarnessResultEnvelopeSchema = z
  .object({
    body: z.record(z.string(), z.unknown()),
    disposition: z.enum(['succeeded', 'refused', 'unknown']),
    harnessInstanceId: HarnessIdentitySchema,
    operationId: HarnessSha256HexSchema,
    schemaVersion: z.literal(2),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** One private Harness result. */
export type HarnessResultEnvelope = z.infer<typeof HarnessResultEnvelopeSchema>;

/**
 * Validates one result body against the operation it settles.
 *
 * @param operation The dispatched operation the result settles.
 * @param result The already envelope-validated result.
 * @returns Whether the body is exact for that operation and disposition.
 */
export function isHarnessResultBodyValid(
  operation: HarnessOperation,
  result: Pick<HarnessResultEnvelope, 'body' | 'disposition'>
): boolean {
  if (result.disposition === 'unknown') {
    return HarnessUnknownBodySchema.safeParse(result.body).success;
  }
  if (result.disposition === 'refused') {
    const refused = HarnessRefusedBodySchema.safeParse(result.body);
    return (
      refused.success &&
      (refused.data.startupFailure === undefined ||
        (refused.data.reasonCode === 'dependency_failed' &&
          (operation === 'turn.start' ||
            (operation === 'session.open' &&
              refused.data.startupFailure.stage === 'workspace_materialization'))))
    );
  }
  return HarnessSuccessBodySchemas[operation].safeParse(result.body).success;
}

/** Reads the descriptive command envelope; its effect-bearing body stays exact. */
export const HarnessCommandEnvelopeReaderSchema = HarnessCommandEnvelopeSchema.strip();

/** Reads normalized startup diagnostics, preserving all closed cross-field constraints. */
export const WorkerStartupFailureReaderSchema = WorkerStartupFailureSchema.safeExtend({
  explanation: GitFailureExplanationReaderSchema.optional(),
}).strip();

const HarnessRefusedBodyReaderSchema = HarnessRefusedBodySchema.extend({
  startupFailure: WorkerStartupFailureReaderSchema.optional(),
}).strip();
const HarnessUnknownBodyReaderSchema = HarnessUnknownBodySchema.strip();
const HarnessSuccessBodyReaderSchemas = {
  'harness.drain': HarnessSuccessBodySchemas['harness.drain'].strip(),
  'session.close': HarnessSuccessBodySchemas['session.close'].strip(),
  'session.inspect': HarnessSuccessBodySchemas['session.inspect'].strip(),
  'session.open': HarnessSuccessBodySchemas['session.open']
    .safeExtend({
      workspaceGitBaseline: WorkspaceGitBaselineSchema.strip().optional(),
    })
    .strip(),
  'turn.interrupt': HarnessSuccessBodySchemas['turn.interrupt'].strip(),
  'turn.start': HarnessSuccessBodySchemas['turn.start'].strip(),
} as const;

/**
 * Reads the known result body for its dispatched operation before identity or use.
 *
 * @param operation Exact operation selected by the durable command owner.
 * @param result Envelope-validated result.
 * @returns Only the admitted descriptive core.
 * @throws When required fields, closed values or operation-specific diagnostics disagree.
 */
export function parseHarnessResultBody(
  operation: HarnessOperation,
  result: Pick<HarnessResultEnvelope, 'body' | 'disposition'>
): Record<string, unknown> {
  if (result.body.startupFailure !== undefined && result.disposition !== 'refused')
    throw new Error('Harness startup failure requires a dependency refusal.');
  if (result.disposition === 'unknown') return HarnessUnknownBodyReaderSchema.parse(result.body);
  if (result.disposition === 'refused') {
    const body = HarnessRefusedBodyReaderSchema.parse(result.body);
    if (
      body.startupFailure !== undefined &&
      (body.reasonCode !== 'dependency_failed' ||
        (operation !== 'turn.start' &&
          (operation !== 'session.open' ||
            body.startupFailure.stage !== 'workspace_materialization')))
    ) {
      throw new Error('Harness startup failure is invalid for this operation.');
    }
    return body;
  }
  return HarnessSuccessBodyReaderSchemas[operation].parse(result.body);
}

/** Reads the descriptive result envelope; the durable operation selects its body reader. */
export const HarnessResultEnvelopeReaderSchema = HarnessResultEnvelopeSchema.strip();
