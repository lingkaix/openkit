import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import type { ProductOperation } from '../policy/workspace-access.js';

/** Public authorization scope declared by one canonical operation. */
export type PublicOperationScope = 'server' | 'user' | 'workspace';

/** Closed direct Workspace-resolution shapes used by Workspace-scoped operations. */
export type PublicOperationResolver =
  | 'actor-quick-chat-workspace'
  | 'authorized-workspace-set'
  | 'body-workspace'
  | 'opaque-child-workspace'
  | 'path-workspace'
  | 'workspace-child-lineage';

/** Authentication owners for non-Workspace public operations. */
export type PublicOperationAuthentication =
  | 'bootstrap-secret'
  | 'canonical-user'
  | 'deployment-admin'
  | 'gateway-actor';

/** Fields shared by every public-operation access declaration. */
interface PublicOperationAccessBase {
  /** Whether the operation may mutate product state or cause an external effect. */
  readonly mutating: boolean;
  /** Product operation evaluated by the policy owner. */
  readonly policyOperation: ProductOperation;
  /** Top-level authorization scope. */
  readonly scope: PublicOperationScope;
}

/** Access declaration for one deployment-scoped operation. */
export interface ServerOperationAccess extends PublicOperationAccessBase {
  /** Route-owned deployment or bootstrap authentication contract. */
  readonly authentication: 'bootstrap-secret' | 'deployment-admin';
  /** Server operations never use a Workspace resolver. */
  readonly resolver?: never;
  /** Deployment-scoped operation discriminator. */
  readonly scope: 'server';
  /** Server operations never use conditional Workspace attribution. */
  readonly workspaceResolver?: never;
}

/** Access declaration for one canonical-user operation. */
export interface UserOperationAccess extends PublicOperationAccessBase {
  /** Canonical-user authentication contract. */
  readonly authentication: 'canonical-user';
  /** Ordinary user operations never use a direct Workspace resolver. */
  readonly resolver?: never;
  /** User-scoped operation discriminator. */
  readonly scope: 'user';
  /** Ordinary user operations never use conditional Workspace attribution. */
  readonly workspaceResolver?: never;
}

/** Access declaration for a Gateway operation with optional Workspace attribution. */
export interface GatewayOperationAccess extends PublicOperationAccessBase {
  /** Gateway-specific actor contract for attributed and unattributed requests. */
  readonly authentication: 'gateway-actor';
  /** Gateway operations never use a direct Workspace resolver. */
  readonly resolver?: never;
  /** User-scoped operation discriminator. */
  readonly scope: 'user';
  /** Optional Workspace attribution resolved only from Gateway metadata. */
  readonly workspaceResolver: 'gateway-metadata-workspace';
}

/** Access declaration for one Workspace-scoped operation. */
export interface WorkspaceOperationAccess extends PublicOperationAccessBase {
  /** Optional deployment-admin authority intersected with current Workspace access. */
  readonly authentication?: 'deployment-admin';
  /** Authoritative Workspace-resolution strategy. */
  readonly resolver: PublicOperationResolver;
  /** Workspace-scoped operation discriminator. */
  readonly scope: 'workspace';
  /** Workspace operations never use conditional Workspace attribution. */
  readonly workspaceResolver?: never;
}

/** Canonical access metadata for one public operation. */
export type PublicOperationAccess =
  | ServerOperationAccess
  | UserOperationAccess
  | GatewayOperationAccess
  | WorkspaceOperationAccess;

/**
 * Adds operation keys that share one explicit authorization declaration.
 *
 * @param catalog Mutable catalog under construction.
 * @param operationKeys Canonical App operation identifiers or direct route keys.
 * @param access Explicit access declaration shared by the named operations.
 * @throws When an operation key is registered more than once.
 */
function registerOperations(
  catalog: Record<string, PublicOperationAccess>,
  operationKeys: readonly string[],
  access: PublicOperationAccess
): void {
  const frozenAccess = Object.freeze(access);
  for (const operationKey of operationKeys) {
    if (Object.hasOwn(catalog, operationKey)) {
      throw new Error(`Duplicate public operation access metadata for ${operationKey}.`);
    }
    catalog[operationKey] = frozenAccess;
  }
}

const catalog: Record<string, PublicOperationAccess> = {};

registerOperations(
  catalog,
  ['getAppDiagnostics', 'getSetupDiagnostics', 'listOpenKitAccessTokens'],
  {
    authentication: 'deployment-admin',
    mutating: false,
    policyOperation: 'api.call',
    scope: 'server',
  }
);
registerOperations(
  catalog,
  ['createOpenKitAccessToken', 'revokeOpenKitAccessToken', 'rotateOpenKitAccessToken'],
  {
    authentication: 'deployment-admin',
    mutating: true,
    policyOperation: 'api.call',
    scope: 'server',
  }
);
registerOperations(catalog, ['consumeOpenKitBootstrapToken'], {
  authentication: 'bootstrap-secret',
  mutating: true,
  policyOperation: 'api.call',
  scope: 'server',
});

registerOperations(catalog, ['dryRunWorkspaceArchiveImport'], {
  authentication: 'canonical-user',
  mutating: false,
  policyOperation: 'workspace.write',
  scope: 'user',
});

registerOperations(catalog, ['listMyAdminAccessTokens'], {
  authentication: 'canonical-user',
  mutating: false,
  policyOperation: 'api.call',
  scope: 'user',
});
registerOperations(catalog, ['setMyAdminAccessTokenDefault'], {
  authentication: 'canonical-user',
  mutating: true,
  policyOperation: 'api.call',
  scope: 'user',
});
registerOperations(catalog, ['importWorkspaceArchive'], {
  authentication: 'canonical-user',
  mutating: true,
  policyOperation: 'workspace.write',
  scope: 'user',
});
registerOperations(catalog, ['POST /v1/chat/completions', 'POST /v1/responses'], {
  authentication: 'gateway-actor',
  mutating: true,
  policyOperation: 'llm.gateway.use',
  scope: 'user',
  workspaceResolver: 'gateway-metadata-workspace',
});

registerOperations(catalog, ['downloadWorkspaceExportArchive'], {
  mutating: false,
  policyOperation: 'workspace.export',
  resolver: 'path-workspace',
  scope: 'workspace',
});
registerOperations(catalog, ['GET /api/workspaces/:workspaceId/threads/:threadId/events'], {
  mutating: false,
  policyOperation: 'thread.read',
  resolver: 'workspace-child-lineage',
  scope: 'workspace',
});

// Migrated declarations are projections, never a second contract or admission path.
for (const [id, definition] of Object.entries(OPERATION_DEFINITIONS)) {
  registerOperations(
    catalog,
    [id],
    definition.scope.kind === 'server'
      ? {
          authentication: 'deployment-admin',
          mutating: definition.mutating,
          policyOperation: definition.policyOperation,
          scope: 'server',
        }
      : definition.scope.kind === 'user'
        ? {
            authentication: 'canonical-user',
            mutating: definition.mutating,
            policyOperation: definition.policyOperation,
            scope: 'user',
          }
        : {
            mutating: definition.mutating,
            policyOperation: definition.policyOperation,
            resolver: definition.scope.kind,
            scope: 'workspace',
          }
  );
}

/** Canonical access metadata for every public App API and direct Core/Gateway operation. */
export const PUBLIC_OPERATION_ACCESS: Readonly<Record<string, PublicOperationAccess>> =
  Object.freeze(catalog);
