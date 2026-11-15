import { prepareAuditEventStatement } from '../audit-events.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb, WorkspaceDb } from './db.js';
import { prepareSecurityCanaryAuditInDb } from './security-canary-audit-native.js';
import { enqueueE12NoticeInDb } from './security-trigger-native.js';
import {
  type ControlStandaloneAuditInput,
  ControlStandaloneAuditInputSchema,
} from './standalone-audit-codecs.js';

/** Applies only an originally standalone admitted stage inside the supplied native savepoint. */
export function applyStandaloneAuditInDb(
  db: CoreDb | WorkspaceDb,
  input: ControlStandaloneAuditInput
): void {
  assertControlProductWriter(db.sqlite);
  if (
    !ControlStandaloneAuditInputSchema.safeParse(input).success ||
    (db.scope === 'core' ? input.workspaceId !== undefined : db.workspaceId !== input.workspaceId)
  )
    throw new ControlProductPreconditionError();
  if (input.stage === 'security.canary') {
    if (db.scope !== 'core') throw new ControlProductPreconditionError();
    if (prepareSecurityCanaryAuditInDb(db, input) !== 'new') return;
  }
  const statement = prepareAuditEventStatement(input.event);
  db.sqlite.prepare(statement.sql).run(...statement.parameters);
  if (db.scope === 'core' && input.stage === 'security.canary')
    enqueueE12NoticeInDb(db, input.event.id);
}
