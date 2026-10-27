import type { WorkspaceBlocker } from '@openkit/app-api-schemas';

/** Nonwaiting freeze result; the caller owns release only after successful admission. */
export type WorkspaceFreezeAdmission =
  | { readonly status: 'busy' }
  | { readonly status: 'blocked'; readonly blockers: readonly WorkspaceBlocker[] }
  | { readonly status: 'frozen'; readonly release: () => void };

/** Process-local mutation admission state for one Workspace. */
interface WorkspaceMutationGateState {
  admitted: number;
  closed: boolean;
  captureClosed: boolean;
  waiters: Set<() => void>;
}

/** Registered canonical publishers that can write after ordinary handler admission. */
export const WORKSPACE_MUTATION_LATE_PUBLISHERS = ['worker-turn-closeout'] as const;

/** Registered canonical publisher that must name late mutation admission. */
export type WorkspaceMutationLatePublisher = (typeof WORKSPACE_MUTATION_LATE_PUBLISHERS)[number];

/** Coordinates ordinary Workspace mutations and exclusive lifecycle admission. */
export class WorkspaceMutationAdmission {
  private readonly gates = new Map<string, WorkspaceMutationGateState>();
  private readonly deletionTails = new Map<string, Promise<void>>();

  /** Fences an idle target before synchronous authoritative inspection, without draining live work. */
  public tryFreeze(
    workspaceId: string,
    readBlockers: () => readonly WorkspaceBlocker[]
  ): WorkspaceFreezeAdmission {
    const state = this.state(workspaceId);
    if (this.isClosed(workspaceId) || state.admitted !== 0) return { status: 'busy' };
    state.captureClosed = true;
    let blockers: readonly WorkspaceBlocker[];
    try {
      blockers = readBlockers();
    } catch {
      blockers = [{ kind: 'unavailable', reason: 'unavailable', actions: [] }];
    }
    if (blockers.length !== 0) {
      state.captureClosed = false;
      return { status: 'blocked', blockers };
    }
    let released = false;
    return {
      status: 'frozen',
      release: () => {
        if (released) return;
        released = true;
        this.reopen(workspaceId, 'capture');
      },
    };
  }

  /** Counts ordinary admission or existing settlement; capture exclusion fences both without changing legacy deletion settlement. */
  public enter(
    workspaceId: string,
    exclusion: 'ordinary' | 'capture' = 'ordinary'
  ): (() => void) | null {
    const state = this.state(workspaceId);
    if (this.isClosed(workspaceId, exclusion)) {
      return null;
    }
    state.admitted += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      state.admitted -= 1;
      if (state.admitted === 0) {
        for (const resolve of state.waiters) {
          resolve();
        }
        state.waiters.clear();
      }
    };
  }

  /** Admits one registered late publisher through the same Workspace gate. */
  public enterLatePublisher(
    workspaceId: string,
    publisher: WorkspaceMutationLatePublisher
  ): (() => void) | null {
    if (!WORKSPACE_MUTATION_LATE_PUBLISHERS.includes(publisher)) {
      throw new Error(`Unknown Workspace late publisher: ${publisher}.`);
    }
    return this.enter(workspaceId);
  }

  /** Closes one Workspace gate and waits for previously admitted mutations to leave. */
  public async close(workspaceId: string): Promise<void> {
    const state = this.state(workspaceId);
    state.closed = true;
    if (state.admitted === 0) {
      return;
    }
    await new Promise<void>((resolve) => state.waiters.add(resolve));
  }

  /** Releases only the selected owner closure; capture release cannot reopen a concurrent deletion. */
  public reopen(workspaceId: string, closure: 'ordinary' | 'capture' = 'ordinary'): void {
    const state = this.state(workspaceId);
    if (state.admitted !== 0) {
      throw new Error('Workspace mutation gate cannot reopen while mutations remain admitted.');
    }
    if (closure === 'capture') state.captureClosed = false;
    else state.closed = false;
  }

  /** Restores an owned closure without clearing a different lifecycle owner's exclusion. */
  public restoreClosed(workspaceId: string, closure: 'ordinary' | 'capture' = 'ordinary'): void {
    const state = this.state(workspaceId);
    if (closure === 'capture') state.captureClosed = true;
    else state.closed = true;
  }

  /** Tests ordinary exclusion or the capture-only exclusion required by already-owned low-level settlement. */
  public isClosed(workspaceId: string, exclusion: 'ordinary' | 'capture' = 'ordinary'): boolean {
    const state = this.state(workspaceId);
    return state.captureClosed || (exclusion === 'ordinary' && state.closed);
  }

  /** Serializes deletion-request admission for one Workspace. */
  public async runDeletionExclusive<T>(
    workspaceId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const preceding = this.deletionTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = preceding.then(() => current);
    this.deletionTails.set(workspaceId, tail);
    await preceding;
    try {
      return await operation();
    } finally {
      release();
      if (this.deletionTails.get(workspaceId) === tail) {
        this.deletionTails.delete(workspaceId);
      }
    }
  }

  private state(workspaceId: string): WorkspaceMutationGateState {
    let state = this.gates.get(workspaceId);
    if (!state) {
      state = { admitted: 0, closed: false, captureClosed: false, waiters: new Set() };
      this.gates.set(workspaceId, state);
    }
    return state;
  }
}
