import type { VaultBackend } from './vault-backend.js';
import type { VaultGrantRecord } from './vault-grants.js';
import type { VaultReferenceRecord } from './vault-references.js';

/** Classifies the bounded shared-MCP family without admitting other Server credential lifecycles. */
export function isServerMcpReference(
  value: VaultReferenceRecord | null
): value is VaultReferenceRecord {
  return (
    value !== null &&
    value.ownerScope === 'server' &&
    value.workspaceId === null &&
    value.userId === null &&
    value.secretKind === 'mcp-credential'
  );
}

/** Requires the same active material identity and owner in Core and the existing backend inventory. */
export function isCurrentServerMcpMaterial(
  backend: VaultBackend,
  reference: VaultReferenceRecord
): boolean {
  if (
    backend.health().state !== 'available' ||
    !isServerMcpReference(reference) ||
    reference.status !== 'active'
  )
    return false;
  const inventory = backend
    .listReferences({ ownerScope: 'server' })
    .find((item) => item.referenceId === reference.referenceId);
  return (
    inventory !== undefined &&
    !inventory.revoked &&
    inventory.ownerScope === 'server' &&
    inventory.workspaceId === undefined &&
    inventory.userId === undefined &&
    inventory.providerSubscriptionAccount === undefined &&
    inventory.currentVersion === reference.currentVersion &&
    inventory.backendKind === reference.backendKind &&
    reference.backendKind === backend.kind &&
    reference.backendLocator === `${backend.kind}://server/vault/${reference.referenceId}`
  );
}

/** Classifies the existing Server Gateway grant partition without strengthening revocation to active-only. */
export function isServerMcpGrant(value: VaultGrantRecord | null): value is VaultGrantRecord & {
  ownerScope: 'server';
  workspaceId: null;
  userId: null;
  lifetime: 'server';
} {
  return (
    value !== null &&
    value.ownerScope === 'server' &&
    value.workspaceId === null &&
    value.userId === null &&
    value.lifetime === 'server' &&
    value.allowedInjectionPaths.length === 1 &&
    value.allowedInjectionPaths[0] === 'gateway-only'
  );
}
