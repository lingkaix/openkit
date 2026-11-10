import { VaultReferenceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  StoredThreadSnapshotV1Schema,
  THREAD_REQUIRED_FEATURES,
} from './retained-work-events-v1.js';

/** Required interpretation of the two approved private canonical Thread Login facts. */
export const NATIVE_THREAD_LOGIN_FEATURE = 'openkit.thread-login.v1' as const;
/** Native readers support private affinity; public/event snapshot readers deliberately do not. */
export const NativeThreadRequiredFeaturesSchema = z.array(
  z.enum([...THREAD_REQUIRED_FEATURES, NATIVE_THREAD_LOGIN_FEATURE])
);
const timestamp = z.iso
  .datetime({ precision: 3 })
  .refine(
    (value) =>
      value.length === 24 &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
  );
/** No account, grant, material generation or provider payload belongs to Thread affinity. */
export const NativeThreadLoginSchema = z
  .object({
    referenceId: VaultReferenceIdSchema.nullable(),
    lastLeftAt: z
      .record(VaultReferenceIdSchema, timestamp)
      .refine((value) => Object.keys(value).length <= 256),
  })
  .strict();
/** Closed canonical private meaning, separate from retained public/event Thread snapshots. */
export const StoredNativeThreadSnapshotV1Schema = StoredThreadSnapshotV1Schema.safeExtend({
  login: NativeThreadLoginSchema,
  requiredFeatures: NativeThreadRequiredFeaturesSchema,
});
export type NativeThreadLogin = z.infer<typeof NativeThreadLoginSchema>;

/** Computes only a proposal; the native effect/receipt owner is the sole caller allowed to publish it. */
export function nextNativeThreadLogin(
  previous: NativeThreadLogin | undefined,
  referenceId: string | null,
  now: string
): NativeThreadLogin {
  timestamp.parse(now);
  if (referenceId !== null) VaultReferenceIdSchema.parse(referenceId);
  const lastLeftAt = { ...previous?.lastLeftAt };
  if (
    previous?.referenceId !== referenceId &&
    referenceId !== null &&
    lastLeftAt[referenceId] &&
    Date.parse(now) - Date.parse(lastLeftAt[referenceId]!) < 60_000
  )
    throw new Error('Thread Login departure cooldown is still effective.');
  if (previous?.referenceId !== referenceId && previous?.referenceId) {
    if (lastLeftAt[previous.referenceId] && lastLeftAt[previous.referenceId]! > now)
      throw new Error('Thread Login departure clock cannot regress.');
    for (const [id, left] of Object.entries(lastLeftAt))
      if (Date.parse(now) - Date.parse(left) >= 60_000) delete lastLeftAt[id];
    if (!Object.hasOwn(lastLeftAt, previous.referenceId) && Object.keys(lastLeftAt).length >= 256)
      throw new Error('Thread Login departure capacity is unavailable.');
    lastLeftAt[previous.referenceId] = now;
  }
  return NativeThreadLoginSchema.parse({ referenceId, lastLeftAt });
}
