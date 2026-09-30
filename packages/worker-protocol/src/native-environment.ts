import { z } from 'zod';

/** Compact canonical JSON for the bounded ASCII-key native environment namespace. */
export function canonicalNativeEnvironment(
  values: Readonly<Record<string, string | null>>
): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  );
}

/** A consumed environment identifier, distinct from ignorable envelope metadata. */
export const NativeEnvironmentNameSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const literalValue = z
  .string()
  .refine(
    (value) =>
      !value.includes('\0') &&
      !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(value)
  );
const withinBounds = (values: Record<string, string | null>) =>
  Object.keys(values).length <= 128 &&
  new TextEncoder().encode(canonicalNativeEnvironment(values)).byteLength <= 16 * 1024;

/**
 * Validates the raw literal namespace without Zod record's silent `__proto__` omission.
 * N-env permits every matching ASCII identifier. Keep this validation and its editor
 * projection together until the generic record parser preserves those exact keys.
 */
function literalMap<T extends string | null>(
  valueSchema: z.ZodType<T>,
  nullable: boolean
): z.ZodType<Record<string, T>> {
  return z
    .unknown()
    .superRefine((input, context) => {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        ![null, Object.prototype].includes(Object.getPrototypeOf(input))
      ) {
        context.addIssue({ code: 'custom', message: 'Native environment must be a literal map.' });
        return;
      }
      const entries = Object.entries(input);
      if (
        Reflect.ownKeys(input).length !== entries.length ||
        entries.some(
          ([name, value]) =>
            !NativeEnvironmentNameSchema.safeParse(name).success ||
            !valueSchema.safeParse(value).success
        ) ||
        !withinBounds(input as Record<string, T>)
      )
        context.addIssue({
          code: 'custom',
          message: 'Native environment names, values or bounds are invalid.',
        });
    })
    .meta({
      type: 'object',
      maxProperties: 128,
      propertyNames: { type: 'string', maxLength: 128, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
      additionalProperties: nullable
        ? { anyOf: [{ type: 'string' }, { type: 'null' }] }
        : { type: 'string' },
    }) as z.ZodType<Record<string, T>>;
}

/** Public child settings; empty strings are values and absence is not inspected emptiness. */
export const NativeEnvironmentValuesSchema = literalMap(literalValue, false);

/** Agent-authored overrides: null suppresses the image default and omission inherits it. */
export const AuthoredNativeEnvironmentSchema = literalMap(literalValue.nullable(), true);

/** Measured identity and admitted values in immutable environment-aware packages. */
export const NativeEnvironmentRecordSchema = z
  .object({
    requiredFeatures: z.never().optional(),
    minCoreVersion: z.never().optional(),
    env: z.never().optional(),
    runtimeEnvironment: z.never().optional(),
    imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    defaultsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    values: NativeEnvironmentValuesSchema,
  })
  .strip();

/** Names owned by trusted bootstrap or fixed control projections, never user settings. */
export function isProtectedNativeEnvironmentName(name: string, adapterId: string): boolean {
  const fixed = new Set([
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'NODE_OPTIONS',
    'BUN_OPTIONS',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'NODE_EXTRA_CA_CERTS',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'BASH_ENV',
    'ENV',
    'SHELL',
    'NO_PROXY',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_USE_ENV_PROXY',
  ]);
  const adapter =
    adapterId === 'pi'
      ? ['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY']
      : adapterId === 'opencode'
        ? [
            'OPENCODE_CONFIG',
            'OPENCODE_CONFIG_CONTENT',
            'OPENCODE_CONFIG_DIR',
            'OPENCODE_SERVER_PASSWORD',
            'OPENCODE_SERVER_USERNAME',
            'OPENCODE_PASSWORD',
            'OPENCODE_TEST_HOME',
            'OPENCODE_DISABLE_AUTOUPDATE',
            'OPENCODE_DISABLE_FILEWATCHER',
            'OPENCODE_DISABLE_MODELS_FETCH',
            'OPENCODE_DISABLE_PROJECT_CONFIG',
            'XDG_CONFIG_HOME',
            'XDG_DATA_HOME',
            'XDG_STATE_HOME',
            'XDG_CACHE_HOME',
          ]
        : adapterId === 'deepseek'
          ? ['DSH_HOME', 'DSH_PERMISSION_MODE', 'DSH_TELEMETRY_MODE', 'DSH_TELEMETRY_OTLP_URL']
          : adapterId === 'codex'
            ? ['CODEX_HOME']
            : [];
  return (
    name.startsWith('OPENKIT_') ||
    name.toLowerCase() === 'npm_config_nodedir' ||
    fixed.has(name) ||
    adapter.includes(name)
  );
}
