import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  changeDiscordReportsBinding,
  changeDiscordReportsTier,
  createDiscordReportsDraft,
  type DiscordReportsBinding,
  type DiscordReportsMutationAuthority,
  type DiscordReportsParticipant,
  type DiscordReportsTarget,
  readDiscordReportsBinding,
} from '../channels/discord-reports-binding.js';

export type DiscordReportsOperatorCommand =
  | { readonly operation: 'create'; readonly target: DiscordReportsTarget }
  | { readonly operation: 'read'; readonly bindingId: string }
  | {
      readonly operation: 'activate' | 'revoke';
      readonly bindingId: string;
      readonly expectedRevision: string;
    }
  | {
      readonly operation: 'narrow';
      readonly bindingId: string;
      readonly expectedRevision: string;
      readonly roles: DiscordReportsTarget['roles'];
      readonly collectionSetRevision: string;
    }
  | {
      readonly operation: 'tier';
      readonly bindingId: string;
      readonly principalId: string;
      readonly expectedRevision: string;
      readonly expectedTierRevision: string;
      readonly tier: 'basic' | 'expanded';
    };

export type DiscordReportsOperatorResult = DiscordReportsBinding | DiscordReportsParticipant | null;

type Authority = Omit<DiscordReportsMutationAuthority, 'routeIsFree'>;
const columns = `binding_id AS bindingId, binding_revision AS bindingRevision, guild_id AS guildId,
  channel_id AS channelId, bot_user_id AS botUserId, state, target_json AS targetJson`;
type Row = Pick<
  DiscordReportsBinding,
  'bindingId' | 'bindingRevision' | 'guildId' | 'channelId' | 'botUserId' | 'state'
> & { targetJson: string };

/** Rejects unknown state without accepting duplicate authority fields in the JSON payload. */
function decode(row: unknown): DiscordReportsBinding | null {
  if (!row) return null;
  const { targetJson, ...fixed } = row as Row;
  try {
    return readDiscordReportsBinding({ ...JSON.parse(targetJson), ...fixed });
  } catch {
    return null;
  }
}

function targetJson(binding: DiscordReportsBinding): string {
  const { audienceRef, workspaceId, accountableUserId, roles, collectionSetRevision } = binding;
  return JSON.stringify({
    audienceRef,
    workspaceId,
    accountableUserId,
    roles,
    collectionSetRevision,
  });
}

function retainRevision(sqlite: Database.Database, binding: DiscordReportsBinding): void {
  sqlite
    .prepare(`INSERT INTO discord_reports_binding_revisions
    (binding_id,binding_revision,state,target_json) VALUES (?,?,?,?)`)
    .run(binding.bindingId, binding.bindingRevision, binding.state, targetJson(binding));
}

/** Historical readback is evidence only and never activates a superseded revision. */
export function readDiscordReportsBindingRevision(
  sqlite: Database.Database,
  bindingId: string,
  revision: string
): DiscordReportsBinding | null {
  return decode(
    sqlite
      .prepare(`SELECT b.binding_id AS bindingId, r.binding_revision AS bindingRevision,
    b.guild_id AS guildId, b.channel_id AS channelId, b.bot_user_id AS botUserId, r.state, r.target_json AS targetJson
    FROM discord_reports_binding_revisions r JOIN discord_reports_bindings b ON b.binding_id = r.binding_id
    WHERE r.binding_id = ? AND r.binding_revision = ?`)
      .get(bindingId, revision)
  );
}

/** Selects one routable record by exact route; this is not proof of current publication or ask authority. */
export function readActiveDiscordReportsBinding(
  sqlite: Database.Database,
  route: Pick<DiscordReportsTarget, 'guildId' | 'channelId' | 'botUserId'>
): DiscordReportsBinding | null {
  return decode(
    sqlite
      .prepare(`SELECT ${columns} FROM discord_reports_bindings
    WHERE state = 'active' AND guild_id = ? AND channel_id = ? AND bot_user_id = ?`)
      .get(route.guildId, route.channelId, route.botUserId)
  );
}

/** Applies one operator operation on the native Core writer. Replay or a second writer cannot widen it. */
export function applyDiscordReportsOperatorCommand(
  sqlite: Database.Database,
  command: DiscordReportsOperatorCommand,
  currentAuthority: Authority
): DiscordReportsOperatorResult {
  return sqlite
    .transaction((): DiscordReportsOperatorResult => {
      const authority: DiscordReportsMutationAuthority = {
        ...currentAuthority,
        routeIsFree: (target, except) => {
          const active = readActiveDiscordReportsBinding(sqlite, target);
          return !active || active.bindingId === except;
        },
      };
      if (command.operation === 'create') {
        const draft = createDiscordReportsDraft(
          { ...command.target, bindingId: randomUUID(), bindingRevision: randomUUID() },
          authority
        );
        if (!draft) return null;
        sqlite
          .prepare(`INSERT INTO discord_reports_bindings
        (binding_id,binding_revision,guild_id,channel_id,bot_user_id,state,target_json) VALUES (?,?,?,?,?,?,?)`)
          .run(
            draft.bindingId,
            draft.bindingRevision,
            draft.guildId,
            draft.channelId,
            draft.botUserId,
            draft.state,
            targetJson(draft)
          );
        retainRevision(sqlite, draft);
        return draft;
      }
      const saved = decode(
        sqlite
          .prepare(`SELECT ${columns} FROM discord_reports_bindings WHERE binding_id = ?`)
          .get(command.bindingId)
      );
      if (!saved) return null;
      if (command.operation === 'read') return authority.manage(saved) === true ? saved : null;
      if (command.operation === 'tier') {
        const before = sqlite
          .prepare(`SELECT binding_id AS bindingId, principal_id AS principalId, tier, tier_revision AS tierRevision
        FROM discord_reports_participants WHERE binding_id = ? AND principal_id = ?`)
          .get(saved.bindingId, command.principalId);
        const next = changeDiscordReportsTier(
          saved,
          before,
          {
            ...command,
            expectedBindingRevision: command.expectedRevision,
            nextTierRevision: randomUUID(),
          },
          authority
        );
        if (!next) return null;
        return sqlite
          .prepare(`UPDATE discord_reports_participants SET tier = ?, tier_revision = ?
        WHERE binding_id = ? AND principal_id = ? AND tier_revision = ?`)
          .run(
            next.tier,
            next.tierRevision,
            next.bindingId,
            next.principalId,
            command.expectedTierRevision
          ).changes === 1
          ? next
          : null;
      }
      const next = changeDiscordReportsBinding(
        saved,
        { ...command, nextRevision: randomUUID() },
        authority
      );
      if (!next) return null;
      const changed =
        sqlite
          .prepare(`UPDATE discord_reports_bindings SET binding_revision = ?, state = ?, target_json = ?
      WHERE binding_id = ? AND binding_revision = ?`)
          .run(
            next.bindingRevision,
            next.state,
            targetJson(next),
            saved.bindingId,
            command.expectedRevision
          ).changes === 1;
      if (!changed) return null;
      retainRevision(sqlite, next);
      return next;
    })
    .immediate();
}

/** Maps an admitted human account to one basic principal. Call within the native admission transaction. */
export function getOrCreateDiscordReportsPrincipal(
  sqlite: Database.Database,
  expected: Pick<DiscordReportsBinding, 'bindingId' | 'bindingRevision'>,
  discordUserId: string
): DiscordReportsParticipant | null {
  if (!sqlite.inTransaction || !/^[1-9][0-9]{0,19}$/.test(discordUserId)) return null;
  const active = sqlite
    .prepare(
      `SELECT 1 FROM discord_reports_bindings WHERE binding_id = ? AND binding_revision = ? AND state = 'active'`
    )
    .get(expected.bindingId, expected.bindingRevision);
  if (!active) return null;
  sqlite
    .prepare(`INSERT INTO discord_reports_participants (binding_id,discord_user_id,principal_id,tier,tier_revision)
    VALUES (?,?,?,'basic',?) ON CONFLICT(binding_id, discord_user_id) DO NOTHING`)
    .run(expected.bindingId, discordUserId, randomUUID(), randomUUID());
  return sqlite
    .prepare(`SELECT binding_id AS bindingId, principal_id AS principalId, tier, tier_revision AS tierRevision
    FROM discord_reports_participants WHERE binding_id = ? AND discord_user_id = ?`)
    .get(expected.bindingId, discordUserId) as DiscordReportsParticipant;
}
