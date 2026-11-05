import { AccessTokenIdSchema, UserIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** The admitted owner's personal selection; never a bearer, hash, role or SQL program. */
export const ControlServerAdminTokenDefaultSchema = z
  .object({ ownerUserId: UserIdSchema, tokenId: AccessTokenIdSchema })
  .strict();

/** Original owner/token facts; the native Core decides current eligibility. */
export type ControlServerAdminTokenDefault = z.infer<typeof ControlServerAdminTokenDefaultSchema>;
