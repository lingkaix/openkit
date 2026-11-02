import { OperationError } from '../operation-error.js';
import { TurnStartValidationError } from '../runtime/orchestrator.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import type { CoreDb } from './db.js';
import {
  AutomationMutationError,
  AutomationRecordNotFoundError,
  type ControlSchedulerAdmission,
  type ControlSchedulerAdmissionResult,
  ControlSchedulerAdmissionSchema,
  type SchedulerAdmissionDraft,
} from './scheduler-admission-codecs.js';
import { nativeProductScope } from './workspace-file-records.js';
/** Posts an exact family tuple after native open and the caller's current immutable Workspace checks. */
export async function publishSchedulerAdmission<I extends SchedulerAdmissionDraft>(
  db: CoreDb,
  input: I,
  prepare?: (input: I) => I | ControlSchedulerAdmission | Promise<I | ControlSchedulerAdmission>
): Promise<ControlSchedulerAdmissionResult> {
  const snapshot = structuredClone(input);
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  const prepared = prepare ? await prepare(snapshot) : snapshot;
  const ready = ControlSchedulerAdmissionSchema.parse(
    prepared.mode === 'create'
      ? {
          ...prepared,
          entry: {
            ...prepared.entry,
            timestamp: prepared.entry.timestamp ?? new Date().toISOString(),
          },
        }
      : prepared
  );
  try {
    return await client.schedulerAdmission(database, ready);
  } catch (error) {
    if (input.mode === 'definition' && error instanceof OperationError) {
      if (error.code === 'automation_conflict') throw new AutomationMutationError(error.message);
      if (error.code === 'automation_update_failed' || error.code === 'automation_delete_failed')
        throw new AutomationRecordNotFoundError(error.message);
    }
    if (input.mode === 'create' && error instanceof OperationError)
      throw new TurnStartValidationError(error.code, error.message, error.status);
    throw error;
  }
}
