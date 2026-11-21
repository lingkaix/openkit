import { canonicalIdentifierName, deriveEntityId } from '@openkit/protocol';
import type {
  CapabilityAuditLineage,
  FinishCapabilityCallInput,
  RecordUsageInput,
  ServerGatewayCallContext,
  StartedCapabilityCall,
} from '../capability/usage-ledger.js';
import { OperationError } from '../operation-error-core.js';
import { ControlCapabilityCommandInputSchema } from '../storage/control-store-capability.js';
import { presentControlFacts } from '../storage/control-store-input.js';
import {
  admitServerWorkCall,
  type ServerCallSettlement,
  type ServerCallUsage,
} from '../storage/server-work-call.js';
import {
  publishServerWorkDraft,
  type ServerWorkCommandBinding,
  serverWorkBindingAvailable,
  serverWorkIntent,
  serverWorkUnavailable,
} from '../storage/server-work-command.js';
import type { ServerCallAdmission } from '../storage/server-work-port.js';

type RouteLineageInput = Parameters<
  NonNullable<ServerWorkCommandBinding['owner']['writeRouteLineage']>
>[1];

export interface ServerGatewayCallLedger {
  readonly call: StartedCapabilityCall<ServerGatewayCallContext>;
  claimContact(): Promise<void>;
  recordUsage(input: Pick<RecordUsageInput, 'records' | 'now'>): Promise<string[]>;
  finish(
    input: Omit<FinishCapabilityCallInput, 'workspaceDb' | 'callId' | 'serverWorkCall'>
  ): Promise<void>;
  writeRouteLineage(input: RouteLineageInput): Promise<number>;
}

/** Lets streaming headers escape while the original producer still owns terminal publication. */
export async function withServerGatewayResponseProducer(
  binding: Pick<ServerWorkCommandBinding, 'withProducer'> | undefined,
  respond: (retain?: (terminal: Promise<void>) => void) => Promise<Response>
): Promise<Response> {
  if (!binding?.withProducer) return respond();
  const response = Promise.withResolvers<Response>();
  void binding
    .withProducer(async () => {
      let terminal: Promise<void> | undefined;
      const result = await respond((completion) => {
        terminal = completion;
      });
      if (terminal) {
        response.resolve(result);
        await terminal;
      }
      return result;
    })
    .then(response.resolve, response.reject);
  return response.promise;
}

/** Opens the original Server Call through the admitted owner and prepares a one-use transport claim. */
export async function openServerGatewayCall(
  binding: ServerWorkCommandBinding | undefined,
  input: {
    readonly context: ServerGatewayCallContext;
    readonly logicalModelId: string;
    readonly credentialRef?: string | null;
    readonly systemPromptDigest?: string;
    readonly auditLineage?: CapabilityAuditLineage;
    readonly assertAuthority?: () => void | Promise<void>;
  }
): Promise<ServerGatewayCallLedger> {
  const { context } = input;
  const actor = context.authorityActor;
  if (
    !actor ||
    !serverWorkBindingAvailable(binding) ||
    !binding.verifyCallAuthority ||
    !binding.callBudgetRef ||
    !binding.owner.readUsageIds ||
    !binding.owner.writeRouteLineage ||
    !context.requestId ||
    (context.family === 'llm' && context.capabilityId === 'llm.decision')
  )
    throw serverWorkUnavailable();
  const { owner, kernel, verifyCallAuthority, callBudgetRef } = binding;
  const routeRef = input.logicalModelId;
  const credentialRef = input.credentialRef ?? context.authentication?.credentialId ?? null;
  await input.assertAuthority?.();
  const budgetRef = await callBudgetRef({ actor, credentialRef, routeRef });
  const occurrence = canonicalIdentifierName([
    actor,
    context.family,
    context.operation,
    context.requestId,
  ]);
  const callId = deriveEntityId('cap', [binding.deploymentId, occurrence]);
  const draft = ControlCapabilityCommandInputSchema.parse({
    kind: 'server-admit',
    callId,
    context,
    now: new Date().toISOString(),
    ...(input.auditLineage ? { auditLineage: input.auditLineage } : {}),
    ...(input.systemPromptDigest ? { systemPromptDigest: input.systemPromptDigest } : {}),
  });
  if (draft.kind !== 'server-admit') throw serverWorkUnavailable();
  const payload = JSON.stringify(draft);
  const intent: ServerCallAdmission = serverWorkIntent(
    binding,
    'admit-call',
    occurrence,
    null,
    {
      actor,
      credentialRef,
      callId,
      threadId: context.threadId ?? null,
      turnId: context.turnId ?? null,
      routeRef,
      budgetRef,
    },
    payload
  );
  const previous = await owner.readIntent(intent.requestId);
  if (previous.state !== 'ready') throw serverWorkUnavailable();
  if (previous.value)
    throw new OperationError('recovery_required', 'Inspect the original Server Call.', 409);
  const admission = await admitServerWorkCall({
    intent,
    kernel,
    store: {
      stage: (value) => owner.stage(value, payload),
      readLocalReceipt: (key) => owner.readLocalReceipt(key),
      settle: (receipt) => owner.settle(receipt),
      isPublished: (receipt) => owner.isPublished(receipt),
      claimCallContact: (receipt) => owner.claimCallContact(receipt),
    },
    verifyCurrentAuthority: async () => {
      await input.assertAuthority?.();
      return verifyCallAuthority(intent);
    },
  });
  if (admission.state === 'unavailable') throw serverWorkUnavailable();
  if (admission.value.state === 'refused')
    throw new OperationError(
      'server_work_refused',
      'Server Call authority refused the operation.',
      403
    );
  if (admission.value.state !== 'admitted')
    throw new OperationError('recovery_required', 'Inspect the original Server Call.', 409);
  const original = admission.value;
  const call: StartedCapabilityCall<ServerGatewayCallContext> = {
    id: callId,
    inserted: true,
    context: presentControlFacts(draft.context),
  };
  const measurements = new Map<string, { intent: ServerCallUsage; payload: string }>();
  return {
    call,
    async claimContact() {
      const result = await original.claimContact();
      if (result.state !== 'ready' || result.value.state !== 'claimed-now')
        throw serverWorkUnavailable();
    },
    async recordUsage({ records, now }) {
      const ids: string[] = [];
      for (const measurement of records) {
        const key = canonicalIdentifierName([callId, measurement]);
        let command = measurements.get(key);
        if (!command) {
          const body = JSON.stringify(
            ControlCapabilityCommandInputSchema.parse({
              kind: 'server-usage',
              call,
              measurement,
              now: (now ?? new Date()).toISOString(),
              ...(input.auditLineage ? { auditLineage: input.auditLineage } : {}),
            })
          );
          command = {
            payload: body,
            intent: serverWorkIntent(
              binding,
              'settle-usage',
              key,
              null,
              {
                actor,
                credentialRef,
                callId,
              },
              body
            ),
          };
          measurements.set(key, command);
        }
        const receipt = await publishServerWorkDraft(binding, command.intent, command.payload);
        const read = await owner.readUsageIds!(receipt);
        if (read.state !== 'ready' || !read.value) throw serverWorkUnavailable();
        ids.push(...read.value);
      }
      return ids;
    },
    async finish({ now, ...finish }) {
      const body = JSON.stringify(
        ControlCapabilityCommandInputSchema.parse({
          kind: 'server-finish',
          callId,
          finish: { ...finish, now: (now ?? new Date()).toISOString() },
        })
      );
      const terminal: ServerCallSettlement = serverWorkIntent(
        binding,
        'settle-call',
        callId,
        null,
        {
          actor,
          credentialRef,
          callId,
        },
        body
      );
      await publishServerWorkDraft(binding, terminal, body);
    },
    async writeRouteLineage(lineage) {
      const result = await owner.writeRouteLineage!(original.receipt, lineage);
      if (result.state !== 'ready') throw serverWorkUnavailable();
      return result.value;
    },
  };
}
