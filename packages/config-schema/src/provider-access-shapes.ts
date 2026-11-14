import { z } from 'zod';

/** Source-configured static bearer destination intent, never a native profile or permission. */
export const StaticProviderAccessShapeSchema = z
  .object({
    id: z.string().min(1),
    credentialKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    endpoints: z
      .array(
        z
          .object({
            access: z.enum(['read-only', 'read-write']).optional(),
            allowEncodedSlash: z.boolean().optional(),
            binaries: z
              .array(z.string().refine((value) => value.startsWith('/') && !/[\r\n\0]/.test(value)))
              .min(1),
            host: z.string().refine((value) => value.trim().length > 0 && !/[\r\n\0]/.test(value)),
            name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            port: z.number().int().min(1).max(65535),
            protocol: z.literal('rest').optional(),
            rules: z
              .array(
                z
                  .object({
                    method: z.enum(['GET', 'POST']),
                    path: z
                      .string()
                      .refine((value) => value.startsWith('/') && !/[\r\n\0]/.test(value)),
                  })
                  .strict()
              )
              .optional(),
          })
          .strict()
          .refine((endpoint) => !endpoint.access || !endpoint.rules?.length)
          .refine(
            (endpoint) =>
              endpoint.allowEncodedSlash === undefined ||
              ((endpoint.protocol ?? 'rest') === 'rest' &&
                (endpoint.access ?? 'read-only') === 'read-only' &&
                endpoint.rules === undefined)
          )
      )
      .min(1),
  })
  .strict();

/** Secret-free configuration data; Runtime independently validates exact native projection. */
export type StaticProviderAccessShape = z.infer<typeof StaticProviderAccessShapeSchema>;
