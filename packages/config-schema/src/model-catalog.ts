import { z } from 'zod';
import { ProviderModelMetadataEntrySchema } from './provider.js';

/** Exact, nonblank catalog key; whitespace is not normalized into an alias. */
const CatalogKeySchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'Catalog keys must be nonblank.');

/** Deployment-owned extension metadata keyed by provider vendor and exact native model ID. */
export const ModelCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    providers: z.record(
      CatalogKeySchema,
      z
        .object({
          models: z.record(CatalogKeySchema, ProviderModelMetadataEntrySchema),
        })
        .strict()
    ),
  })
  .strict();

/** Validated deployment model extension catalog; it contains no Provider credentials or routes. */
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
