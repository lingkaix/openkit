import { z } from 'zod';
import type { DiscordReportsOperatorCommand } from '../storage/discord-reports-bindings.js';
import { DiscordReportsTargetSchema } from './discord-reports-binding.js';

const id = z.string().min(1);
const mutation = { bindingId: id, expectedRevision: id };
const payload = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('create'), target: DiscordReportsTargetSchema }),
  z.strictObject({ operation: z.literal('read'), bindingId: id }),
  z.strictObject({ operation: z.literal('activate'), ...mutation }),
  z.strictObject({ operation: z.literal('revoke'), ...mutation }),
  z.strictObject({
    operation: z.literal('narrow'),
    ...mutation,
    roles: DiscordReportsTargetSchema.shape.roles,
    collectionSetRevision: id,
  }),
  z.strictObject({
    operation: z.literal('tier'),
    ...mutation,
    principalId: id,
    expectedTierRevision: id,
    tier: z.enum(['basic', 'expanded']),
  }),
]);

/** Parses one complete operator request. Raw Discord accounts and credentials are not CLI fields. */
export function parseDiscordReportsOperatorCommand(
  raw: string
): DiscordReportsOperatorCommand | null {
  try {
    return payload.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}
