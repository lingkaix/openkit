import {
  RequestIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { DiscordSnowflakeSchema } from '../channels/discord-snowflake.js';
import { OperationError } from '../operation-error.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Instant = z.number().int().nonnegative().safe();
const DisclosureKey = z.object({
  tokenDigest: Digest,
  externalAccountId: DiscordSnowflakeSchema,
  bindingRevision: RequestIdSchema,
  userId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  pendingRequestId: z.string().min(1),
});
const Disclosure = z.object({
  kind: z.enum(['approval', 'user-input']),
  contentDigest: Digest,
  expiresAt: Instant,
});
export const CommunicationDisclosureWriteSchema = DisclosureKey.extend(Disclosure.shape).strict();

export type CommunicationDisclosureKey = z.infer<typeof DisclosureKey>;
export type CommunicationDisclosureWrite = z.infer<typeof CommunicationDisclosureWriteSchema>;

/** Reads only the current exact disclosure and its still-active binding revision. */
export function readCommunicationDisclosure(
  sqlite: Database.Database,
  input: CommunicationDisclosureKey,
  now: number
): z.infer<typeof Disclosure> | null {
  const key = DisclosureKey.parse(input);
  const row = sqlite
    .prepare(`
      SELECT d.kind, d.content_digest AS contentDigest, d.expires_at AS expiresAt
      FROM channel_disclosures d
      JOIN channel_account_bindings b
        ON b.channel_kind = d.channel_kind AND b.revision = d.binding_revision
        AND b.external_account_id = d.external_account_id
      WHERE d.channel_kind = 'discord' AND d.token_digest = @tokenDigest
        AND d.external_account_id = @externalAccountId AND d.binding_revision = @bindingRevision
        AND b.user_id = @userId AND b.revoked_at IS NULL
        AND d.workspace_id = @workspaceId AND d.thread_id = @threadId
        AND d.pending_request_id = @pendingRequestId AND d.expires_at > @now
    `)
    .get({ ...key, now: Instant.parse(now) });
  return row === undefined ? null : Disclosure.parse(row);
}

/** Persists only digests and exact lineage while the admitted binding is still active. */
export function writeCommunicationDisclosureInDb(
  sqlite: Database.Database,
  input: CommunicationDisclosureWrite,
  now: number
): void {
  const disclosure = CommunicationDisclosureWriteSchema.parse(input);
  const inserted = sqlite
    .prepare(`
      INSERT INTO channel_disclosures(
        token_digest, channel_kind, external_account_id, binding_revision, workspace_id,
        thread_id, pending_request_id, kind, content_digest, expires_at
      )
      SELECT @tokenDigest, channel_kind, external_account_id, revision, @workspaceId,
        @threadId, @pendingRequestId, @kind, @contentDigest, @expiresAt
      FROM channel_account_bindings
      WHERE channel_kind = 'discord' AND revision = @bindingRevision
        AND external_account_id = @externalAccountId AND user_id = @userId
        AND revoked_at IS NULL AND @expiresAt > @now
    `)
    .run({ ...disclosure, now: Instant.parse(now) });
  if (inserted.changes !== 1) {
    throw new OperationError(
      'channel_disclosure_unavailable',
      'Current disclosure unavailable.',
      409
    );
  }
}
