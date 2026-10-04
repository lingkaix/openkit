import type {
  AUTOMATION_OPERATION_DEFINITIONS,
  JsonOperationId,
  OperationId,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import type { createAutomationOperationImplementations } from './automation-operations.js';
import type { createOperationImplementations } from './operation-composition.js';
import type { OperationImplementations } from './operation-contract.js';

/** Actual family factory keys, rather than a restated generic alias, must remain exact. */
export type ActualAutomationJoin = AssertTrue<
  Identical<
    keyof ReturnType<typeof createAutomationOperationImplementations>,
    keyof typeof AUTOMATION_OPERATION_DEFINITIONS
  >
>;

/** The concrete composition must retain every JSON family key, including accidental extras. */
export type ActualComposedJoin = AssertTrue<
  Identical<keyof ReturnType<typeof createOperationImplementations>, JsonOperationId>
>;

/** Compile-time equality oracle for the exact JSON definition/implementation key join. */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Fails compilation if its owner-derived predicate is false. */
type AssertTrue<T extends true> = T;
/** The implementation cannot independently add or lose definition keys. */
export type ExactOperationJoin = AssertTrue<
  Identical<keyof OperationImplementations, JsonOperationId>
>;

/** Negative compile probes; deliberately never executed. */
export function rejectBrokenJoins(handlers: OperationImplementations): void {
  const { 'kernel.apps.get': _read, ...missing } = handlers;
  // @ts-expect-error A missing definition handler must not satisfy the join.
  const incomplete: OperationImplementations = missing;
  // @ts-expect-error An extra server handler must fail the exact literal join.
  const extra = { ...handlers, unexpected: () => true } satisfies OperationImplementations;
  const mismatched = {
    ...handlers,
    // @ts-expect-error A handler with unrelated input and output must fail its operation's signature.
    'kernel.apps.get': (_input: string, _actor: ActorRef) => false,
  } satisfies OperationImplementations;
  void incomplete;
  void extra;
  void mismatched;
}

/** Retained streams cannot acquire a parallel native JSON implementation. */
export type NoStreamingImplementation = AssertTrue<
  Identical<Extract<keyof OperationImplementations, Exclude<OperationId, JsonOperationId>>, never>
>;
