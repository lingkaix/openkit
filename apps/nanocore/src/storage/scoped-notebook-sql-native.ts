import { isEntityId } from '@openkit/protocol';
import { recordServerAuditEvent } from '../audit-events.js';
import { presentControlFacts } from './control-store-input.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import type { CoreDb } from './db.js';
import type { ControlScopedNotebookSqlInput } from './scoped-notebook-sql-codecs.js';

/** Publishes only the original Server Notebook Audit on its actual native Core connection. */
export function applyScopedNotebookSqlInDb(db: CoreDb, input: ControlScopedNotebookSqlInput): void {
  if (!db.sqlite.inTransaction) throw new ControlProductPreconditionError();
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
