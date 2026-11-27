import { StoreRecordNotFoundError } from '../lib/store-errors.js';
import { ControlStoreWorkerError } from '../storage/control-store-worker-error.js';
import { listWorkspaceDirectories, openCoreReadDb } from '../storage/db.js';
import { getWorkspaceRegistryLifecycleFact } from '../workspace-sharing.js';
import {
  attributeBootWalkStage,
  type BootWorkspaceWalkStage,
  isScopeAdmitted,
  refuseScope,
  type ScopeAdmissionFailure,
} from './readiness.js';

/** A conflict that a Boot walk found in one Workspace's own records before writing to it. */
export class BootWorkspaceConflict extends Error {
  /**
   * @param check Failed check reported in the held Workspace's readiness diagnosis.
   * @param message Bounded description of the conflicting record.
   */
  constructor(
    readonly check: Extract<ScopeAdmissionFailure['check'], 'records' | 'recovery'>,
    message: string
  ) {
    super(message);
    this.name = 'BootWorkspaceConflict';
  }
}

/**
 * Runs one Workspace's Boot walk step inside that Workspace's failure boundary.
 * A failure attributed to the Workspace holds it through scope admission and lets Boot continue.
 * A shared writer failure, or a failure the common owners cannot exclude, stops Boot.
 *
 * The hold is observed through the existing scoped readiness entry; completion returns nothing.
 *
 * @param input Rooted data, the walked Workspace and the Boot walk stage.
 * @param step The Workspace's own recovery reads and writes, including its record read.
 */
export async function withinBootWorkspaceBoundary(
  input: {
    readonly dataRoot: string | null;
    readonly workspaceId: string;
    readonly stage: BootWorkspaceWalkStage;
  },
  step: () => Promise<void> | void
): Promise<void> {
  const { dataRoot, workspaceId, stage } = input;
  // An unrooted Store has no scoped admission owner to hold a Workspace.
  if (!dataRoot) {
    await step();
    return;
  }
  // A sibling's owner discovery can hold this Workspace after the census; refuse before any effect.
  if (!isScopeAdmitted(dataRoot, 'workspace', workspaceId)) return;
  try {
    await step();
  } catch (error) {
    holdBootWorkspaceFailure({ dataRoot, workspaceId, stage }, error);
  }
}

/**
 * Attributes one failed startup step of a walked Workspace: an owned failure holds that Workspace
 * through scope admission, while a shared writer failure, or one the common owners cannot
 * exclude, is rethrown so startup stops.
 *
 * @param input Rooted data, the walked Workspace and the Boot walk stage.
 * @param error The step's failure.
 */
export function holdBootWorkspaceFailure(
  input: {
    readonly dataRoot: string;
    readonly workspaceId: string;
    readonly stage: BootWorkspaceWalkStage;
  },
  error: unknown
): void {
  const { dataRoot, workspaceId, stage } = input;
  const check = attributedCheck(error);
  if (check === 'shared') throw error;
  if (isScopeAdmitted(dataRoot, 'workspace', workspaceId)) {
    if (check === undefined) assertCommonOwners(dataRoot, workspaceId);
    refuseScope(dataRoot, {
      scope: 'workspace',
      id: workspaceId,
      check: check ?? 'records',
      stage,
    });
  } else {
    // The scoped owner already recorded its own failed check during this step.
    attributeBootWalkStage(dataRoot, workspaceId, stage);
  }
  console.warn(
    `Boot recovery held Workspace ${workspaceId} during ${stage}.`,
    error instanceof Error ? error.message : String(error)
  );
}

/**
 * Runs one Boot recovery write addressed only to the walked Workspace's own writer.
 * That writer's definite precondition noncommit names this Workspace's records; any other
 * writer result, including an uncertain commit, keeps its shared or unclassified disposition.
 *
 * @param write One publication or command on the walked Workspace's database.
 * @returns The write's result.
 */
export async function bootWorkspaceWrite<Value>(write: () => Promise<Value>): Promise<Value> {
  try {
    return await write();
  } catch (error) {
    if (
      error instanceof ControlStoreWorkerError &&
      !error.domain &&
      error.code === 'precondition' &&
      error.commit === 'not-committed'
    )
      throw new BootWorkspaceConflict('records', 'The Workspace writer refused Boot recovery.');
    throw error;
  }
}

/** Maps a typed owner result to its failed check; undefined when the type cannot name an owner. */
function attributedCheck(
  error: unknown
): Extract<ScopeAdmissionFailure['check'], 'records' | 'recovery'> | 'shared' | undefined {
  if (error instanceof BootWorkspaceConflict) return error.check;
  // The control-store transport is the shared writer; only its domain refusal names this Workspace.
  if (error instanceof ControlStoreWorkerError) return error.domain ? 'recovery' : 'shared';
  if (error instanceof StoreRecordNotFoundError) return 'records';
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'unavailable' || code === 'busy') return 'shared';
  if (code === 'recovery_required' || code === 'conflict') return 'recovery';
  return undefined;
}

/**
 * Revalidates Core authority and the Workspace census before an untyped failure is held locally.
 * Any failure here is the shared cause, so Boot stops with it.
 */
function assertCommonOwners(dataRoot: string, workspaceId: string): void {
  const core = openCoreReadDb(dataRoot);
  try {
    if (getWorkspaceRegistryLifecycleFact(core, workspaceId)?.status !== 'active')
      throw new Error('Workspace census changed during Boot recovery.');
  } finally {
    core.sqlite.close();
  }
  if (!listWorkspaceDirectories(dataRoot).includes(workspaceId))
    throw new Error('Workspace census changed during Boot recovery.');
}
