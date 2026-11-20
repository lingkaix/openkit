import { canonicalIdentifierName } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import type { StorageReceipt } from './storage-owner.js';

/** Checks A8's versioned digest over the complete receipt body. */
export function hasOriginalReceiptDigest(receipt: StorageReceipt<unknown, unknown>): boolean {
  const { receiptDigest, ...body } = receipt;
  return (
    receiptDigest ===
    `sha256:${sha256Hex(canonicalIdentifierName(['openkit:storage-receipt:v1', body]))}`
  );
}
