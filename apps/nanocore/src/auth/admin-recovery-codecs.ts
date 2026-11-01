import { isEntityId, TimestampSchema, UserIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** The existing stopped-operator SQL tuple: material and its output location never cross the wire. */
export const ControlAdminRecoveryInputSchema = z
  .object({
    requestId: z.string().uuid(),
    tokenId: z.string().refine((value): boolean => isEntityId('tok', value)),
    ownerUserId: UserIdSchema,
    tokenHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

/** Closed hash-only input to the existing Core writer. */
export type ControlAdminRecoveryInput = z.infer<typeof ControlAdminRecoveryInputSchema>;

/** Safe terminal error surfaced by the local operator executable and native recovery owner. */
export class AdminRecoveryError extends Error {
  /** Stable secret-free error code. */
  public readonly code: string;

  /** Creates one secret-free operator failure. */
  public constructor(code: string, message: string) {
    super(message);
    this.name = 'AdminRecoveryError';
    this.code = code;
  }
}

/** Exact existing redacted Audit summary, shared by publication and same-attempt verification. */
export function recoveryAuditSummary(expiresAt: string): string {
  return `Local operator issued one server-admin Token expiring at ${expiresAt}.`;
}

/** Fixed existing half-state refusal; no SQL diagnostic or bound value may cross the writer. */
export const ADMIN_RECOVERY_REQUIRED = 'Administrator recovery state requires operator inspection.';

/** Creates the existing fail-closed half-state error for Main and its native tuple. */
export function recoveryRequired(): AdminRecoveryError {
  return new AdminRecoveryError('recovery_required', ADMIN_RECOVERY_REQUIRED);
}
