import { z } from 'zod';
import type { NanoHostEpochPlacement } from './nanohost-epoch-invalidation.js';
import { NanoHostEpochPlacementSchema } from './nanohost-epoch-invalidation-codecs.js';
import type { NanoHostEpochInvalidation, NanoHostEpochReceipt } from './nanohost-port.js';
import type { StorageDecision, StorageReceiptLookup } from './storage-owner.js';
import { NanoHostEpochInvalidationSchema as intent } from './vault-native-codecs.js';

const text = z.string().min(1);
const holderIds = z.array(text).max(4096);
const receipt = z.discriminatedUnion('disposition', [
  z.strictObject({
    disposition: z.literal('applied'),
    intent,
    receiptDigest: text,
    result: z.strictObject({ fencedHolderReceiptIds: holderIds }),
  }),
  z.strictObject({ disposition: z.literal('refused'), intent, receiptDigest: text, reason: text }),
]);
const ownerIdentity = z.string().regex(/^\d+:\d+$/);

export const NanoHostEpochKernelInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('reserve'),
    placement: NanoHostEpochPlacementSchema.strict(),
    ownerIdentity,
  }),
  z.strictObject({ kind: z.literal('fence'), intent, ownerIdentity }),
  z.strictObject({ kind: z.literal('inspect'), intent }),
]);
export type NanoHostEpochKernelInput =
  | {
      readonly kind: 'reserve';
      readonly placement: NanoHostEpochPlacement;
      readonly ownerIdentity: string;
    }
  | {
      readonly kind: 'fence';
      readonly intent: NanoHostEpochInvalidation;
      readonly ownerIdentity: string;
    }
  | { readonly kind: 'inspect'; readonly intent: NanoHostEpochInvalidation };

const hold = z.strictObject({ state: z.enum(['conflict', 'unknown']) });
const settled = z.strictObject({ state: z.literal('settled'), receipt });

export const NanoHostEpochKernelReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('reserve'),
    value: hold.or(z.strictObject({ state: z.literal('settled'), receipt: intent })),
  }),
  z.strictObject({ kind: z.literal('fence'), value: hold.or(settled) }),
  z.strictObject({
    kind: z.literal('inspect'),
    value: z.union([hold, settled, z.strictObject({ state: z.literal('absent') })]),
  }),
]);
export type NanoHostEpochKernelReply =
  | { readonly kind: 'reserve'; readonly value: StorageDecision<NanoHostEpochInvalidation> }
  | { readonly kind: 'fence'; readonly value: StorageDecision<NanoHostEpochReceipt> }
  | { readonly kind: 'inspect'; readonly value: StorageReceiptLookup<NanoHostEpochReceipt> };
