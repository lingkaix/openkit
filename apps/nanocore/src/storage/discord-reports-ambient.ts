import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DiscordAmbientResult } from '../channels/discord-ambient.js';

interface Route {
  readonly guildId: string;
  readonly channelId: string;
}
interface CaptureKey extends Route {
  readonly turnId: string;
  readonly bindingRevision: string;
  readonly mentionId: string;
}
interface RevisionRef {
  readonly revisionId: string;
  readonly authorRef: string;
  readonly renderedLabel: string;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

type ReaderSelection = Extract<DiscordAmbientResult, { state: 'selected' }>;
/** The Turn owner passes only messages that survived fitting the final context. */
export type DiscordAmbientFittedSelection =
  | { readonly state: 'unavailable' }
  | (Omit<ReaderSelection, 'messages'> & {
      readonly fitted: readonly (ReaderSelection['messages'][number] & {
        readonly renderedLabel: string;
      })[];
    });

/** Freezes the first attempt. Each selected exact revision is canonical across captures in one channel. */
export function freezeDiscordReportsAmbient(
  db: Database.Database,
  key: CaptureKey,
  observed: DiscordAmbientFittedSelection,
  policy: {
    readonly capturedAt: number;
    readonly captureItemId: string;
    readonly tier: 'basic' | 'expanded';
    readonly sourceAuthor: (account: string) => string | null;
    readonly current: () => boolean;
    readonly mapAuthor: (account: string) => string | null;
  }
): boolean {
  return db
    .transaction(() => {
      if (
        db
          .prepare('SELECT 1 FROM discord_reports_ambient_captures WHERE turn_id = ?')
          .get(key.turnId)
      )
        return false;
      if (policy.current() !== true) return false;
      const insert = db.prepare(`INSERT INTO discord_reports_ambient_captures
      (turn_id,binding_revision,mention_id,state,capture_digest,count_observed_at,approximate_member_count,window_start,captured_at,capture_item_id,tier)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const unavailable = () => {
        insert.run(
          key.turnId,
          key.bindingRevision,
          key.mentionId,
          'unavailable',
          null,
          null,
          null,
          null,
          policy.capturedAt,
          policy.captureItemId,
          policy.tier
        );
        return true;
      };
      if (observed.state !== 'selected') return unavailable();
      const cap =
        observed.approximateMemberCount <= 20
          ? 100
          : observed.approximateMemberCount <= 100
            ? 30
            : 0;
      if (!cap || observed.approximateMemberCount < 1 || observed.fitted.length > cap)
        return unavailable();
      const checkBlocked = db.prepare(`SELECT 1 FROM discord_reports_ambient_revisions
      WHERE guild_id = ? AND channel_id = ? AND message_id = ? AND blocked = 1`);
      const find =
        db.prepare(`SELECT revision_id AS revisionId, posted_at AS postedAt, source_author_ref AS sourceAuthorRef, created_at AS createdAt, body FROM discord_reports_ambient_revisions
      WHERE guild_id = ? AND channel_id = ? AND message_id = ? AND content_digest = ? AND edited_at IS ?`);
      const planned = [];
      const ids = new Set<string>();
      for (const message of [...observed.fitted].sort(
        (a, b) => a.postedAt - b.postedAt || (BigInt(a.messageId) < BigInt(b.messageId) ? -1 : 1)
      )) {
        if (
          ids.has(message.messageId) ||
          checkBlocked.get(key.guildId, key.channelId, message.messageId)
        )
          return unavailable();
        ids.add(message.messageId);
        const authorRef = policy.mapAuthor(message.discordAuthorId);
        const sourceAuthorRef = policy.sourceAuthor(message.discordAuthorId);
        if (!authorRef || !sourceAuthorRef || !message.renderedLabel) return unavailable();
        const digest = hash(message.text);
        const editedAt = message.editedAt;
        const existing = find.get(
          key.guildId,
          key.channelId,
          message.messageId,
          digest,
          editedAt
        ) as
          | {
              revisionId: string;
              postedAt: number;
              sourceAuthorRef: string;
              createdAt: number;
              body: string | null;
            }
          | undefined;
        if (
          existing &&
          (existing.body !== message.text ||
            existing.postedAt !== message.postedAt ||
            existing.sourceAuthorRef !== sourceAuthorRef ||
            existing.createdAt > policy.capturedAt)
        )
          return unavailable();
        planned.push({
          revisionId: existing?.revisionId ?? randomUUID(),
          existing: !!existing,
          message,
          authorRef,
          sourceAuthorRef,
          renderedLabel: message.renderedLabel,
          digest,
          editedAt,
        });
      }
      const refs: RevisionRef[] = planned.map(({ revisionId, authorRef, renderedLabel }) => ({
        revisionId,
        authorRef,
        renderedLabel,
      }));
      insert.run(
        key.turnId,
        key.bindingRevision,
        key.mentionId,
        'selected',
        hash(JSON.stringify(refs)),
        observed.countObservedAt,
        observed.approximateMemberCount,
        observed.windowStart,
        policy.capturedAt,
        policy.captureItemId,
        policy.tier
      );
      const revision = db.prepare(`INSERT INTO discord_reports_ambient_revisions
      (revision_id,guild_id,channel_id,message_id,content_digest,edited_at,posted_at,source_author_ref,created_at,body) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const edge = db.prepare(
        'INSERT INTO discord_reports_ambient_refs (turn_id,ordinal,revision_id,author_ref,rendered_label) VALUES (?,?,?,?,?)'
      );
      for (const [ordinal, item] of planned.entries()) {
        if (!item.existing)
          revision.run(
            item.revisionId,
            key.guildId,
            key.channelId,
            item.message.messageId,
            item.digest,
            item.editedAt,
            item.message.postedAt,
            item.sourceAuthorRef,
            policy.capturedAt,
            item.message.text
          );
        edge.run(key.turnId, ordinal, item.revisionId, item.authorRef, item.renderedLabel);
      }
      return true;
    })
    .immediate();
}

/** Reads only the exact current Turn's frozen capture. Missing or blocked bodies yield no context. */
export function readDiscordReportsAmbient(
  db: Database.Database,
  input: Pick<CaptureKey, 'turnId' | 'bindingRevision' | 'mentionId'>
): {
  readonly digest: string;
  readonly ordered: readonly (RevisionRef & { readonly text: string })[];
} | null {
  return db.transaction(() => {
    const row = db
      .prepare(`SELECT capture_digest AS digest FROM discord_reports_ambient_captures
      WHERE turn_id = ? AND binding_revision = ? AND mention_id = ? AND state = 'selected'`)
      .get(input.turnId, input.bindingRevision, input.mentionId) as { digest: string } | undefined;
    if (!row) return null;
    const edges = db
      .prepare(`SELECT refs.revision_id AS revisionId, refs.author_ref AS authorRef, refs.rendered_label AS renderedLabel, revisions.body AS text,
      revisions.blocked, revisions.content_digest AS contentDigest FROM discord_reports_ambient_refs refs
      JOIN discord_reports_ambient_revisions revisions ON revisions.revision_id = refs.revision_id
      WHERE refs.turn_id = ? ORDER BY refs.ordinal`)
      .all(input.turnId) as (RevisionRef & {
      text: string | null;
      blocked: number;
      contentDigest: string;
    })[];
    const ordered: (RevisionRef & { text: string })[] = [];
    for (const { revisionId, authorRef, renderedLabel, text, contentDigest, blocked } of edges) {
      if (blocked || text === null || hash(text) !== contentDigest) return null;
      ordered.push({ revisionId, authorRef, renderedLabel, text });
    }
    if (
      hash(
        JSON.stringify(
          ordered.map(({ revisionId, authorRef, renderedLabel }) => ({
            revisionId,
            authorRef,
            renderedLabel,
          }))
        )
      ) !== row.digest
    )
      return null;
    return { digest: row.digest, ordered };
  })();
}

/** Blocks every capture that referenced any revision. The Storage owner fences dependent copies in this transaction. */
export function blockDiscordReportsAmbientMessage(
  db: Database.Database,
  selected: Route & { readonly messageId: string },
  authority: {
    readonly canDelete: () => boolean;
    readonly fenceDerived: (affectedTurnIds: readonly string[]) => boolean;
    readonly isHeld: (revisionId: string) => boolean;
  }
): {
  readonly affectedTurns: number;
  readonly bodiesDeleted: number;
  readonly bodiesHeld: number;
} | null {
  return db
    .transaction(() => {
      if (authority.canDelete() !== true) return null;
      const keys = [selected.guildId, selected.channelId, selected.messageId];
      const revisions = db
        .prepare(`SELECT revision_id AS revisionId FROM discord_reports_ambient_revisions
      WHERE guild_id = ? AND channel_id = ? AND message_id = ?`)
        .all(...keys) as { revisionId: string }[];
      const turns = db
        .prepare(`SELECT DISTINCT refs.turn_id AS turnId FROM discord_reports_ambient_refs refs
      JOIN discord_reports_ambient_revisions revisions ON revisions.revision_id = refs.revision_id
      WHERE revisions.guild_id = ? AND revisions.channel_id = ? AND revisions.message_id = ?`)
        .all(...keys) as { turnId: string }[];
      if (authority.fenceDerived(turns.map(({ turnId }) => turnId)) !== true) return null;
      const blockCapture = db.prepare(
        "UPDATE discord_reports_ambient_captures SET state = 'blocked' WHERE turn_id = ?"
      );
      for (const { turnId } of turns) blockCapture.run(turnId);
      const remove = db.prepare(
        'UPDATE discord_reports_ambient_revisions SET blocked = 1, body = NULL WHERE revision_id = ? AND body IS NOT NULL'
      );
      const hold = db.prepare(
        'UPDATE discord_reports_ambient_revisions SET blocked = 1 WHERE revision_id = ? AND body IS NOT NULL'
      );
      let bodiesHeld = 0;
      let bodiesDeleted = 0;
      for (const { revisionId } of revisions) {
        if (authority.isHeld(revisionId) === true) bodiesHeld += hold.run(revisionId).changes;
        else bodiesDeleted += remove.run(revisionId).changes;
      }
      return { affectedTurns: turns.length, bodiesDeleted, bodiesHeld };
    })
    .immediate();
}
