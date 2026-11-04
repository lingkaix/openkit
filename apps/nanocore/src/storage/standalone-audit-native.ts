import { prepareAuditEventStatement } from '../audit-events.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import {
  type ControlStandaloneAuditInput,
  ControlStandaloneAuditInputSchema,
} from './standalone-audit-codecs.js';

/** Applies only an originally standalone admitted stage inside the supplied native savepoint. */
export function applyStandaloneAuditInDb(
  db: WorkspaceDb,
  input: ControlStandaloneAuditInput
): void {
  assertControlProductWriter(db.sqlite);
  if (
    !ControlStandaloneAuditInputSchema.safeParse(input).success ||
    db.workspaceId !== input.workspaceId
  )
    throw new ControlProductPreconditionError();
  const statement = prepareAuditEventStatement(input.event);
  db.sqlite.prepare(statement.sql).run(...statement.parameters);
}
