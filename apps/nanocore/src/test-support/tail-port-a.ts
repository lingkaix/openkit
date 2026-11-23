import type Database from 'better-sqlite3';
import {
  prepareWorkerControlObservation,
  writeWorkerControlAcceptedRecord,
} from '../runtime/worker-control-records.js';
import { createWorkerControlSequenceRecorder } from '../runtime/worker-control-sequences.js';
import type { CoreDb } from '../storage/db.js';
import {
  currentAdmittedTestNanoHostOwner,
  mutateAdmittedTestNanoHost,
  readAdmittedTestNanoHost,
} from './admitted-nanohost.js';

type AdmittedOwner = NonNullable<ReturnType<typeof currentAdmittedTestNanoHostOwner>>;
type BackendSessionInput = Parameters<AdmittedOwner['backendSession']>[0];

/** The acknowledged Native owner of a fixture root; production writes Native rows only through it. */
export function requireTestNanoHostOwner(coreDb: Pick<CoreDb, 'dataRoot'>): AdmittedOwner {
  const owner = currentAdmittedTestNanoHostOwner(coreDb);
  if (!owner) throw new Error('Fixture root has no admitted NanoHost owner.');
  return owner;
}

/**
 * Commits one original backend-session transition through the admitted NanoHost owner,
 * as the configured Worker lifecycle does after K8. The Core frame refuses this Native table.
 */
export function transitionBackendSessionThroughOwner(
  coreDb: Pick<CoreDb, 'dataRoot'>,
  input: Omit<Extract<BackendSessionInput, { kind: 'transition' }>, 'kind' | 'observedAt'> & {
    readonly now?: () => string;
  }
) {
  const { now, ...facts } = input;
  return requireTestNanoHostOwner(coreDb).backendSession({
    kind: 'transition',
    ...facts,
    ...(now ? { observedAt: now() } : {}),
  });
}

/**
 * Gateway recorders over the admitted NanoHost file: accepted Worker control records and
 * sequence fingerprints live in Native storage after K8, not in the Core frame.
 */
export function admittedWorkerControlRecorders(coreDb: CoreDb) {
  return {
    acceptedRecordRecorder: {
      prepareObservation: (record: Parameters<typeof prepareWorkerControlObservation>[1]) =>
        prepareWorkerControlObservation(coreDb, record),
      record: (input: Parameters<typeof writeWorkerControlAcceptedRecord>[1]) =>
        mutateAdmittedTestNanoHost(coreDb, (sqlite) =>
          writeWorkerControlAcceptedRecord({ sqlite }, input)
        ),
    },
    sequenceRecorder: {
      accept: (
        input: Parameters<ReturnType<typeof createWorkerControlSequenceRecorder>['accept']>[0]
      ) =>
        mutateAdmittedTestNanoHost(coreDb, (sqlite) =>
          createWorkerControlSequenceRecorder({ sqlite }).accept(input)
        ),
    },
  };
}

/**
 * Runs a domain function that refuses by throwing on the admitted NanoHost reader's connection.
 * The reader reports a throw inside its callback as a hold and drops the domain text, so the
 * refusal is carried out of the callback and rethrown unchanged for the test's own assertion.
 */
export function readAdmittedTestNanoHostRefusing<Value>(
  coreDb: CoreDb,
  query: (sqlite: Database.Database) => Value
): Value {
  const outcome = readAdmittedTestNanoHost(coreDb, (sqlite) => {
    try {
      return { ok: true as const, value: query(sqlite) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
