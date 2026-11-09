import { isEntityId } from '@openkit/protocol';
import { recordServerAuditEvent } from '../audit-events.js';
import {
  pruneControlScopedNotebookReceiptsInDb,
  recordControlCommandRequestRecordInDb,
  recordControlScopedNotebookReceiptInDb,
} from './command-request-records.js';
import { presentControlFacts } from './control-store-input.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import type { CoreDb, UserDb } from './db.js';
import {
  type ControlScopedNotebookSqlInput,
  isSeparateScopedNotebookReceipt,
  SCOPED_NOTEBOOK_SERVER_RECEIPTS,
} from './scoped-notebook-sql-codecs.js';

/** Publishes one original scoped stage on the physical owner's supplied connection and savepoint. */
export function applyScopedNotebookSqlInDb(
  db: CoreDb | UserDb,
  input: ControlScopedNotebookSqlInput
): void {
  if (!db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  if (input.action === 'user-receipt-maintenance') {
    if (db.scope !== 'user' || db.userId !== input.userId)
      throw new ControlProductPreconditionError();
    pruneControlScopedNotebookReceiptsInDb(db, input.command, input.referenceTime);
    return;
  }
  if (input.action === 'user-receipt') {
    if (db.scope !== 'user' || db.userId !== input.userId)
      throw new ControlProductPreconditionError();
    if (isSeparateScopedNotebookReceipt(db.scope, input.receipt.command))
      recordControlScopedNotebookReceiptInDb(db, input.receipt);
    else recordControlCommandRequestRecordInDb(db, input.receipt);
    return;
  }
  if (db.scope !== 'core') throw new ControlProductPreconditionError();
  if (input.action === 'server-receipt-maintenance') {
    pruneControlScopedNotebookReceiptsInDb(db, input.command, input.referenceTime);
    return;
  }
  if (input.action === 'server-receipt') {
    if (!SCOPED_NOTEBOOK_SERVER_RECEIPTS.some((name) => name === input.receipt.command))
      throw new ControlProductPreconditionError();
    if (isSeparateScopedNotebookReceipt(db.scope, input.receipt.command))
      recordControlScopedNotebookReceiptInDb(db, input.receipt);
    else recordControlCommandRequestRecordInDb(db, input.receipt);
    return;
  }
  const event = input.event;
  if (
    event.notebookAdmission
      ? event.notebookAdmission.ownerScope.kind !== 'server' ||
        (event.resource?.startsWith('knowledge-source:')
          ? !['knowledge.notebook.admit', 'knowledge.source.register'].includes(event.action) ||
            !isEntityId('ks', event.resource.slice('knowledge-source:'.length))
          : event.action === 'knowledge.source.register' ||
            event.resource !== `knowledge-notebook:${event.notebookAdmission.candidateRevision}`)
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
