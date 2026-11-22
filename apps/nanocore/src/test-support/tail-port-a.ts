import type { CoreDb } from '../storage/db.js';
import { currentAdmittedTestNanoHostOwner } from './admitted-nanohost.js';

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
