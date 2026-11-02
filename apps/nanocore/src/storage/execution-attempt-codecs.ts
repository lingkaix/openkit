import {
  AgentSessionIdSchema,
  ExecutionAttemptIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { WorkerLineageSchema } from '@openkit/worker-protocol';
import { z } from 'zod';

/** The existing retained attempt reader also validates its complete native acknowledgement. */
export const SchedulerExecutionAttemptSchema = z.object({
  attemptId: ExecutionAttemptIdSchema,
  queueEntryId: z.string().min(1),
  backendId: z.string().min(1),
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  agentSessionId: AgentSessionIdSchema.nullable(),
  preparationInputJson: z.string(),
  inputRef: z.string().min(1).nullable(),
  bindingRef: z.string().min(1).nullable(),
  phase: z.enum(['open', 'closing', 'closed']),
  disposition: z.enum(['not_accepted', 'accepted', 'unknown']),
  operationId: z.string().min(1).nullable(),
  deadline: z.string().datetime().nullable(),
  terminalCause: z.string().nullable(),
  outcomeRef: z.string().nullable(),
  fenceRef: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const identity = z.string().min(1);
const clock = { observedAt: z.string().optional() };
const attempt = { attemptId: ExecutionAttemptIdSchema, ...clock };
const correlation = z
  .object({
    attemptId: ExecutionAttemptIdSchema,
    backendId: identity,
    bindingRef: identity.nullable(),
    inputRef: identity.nullable(),
    operationId: identity,
  })
  .strict();
/** Closed existing Core attempt tuples; retained preparation bytes are JSON, never executable callbacks. */
export const ControlExecutionAttemptInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('native-preparation'),
      ...attempt,
      agentSessionId: AgentSessionIdSchema,
      inputRef: identity,
      bindingRef: identity,
      sessionCompatibilityKey: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal('native-reconnect-arm'),
      ...attempt,
      classifiedAt: z.string().datetime(),
      expectedRecoveryDeadline: z.string().datetime().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('native-needs-evidence'), ...attempt }).strict(),

  z
    .object({
      kind: z.literal('simulator-final'),
      ...attempt,
      lineage: WorkerLineageSchema,
      acceptedAt: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('create'),
      queueEntryId: identity,
      backendId: identity,
      byteLength: z.number().int().nonnegative().safe(),
      attemptId: ExecutionAttemptIdSchema.optional(),
      ...clock,
    })
    .strict(),
  z
    .object({ kind: z.literal('bind-session'), ...attempt, agentSessionId: AgentSessionIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal('finalize-input'),
      ...attempt,
      inputRef: identity,
      bindingRef: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal('record-operation'),
      ...attempt,
      operationId: identity,
      submission: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('observe'),
      observation: correlation
        .extend({
          disposition: z.enum(['not_accepted', 'accepted', 'unknown']),
          execution: z.enum(['pending', 'running', 'terminal', 'unknown']),
          fenceRef: identity.nullable(),
          outcomeRef: identity.nullable(),
        })
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('closing'),
      ...attempt,
      cause: z.string(),
      outcomeRef: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('close-without-effects'),
      ...attempt,
      noOutstandingEffects: z.literal(true),
      cause: z.string(),
      requeue: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('close-with-fence'),
      correlation,
      proof: z
        .object({
          terminalHandoff: z.boolean(),
          output: z.boolean(),
          evidence: z.boolean(),
          outsideWorkspaceCollection: z.boolean(),
          integrationDrain: z.boolean(),
          routesRevoked: z.boolean(),
        })
        .strict(),
      fenceRef: identity,
      ...clock,
    })
    .strict(),
]);
/** Exact bounded peer input for the existing attempt lifecycle. */
export type ControlExecutionAttemptInput = z.infer<typeof ControlExecutionAttemptInputSchema>;
/** Before existing binary admission, preparation remains one exact caller-owned JSON string. */
export type ControlExecutionAttemptCommand =
  | Exclude<ControlExecutionAttemptInput, { kind: 'create' }>
  | (Omit<Extract<ControlExecutionAttemptInput, { kind: 'create' }>, 'byteLength'> & {
      readonly preparationJson: string;
    });
/** Original observation may be absent; all other transitions return the complete original row. */
export const ControlExecutionAttemptResultSchema = SchedulerExecutionAttemptSchema.nullable();
/** Complete original row or the original absent observation. */
export type ControlExecutionAttemptResult = z.infer<typeof ControlExecutionAttemptResultSchema>;
/** Only fixed messages raised by the existing domain owner cross the trusted refusal channel. */
export class ExecutionAttemptRefusal extends Error {}
/** Private refusal projection carries no SQL, credentials or arbitrary native diagnostic. */
export const ControlExecutionAttemptRefusalSchema = z
  .object({
    operation: z.literal('execution-attempt'),
    code: z.literal('attempt_refused'),
    message: z.string(),
    status: z.literal(409),
  })
  .strict();
