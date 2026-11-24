import type { AdmittedNanoHostHarnessTurnLifecycle } from '../runtime/nanohost-harness.js';
import type { CoreDb } from '../storage/db.js';
import { reopenAdmittedTestNanoHost } from './admitted-nanohost.js';
import {
  acknowledgeTestExternalWorkspaceConsumer as acknowledgeExternal,
  queueTestPreparedHarnessOperation,
} from './execution-attempt.js';

async function harnessOwner(coreDb: CoreDb): Promise<AdmittedNanoHostHarnessTurnLifecycle> {
  return (await reopenAdmittedTestNanoHost(coreDb)).value.owner.harnessTurnLifecycle;
}

/** Queues fixture operations through the same decided owner as the configured runtime. */
export async function queueNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: Parameters<typeof queueTestPreparedHarnessOperation>[1]
) {
  return queueTestPreparedHarnessOperation(coreDb, input, await harnessOwner(coreDb));
}

/** Takes the original command from the admissible Native Integration's queue. */
export async function dispatchNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: Parameters<AdmittedNanoHostHarnessTurnLifecycle['dispatch']>[0]
) {
  return (await harnessOwner(coreDb)).dispatch(input);
}

/** Publishes the test peer's exact result through the configured Native writer. */
export async function settleNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: Parameters<AdmittedNanoHostHarnessTurnLifecycle['settle']>[0]
) {
  // The test peer has no private physical connection; its result is owner-local.
  return (await harnessOwner(coreDb)).settle(input, null);
}

/** Supplies the original external Workspace ACK through the admitted Core consumer. */
export async function acknowledgeTestExternalWorkspaceConsumer(
  coreDb: CoreDb,
  input: Parameters<typeof acknowledgeExternal>[1]
) {
  return acknowledgeExternal(coreDb, input, await harnessOwner(coreDb));
}
