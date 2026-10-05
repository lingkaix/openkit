import { z } from 'zod';

/** Pinned Codex sub-agent classifications retained without adapter-private labels. */
export type WorkerInferenceSubagentKind =
  | 'review'
  | 'compact'
  | 'thread_spawn'
  | 'memory_consolidation'
  | 'other';

/**
 * Ephemeral runtime-native inference hints consumed at the trusted worker boundary.
 */
export interface WorkerInferenceRuntimeHint {
  /** Pinned runtime adapter family. */
  readonly runtimeFamily: 'codex';
  /** Runtime-native session identity. */
  readonly nativeSessionId: string;
  /** Runtime-native thread identity. */
  readonly nativeThreadId: string;
  /** Runtime-native turn identity when supplied. */
  readonly nativeTurnId?: string;
  /** Runtime-native parent thread identity when supplied. */
  readonly parentNativeThreadId?: string;
  /** Normalized runtime-native sub-agent classification. */
  readonly subagentKind?: WorkerInferenceSubagentKind;
  /** Runtime-native cache lineage consumed before provider dispatch. */
  readonly nativeCacheLineageId?: string;
}

/** Closed Core values with unknown additive content ignored at this internal boundary. */
const boundedHintString = z
  .string()
  .min(1)
  .max(16 * 1024);
const runtimeHintSchema = z.object({
  runtimeFamily: z.literal('codex'),
  nativeSessionId: boundedHintString,
  nativeThreadId: boundedHintString,
  nativeTurnId: boundedHintString.optional(),
  parentNativeThreadId: boundedHintString.optional(),
  subagentKind: z
    .enum(['review', 'compact', 'thread_spawn', 'memory_consolidation', 'other'])
    .optional(),
  nativeCacheLineageId: boundedHintString.optional(),
});

/**
 * Validates the adapter-normalized hint against the authenticated runtime binding.
 *
 * @param value First-party Integration carriage field, absent when no mapping produced a hint.
 * @param runtimeFamily AEP-owned runtime adapter family.
 * @returns An ephemeral hint consumed before provider dispatch, or undefined.
 * @throws Error with a fixed message for malformed or mismatched hints.
 */
export function readWorkerInferenceRuntimeHint(
  value: unknown,
  runtimeFamily: string
): WorkerInferenceRuntimeHint | undefined {
  if (value === undefined) return undefined;
  const parsed = runtimeHintSchema.safeParse(value);
  if (!parsed.success || parsed.data.runtimeFamily !== runtimeFamily) {
    throw new Error('Worker inference runtime hint is invalid.');
  }
  const hint = parsed.data;
  return {
    runtimeFamily: hint.runtimeFamily,
    nativeSessionId: hint.nativeSessionId,
    nativeThreadId: hint.nativeThreadId,
    ...(hint.nativeTurnId !== undefined ? { nativeTurnId: hint.nativeTurnId } : {}),
    ...(hint.parentNativeThreadId !== undefined
      ? { parentNativeThreadId: hint.parentNativeThreadId }
      : {}),
    ...(hint.subagentKind !== undefined ? { subagentKind: hint.subagentKind } : {}),
    ...(hint.nativeCacheLineageId !== undefined
      ? { nativeCacheLineageId: hint.nativeCacheLineageId }
      : {}),
  };
}
