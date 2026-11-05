import { completeAttentionAttemptInDb } from '../notifications/attention.js';
import {
  type ControlAttentionAttemptCompletion,
  type ControlAttentionAttemptCompletionResult,
  ControlAttentionAttemptCompletionSchema,
} from './attention-attempt-completion-codecs.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';

/** Commits only the original completion statement inside the existing native Core FULL boundary. */
export function applyControlAttentionAttemptCompletion(
  db: CoreDb,
  value: ControlAttentionAttemptCompletion
): ControlAttentionAttemptCompletionResult {
  assertControlProductWriter(db.sqlite);
  if (db.scope !== 'core' || !db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  const input = ControlAttentionAttemptCompletionSchema.parse(value);
  completeAttentionAttemptInDb(db.sqlite, input);
  return { kind: 'attention-attempt-completion' };
}
