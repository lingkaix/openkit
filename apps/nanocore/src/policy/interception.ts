import type { PolicyDecision } from '@openkit/policy-kernel';
import {
  allocateEntityId,
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
import {
  readPolicyStatementUseCount,
  recordProductPermissionDecision,
} from './permission-decisions.js';
import {
  type PolicyProposal,
  policyDigest,
  policyProposalDigest,
  policyScopeIncludesProposal,
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

/** Current owner facts and existing durable owner used by the I16 pilot. */
export interface InterceptionInput {
  readonly workspaceDb: WorkspaceDb;
  readonly document: PolicyDocumentV1;
  readonly proposal: PolicyProposal;
  readonly authorizationRevision: string;
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
  }) => PolicyDecision;
}

/** A final allow is permission to attempt the effect, not an effect result. */
export interface InterceptionDecision {
  readonly result: PermissionDecisionResult;
  readonly decisionId: string;
  readonly proposalDigest: string;
  readonly policyRevision: string;
  readonly authorizationRevision: string;
}

/** Bounded process-local availability state; restart never replays participant work. */
export class PolicyInterception {
  private readonly circuits = new Map<
    string,
    { failures: number; retryAt: number; probing: boolean }
  >();

  constructor(private readonly participant?: DeterministicPolicyParticipant) {}

  /** Runs the supported pilot modes and retains evidence before releasing a result. */
  async decide(input: InterceptionInput): Promise<InterceptionDecision> {
    const policyRevision = policyDigest(input.document);
    const proposalDigest = policyProposalDigest(input.proposal);
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
    let kernel: PolicyDecision | null = null;
    try {
      kernel = input.finalKernel({ proposal: input.proposal, advice });
      results.push(
        kernel.reasons.some(({ code }) =>
          ['invalid-policy', 'invalid-request', 'missing-operation'].includes(code)
        )
          ? 'error'
          : kernel.effect
      );
    } catch {
      results.push('error');
    }
    const result = combineResults(results);
    const decisionId = allocateEntityId('pd');
    const consumed =
      result === 'allow' ? used.filter((binding) => binding.lifetime.uses !== undefined) : [];
    recordProductPermissionDecision({
      ...decisionInput(input, policyRevision),
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
        point: `${input.proposal.operation}@decide`,
        proposalDigest,
        policyRevision,
        authorizationRevision: input.authorizationRevision,
        subject: input.proposal.subject,
        role: 'final',
        kernel: kernel
          ? { effect: kernel.effect, reason: kernel.reasons[0]?.code ?? 'not_granted' }
          : null,
        invocations,
        consumedStatements: consumed.map((binding) => ({
          id: binding.id,
          digest: policyDigest(binding),
        })),
      },
      ...(consumed.length
        ? {
            uses: consumed.map((binding) => ({
              statement: { id: binding.id, digest: policyDigest(binding) },
              limit: binding.lifetime.uses!,
            })),
          }
        : {}),
    });
    return {
      result,
      decisionId,
      proposalDigest,
      policyRevision,
      authorizationRevision: input.authorizationRevision,
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
    try {
      current = input.stillCurrent();
      if (current)
        participantAuthorized =
          policyScopeIncludesProposal(binding.inputDisclosure, input.proposal) &&
          input.participantAuthorized(binding);
    } catch {
      authorityError = true;
    }
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
      this.participant?.id === binding.participant.id &&
      this.participant.version === binding.participant.version
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
          this.participant.invoke({
            binding: structuredClone(binding),
            proposal: structuredClone(input.proposal),
            advice: structuredClone(advice),
            signal: controller.signal,
          }),
          timeout,
        ]);
        const parsed =
          binding.mode === 'gate'
            ? GateOutput.safeParse(output)
            : binding.mode === 'advise'
              ? AdviceOutput.safeParse(output)
              : ObservationOutput.safeParse(output);
        if (!parsed.success) outcome = 'malformed';
        else if (!input.stillCurrent()) outcome = 'stale';
        else {
          outcome = 'completed';
          output = parsed.data;
          if (binding.mode === 'gate') {
            const gate = GateOutput.parse(parsed.data).decision;
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
    const invocation: PolicyInvocationV1 = {
      binding: bindingRef,
      operation: binding.operation,
      stage: binding.stage,
      point: binding.point,
      mode: binding.mode,
      policyRevision,
      authorizationRevision: input.authorizationRevision,
      proposalDigest,
      subject: input.proposal.subject,
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
          point: binding.point,
          policyRevision,
          authorizationRevision: input.authorizationRevision,
          proposalDigest,
          subject: input.proposal.subject,
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
