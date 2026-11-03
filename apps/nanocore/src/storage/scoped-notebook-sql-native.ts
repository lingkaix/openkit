import { recordServerAuditEvent } from '../audit-events.js';
import { recordControlCommandRequestRecordInDb } from './command-request-records.js';
import { presentControlFacts } from './control-store-input.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import type { CoreDb, UserDb } from './db.js';
import {
  type ControlScopedNotebookSqlInput,
  SCOPED_NOTEBOOK_SERVER_RECEIPTS,
} from './scoped-notebook-sql-codecs.js';

/** Publishes one original scoped stage on the physical owner's supplied connection and savepoint. */
export function applyScopedNotebookSqlInDb(
  db: CoreDb | UserDb,
  input: ControlScopedNotebookSqlInput
): void {
  if (!db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  if (input.action === 'user-receipt') {
    if (db.scope !== 'user' || db.userId !== input.userId)
      throw new ControlProductPreconditionError();
    recordControlCommandRequestRecordInDb(db, input.receipt);
    return;
  }
  if (db.scope !== 'core') throw new ControlProductPreconditionError();
  if (input.action === 'server-receipt') {
    if (!SCOPED_NOTEBOOK_SERVER_RECEIPTS.some((name) => name === input.receipt.command))
      throw new ControlProductPreconditionError();
    recordControlCommandRequestRecordInDb(db, input.receipt);
    return;
  }
  const event = input.event;
  if (
    event.notebookAdmission
      ? event.notebookAdmission.ownerScope.kind !== 'server' ||
        event.resource !== `knowledge-notebook:${event.notebookAdmission.candidateRevision}`
      : event.action !== 'knowledge.proposal.decide' ||
        !event.resource?.startsWith('knowledge-proposal:')
  )
    throw new ControlProductPreconditionError();
  recordServerAuditEvent(
    presentControlFacts({
      ...event,
      coreDb: db,
      auditEventId: event.id,
      now: new Date(event.createdAt),
      occurredAt: new Date(event.occurredAt),
    })
  );
}
