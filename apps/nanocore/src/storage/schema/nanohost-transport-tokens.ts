import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Durable configured NanoHost IntegrationIdentity lifecycle status. */
export type NanoHostIntegrationIdentityStatus = 'active' | 'decommissioned';

/** Durable configured NanoHost IntegrationIdentity projection. */
export const nanohostIntegrationIdentities = sqliteTable('nanohost_integration_identities', {
  /** Configured integration identity id. */
  identityId: text('identity_id').primaryKey().notNull(),
  /** Deployment binding for the configured identity. */
  deploymentId: text('deployment_id').notNull().unique(),
  /** Identity lifecycle status. */
  status: text('status').$type<NanoHostIntegrationIdentityStatus>().notNull(),
  /** Creation timestamp. */
  createdAt: text('created_at').notNull(),
  /** Decommission timestamp when terminal. */
  decommissionedAt: text('decommissioned_at'),
});

/** Closed NanoHost transport Token type stored in Core. */
export type NanoHostTransportTokenType = 'nanohost-transport';

/** Closed NanoHost transport Token scope stored in Core. */
export type NanoHostTransportTokenScope = 'nanohost-transport';

/** Durable NanoHost transport Token lifecycle statuses. */
export type NanoHostTransportTokenStatus = 'active' | 'expired' | 'revoked' | 'rotated';

/**
 * Hash-only NanoHost transport Token metadata projection.
 *
 * Stores non-secret Core Token fields for the dedicated `nanohost-transport`
 * class. Raw `okt_` secrets are never persisted here.
 */
export const nanohostTransportTokens = sqliteTable(
  'nanohost_transport_tokens',
  {
    /** Durable token id. */
    tokenId: text('token_id').primaryKey().notNull(),
    /** Versioned one-way hash of the opaque token secret. */
    tokenHash: text('token_hash').notNull(),
    /** Configured NanoHost IntegrationIdentity id that owns this token. */
    ownerNanohostIdentityId: text('owner_nanohost_identity_id').notNull(),
    /** Closed token type. */
    tokenType: text('token_type').$type<NanoHostTransportTokenType>().notNull(),
    /** Closed token scope. */
    scope: text('scope').$type<NanoHostTransportTokenScope>().notNull(),
    /** Declared deployment binding. */
    deploymentId: text('deployment_id').notNull(),
    /** Token lifecycle status. */
    status: text('status').$type<NanoHostTransportTokenStatus>().notNull(),
    /** Issue timestamp. */
    issuedAt: text('issued_at').notNull(),
    /** Expiration timestamp. */
    expiresAt: text('expires_at').notNull(),
    /** Revocation timestamp when revoked. */
    revokedAt: text('revoked_at'),
    /** Predecessor token id after rotation. */
    predecessorTokenId: text('predecessor_token_id'),
    /** Rotation overlap deadline for the predecessor credential. */
    rotationOverlapExpiresAt: text('rotation_overlap_expires_at'),
    /** Server-admin actor that authorized issuance. */
    responsibleServerAdminActorId: text('responsible_server_admin_actor_id').notNull(),
    /** Redacted last-use timestamp. */
    lastUsedAt: text('last_used_at'),
    /** Redacted last-use channel. */
    lastUsedChannel: text('last_used_channel'),
    /** Redacted last-use source summary. */
    lastUsedSource: text('last_used_source'),
  },
  (table) => [
    uniqueIndex('nanohost_transport_tokens_hash_idx').on(table.tokenHash),
    index('nanohost_transport_tokens_owner_idx').on(
      table.ownerNanohostIdentityId,
      table.deploymentId,
      table.status
    ),
  ]
);
