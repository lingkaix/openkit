import { z } from 'zod';

const MCP_SLOT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SDK_MANAGED_HTTP_HEADERS = new Set(['accept', 'content-type']);

/** Vault credential sink owned by an MCP transport. */
export const WorkspaceMcpCredentialSinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), name: z.string().regex(ENVIRONMENT_NAME) }).strict(),
  z
    .object({
      kind: z.literal('header'),
      name: z
        .string()
        .regex(HTTP_HEADER_NAME)
        .refine(
          (name) => !SDK_MANAGED_HTTP_HEADERS.has(name.toLowerCase()),
          'MCP SDK-owned HTTP headers cannot be credential sinks.'
        ),
    })
    .strict(),
  z.object({ kind: z.literal('query'), name: z.string().min(1).max(128) }).strict(),
]);

/** One logical Vault grant binding for an MCP transport sink. */
export const WorkspaceMcpCredentialBindingSchema = z
  .object({
    slot: z.string().regex(MCP_SLOT_ID),
    vaultGrantId: z.string().min(1),
    sink: WorkspaceMcpCredentialSinkSchema,
    // Omission preserves retained raw bytes and their effective digest.
    presentation: z.enum(['raw', 'bearer']).optional(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (
      binding.presentation === 'bearer' &&
      (binding.sink.kind !== 'header' || binding.sink.name.toLowerCase() !== 'authorization')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Bearer presentation requires an Authorization header sink.',
        path: ['presentation'],
      });
    }
  });
