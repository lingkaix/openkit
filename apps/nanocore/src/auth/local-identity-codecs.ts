import { UserIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Captured fresh-deployment authority only; an empty lookup supplies no allocation permission. */
export const ControlLocalIdentitySchema = z.object({ freshInitialization: z.boolean() }).strict();
export type ControlLocalIdentity = z.infer<typeof ControlLocalIdentitySchema>;

/** The exact recorded canonical User, returned only after the native FULL acknowledgement. */
export const ControlLocalIdentityResultSchema = UserIdSchema;
