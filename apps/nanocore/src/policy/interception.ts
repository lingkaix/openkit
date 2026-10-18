import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { stableJson } from '@openkit/config-schema';
import {
  type ActorRef,
  type InterceptionBinding,
  InterceptionBindingSchema,
  type InterceptionInvocation,
  InterceptionInvocationSchema,
  type InterceptionRecordReference,
  type InterceptionReference,
  InterceptionReferenceSchema,
  type InterceptionStatement,
} from '@openkit/protocol';

/** Resolves a statement at its existing Policy/config owner, without a self-referential authored hash. */
export function resolveInterceptionBinding(
  statement: InterceptionStatement,
  source: InterceptionRecordReference
): InterceptionBinding {
  const version = `sha256:${createHash('sha256').update(stableJson({ statement, source })).digest('hex')}`;
  return InterceptionBindingSchema.parse({ ...statement, source, version });
}

/** A provider result is tied to exactly the admitted binding and input, never interpreted from prose. */
export interface InterceptionParticipantResult {
  readonly bindingVersion: string;
  readonly input: InterceptionReference;
  readonly outcome: 'observed' | 'transformed' | 'advised' | 'allowed' | 'refused' | 'pending';
  readonly output: InterceptionReference | null;
}

/** Safe values stay in the effect owner; only their admitted references enter Audit. */
interface InterceptionInput {
  readonly reference: InterceptionReference;
  readonly value: unknown;
}

/** The existing effect owner keeps execution results, uncertainty and retry responsibility. */
export type InterceptionResult<T> =
  | { readonly outcome: 'allowed'; readonly released: T }
  | {
      readonly outcome: 'refused' | 'pending' | 'unavailable' | 'error';
      readonly reasonCode: string;
    };

/** One scoped bounded participant invocation; this is injection, not provider discovery or registration. */
export interface InterceptionExecutorOptions {
  readonly invoke: (
    binding: InterceptionBinding,
    input: InterceptionInput,
    signal: AbortSignal
  ) => Promise<InterceptionParticipantResult>;
  readonly now?: () => number;
}

/** Current admission and final release remain supplied by the specialized effect owner. */
export interface InterceptionExecution<T> {
  readonly nativeBinding: InterceptionBinding;
  readonly record: (invocation: InterceptionInvocation) => void;
  readonly bindings: readonly InterceptionBinding[];
  readonly input: InterceptionInput;
  readonly actor: ActorRef;
  readonly isCurrent: (binding: InterceptionBinding, input: InterceptionReference) => boolean;
  readonly authorize: (binding: InterceptionBinding) => boolean;
  readonly resolveOutput: (reference: InterceptionReference) => unknown;
  readonly validateInput: (value: unknown) => void;
  readonly finalPolicy: (value: unknown) => 'allow' | 'deny';
  /** Called synchronously after final current Policy and durable evidence, before another await. */
  readonly release: (value: unknown) => T;
}

/** Bounded availability is process-local; restart never resumes a participant or effect. */
interface Circuit {
  failures: number;
  openUntil: number;
  probing: boolean;
}

const stage = { transform: 0, advise: 1, gate: 2, observe: 3 } as const;

/** Orders admitted jobs and releases an effect only after its existing current Policy and Audit owners. */
export function createInterceptionExecutor(options: InterceptionExecutorOptions) {
  const now = options.now ?? Date.now;
  const circuits = new Map<string, Circuit>();

  return {
    async execute<T>(execution: InterceptionExecution<T>): Promise<InterceptionResult<T>> {
      const native = InterceptionBindingSchema.parse(structuredClone(execution.nativeBinding));
      const bindings = execution.bindings
        .map((binding) => InterceptionBindingSchema.parse(structuredClone(binding)))
        .sort(
          (a, b) => stage[a.mode] - stage[b.mode] || a.order - b.order || a.id.localeCompare(b.id)
        );
      const consumed: Array<{ binding: InterceptionBinding; reference: InterceptionReference }> =
        [];
      let input = {
        reference: InterceptionReferenceSchema.parse(execution.input.reference),
        value: execution.input.value,
      };

      const record = (
        binding: InterceptionBinding,
        started: number,
        outcome: InterceptionInvocation['outcome'],
        reasonCode: string | null,
        output: InterceptionReference | null = null
      ) => {
        execution.record(
          InterceptionInvocationSchema.parse({
            schemaVersion: 1,
            binding,
            input: input.reference,
            output,
            actor: execution.actor,
            outcome,
            reasonCode,
            startedAt: new Date(started).toISOString(),
            finishedAt: new Date(now()).toISOString(),
          })
        );
      };

      for (const binding of bindings) {
        const started = now();
        const key = stableJson([binding.owner, binding.id, binding.version, binding.participant]);
        const circuit = circuits.get(key) ?? { failures: 0, openUntil: 0, probing: false };
        circuits.set(key, circuit);
        let reason: string | null = null;
        let result: InterceptionParticipantResult | undefined;
        let transformed: InterceptionInput | undefined;
        try {
          if (!execution.isCurrent(binding, input.reference)) reason = 'stale';
          else if (
            (binding.mode === 'gate' || binding.mode === 'transform') &&
            !execution.authorize(binding)
          )
            reason = 'authority-unavailable';
        } catch {
          reason = 'authority-unavailable';
        }
        if (!reason && (circuit.openUntil > now() || circuit.probing)) reason = 'open-circuit';
        if (!reason) {
          circuit.probing = circuit.openUntil !== 0;
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            result = await Promise.race([
              options.invoke(structuredClone(binding), structuredClone(input), controller.signal),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new Error('timeout'));
                }, binding.timeoutMs);
              }),
            ]);
            const validOutcomes =
              binding.mode === 'gate'
                ? ['allowed', 'refused', 'pending']
                : binding.mode === 'transform'
                  ? ['transformed']
                  : binding.mode === 'advise'
                    ? ['advised']
                    : ['observed'];
            if (
              !result ||
              !validOutcomes.includes(result.outcome) ||
              result.bindingVersion !== binding.version ||
              !isDeepStrictEqual(result.input, input.reference) ||
              (binding.mode === 'transform' && result.output === null)
            ) {
              reason = 'invalid-result';
            } else if (!execution.isCurrent(binding, input.reference)) {
              reason = 'stale';
            } else if (result.output !== null) {
              const reference = InterceptionReferenceSchema.parse(result.output);
              const value = execution.resolveOutput(reference);
              if (binding.mode === 'transform') {
                execution.validateInput(value);
                // Retain the original input reference in this invocation; advance only after Audit.
                result = { ...result, output: reference };
                transformed = { reference, value };
              }
            }
          } catch {
            reason = controller.signal.aborted ? 'timeout' : 'participant-unavailable';
          } finally {
            if (timer !== undefined) clearTimeout(timer);
            circuit.probing = false;
          }
          if (reason && reason !== 'stale') {
            circuit.failures += 1;
            if (circuit.failures >= binding.circuit.failureThreshold)
              circuit.openUntil = now() + binding.circuit.resetAfterMs;
          } else if (!reason) {
            circuit.failures = 0;
            circuit.openUntil = 0;
          }
        }
        try {
          if (reason) {
            record(binding, started, 'unavailable', reason);
            if (
              binding.onUnavailable === 'continue' &&
              (binding.mode === 'observe' || binding.mode === 'advise')
            )
              continue;
            return {
              outcome: binding.onUnavailable === 'pending' ? 'pending' : 'unavailable',
              reasonCode: reason,
            };
          }
          record(binding, started, result!.outcome, null, result!.output);
          consumed.push({ binding, reference: input.reference });
          if (transformed) input = transformed;
          if (result!.outcome === 'refused' || result!.outcome === 'pending')
            return { outcome: result!.outcome, reasonCode: 'participant-decision' };
        } catch {
          return { outcome: 'error', reasonCode: 'evidence-write-failed' };
        }
      }

      const started = now();
      let decision: 'allow' | 'deny';
      try {
        if (
          !execution.isCurrent(native, input.reference) ||
          consumed.some((entry) => !execution.isCurrent(entry.binding, entry.reference))
        ) {
          record(native, started, 'unavailable', 'stale');
          return { outcome: 'unavailable', reasonCode: 'stale' };
        }
        execution.validateInput(input.value);
        decision = execution.finalPolicy(input.value);
        if (decision !== 'allow' && decision !== 'deny') throw new Error('Invalid Policy result.');
      } catch {
        try {
          record(native, started, 'error', 'policy-unavailable');
        } catch {
          /* The required evidence failure still prevents release. */
        }
        return { outcome: 'error', reasonCode: 'policy-unavailable' };
      }
      try {
        record(native, started, decision === 'allow' ? 'allowed' : 'refused', null);
      } catch {
        return { outcome: 'error', reasonCode: 'evidence-write-failed' };
      }
      if (decision === 'deny') return { outcome: 'refused', reasonCode: 'policy-denied' };
      // Do not suspend between the final owner checks, required record and effect dispatch.
      return { outcome: 'allowed', released: execution.release(input.value) };
    },
  };
}
