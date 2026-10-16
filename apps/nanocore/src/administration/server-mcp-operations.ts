import type { SERVER_MCP_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { digestMcpConfig, McpValidatedDeclarationSchema } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { z } from 'zod';
import { listServerAuditEvents, recordServerAuditEvent } from '../audit-events.js';
import { requireCurrentDeploymentAdmin } from '../auth/operation-authorizer.js';
import { mcpEntries } from '../catalog/catalog-operations.js';
import {
  CatalogConflictError,
  CatalogForbiddenError,
  CatalogIntegrityError,
  CatalogNotFoundError,
  createMcpConfig,
  loadResourceCatalog,
  McpBindingValidationError,
  removeMcpEntry,
  selectMcpVersion,
  setSharedMcpDisabled,
  updateMcpBinding,
} from '../catalog/resource-catalog.js';
import type { CommandRequestName, CommandRequestResponseKind } from '../lib/store.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import {
  type AdmittedOperationContext,
  type FamilyImplementations,
  publicOperationActor,
} from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import { isCurrentServerMcpMaterial, isServerMcpReference } from '../vault/server-mcp-authority.js';
import {
  createVaultGrant,
  getVaultGrant,
  listVaultGrants,
  narrowVaultGrant,
  revokeVaultGrant,
  VaultGrantNarrowingError,
} from '../vault/vault-grants.js';
import {
  advanceActiveVaultReferenceVersion,
  createVaultReferenceWithInsertEvidence,
  getVaultReference,
  listVaultReferences,
  revokeVaultReference,
  type VaultReferenceRecord,
} from '../vault/vault-references.js';

/** Server-shared MCP administration uses the existing catalog CAS, Core Vault records, receipts and Audit. */
export function createServerMcpOperationImplementations(
  dependencies: OperationInvocationDependencies
) {
  const { coreDb, store, inflightCommands } = dependencies;
  const root = () => {
    const dataRoot = dependencies.dataRoot ?? store?.getDataRoot();
    if (!dataRoot || !coreDb || !store || !inflightCommands)
      throw new OperationError('storage_unavailable', 'Server MCP storage is unavailable.', 503);
    return dataRoot;
  };
  const server = () => loadResourceCatalog(root(), { kind: 'server' });
  const reference = (id: string) => {
    const value = getVaultReference(coreDb!, id);
    if (!isServerMcpReference(value))
      throw new OperationError('vault_reference_not_found', 'Server MCP reference not found.', 404);
    return value;
  };
  const grant = (id: string) => {
    const value = getVaultGrant(coreDb!, id);
    if (
      !value ||
      value.ownerScope !== 'server' ||
      value.workspaceId !== null ||
      value.userId !== null ||
      value.lifetime !== 'server' ||
      value.allowedInjectionPaths.length !== 1 ||
      value.allowedInjectionPaths[0] !== 'gateway-only'
    )
      throw new OperationError('vault_grant_not_found', 'Server MCP grant not found.', 404);
    reference(value.vaultReferenceId);
    return {
      ...value,
      ownerScope: 'server' as const,
      workspaceId: null,
      userId: null,
      lifetime: 'server' as const,
    };
  };
  const entry = (id: string) => {
    const catalog = server();
    const value = mcpEntries(catalog).find((item) => item.id === id);
    if (!value) throw new CatalogNotFoundError('Server MCP entry not found.');
    return value;
  };
  const backend = () => {
    const value = dependencies.vaultUnlockState?.backend();
    if (!value || value.health().state !== 'available')
      throw new OperationError(
        'vault_backend_not_available',
        'Vault backend is not available.',
        423
      );
    return value;
  };
  const currentBackendReference = (id: string) => {
    const value = reference(id);
    const vault = backend();
    if (!isCurrentServerMcpMaterial(vault, value))
      throw new OperationError(
        'recovery_required',
        'Server MCP credential requires inspection.',
        409
      );
    return { value, vault };
  };

  /** A pre-effect Audit marker fences missing receipts without claiming file, backend and SQL atomicity. */
  const command = async <T>(
    input: { requestId: string; grantId?: string; referenceId?: string },
    context: AdmittedOperationContext,
    name: CommandRequestName,
    kind: CommandRequestResponseKind,
    execute: () => T | Promise<T>,
    replay: (id: string) => T,
    responseId: (result: T) => string,
    workspaceId?: string
  ): Promise<T> => {
    root();
    const actor = publicOperationActor(context);
    if (!workspaceId) requireCurrentDeploymentAdmin(coreDb!, actor);
    const scope = {
      actorId: actor.userId,
      ...(workspaceId ? { workspaceId } : { coreId: 'server' }),
    };
    const marker = `mcp-command:${commandInputHash({ name, scope, requestId: input.requestId })}`;
    try {
      return await runIdempotentCommand({
        store: store!,
        inflightCommands: inflightCommands!,
        command: name,
        requestId: input.requestId,
        scope,
        input,
        responseKind: kind,
        responseId,
        replay: (record) => replay(record.response.id),
        execute: async () => {
          if (!workspaceId) requireCurrentDeploymentAdmin(coreDb!, actor);
          if (listServerAuditEvents(coreDb!).some((event) => event.resource === marker))
            throw new OperationError(
              'recovery_required',
              'A prior Server MCP effect requires inspection. Do not repeat it.',
              409
            );
          recordServerAuditEvent({
            coreDb: coreDb!,
            actor: { kind: 'user', id: actor.userId },
            workspaceId: workspaceId ?? null,
            requestId: input.requestId,
            action: name,
            resource: marker,
            outcome: 'unknown',
            summary:
              'Server MCP command started; inspect the current resource if no receipt is available.',
          });
          const result = await execute();
          recordServerAuditEvent({
            coreDb: coreDb!,
            actor: { kind: 'user', id: actor.userId },
            workspaceId: workspaceId ?? null,
            requestId: input.requestId,
            action: name,
            resource: `${kind}:${responseId(result)}`,
            ...(kind === 'vault_grant' ? { vaultGrantId: responseId(result) } : {}),
            outcome: 'succeeded',
            summary: 'Server MCP command completed.',
          });
          return result;
        },
      });
    } catch (error) {
      fail(error);
    }
  };
  const create = (
    input: Parameters<
      FamilyImplementations<
        typeof SERVER_MCP_OPERATION_DEFINITIONS
      >['administration.server-mcp-create']
    >[0] & { mcpId?: string },
    context: AdmittedOperationContext,
    stage: boolean
  ) =>
    command(
      input,
      context,
      stage ? 'administration.server-mcp-stage-version' : 'administration.server-mcp-create',
      'catalog_mcp',
      async () => {
        if (stage && !server().mcp.entries.some((item) => item.id === input.mcpId))
          throw new CatalogNotFoundError('Server MCP entry not found.');
        const result = createMcpConfig({
          allowedTools: input.allowedTools,
          declaration: input.declaration,
          displayName: input.displayName,
          expectedRevision: input.expectedRevision,
          ...(input.id ? { id: input.id } : {}),
          dataRoot: root(),
          owner: { kind: 'server' },
          createdAt: new Date().toISOString(),
          selectCurrent: !stage,
          ...(stage ? { id: input.mcpId! } : {}),
          stdioHostAuthorized: true,
        });
        await dependencies.closeServerMcpSessions?.(undefined, result.version.entryId);
        return {
          entry: entry(result.version.entryId),
          revision: result.catalog.revision,
          versionDigest: result.version.digest,
        };
      },
      (id) => {
        const digest = digestMcpConfig(
          McpValidatedDeclarationSchema.parse(input.declaration),
          null
        );
        if (
          !server().mcp.versions.some(
            (version) => version.entryId === id && version.digest === digest
          )
        )
          throw new CatalogIntegrityError('Retained MCP version is unavailable.');
        return { entry: entry(id), revision: server().revision, versionDigest: digest };
      },
      (result) => result.entry.id
    );

  return {
    'administration.server-mcp-list': () => ({
      entries: mcpEntries(server()),
      revision: server().revision,
    }),
    'administration.server-mcp-read': (input) => {
      const catalog = server();
      const selected = mcpEntries(catalog).find((item) => item.id === input.mcpId);
      if (!selected) throw new OperationError('not_found', 'Server MCP entry not found.', 404);
      const binding = catalog.mcp.bindings.find((item) => item.entryId === input.mcpId);
      return {
        entry: selected,
        revision: catalog.revision,
        credentialBindings: binding?.credentialBindings ?? [],
        pinnedSchemaSnapshotId: binding?.pinnedSchemaSnapshotId ?? null,
        versions: catalog.mcp.versions
          .filter((version) => version.entryId === input.mcpId)
          .map((version) => ({
            digest: version.digest,
            createdAt: version.createdAt,
            declaration: version.declaration,
            packageRootDigest: version.packageRootDigest,
          })),
      };
    },
    'administration.server-mcp-create': (input, context) => create(input, context, false),
    'administration.server-mcp-stage-version': (input, context) => create(input, context, true),
    'administration.server-mcp-select-version': (input, context) =>
      command(
        input,
        context,
        'administration.server-mcp-select-version',
        'catalog_mcp',
        async () => {
          const result = selectMcpVersion({
            ...input,
            dataRoot: root(),
            owner: { kind: 'server' },
            entryId: input.mcpId,
            stdioHostAuthorized: true,
          });
          await dependencies.closeServerMcpSessions?.(undefined, input.mcpId);
          return { revision: result.revision };
        },
        (id) => {
          entry(id);
          return { revision: server().revision };
        },
        () => input.mcpId
      ),
    'administration.server-mcp-update-binding': (input, context) =>
      command(
        input,
        context,
        'administration.server-mcp-update-binding',
        'catalog_mcp',
        async () => {
          const catalog = server();
          if (
            !catalog.mcp.entries.some(
              (item) => item.id === input.mcpId && item.availability === 'available'
            )
          )
            throw new CatalogNotFoundError('Server MCP entry not found.');
          const previous = catalog.mcp.bindings.find((item) => item.entryId === input.mcpId);
          const credentials = input.credentialBindings ?? previous?.credentialBindings ?? [];
          for (const binding of credentials) {
            const authority = grant(binding.vaultGrantId);
            currentBackendReference(authority.vaultReferenceId);
            if (
              authority.status !== 'active' ||
              (authority.expiresAt && Date.parse(authority.expiresAt) <= Date.now())
            )
              throw new OperationError(
                'vault_grant_not_active',
                'Server MCP grant is not active.',
                409
              );
          }
          const result = updateMcpBinding({
            dataRoot: root(),
            owner: { kind: 'server' },
            entryId: input.mcpId,
            expectedRevision: input.expectedRevision,
            binding: {
              allowedTools: input.allowedTools,
              approvalRequiredTools: input.approvalRequiredTools,
              deniedTools: input.deniedTools,
              credentialBindings: credentials,
              enabled: input.enabled,
              revision: input.bindingRevision,
              pinnedSchemaSnapshotId:
                input.pinnedSchemaSnapshotId !== undefined
                  ? input.pinnedSchemaSnapshotId
                  : (previous?.pinnedSchemaSnapshotId ?? null),
              schemaPolicy: input.schemaPolicy,
              timeoutMs: input.timeoutMs,
            },
          });
          await dependencies.closeServerMcpSessions?.(undefined, input.mcpId);
          return { revision: result.revision };
        },
        (id) => {
          entry(id);
          return { revision: server().revision };
        },
        () => input.mcpId
      ),
    'administration.server-mcp-remove': (input, context) =>
      command(
        input,
        context,
        'administration.server-mcp-remove',
        'catalog_mcp',
        async () => {
          const result = removeMcpEntry({ ...input, dataRoot: root(), owner: { kind: 'server' } });
          await dependencies.closeServerMcpSessions?.(undefined, input.mcpId);
          return { revision: result.revision };
        },
        (id) => {
          entry(id);
          return { revision: server().revision };
        },
        () => input.mcpId
      ),
    'vault.server-mcp-reference-list': () => {
      root();
      return {
        items: listVaultReferences(coreDb!).filter(isServerMcpReference).map(projectReference),
      };
    },
    'vault.server-mcp-secret-create': (input, context) =>
      command(
        input,
        context,
        'vault.server-mcp-secret-create',
        'vault_reference',
        () => {
          const vault = backend();
          const referenceId = allocateEntityId('vault');
          recordServerAuditEvent({
            coreDb: coreDb!,
            actor: { kind: 'user', id: publicOperationActor(context).userId },
            requestId: input.requestId,
            action: 'vault.server-mcp-secret-create',
            resource: `vault-reference:${referenceId}`,
            outcome: 'unknown',
            summary:
              'Shared MCP material storage started; inspect this exact reference and backend inventory if no receipt is available.',
          });
          const inventory = vault.store({
            referenceId,
            material: input.material,
            metadata: { ownerScope: 'server' },
          });
          if (inventory.currentVersion !== 1 || inventory.revoked)
            throw new OperationError(
              'recovery_required',
              'Server MCP credential requires inspection.',
              409
            );
          const result = createVaultReferenceWithInsertEvidence(coreDb!, {
            referenceId,
            ownerScope: 'server',
            secretKind: 'mcp-credential',
            displayName: 'Shared MCP credential',
            backendKind: vault.kind,
            backendLocator: `${vault.kind}://server/vault/${referenceId}`,
          });
          if (!result.inserted)
            throw new OperationError(
              'recovery_required',
              'Server MCP credential requires inspection.',
              409
            );
          return projectReference(result.reference);
        },
        (id) => projectReference(reference(id)),
        (result) => result.referenceId
      ),
    'vault.server-mcp-secret-rotate': (input, context) =>
      command(
        input,
        context,
        'vault.server-mcp-secret-rotate',
        'vault_reference',
        async () => {
          const { vault } = currentBackendReference(input.referenceId);
          const result = vault.rotate({ referenceId: input.referenceId, material: input.material });
          const updated = projectReference(
            advanceActiveVaultReferenceVersion(coreDb!, {
              referenceId: input.referenceId,
              currentVersion: result.currentVersion,
            })
          );
          await dependencies.closeServerMcpSessions?.();
          return updated;
        },
        (id) => projectReference(reference(id)),
        (result) => result.referenceId
      ),
    'vault.server-mcp-secret-revoke': (input, context) =>
      command(
        input,
        context,
        'vault.server-mcp-secret-revoke',
        'vault_reference',
        async () => {
          reference(input.referenceId);
          // Metadata first fences future use even when backend revocation or session cleanup fails.
          const result = revokeVaultReference(coreDb!, { referenceId: input.referenceId });
          try {
            backend().revoke({ referenceId: input.referenceId });
          } finally {
            await dependencies.closeServerMcpSessions?.();
          }
          return projectReference(result);
        },
        (id) => projectReference(reference(id)),
        (result) => result.referenceId
      ),
    'vault.server-mcp-grant-create': (input, context) =>
      command(
        input,
        context,
        'vault.server-mcp-grant-create',
        'vault_grant',
        () => {
          currentBackendReference(input.referenceId);
          if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
            throw new OperationError('invalid_request', 'Grant expiry must be in the future.', 400);
          const created = createVaultGrant(coreDb!, {
            grantId: allocateEntityId('grant'),
            vaultReferenceId: input.referenceId,
            ownerScope: 'server',
            lifetime: 'server',
            allowedInjectionPaths: ['gateway-only'],
            subjectSummary: 'Shared MCP Gateway-only credential',
            targetAgentId: input.targetAgentId ?? null,
            targetAgentSessionId: input.targetAgentSessionId ?? null,
            targetCapabilityId: input.targetCapabilityId ?? null,
            expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
          });
          return grant(created.grantId);
        },
        grant,
        (result) => result.grantId
      ),
    'vault.server-mcp-grant-list': () => {
      root();
      return {
        items: listVaultGrants(coreDb!)
          .filter(
            (item) =>
              item.ownerScope === 'server' &&
              getVaultReference(coreDb!, item.vaultReferenceId)?.secretKind === 'mcp-credential'
          )
          .map((item) => grant(item.grantId)),
      };
    },
    'vault.server-mcp-grant-revoke': (input, context) =>
      command(
        input,
        context,
        'vault.server-mcp-grant-revoke',
        'vault_grant',
        async () => {
          grant(input.grantId);
          const result = revokeVaultGrant(coreDb!, { grantId: input.grantId });
          await dependencies.closeServerMcpSessions?.();
          return grant(result.grantId);
        },
        grant,
        (result) => result.grantId
      ),
    'vault.server-mcp-grant-narrow': (input, context) =>
      command(
        input,
        context,
        'vault.server-mcp-grant-narrow',
        'vault_grant',
        async () => {
          grant(input.grantId);
          const result = coreDb!.sqlite.transaction(() => {
            const narrowed = narrowVaultGrant(coreDb!, {
              grantId: input.grantId,
              replacementGrantId: allocateEntityId('grant'),
              constraints: input.constraints,
            });
            recordServerAuditEvent({
              coreDb: coreDb!,
              actor: { kind: 'user', id: publicOperationActor(context).userId },
              requestId: input.requestId,
              action: 'vault.server-mcp-grant-narrow',
              outcome: 'succeeded',
              resource: `vault-grant:${input.grantId}`,
              vaultGrantId: narrowed.grant.grantId,
              summary:
                'Server MCP grant narrowed through replacement. Explicit binding update is required.',
            });
            return narrowed;
          })();
          await dependencies.closeServerMcpSessions?.();
          return {
            revokedGrant: grant(result.revokedGrant.grantId),
            grant: grant(result.grant.grantId),
          };
        },
        (id) => ({ revokedGrant: grant(input.grantId), grant: grant(id) }),
        (result) => result.grant.grantId
      ),
    'catalog.shared-mcp-list': (input) => {
      const local = loadResourceCatalog(root(), {
        kind: 'workspace',
        workspaceId: input.workspaceId,
      });
      return {
        revision: local.revision,
        items: mcpEntries(server()).map((item) => ({
          ...item,
          disabled: local.mcp.disabledServerIds.includes(item.id),
          shadowed: local.mcp.entries.some((entry) => entry.id === item.id),
        })),
      };
    },
    'catalog.shared-mcp-set-disabled': (input, context) =>
      command(
        input,
        context,
        'catalog.shared-mcp-set-disabled',
        'catalog_mcp',
        async () => {
          const result = setSharedMcpDisabled({ ...input, dataRoot: root() });
          await dependencies.closeServerMcpSessions?.(input.workspaceId, input.mcpId);
          return { revision: result.revision };
        },
        () => ({
          revision: loadResourceCatalog(root(), {
            kind: 'workspace',
            workspaceId: input.workspaceId,
          }).revision,
        }),
        () => input.mcpId,
        input.workspaceId
      ),
  } satisfies FamilyImplementations<typeof SERVER_MCP_OPERATION_DEFINITIONS>;
}

/** Public results contain only MCP-specific reference metadata. */
function projectReference(value: VaultReferenceRecord) {
  return {
    referenceId: value.referenceId,
    ownerScope: 'server' as const,
    workspaceId: null,
    secretKind: 'mcp-credential' as const,
    backendKind: value.backendKind,
    currentVersion: value.currentVersion,
    status: value.status,
  };
}

/** Never publish backend messages, which can contain material or credential-bearing endpoints. */
function fail(error: unknown): never {
  if (error instanceof OperationError) throw error;
  if (error instanceof CatalogConflictError)
    throw new OperationError('conflict', 'Catalog revision conflict.', 409);
  if (error instanceof CatalogNotFoundError)
    throw new OperationError('not_found', 'Server MCP entry not found.', 404);
  if (error instanceof CatalogForbiddenError)
    throw new OperationError('forbidden', 'Server MCP operation denied.', 403);
  if (error instanceof IdempotencyKeyConflictError)
    throw new OperationError(error.code, error.message, error.status);
  if (error instanceof VaultGrantNarrowingError)
    throw new OperationError('invalid_request', error.message, error.status);
  if (error instanceof z.ZodError || error instanceof McpBindingValidationError)
    throw new OperationError(
      'invalid_request',
      'Invalid Server MCP declaration, binding or grant constraints.',
      400
    );
  if (error instanceof CatalogIntegrityError)
    throw new OperationError('recovery_required', 'Catalog authority requires inspection.', 409);
  throw new OperationError(
    'recovery_required',
    'Server MCP operation could not complete. Inspect current resources before another request.',
    409
  );
}
