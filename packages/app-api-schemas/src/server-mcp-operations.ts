import { McpHttpEndpointSchema } from '@openkit/config-schema/mcp-credentials';
import { RequestIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';
import { addRawSecretIssues } from './raw-secrets.js';
import {
  CatalogMutationResponseSchema,
  CreateMcpConfigRequestSchema,
  CreateMcpConfigResponseSchema,
  McpCatalogEntrySchema,
  SelectMcpVersionRequestSchema,
  UpdateMcpBindingRequestSchema,
} from './resource-catalog.js';
import {
  CreateWorkspaceVaultGrantRequestSchema,
  NarrowWorkspaceVaultGrantRequestSchema,
  VaultAdminWorkspaceReferenceSchema,
} from './vault-admin.js';
import { WorkspaceVaultGrantSchema } from './vault-injection.js';

const mcpId = z.string().min(1);
const request = z.object({ requestId: RequestIdSchema }).strict();
const referenceRequest = request.safeExtend({ referenceId: z.string().min(1) });
const grantRequest = request.safeExtend({ grantId: z.string().min(1) });
const material = z.string().min(1).max(65_536);
const reference = z
  .object({
    ...VaultAdminWorkspaceReferenceSchema.shape,
    ownerScope: z.literal('server'),
    workspaceId: z.null(),
    secretKind: z.literal('mcp-credential'),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));
const grant = z
  .object({
    ...WorkspaceVaultGrantSchema.shape,
    ownerScope: z.literal('server'),
    workspaceId: z.null(),
    lifetime: z.literal('server'),
  })
  .strict()
  .superRefine((value, ctx) => addRawSecretIssues(value, ctx, []));
const entries = z
  .object({ entries: z.array(McpCatalogEntrySchema), revision: z.number().int().nonnegative() })
  .strict();

/** Non-secret administrative view; canonical declaration validation remains with the catalog owner. */
const declaration = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('http'),
      endpoint: McpHttpEndpointSchema,
      headers: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()),
      cwd: z.string().nullable(),
      environment: z.record(z.string(), z.string()),
      environmentSlots: z.record(
        z.string(),
        z.object({ credentialSlot: z.string().min(1) }).strict()
      ),
    })
    .strict(),
]);
const pinnedSchemaSnapshotId = z.string().min(1).nullable();

/** Fixed Server authority; handlers also recheck the current administrator before effects and replay. */
function serverOperation<const I extends z.ZodObject, const O extends z.ZodType>(
  description: string,
  inputSchema: I,
  outputSchema: O,
  mutating: boolean,
  sensitive = false
) {
  return {
    description,
    inputSchema,
    outputSchema,
    mutating,
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'server' },
    policyOperation: 'api.call',
    ...(sensitive ? { inputSensitivity: 'secret stdin' as const } : {}),
  } as const satisfies OperationDefinition;
}

/** Server MCP administration extends the existing catalog, Vault and command owners. */
export const SERVER_MCP_OPERATION_DEFINITIONS = {
  'administration.server-mcp-list': serverOperation(
    'List redacted Server MCP supply.',
    z.object({}).strict(),
    entries,
    false
  ),
  'administration.server-mcp-read': serverOperation(
    'Read one Server MCP binding and non-secret immutable configurations.',
    z.object({ mcpId }).strict(),
    z
      .object({
        entry: McpCatalogEntrySchema,
        revision: z.number().int().nonnegative(),
        credentialBindings: UpdateMcpBindingRequestSchema.shape.credentialBindings.unwrap(),
        pinnedSchemaSnapshotId,
        versions: z.array(
          z
            .object({
              digest: z.string().min(1),
              createdAt: z.string().min(1),
              declaration,
              packageRootDigest: z.string().nullable(),
            })
            .strict()
        ),
      })
      .strict(),
    false
  ),
  'administration.server-mcp-create': serverOperation(
    'Create disabled Server MCP supply.',
    CreateMcpConfigRequestSchema,
    CreateMcpConfigResponseSchema,
    true
  ),
  'administration.server-mcp-stage-version': serverOperation(
    'Stage an immutable Server MCP version without selecting it.',
    CreateMcpConfigRequestSchema.safeExtend({ mcpId }),
    CreateMcpConfigResponseSchema,
    true
  ),
  'administration.server-mcp-select-version': serverOperation(
    'Select a retained Server MCP version.',
    SelectMcpVersionRequestSchema.safeExtend({ mcpId }),
    CatalogMutationResponseSchema,
    true
  ),
  'administration.server-mcp-update-binding': serverOperation(
    'Update the Server MCP binding and exact Vault grants.',
    UpdateMcpBindingRequestSchema.safeExtend({
      mcpId,
      pinnedSchemaSnapshotId: pinnedSchemaSnapshotId.optional(),
    }),
    CatalogMutationResponseSchema,
    true
  ),
  'administration.server-mcp-remove': serverOperation(
    'Remove Server MCP supply while retaining its history.',
    request.safeExtend({ mcpId, expectedRevision: z.number().int().nonnegative() }),
    CatalogMutationResponseSchema,
    true
  ),
  'vault.server-mcp-secret-create': serverOperation(
    'Create a Server MCP credential from request-only material.',
    request.safeExtend({ material }),
    reference,
    true,
    true
  ),
  'vault.server-mcp-secret-rotate': serverOperation(
    'Rotate a Server MCP credential.',
    referenceRequest.safeExtend({ material }),
    reference,
    true,
    true
  ),
  'vault.server-mcp-secret-revoke': serverOperation(
    'Revoke a Server MCP credential.',
    referenceRequest,
    reference,
    true
  ),
  'vault.server-mcp-reference-list': serverOperation(
    'List Server MCP credential metadata.',
    z.object({}).strict(),
    z.object({ items: z.array(reference) }).strict(),
    false
  ),
  'vault.server-mcp-grant-create': serverOperation(
    'Authorize Gateway-only Server MCP credential use.',
    CreateWorkspaceVaultGrantRequestSchema.omit({ injectionPath: true }).safeExtend({
      requestId: RequestIdSchema,
      referenceId: z.string().min(1),
    }),
    grant,
    true
  ),
  'vault.server-mcp-grant-list': serverOperation(
    'List Server MCP grants.',
    z.object({}).strict(),
    z.object({ items: z.array(grant) }).strict(),
    false
  ),
  'vault.server-mcp-grant-revoke': serverOperation(
    'Revoke a Server MCP grant.',
    grantRequest,
    grant,
    true
  ),
  'vault.server-mcp-grant-narrow': serverOperation(
    'Replace a Server MCP grant with strictly less authority.',
    grantRequest.safeExtend({
      constraints: NarrowWorkspaceVaultGrantRequestSchema.shape.constraints,
    }),
    z.object({ revokedGrant: grant, grant }).strict(),
    true
  ),
  'catalog.shared-mcp-list': {
    description: 'List redacted shared MCP supply and local collisions.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: z.object({ workspaceId: WorkspaceIdSchema }).strict(),
    outputSchema: z
      .object({
        revision: z.number().int().nonnegative(),
        items: z.array(
          McpCatalogEntrySchema.safeExtend({ disabled: z.boolean(), shadowed: z.boolean() })
        ),
      })
      .strict(),
    credentials: ['local-user', 'user-session', 'user-bearer', 'deployment-administrator'],
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'catalog.shared-mcp-set-disabled': {
    description: 'Disable or restore shared MCP supply in the selected Workspace.',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    inputSchema: request.safeExtend({
      workspaceId: WorkspaceIdSchema,
      mcpId,
      disabled: z.boolean(),
      expectedRevision: z.number().int().nonnegative(),
    }),
    outputSchema: CatalogMutationResponseSchema,
    credentials: ['local-user', 'user-session', 'user-bearer', 'deployment-administrator'],
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.configure',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;
