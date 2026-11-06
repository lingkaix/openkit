import { claimAttentionAttemptInDb } from '../notifications/attention.js';
import { AttentionError } from '../notifications/attention-error.js';
import {
  type ControlAttentionAttemptClaim,
  ControlAttentionAttemptClaimRefusalSchema,
  type ControlAttentionAttemptClaimResult,
  ControlAttentionAttemptClaimResultSchema,
  ControlAttentionAttemptClaimSchema,
} from './attention-attempt-claim-codecs.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';

/** Original whole claim, including rollback and readback, inside the native Core FULL boundary. */
export function applyControlAttentionAttemptClaim(
  db: CoreDb,
  value: ControlAttentionAttemptClaim
): ControlAttentionAttemptClaimResult {
  assertControlProductWriter(db.sqlite);
  if (db.scope !== 'core' || !db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  const input = ControlAttentionAttemptClaimSchema.parse(value);
  try {
    const delivery = claimAttentionAttemptInDb(db.sqlite, input, () => {
      if (input.startedAt === null) throw new AttentionError('invalid_attention_input');
      return input.startedAt;
    });
    return ControlAttentionAttemptClaimResultSchema.parse({
      kind: 'attention-attempt-claim',
      status: 'claimed',
      delivery,
    });
  } catch (error) {
    // The original transaction has rolled back before a refusal can be returned.
    // Unexpected SQL/codec failures still escape into the covering native rollback.
    if (error instanceof AttentionError) {
      const code = ControlAttentionAttemptClaimRefusalSchema.safeParse(error.code);
      if (code.success)
        return { kind: 'attention-attempt-claim', status: 'refused', code: code.data };
    }
    throw error;
  }
}
