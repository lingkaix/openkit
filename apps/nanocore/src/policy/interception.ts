import type { PolicyDecision } from '@openkit/policy-kernel';
import {
  allocateEntityId,
  PolicyAgentGateOutputV1Schema,
  type PolicyApprovalBindingV1Schema,
  type PolicyBindingV1,
  type PolicyDecisionV1,
  type PolicyDocumentV1,
  type PolicyInvocationV1,
} from '@openkit/protocol';
import { z } from 'zod';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { PermissionDecisionResult } from '../storage/schema/permission-decisions.js';
import type { GoalTaskAccessResult } from './goal-task-access.js';
import {
  type RecordProductPermissionDecisionInput,
  readPolicyStatementUseCount,
  recordProductPermissionDecision,
} from './permission-decisions.js';
import {
  type PolicyProposal,
  policyDigest,
  policyProposalDigest,
  policyScopeIncludesProposal,
  readPolicyAgentPrincipal,
  selectPolicyBindings,
} from './statements.js';

const GateOutput = z.object({ decision: z.enum(['allow', 'deny', 'escalate']) }).strict();
const AdviceOutput = z.object({ attributes: z.record(z.string(), z.json()) }).strict();
const ObservationOutput = z.object({ observed: z.literal(true) }).strict();
type InvocationReference = PolicyDecisionV1['invocations'][number];

/** One injected deterministic participant; this is not a provider adapter or loader. */
export interface DeterministicPolicyParticipant {
  readonly id: string;
  readonly version: string;
  invoke(input: {
    readonly binding: PolicyBindingV1;
    readonly proposal: PolicyProposal;
    readonly advice: readonly unknown[];
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/** A single bounded native agent runner; optional selectors are useful for isolated transport fakes. */
export interface AgentPolicyParticipant {
  readonly id?: string;
  readonly version?: string;
  invoke: DeterministicPolicyParticipant['invoke'];
}

/** Current owner facts and existing durable owner used by the I16 pilot. */
export interface InterceptionInput {
  readonly workspaceDb: WorkspaceDb;
  readonly document: PolicyDocumentV1;
  readonly proposal: PolicyProposal;
  readonly authorizationRevision: string;
  /** Current finite grants used by the native mandatory Kernel adapter, not participant results. */
  readonly authorizationUses?: RecordProductPermissionDecisionInput['uses'];
  /** Existing catalog condition, pinned by the proposal's catalog revision. */
  readonly requiresHumanApproval?: boolean;
  /** Exact human response context supplied only by the existing captured approval owner. */
  readonly humanApproval?: {
    readonly requestId: string;
    readonly sourceDecisionId: string;
    readonly deciderId: string;
    readonly binding: z.infer<typeof PolicyApprovalBindingV1Schema>;
  };
  readonly authorCurrent: (userId: string) => boolean;
  readonly anchorCurrent: (anchor: PolicyBindingV1['lifetime']['anchor']) => boolean;
  /** Kernel-only participant admission: no bindings or investigative recursion. */
  readonly participantAuthorized: (binding: PolicyBindingV1) => boolean;
  /** A changed Policy, input, current authority or binding invalidates this attempt. */
  readonly stillCurrent: () => boolean;
  /** Actual pure synchronous Kernel evaluation is always last, including after a gate deny. */
  readonly finalKernel: (context: {
    readonly proposal: PolicyProposal;
    readonly advice: readonly unknown[];
  }) => PolicyDecision | GoalTaskAccessResult;
}

/** A final allow is permission to attempt the effect, not an effect result. */
export interface InterceptionDecision {
  readonly result: PermissionDecisionResult;
  readonly decisionId: string;
  readonly proposalDigest: string;
  readonly policyRevision: string;
  readonly authorizationRevision: string;
  /** Present only for the current Goal Task association gap, never a human/participant refusal. */
  readonly escalation?: GoalTaskAccessResult['escalation'];
}

/** Bounded process-local availability state; restart never replays participant work. */
export class PolicyInterception {
  private readonly circuits = new Map<
    string,
    { failures: number; retryAt: number; probing: boolean }
  >();

  constructor(
    private readonly participant?: DeterministicPolicyParticipant,
    private readonly agentParticipant?: AgentPolicyParticipant
  ) {}

  /** Runs the supported pilot modes and retains evidence before releasing a result. */
  async decide(input: InterceptionInput): Promise<InterceptionDecision> {
    if (
      input.document.statements.some(
        (statement) =>
          statement.kind === 'binding' &&
          statement.state !== 'inactive' &&
          (statement.mode === 'advise' || statement.mode === 'transform')
      )
    )
      throw new Error('I16 safe participant output reference is unavailable.');
    const policyRevision = policyDigest(input.document);
    const proposalDigest = policyProposalDigest(input.proposal);
    for (const { statement, limit } of input.authorizationUses ?? []) {
      const current = input.document.statements.find((value) => value.id === statement.id);
      if (
        !current ||
        current.state !== 'active' ||
        policyDigest(current) !== statement.digest ||
        current.lifetime.uses !== limit
      )
        throw new Error('Finite authorization must match the current Policy statement and limit.');
    }
    const bindings = selectPolicyBindings({ ...input, now: Date.now() });
    const invocations: InvocationReference[] = [];
    const advice: unknown[] = [];
    const results: PermissionDecisionResult[] = [];
    const used: PolicyBindingV1[] = [];
    const humanApproved =
      input.humanApproval &&
      input.humanApproval.binding.proposalDigest === proposalDigest &&
      input.humanApproval.binding.policyRevision === policyRevision &&
      input.humanApproval.binding.authorizationRevision === input.authorizationRevision;
    if (input.requiresHumanApproval && !humanApproved) results.push('require_approval');
    for (const mode of ['transform', 'advise', 'gate'] as const) {
      for (const binding of bindings.filter((value) => value.mode === mode)) {
        if (
          binding.lifetime.uses !== undefined &&
          readPolicyStatementUseCount(input.workspaceDb, {
            id: binding.id,
            digest: policyDigest(binding),
          }) >= binding.lifetime.uses
        )
          continue;
        const evaluated = await this.invoke(input, binding, advice, policyRevision, proposalDigest);
        invocations.push(evaluated.reference);
        if (binding.state === 'shadow') continue;
        used.push(binding);
        results.push(
          evaluated.result === 'require_escalation' && humanApproved ? 'allow' : evaluated.result
        );
        if (evaluated.advice)
          advice.push({
            binding: { id: binding.id, digest: policyDigest(binding) },
            ...evaluated.advice,
          });
      }
    }
    let current = false;
    try {
      current = input.stillCurrent();
    } catch {
      /* Missing mandatory facts are an evaluation error. */
    }
    if (!current) results.push('error');
    // Recheck agent authority after participant work and before the final mandatory Kernel.
    // Only active gates decide; shadow failures remain evidence without a veto.
    for (const binding of used.filter((value) => value.participant.kind === 'agent')) {
      try {
        readPolicyAgentPrincipal({ ...input, binding, now: Date.now() });
        if (!input.participantAuthorized(binding))
          throw new Error('Agent disclosure authority changed.');
      } catch {
        results.push('error');
      }
    }
    let kernel: PolicyDecision | null = null;
    let escalation: GoalTaskAccessResult['escalation'];
    try {
      const evaluated = input.finalKernel({ proposal: input.proposal, advice });
      const goal = 'kernel' in evaluated ? evaluated : undefined;
      kernel = 'kernel' in evaluated ? evaluated.kernel : evaluated;
      if (
        kernel.reasons.some(({ code }) =>
          ['invalid-policy', 'invalid-request', 'missing-operation'].includes(code)
        )
      ) {
        results.push('error');
      } else if (goal?.escalation) {
        if (
          !goal.inGoalEnvelope ||
          kernel.effect !== 'deny' ||
          kernel.reasons.length === 0 ||
          kernel.reasons.some(({ code }) => code !== 'missing-privilege') ||
          goal.escalation.workspaceId !== input.proposal.workspaceId
        )
          throw new Error('Goal escalation contradicts the current mandatory Kernel evaluation.');
        // A Task association gap cannot redirect a human-only condition or a
        // participant failure. Keep their existing result and destination.
        if (results.every((value) => value === 'allow' || value === 'not_applicable')) {
          results.push('require_escalation');
          escalation = goal.escalation;
        }
      } else {
        results.push(kernel.effect);
      }
    } catch {
      results.push('error');
    }
    const result = combineResults(results);
    const decisionId = allocateEntityId('pd');
    const consumed =
      result === 'allow'
        ? [
            ...new Map(
              [
                ...(input.authorizationUses ?? []),
                ...used
                  .filter((binding) => binding.lifetime.uses !== undefined)
                  .map((binding) => ({
                    statement: { id: binding.id, digest: policyDigest(binding) },
                    limit: binding.lifetime.uses!,
                  })),
              ].map((value) => [value.statement.id, value])
            ).values(),
          ]
        : [];
    const finalInput = decisionInput(input, policyRevision);
    recordProductPermissionDecision({
      ...finalInput,
      contextSummary: {
        ...finalInput.contextSummary,
        ...(kernel
          ? {
              kernelTrace: {
                matchedAssociations: kernel.trace.matchedAssociations,
                matchedProhibitions: kernel.trace.matchedProhibitions,
              },
            }
          : {}),
      },
      decisionId,
      result,
      ...(result === 'require_approval' ? { requiredApprovalKind: 'permission' } : {}),
      reasonCode:
        result === 'deny'
          ? kernel?.effect === 'allow' || kernel?.reasons.some(({ code }) => code === 'restriction')
            ? 'prohibited'
            : 'not_granted'
          : result === 'require_escalation' || result === 'require_approval'
            ? 'require_approval'
            : result === 'allow'
              ? 'granted'
              : 'evaluation_error',
      mediation: {
        operation: input.proposal.operation,
        stage: 'decide',
        proposalDigest,
        authorizationRevision: input.authorizationRevision,
        subject: input.proposal.subject,
        role: 'final',
        kernel: kernel
          ? { effect: kernel.effect, reason: kernel.reasons[0]?.code ?? 'not_granted' }
          : null,
        invocations,
        consumedStatements: consumed.map(({ statement }) => statement),
      },
      ...(consumed.length
        ? {
            uses: consumed,
          }
        : {}),
    });
    return {
      result,
      decisionId,
      proposalDigest,
      policyRevision,
      authorizationRevision: input.authorizationRevision,
      ...(result === 'require_escalation' && escalation ? { escalation } : {}),
    };
  }

  /** Completed observations cannot change an already settled effect or authorize a retry. */
  async observe(input: InterceptionInput): Promise<void> {
    const bindings = selectPolicyBindings({ ...input, now: Date.now() });
    for (const binding of bindings.filter((value) => value.mode === 'observe'))
      await this.invoke(
        input,
        binding,
        [],
        policyDigest(input.document),
        policyProposalDigest(input.proposal)
      );
  }

  private async invoke(
    input: InterceptionInput,
    binding: PolicyBindingV1,
    advice: readonly unknown[],
    policyRevision: string,
    proposalDigest: string
  ): Promise<{
    reference: InvocationReference;
    result: PermissionDecisionResult;
    advice?: z.infer<typeof AdviceOutput>;
  }> {
    const startedAt = new Date().toISOString();
    const bindingRef = { id: binding.id, digest: policyDigest(binding) };
    const key = bindingRef.digest;
    const circuit = this.circuits.get(key) ?? { failures: 0, retryAt: 0, probing: false };
    let outcome: PolicyInvocationV1['outcome'] = 'unavailable';
    let output: unknown = null;
    let parsedAdvice: z.infer<typeof AdviceOutput> | undefined;
    let result: PermissionDecisionResult =
      binding.failure === 'continue'
        ? 'not_applicable'
        : binding.failure === 'error'
          ? 'error'
          : 'require_escalation';
    let current = false;
    let participantAuthorized = false;
    let authorityError = false;
    let agent: ReturnType<typeof readPolicyAgentPrincipal> | undefined;
    try {
      if (binding.participant.kind === 'agent') {
        if (binding.author.kind !== 'human' || !input.authorCurrent(binding.author.id))
          throw new Error('Current agent activation authority is unavailable.');
        agent = readPolicyAgentPrincipal({ ...input, binding, now: Date.now() });
      }
      current = input.stillCurrent();
      if (current)
        participantAuthorized =
          policyScopeIncludesProposal(binding.inputDisclosure, input.proposal) &&
          input.participantAuthorized(binding);
    } catch {
      authorityError = true;
    }
    const participant =
      binding.participant.kind === 'agent' ? this.agentParticipant : this.participant;
    if (authorityError) {
      outcome = 'error';
      result = 'error';
    } else if (!current) {
      outcome = 'stale';
      result = 'error';
    } else if (!participantAuthorized) outcome = 'unavailable';
    else if (circuit.probing || circuit.retryAt > Date.now()) outcome = 'open-circuit';
    else if (binding.mode === 'transform') {
      // No current I16 content owner can retain a replacement. Activation rejects
      // this mode rather than inventing a completed transform from a digest.
      outcome = 'unavailable';
    } else if (
      participant &&
      (binding.participant.kind === 'agent' ||
        (participant.id === binding.participant.id &&
          participant.version === binding.participant.version)) &&
      (participant.id === undefined || participant.id === binding.participant.id) &&
      (participant.version === undefined || participant.version === binding.participant.version)
    ) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      circuit.probing = circuit.retryAt > 0;
      this.circuits.set(key, circuit);
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ParticipantTimeout());
          }, binding.timeoutMs);
        });
        output = await Promise.race([
          participant.invoke({
            binding: structuredClone(binding),
            proposal: structuredClone(input.proposal),
            advice: structuredClone(advice),
            signal: controller.signal,
          }),
          timeout,
        ]);
        const parsed =
          binding.mode === 'gate'
            ? (binding.participant.kind === 'agent'
                ? PolicyAgentGateOutputV1Schema
                : GateOutput
              ).safeParse(output)
            : binding.mode === 'advise'
              ? AdviceOutput.safeParse(output)
              : ObservationOutput.safeParse(output);
        if (!parsed.success) outcome = 'malformed';
        else if (!input.stillCurrent()) outcome = 'stale';
        else {
          if (binding.participant.kind === 'agent') {
            try {
              agent = readPolicyAgentPrincipal({ ...input, binding, now: Date.now() });
              if (!input.participantAuthorized(binding))
                throw new Error('Agent disclosure authority changed.');
            } catch {
              authorityError = true;
              throw new Error('Agent authority changed during review.');
            }
          }
          outcome = 'completed';
          output = parsed.data;
          if (binding.mode === 'gate') {
            const gate =
              binding.participant.kind === 'agent'
                ? PolicyAgentGateOutputV1Schema.parse(parsed.data).decision
                : GateOutput.parse(parsed.data).decision;
            result = gate === 'escalate' ? 'require_escalation' : gate;
          } else {
            result = 'not_applicable';
            if (binding.mode === 'advise') parsedAdvice = AdviceOutput.parse(parsed.data);
          }
        }
      } catch (error) {
        outcome = error instanceof ParticipantTimeout ? 'timeout' : 'error';
      } finally {
        if (timer) clearTimeout(timer);
        circuit.probing = false;
      }
      if (outcome === 'completed') {
        circuit.failures = 0;
        circuit.retryAt = 0;
      } else {
        circuit.failures += 1;
        if (circuit.failures >= binding.circuit.failures)
          circuit.retryAt = Date.now() + binding.circuit.recoveryAfterMs;
      }
    }
    if (authorityError) result = 'error';
    const subject = agent
      ? {
          ...input.proposal.subject,
          principal: { kind: 'agent' as const, id: agent.agentId },
          onBehalfOf: null,
          actor: {
            kind: 'agent' as const,
            id: agent.agentId,
            responsibleUserId: agent.responsibleHumanId,
          },
          responsibleHumanId: agent.responsibleHumanId,
        }
      : input.proposal.subject;
    const invocation: PolicyInvocationV1 = {
      binding: bindingRef,
      operation: binding.operation,
      stage: binding.stage,
      mode: binding.mode,
      policyRevision,
      authorizationRevision: input.authorizationRevision,
      proposalDigest,
      subject,
      participant: { id: binding.participant.id, version: binding.participant.version },
      inputDigest: policyDigest({ proposal: input.proposal, advice }),
      outputDigest: outcome === 'completed' ? policyDigest(output) : null,
      outcome,
      startedAt,
      completedAt: new Date().toISOString(),
      capabilityCallId: input.proposal.capabilityCallId,
    };
    if (binding.mode === 'gate') {
      const decisionId = allocateEntityId('pd');
      recordProductPermissionDecision({
        ...decisionInput(input, policyRevision),
        ...(agent
          ? {
              subjectSummary: {
                principal: subject.principal,
                responsibleHumanId: subject.responsibleHumanId,
              },
              auditActor: subject.actor,
            }
          : {}),
        decisionId,
        result,
        reasonCode:
          outcome !== 'completed'
            ? 'participant_unavailable'
            : result === 'deny'
              ? 'prohibited'
              : result === 'require_escalation'
                ? 'require_approval'
                : 'granted',
        policyInvocation: invocation,
        mediation: {
          operation: binding.operation,
          stage: binding.stage,
          authorizationRevision: input.authorizationRevision,
          proposalDigest,
          subject,
          role: 'gate',
          binding: bindingRef,
          invocations: [],
          consumedStatements: [],
        },
      });
      return { reference: { kind: 'decision', id: decisionId }, result };
    }
    const auditEventId = allocateEntityId('aud');
    recordWorkspaceAuditEvent({
      workspaceDb: input.workspaceDb,
      workspaceId: input.proposal.workspaceId,
      auditEventId,
      actor: input.proposal.subject.actor,
      category: 'system',
      action: 'policy.participant',
      capabilityCallId: input.proposal.capabilityCallId,
      ...(input.proposal.subject.process
        ? {
            threadId: input.proposal.subject.process.threadId,
            turnId: input.proposal.subject.process.turnId,
          }
        : {}),
      policyInvocation: invocation,
      outcome: outcome === 'completed' ? 'succeeded' : 'failed',
      summary: `Policy participant ${binding.id}: ${outcome}.`,
    });
    return {
      reference: { kind: 'audit', id: auditEventId },
      result,
      ...(parsedAdvice ? { advice: parsedAdvice } : {}),
    };
  }
}

class ParticipantTimeout extends Error {}

/** Existing closed precedence; a neutral participant never supplies missing authority. */
function combineResults(results: readonly PermissionDecisionResult[]): PermissionDecisionResult {
  const applicable = results.some((value) => value !== 'not_applicable')
    ? results.filter((value) => value !== 'not_applicable')
    : results;
  return (
    (
      [
        'error',
        'deny',
        'require_escalation',
        'require_approval',
        'defer',
        'not_applicable',
        'allow',
      ] as const
    ).find((value) => applicable.includes(value)) ?? 'not_applicable'
  );
}

function decisionInput(input: InterceptionInput, policyRevision: string) {
  return {
    workspaceDb: input.workspaceDb,
    workspaceId: input.proposal.workspaceId,
    ownerScope: 'workspace' as const,
    action: 'tool.use',
    enforcementPoint: `${input.proposal.operation}@decide`,
    policyEngineVersion: 'nanocore-policy:v1',
    policySnapshotId: policyRevision,
    subjectSummary: {
      principal: input.proposal.subject.principal,
      responsibleHumanId: input.proposal.subject.responsibleHumanId,
    },
    resourceSummary: { serverId: input.proposal.serverId, toolName: input.proposal.toolName },
    contextSummary: {
      capabilityCallId: input.proposal.capabilityCallId,
      packageSnapshotId: input.proposal.packageDigest,
      catalogRevision: input.proposal.catalogRevision,
      threadId: input.proposal.subject.process?.threadId,
      turnId: input.proposal.subject.process?.turnId,
      ...(input.humanApproval
        ? {
            humanApprovalRequestId: input.humanApproval.requestId,
            approvalSourceDecisionId: input.humanApproval.sourceDecisionId,
            humanApprovalDeciderId: input.humanApproval.deciderId,
          }
        : {}),
    },
    auditActor: input.humanApproval
      ? { kind: 'user' as const, id: input.humanApproval.deciderId }
      : input.proposal.subject.actor,
  };
}
