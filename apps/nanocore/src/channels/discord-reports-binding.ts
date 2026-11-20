import { z } from 'zod';
import { DiscordSnowflakeSchema as snowflake } from './discord-snowflake.js';

const id = z.string().min(1);
const role = z.strictObject({
  definitionId: id,
  definitionRevision: id,
  slotCollections: z.record(id, z.strictObject({ collectionId: id, collectionRevision: id })),
});
export const DiscordReportsTargetSchema = z.strictObject({
  botUserId: snowflake,
  guildId: snowflake,
  channelId: snowflake,
  audienceRef: id,
  workspaceId: id,
  accountableUserId: id,
  roles: z.array(role).length(1),
  collectionSetRevision: id,
});
const binding = DiscordReportsTargetSchema.extend({
  bindingId: id,
  bindingRevision: id,
  state: z.enum(['draft', 'active', 'revoked']),
});
const participant = z.object({
  bindingId: id,
  principalId: id,
  tier: z.enum(['basic', 'expanded']),
  tierRevision: id,
});

export type DiscordReportsTarget = z.infer<typeof DiscordReportsTargetSchema>;
export type DiscordReportsBinding = z.infer<typeof binding>;
export type DiscordReportsParticipant = z.infer<typeof participant>;

/** Reads only the known authority-bearing state of the native record. */
export function readDiscordReportsBinding(value: unknown): DiscordReportsBinding | null {
  return binding.safeParse(value).data ?? null;
}

/** Facts must come from the current native mutation boundary, not a caller's preview. */
export interface DiscordReportsMutationAuthority {
  /** Checks deployment-management authority against the exact target. */
  readonly manage: (target: DiscordReportsTarget) => boolean;
  /** Checks exact definition, slots, sources, audience and accountable member authority. */
  readonly publish: (target: DiscordReportsTarget) => boolean;
  /** Rejects a different active binding for the same bot/guild/channel. */
  readonly routeIsFree: (target: DiscordReportsTarget, exceptBindingId: string) => boolean;
}

/** Validates a new unroutable draft. The owner allocates a never-reused binding identity. */
export function createDiscordReportsDraft(
  input: DiscordReportsTarget & { readonly bindingId: string; readonly bindingRevision: string },
  authority: DiscordReportsMutationAuthority
): DiscordReportsBinding | null {
  const draft = binding.safeParse({ ...input, state: 'draft' });
  if (
    !draft.success ||
    authority.manage(draft.data) !== true ||
    authority.publish(draft.data) !== true
  )
    return null;
  return draft.data;
}

/** Derives the next revision inside a native CAS. Unknown stored state grants nothing. */
export function changeDiscordReportsBinding(
  current: unknown,
  input: {
    readonly expectedRevision: string;
    readonly nextRevision: string;
  } & (
    | { readonly operation: 'activate' | 'revoke' }
    | {
        readonly operation: 'narrow';
        readonly roles: DiscordReportsTarget['roles'];
        readonly collectionSetRevision: string;
      }
  ),
  authority: DiscordReportsMutationAuthority
): DiscordReportsBinding | null {
  const stored = binding.safeParse(current);
  if (!stored.success) return null;
  const before = stored.data;
  if (
    before.state === 'revoked' ||
    before.bindingRevision !== input.expectedRevision ||
    !input.nextRevision ||
    input.nextRevision === before.bindingRevision ||
    authority.manage(before) !== true
  )
    return null;
  if (input.operation === 'revoke') {
    // A withdrawn source must not prevent an authorized operator from stopping the deployment.
    return { ...before, state: 'revoked', bindingRevision: input.nextRevision };
  }
  if (input.operation === 'activate') {
    if (
      before.state !== 'draft' ||
      authority.publish(before) !== true ||
      authority.routeIsFree(before, before.bindingId) !== true
    )
      return null;
    return { ...before, state: 'active', bindingRevision: input.nextRevision };
  }
  if (input.operation !== 'narrow') return null;
  const next = binding.safeParse({
    ...before,
    roles: input.roles,
    collectionSetRevision: input.collectionSetRevision,
    bindingRevision: input.nextRevision,
  });
  if (!next.success) return null;
  const oldRole = before.roles[0]!;
  const newRole = next.data.roles[0]!;
  if (
    oldRole.definitionId !== newRole.definitionId ||
    oldRole.definitionRevision !== newRole.definitionRevision ||
    Object.keys(newRole.slotCollections).length >= Object.keys(oldRole.slotCollections).length ||
    before.collectionSetRevision === next.data.collectionSetRevision ||
    Object.entries(newRole.slotCollections).some(([slot, ref]) => {
      if (!Object.hasOwn(oldRole.slotCollections, slot)) return true;
      const previous = oldRole.slotCollections[slot];
      return (
        !previous ||
        ref.collectionId !== previous.collectionId ||
        ref.collectionRevision !== previous.collectionRevision
      );
    }) ||
    authority.publish(next.data) !== true
  )
    return null;
  return next.data;
}

/** Tier mutation cannot create a principal or change its identity. Usage is not part of this mutation. */
export function changeDiscordReportsTier(
  currentBinding: unknown,
  currentParticipant: unknown,
  input: {
    readonly expectedBindingRevision: string;
    readonly expectedTierRevision: string;
    readonly nextTierRevision: string;
    readonly tier: 'basic' | 'expanded';
  },
  authority: DiscordReportsMutationAuthority
): DiscordReportsParticipant | null {
  const active = binding.safeParse(currentBinding);
  const existing = participant.safeParse(currentParticipant);
  if (!active.success || !existing.success) return null;
  const deployment = active.data;
  const person = existing.data;
  if (
    deployment.state !== 'active' ||
    deployment.bindingRevision !== input.expectedBindingRevision ||
    person.bindingId !== deployment.bindingId ||
    person.tierRevision !== input.expectedTierRevision ||
    input.nextTierRevision === person.tierRevision ||
    input.tier === person.tier ||
    authority.manage(deployment) !== true ||
    (input.tier === 'expanded' && authority.publish(deployment) !== true)
  )
    return null;
  const next = participant.safeParse({
    ...person,
    tier: input.tier,
    tierRevision: input.nextTierRevision,
  });
  return next.success ? next.data : null;
}
