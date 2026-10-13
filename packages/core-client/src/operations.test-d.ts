import type {
  AppDiagnosticsClientResponseSchema,
  JsonOperationId,
  KernelOperationInput,
  OperationOutput,
} from '@openkit/app-api-schemas';
import type { z } from 'zod';
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
/** diagnostics.app follows the client reader; other operations follow the server output schema. */
type ExpectedClientResult<K extends JsonOperationId> = K extends 'diagnostics.app'
  ? z.output<typeof AppDiagnosticsClientResponseSchema>
  : OperationOutput<K>;
/** Each operation result is its own schema's output, never the union of family results. */
export type ExactClientResults = AssertTrue<
  {
    [K in JsonOperationId]: Identical<
      Awaited<ReturnType<CoreClient['operations'][K]>>,
      ExpectedClientResult<K>
    >;
  }[JsonOperationId]
>;
/** The client build projection may be absent, so a consumer must check it before reading. */
export type ClientBuildRequiresPresence = AssertTrue<
  undefined extends z.output<typeof AppDiagnosticsClientResponseSchema>['build'] ? true : false
>;
/**
 * Reads the source commit only after checking that the older server sent build.
 */
export async function readObservedSourceCommit(client: CoreClient): Promise<string | null> {
  const observed = await client.operations['diagnostics.app']({});
  if (!observed.build) return null;
  return observed.build.sourceCommit;
}

/** Read input remains exactly its logical schema, with no model-bound request identity. */
export type ExactReadInput = AssertTrue<
  Identical<
    Parameters<CoreClient['operations']['kernel.apps.get']>[0],
    KernelOperationInput<'kernel.apps.get'>
  >
>;
