import { z } from 'zod';

/**
 * Gateway-mintable refresh strategies and their exact refresh-family material keys.
 * Values are secret Vault material; this configuration names keys only.
 */
export const DELEGATED_REFRESH_MATERIAL_KEYS = {
  oauth2_client_credentials: { required: ['client_id', 'client_secret'], optional: [] },
  google_service_account_jwt: { required: ['client_email', 'private_key'], optional: ['subject'] },
  oauth2_refresh_token: { required: ['client_id', 'refresh_token'], optional: ['client_secret'] },
} as const satisfies Record<
  string,
  { readonly required: readonly string[]; readonly optional: readonly string[] }
>;

/** Strategy names accepted in configuration; acceptance is not delegation authority. */
export type DelegatedRefreshStrategy = keyof typeof DELEGATED_REFRESH_MATERIAL_KEYS;

/**
 * Strategies whose token endpoint may rotate a root member that Core cannot recover.
 * They parse, but delegation refuses before any effect until whole-family recovery is proven.
 */
export const BLOCKED_DELEGATED_REFRESH_STRATEGIES: readonly DelegatedRefreshStrategy[] = [
  'oauth2_refresh_token',
];

const boundedText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)));

/** Pinned token endpoint: exact HTTPS origin and path, no credentials, query or fragment. */
const tokenUrl = boundedText(2048).refine((value) => {
  if (value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.length > 0 &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      !value.includes('?') &&
      !value.includes('#')
    );
  } catch {
    return false;
  }
});

/** Secret-free delegated refresh intent pinned by configuration, never a grant of delegation. */
export const DelegatedRefreshIntentSchema = z
  .object({
    strategy: z.enum(
      Object.keys(DELEGATED_REFRESH_MATERIAL_KEYS) as [
        DelegatedRefreshStrategy,
        ...DelegatedRefreshStrategy[],
      ]
    ),
    tokenUrl,
    scopes: z.array(boundedText(1024)).max(64),
  })
  .strict()
  .refine(
    (intent) => intent.strategy !== 'google_service_account_jwt' || intent.scopes.length > 0,
    {
      message: 'Service-account JWT refresh requires at least one scope.',
      path: ['scopes'],
    }
  );

/** Delegated refresh intent selected by one access shape. */
export type DelegatedRefreshIntent = z.infer<typeof DelegatedRefreshIntentSchema>;

/**
 * Validates one strategy's secret refresh-family material without echoing any value.
 *
 * @param strategy Configured strategy.
 * @param material Decoded Vault material.
 * @returns The exact material object when every required key and only declared keys are present.
 * @throws Error with a value-free message when the material does not match the strategy.
 */
export function requireDelegatedRefreshMaterial(
  strategy: DelegatedRefreshStrategy,
  material: string
): Readonly<Record<string, string>> {
  const invalid = () => new Error('Delegated refresh material does not match its strategy.');
  let value: unknown;
  try {
    value = JSON.parse(material);
  } catch {
    throw invalid();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const keys = DELEGATED_REFRESH_MATERIAL_KEYS[strategy];
  const allowed = new Set<string>([...keys.required, ...keys.optional]);
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    keys.required.some((key) => !Object.hasOwn(value as object, key)) ||
    entries.some(
      ([key, item]) =>
        !allowed.has(key) ||
        typeof item !== 'string' ||
        item.length === 0 ||
        new TextEncoder().encode(item).length > 1024 * 1024
    )
  )
    throw invalid();
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

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
    /** Optional Gateway refresh intent; delegation still requires governed Vault authority. */
    refresh: DelegatedRefreshIntentSchema.optional(),
  })
  .strict();

/** Secret-free configuration data; Runtime independently validates exact native projection. */
export type StaticProviderAccessShape = z.infer<typeof StaticProviderAccessShapeSchema>;
