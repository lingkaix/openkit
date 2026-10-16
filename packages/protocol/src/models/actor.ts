import { z } from 'zod';
import { AutomationIdSchema, UserIdSchema } from '../common/ids.js';

/** Human actor whose responsible user is its own stable identifier by definition. */
export const UserActorRefSchema = z
  .object({
    kind: z.literal('user'),
    id: UserIdSchema,
  })
  .strict();

/** Non-human or system actor with explicit nullable responsible-user accountability. */
const ResponsibleActorRefSchema = z
  .object({
    kind: z.enum(['agent', 'integration', 'system']),
    id: z.string().min(1),
    responsibleUserId: UserIdSchema.nullable(),
  })
  .strict();

/** Automation has an allocated entity identity; authored and native actor selectors stay opaque. */
const AutomationActorRefSchema = z
  .object({
    kind: z.literal('automation'),
    id: AutomationIdSchema,
    responsibleUserId: UserIdSchema.nullable(),
  })
  .strict();

/** Stable, non-secret actor identity attached to shared history and governed actions. */
export const ActorRefSchema = z.union([
  UserActorRefSchema,
  ResponsibleActorRefSchema,
  AutomationActorRefSchema,
]);

/** Stable, non-secret actor identity attached to shared history and governed actions. */
export type ActorRef = z.infer<typeof ActorRefSchema>;

/**
 * Derives the exact responsible user recorded by an actor reference.
 *
 * @param actor Stable actor reference.
 * @returns The human actor ID, the non-human actor's recorded responsible user, or null.
 */
export function responsibleUserIdForActor(actor: ActorRef): string | null {
  return actor.kind === 'user' ? actor.id : actor.responsibleUserId;
}
