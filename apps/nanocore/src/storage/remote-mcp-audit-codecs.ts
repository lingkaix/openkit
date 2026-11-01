import { AuditAuthenticationSchema, UserIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Exact separate remote request Audit facts; no arbitrary Audit action or SQL crosses this seam. */
export const ControlRemoteMcpAuditSchema = z
  .object({
    userId: UserIdSchema,
    tokenId: z.string().optional(),
    authentication: AuditAuthenticationSchema,
    operationId: z.string().optional(),
    requestId: z.uuid().nullable(),
    outcome: z.enum(['denied', 'succeeded', 'failed']),
  })
  .strict();
/** Non-secret authenticated request attribution, unchanged by native publication. */
export type ControlRemoteMcpAudit = z.infer<typeof ControlRemoteMcpAuditSchema>;
