import { z } from 'zod';

import {
  ProviderSubscriptionAccountSlotIdSchema,
  resolveProviderSubscriptionFamily,
  type SubscriptionProviderId,
} from './provider-subscription.js';

/**
 * Supported provider profile kinds.
 */
export const ProviderKindSchema = z.enum(['direct', 'gateway', 'local', 'oauth', 'custom']);

/**
 * Supported provider profile kind.
 */
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/** Explicit provider-subscription account binding. */
const ProviderSubscriptionAccountExtensionSchema = z
  .object({
    accountSlotId: ProviderSubscriptionAccountSlotIdSchema,
  })
  .strict();

/**
 * Strict OpenKit-owned provider extension namespace schema.
 */
export const OpenKitProviderExtensionSchema = z
  .object({
    subscriptionAccount: ProviderSubscriptionAccountExtensionSchema.optional(),
  })
  .strict();

/**
 * Provider extension schema with typed OpenKit-owned extensions and open vendor namespaces.
 */
export const ProviderExtensionsSchema = z
  .object({
    openkit: OpenKitProviderExtensionSchema.optional(),
  })
  .catchall(z.unknown());

/**
 * Provider readiness status.
 */
export const ProviderReadinessStatusSchema = z.enum([
  'ready',
  'degraded',
  'blocked',
  'disabled',
  'unknown',
]);

/**
 * Provider readiness payload.
 */
export const ProviderReadinessSchema = z
  .object({
    message: z.string().optional(),
    status: ProviderReadinessStatusSchema,
  })
  .strict();

const ModelModalitySchema = z.enum(['audio', 'image', 'pdf', 'text', 'video']);

/** One models.dev-shaped Provider model metadata entry. */
export const ProviderModelMetadataEntrySchema = z
  .object({
    attachment: z.boolean().optional(),
    cost: z
      .object({
        cache_read: z.number().finite().nonnegative().optional(),
        cache_write: z.number().finite().nonnegative().optional(),
        input: z.number().finite().nonnegative().optional(),
        output: z.number().finite().nonnegative().optional(),
      })
      .strict()
      .optional(),
    family: z.string().min(1).optional(),
    limit: z
      .object({
        context: z.number().int().positive().optional(),
        output: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    modalities: z
      .object({
        input: z.array(ModelModalitySchema).optional(),
        output: z.array(ModelModalitySchema).optional(),
      })
      .strict()
      .optional(),
    reasoning: z.boolean().optional(),
    temperature: z.boolean().optional(),
    tool_call: z.boolean().optional(),
  })
  .strict();

/** Per-native-id Provider model metadata map. */
export const ProviderModelMetadataSchema = z.record(
  z.string().min(1),
  ProviderModelMetadataEntrySchema
);

/** Shared provider-profile fields before cross-field validation. */
const ProviderProfileObjectSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine((value) => {
        if (!URL.canParse(value)) {
          return true;
        }

        const url = new URL(value);
        return !url.username && !url.password;
      }, 'Provider base URL must not contain credentials; use secretRef.')
      .optional(),
    category: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    displayName: z.string().min(1),
    extensions: ProviderExtensionsSchema.optional(),
    id: z.string().min(1),
    kind: ProviderKindSchema,
    modelMetadata: ProviderModelMetadataSchema.optional(),
    models: z.array(z.string().min(1)).min(1),
    readiness: ProviderReadinessSchema.optional(),
    secretRef: z.string().min(1).optional(),
    vendor: z.string().min(1).optional(),
  })
  .strict();

/**
 * Adds provider-subscription issues shared by profile and server-instance schemas.
 *
 * @param profile Provider fields to validate without server-only extensions.
 * @param context Zod refinement context that receives exact issue paths and messages.
 */
function addProviderProfileCrossFieldIssues(
  profile: z.infer<typeof ProviderProfileObjectSchema>,
  context: z.RefinementCtx
): void {
  const subscriptionAccount = profile.extensions?.openkit?.subscriptionAccount;
  let subscriptionFamily: SubscriptionProviderId | null;

  try {
    subscriptionFamily = resolveProviderSubscriptionFamily(profile);
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'Provider vendor and id select conflicting subscription families.',
      path: ['vendor'],
    });
    return;
  }

  if (profile.kind === 'oauth' && subscriptionFamily) {
    if (!subscriptionAccount) {
      context.addIssue({
        code: 'custom',
        message: 'Supported subscription OAuth profiles require an explicit account slot.',
        path: ['extensions', 'openkit', 'subscriptionAccount'],
      });
    }
    if (profile.secretRef !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Subscription OAuth profiles must not declare secretRef.',
        path: ['secretRef'],
      });
    }
    if (profile.baseUrl !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Subscription OAuth profiles must not declare baseUrl.',
        path: ['baseUrl'],
      });
    }
  } else if (subscriptionAccount) {
    context.addIssue({
      code: 'custom',
      message: 'Subscription accounts require a supported OAuth provider family.',
      path: ['extensions', 'openkit', 'subscriptionAccount'],
    });
  }

  for (const modelId of Object.keys(profile.modelMetadata ?? {})) {
    if (!profile.models.includes(modelId)) {
      context.addIssue({
        code: 'custom',
        message: `modelMetadata key is not in the provider model list: ${modelId}.`,
        path: ['modelMetadata', modelId],
      });
    }
  }
}

/**
 * File-backed provider profile schema.
 */
export const ProviderProfileSchema = ProviderProfileObjectSchema.superRefine(
  addProviderProfileCrossFieldIssues
);

/**
 * Configured provider instance schema derived from the canonical provider profile.
 *
 * Materialized runtime instances require an explicit vendor and cannot declare profile-derived category or readiness state.
 */
export const OpenKitProviderInstanceSchema = z
  .object(ProviderProfileObjectSchema.shape)
  .omit({
    category: true,
    readiness: true,
  })
  .extend({
    vendor: ProviderProfileObjectSchema.shape.vendor.unwrap(),
  })
  .strict()
  .superRefine(addProviderProfileCrossFieldIssues);

/**
 * File-backed provider profile.
 */
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
