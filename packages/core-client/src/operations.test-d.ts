import type {
  JsonOperationId,
  KernelOperationInput,
  OperationOutput,
} from '@openkit/app-api-schemas';
import type { CoreClient } from './client.js';

/** Fails compilation when a derived client contract differs from its definition. */
type AssertTrue<T extends true> = T;
/** Compile-time equality for closed keys and correlated operation result types. */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Exactly the definition's ids are callable on this client surface. */
export type ExactClientKeys = AssertTrue<
  Identical<keyof CoreClient['operations'], JsonOperationId>
>;
/** Each operation result is its own schema's output, never the union of family results. */
export type ExactClientResults = AssertTrue<
  {
    [K in JsonOperationId]: Identical<
      Awaited<ReturnType<CoreClient['operations'][K]>>,
      OperationOutput<K>
    >;
  }[JsonOperationId]
>;
/** Read input remains exactly its logical schema, with no model-bound request identity. */
export type ExactReadInput = AssertTrue<
  Identical<
    Parameters<CoreClient['operations']['kernel.apps.get']>[0],
    KernelOperationInput<'kernel.apps.get'>
  >
>;
