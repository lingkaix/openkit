import { createHash } from 'node:crypto';
import { z } from 'zod';

const MCP_SERVER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MCP_SLOT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RAW_SECRET =
  /(^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]+|hf_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|okt_[A-Za-z0-9_-]+)/;

/** Canonical Workspace MCP server id. */
export const WorkspaceMcpServerIdSchema = z.string().regex(MCP_SERVER_ID);

/** Canonical MCP tool name selected by Workspace policy. */
export const WorkspaceMcpToolNameSchema = z.string().trim().min(1).max(256);

/** Vault credential sink owned by an MCP transport. */
export const WorkspaceMcpCredentialSinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), name: z.string().regex(ENVIRONMENT_NAME) }).strict(),
  z.object({ kind: z.literal('header'), name: z.string().regex(HTTP_HEADER_NAME) }).strict(),
  z.object({ kind: z.literal('query'), name: z.string().min(1).max(128) }).strict(),
]);

/** One logical Vault grant binding for an MCP transport sink. */
export const WorkspaceMcpCredentialBindingSchema = z
  .object({
    slot: z.string().regex(MCP_SLOT_ID),
    vaultGrantId: z.string().min(1),
    sink: WorkspaceMcpCredentialSinkSchema,
  })
  .strict();

/** NanoCore-spawned stdio MCP transport. */
export const WorkspaceMcpStdioTransportSchema = z
  .object({
    kind: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    environment: z
      .record(
        z.string().regex(ENVIRONMENT_NAME),
        z.object({ credentialSlot: z.string().regex(MCP_SLOT_ID) }).strict()
      )
      .default({}),
  })
  .strict();

/** NanoCore-connected Streamable HTTP MCP transport. */
export const WorkspaceMcpHttpTransportSchema = z
  .object({
    kind: z.literal('http'),
    endpoint: z.url().refine((value) => {
      const endpoint = new URL(value);
      return (
        (endpoint.protocol === 'http:' || endpoint.protocol === 'https:') &&
        endpoint.username === '' &&
        endpoint.password === '' &&
        endpoint.search === '' &&
        endpoint.hash === ''
      );
    }, 'MCP endpoints must be credential-free HTTP URLs without query or hash.'),
  })
  .strict();

/** Workspace-owned MCP server entry. */
export const WorkspaceMcpServerSchema = z
  .object({
    id: WorkspaceMcpServerIdSchema,
    enabled: z.boolean(),
    transport: z.discriminatedUnion('kind', [
      WorkspaceMcpStdioTransportSchema,
      WorkspaceMcpHttpTransportSchema,
    ]),
    credentialBindings: z.array(WorkspaceMcpCredentialBindingSchema).default([]),
    allowedTools: z.array(WorkspaceMcpToolNameSchema).min(1),
    deniedTools: z.array(WorkspaceMcpToolNameSchema).default([]),
    approvalRequiredTools: z.array(WorkspaceMcpToolNameSchema).default([]),
    timeoutMs: z.number().int().positive().default(60_000),
    schemaPolicy: z.enum(['pinned', 'tracking']),
    pinnedSchemaSnapshotId: z.string().min(1).nullable().default(null),
  })
  .strict()
  .superRefine((server, context) => {
    addDuplicateIssues(server.allowedTools, context, ['allowedTools']);
    addDuplicateIssues(server.deniedTools, context, ['deniedTools']);
    addDuplicateIssues(server.approvalRequiredTools, context, ['approvalRequiredTools']);
    addDuplicateIssues(
      server.credentialBindings.map((binding) => binding.slot),
      context,
      ['credentialBindings']
    );

    const allowed = new Set(server.allowedTools);
    const denied = new Set(server.deniedTools);
    for (const tool of server.approvalRequiredTools) {
      if (!allowed.has(tool) || denied.has(tool)) {
        context.addIssue({
          code: 'custom',
          message: `Approval-required MCP tool is not allowed: ${tool}.`,
          path: ['approvalRequiredTools'],
        });
      }
    }
    for (const tool of denied) {
      if (allowed.has(tool)) {
        context.addIssue({
          code: 'custom',
          message: `MCP tool cannot be both allowed and denied: ${tool}.`,
          path: ['deniedTools'],
        });
      }
    }
    for (const [index, binding] of server.credentialBindings.entries()) {
      const compatible =
        server.transport.kind === 'stdio'
          ? binding.sink.kind === 'env'
          : binding.sink.kind === 'header' || binding.sink.kind === 'query';
      if (!compatible) {
        context.addIssue({
          code: 'custom',
          message: 'MCP credential sink does not match the selected transport.',
          path: ['credentialBindings', index, 'sink'],
        });
      }
    }
    if (server.transport.kind === 'stdio') {
      const bindings = new Map(
        server.credentialBindings
          .filter((binding) => binding.sink.kind === 'env')
          .map((binding) => [binding.slot, binding.sink.name])
      );
      for (const [name, template] of Object.entries(server.transport.environment)) {
        if (bindings.get(template.credentialSlot) !== name) {
          context.addIssue({
            code: 'custom',
            message: 'MCP environment templates must match an env credential binding.',
            path: ['transport', 'environment', name],
          });
        }
      }
      for (const binding of server.credentialBindings) {
        if (
          binding.sink.kind === 'env' &&
          server.transport.environment[binding.sink.name]?.credentialSlot !== binding.slot
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Every MCP env credential binding requires one matching template.',
            path: ['credentialBindings'],
          });
        }
      }
    }
    if (containsRawSecret(server)) {
      context.addIssue({
        code: 'custom',
        message: 'Workspace MCP catalogs must not contain raw-secret-shaped strings.',
      });
    }
  });

/** Workspace-owned MCP server catalog. */
export const WorkspaceMcpServerCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    servers: z.array(WorkspaceMcpServerSchema).default([]),
  })
  .strict()
  .superRefine((catalog, context) => {
    addDuplicateIssues(
      catalog.servers.map((server) => server.id),
      context,
      ['servers']
    );
  });

/** Parsed Workspace MCP server entry. */
export type WorkspaceMcpServer = z.infer<typeof WorkspaceMcpServerSchema>;
/** Parsed Workspace MCP server catalog. */
export type WorkspaceMcpServerCatalog = z.infer<typeof WorkspaceMcpServerCatalogSchema>;
/** Enabled catalog entry with its deterministic configuration digest. */
export type ResolvedWorkspaceMcpServer = WorkspaceMcpServer & { readonly catalogDigest: string };

/** Parses one strict Workspace MCP server catalog. */
export function parseWorkspaceMcpServerCatalog(input: unknown): WorkspaceMcpServerCatalog {
  return WorkspaceMcpServerCatalogSchema.parse(input);
}

/** Resolves one enabled MCP server and stamps its stable catalog-entry digest. */
export function resolveWorkspaceMcpServer(input: {
  readonly catalog: WorkspaceMcpServerCatalog;
  readonly serverId: string;
}): ResolvedWorkspaceMcpServer {
  const server = input.catalog.servers.find((candidate) => candidate.id === input.serverId);
  if (!server) throw new Error(`Workspace MCP server not found: ${input.serverId}`);
  if (!server.enabled) throw new Error(`Workspace MCP server disabled: ${input.serverId}`);
  return {
    ...server,
    catalogDigest: `sha256:${createHash('sha256').update(stableJson(server)).digest('hex')}`,
  };
}

/** Adds one issue for every duplicate string after its first occurrence. */
function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: Array<string | number>
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate value: ${value}.`,
        path: [...path, index],
      });
    }
    seen.add(value);
  }
}

/** Returns true when a catalog subtree contains a recognizable raw credential value. */
function containsRawSecret(value: unknown): boolean {
  if (typeof value === 'string') return RAW_SECRET.test(value);
  if (Array.isArray(value)) return value.some(containsRawSecret);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsRawSecret);
}

/** Serializes values with stable object-key ordering for entry digests. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
