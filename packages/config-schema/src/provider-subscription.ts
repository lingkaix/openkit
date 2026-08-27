import { z } from 'zod';

/** Closed identifiers for internally supported provider subscriptions. */
export const SubscriptionProviderIdSchema = z.enum(['openai-codex', 'xai']);

/** Internally supported provider-subscription identifier. */
export type SubscriptionProviderId = z.infer<typeof SubscriptionProviderIdSchema>;

/**
 * Resolves a provider profile's supported subscription family.
 *
 * @param input Provider profile id and optional vendor.
 * @returns The supported subscription provider id, or null when neither field selects one.
 * @throws Error when the id and vendor select different supported subscription families.
 */
export function resolveProviderSubscriptionFamily({
  id,
  vendor,
}: {
  readonly id: string;
  readonly vendor?: string | undefined;
}): SubscriptionProviderId | null {
  const normalizedId = id.trim().toLowerCase().replaceAll('-', '_');
  const normalizedVendor = vendor?.trim().toLowerCase().replaceAll('-', '_');
  const idFamily =
    normalizedId === 'openai_codex' ? 'openai-codex' : normalizedId === 'xai' ? 'xai' : null;
  const vendorFamily =
    normalizedVendor === 'openai_codex'
      ? 'openai-codex'
      : normalizedVendor === 'xai'
        ? 'xai'
        : null;

  if (vendorFamily && idFamily && vendorFamily !== idFamily) {
    throw new Error('Provider vendor and id select conflicting subscription families.');
  }
  return vendorFamily ?? idFamily;
}

/** Bounded account-slot identifier for an internal provider subscription. */
export const ProviderSubscriptionAccountSlotIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/** Account-slot identifier for an internal provider subscription. */
export type ProviderSubscriptionAccountSlotId = z.infer<
  typeof ProviderSubscriptionAccountSlotIdSchema
>;
