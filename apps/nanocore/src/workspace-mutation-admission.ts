/** Process-local mutation admission state for one Workspace. */
interface WorkspaceMutationGateState {
  admitted: number;
  closed: boolean;
  waiters: Set<() => void>;
}

/** Registered canonical publishers that can write after ordinary handler admission. */
export const WORKSPACE_MUTATION_LATE_PUBLISHERS = ['worker-turn-closeout'] as const;

/** Registered canonical publisher that must name late mutation admission. */
export type WorkspaceMutationLatePublisher = (typeof WORKSPACE_MUTATION_LATE_PUBLISHERS)[number];

/** Coordinates ordinary Workspace mutations with exclusive deletion admission. */
export class WorkspaceMutationAdmission {
  private readonly gates = new Map<string, WorkspaceMutationGateState>();
  private readonly deletionTails = new Map<string, Promise<void>>();

  /** Admits one ordinary mutation while the Workspace gate is open. */
  public enter(workspaceId: string): (() => void) | null {
    const state = this.state(workspaceId);
    if (state.closed) {
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

  /** Reopens a non-deleting Workspace after a request terminates without lifecycle mutation. */
  public reopen(workspaceId: string): void {
    const state = this.state(workspaceId);
    if (state.admitted !== 0) {
      throw new Error('Workspace mutation gate cannot reopen while mutations remain admitted.');
    }
    state.closed = false;
  }

  /** Restores a closed gate from durable deletion state during boot. */
  public restoreClosed(workspaceId: string): void {
    this.state(workspaceId).closed = true;
  }

  /** Returns whether ordinary mutations are currently fenced. */
  public isClosed(workspaceId: string): boolean {
    return this.state(workspaceId).closed;
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
      state = { admitted: 0, closed: false, waiters: new Set() };
      this.gates.set(workspaceId, state);
    }
    return state;
  }
}
