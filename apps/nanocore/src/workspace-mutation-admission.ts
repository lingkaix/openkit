import type { WorkspaceBlocker } from '@openkit/app-api-schemas';

/** Nonwaiting freeze result; the caller owns release only after successful admission. */
export type WorkspaceFreezeAdmission =
  | { readonly status: 'busy' }
  | { readonly status: 'blocked'; readonly blockers: readonly WorkspaceBlocker[] }
  | WorkspaceFrozenAdmission;

/** Exact process-local owner of one successful freeze; release invalidates its native bindings. */
export interface WorkspaceFrozenAdmission {
  readonly status: 'frozen';
  readonly release: () => void;
}

/** Exact retained recovery identity that caused this process-local boot exclusion. */
export interface WorkspaceRecoveryFreezeOrigin {
  readonly admissionId: string;
  readonly revision: number;
  readonly candidateRef: string;
}

/** Recovery uses the same closure, with at most its canonical and owned candidate bindings. */
interface CaptureClosure {
  owner: WorkspaceFrozenAdmission | null;
  readonly origin?: WorkspaceRecoveryFreezeOrigin;
  recovery?: { readonly canonical?: object; readonly candidate: object };
}

/** Process-local mutation admission state for one Workspace. */
interface WorkspaceMutationGateState {
  admitted: number;
  closed: boolean;
  captureClosed: CaptureClosure | null;
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
    const closure: CaptureClosure = { owner: null };
    state.captureClosed = closure;
    const blockers = this.freezeBlockers(readBlockers);
    if (blockers.length !== 0) {
      if (state.captureClosed === closure) state.captureClosed = null;
      return { status: 'blocked', blockers };
    }
    if (state.captureClosed !== closure || state.closed) return { status: 'busy' };
    return this.ownFreeze(workspaceId, state, closure);
  }

  /** Rejoins only the retained origin of an ownerless recovery exclusion, without opening it. */
  public tryResumeRecovery(
    workspaceId: string,
    origin: WorkspaceRecoveryFreezeOrigin,
    readBlockers: () => readonly WorkspaceBlocker[]
  ): WorkspaceFreezeAdmission {
    const state = this.gates.get(workspaceId);
    const closure = state?.captureClosed;
    if (
      !state ||
      state.closed ||
      state.admitted !== 0 ||
      !closure ||
      closure.owner !== null ||
      closure.origin?.admissionId !== origin.admissionId ||
      closure.origin.revision !== origin.revision ||
      closure.origin.candidateRef !== origin.candidateRef
    )
      return { status: 'busy' };
    const blockers = this.freezeBlockers(readBlockers);
    if (blockers.length !== 0) return { status: 'blocked', blockers };
    if (
      state.captureClosed !== closure ||
      state.closed ||
      state.admitted !== 0 ||
      closure.owner !== null
    )
      return { status: 'busy' };
    return this.ownFreeze(workspaceId, state, closure);
  }

  /** Restores exclusion provenance only; this never recovers a live permission. */
  public restoreRecoveryClosed(workspaceId: string, origin: WorkspaceRecoveryFreezeOrigin): void {
    this.state(workspaceId).captureClosed = { owner: null, origin: Object.freeze({ ...origin }) };
  }

  /** Both entry paths preserve the original closed, typed inspection failure. */
  private freezeBlockers(
    readBlockers: () => readonly WorkspaceBlocker[]
  ): readonly WorkspaceBlocker[] {
    try {
      return readBlockers();
    } catch {
      return [{ kind: 'unavailable', reason: 'unavailable', actions: [] }];
    }
  }

  /** Gives the same closure a live owner; a resumed release restores its prior exclusion. */
  private ownFreeze(
    workspaceId: string,
    state: WorkspaceMutationGateState,
    closure: CaptureClosure
  ): WorkspaceFrozenAdmission {
    let released = false;
    const owner: WorkspaceFrozenAdmission = {
      status: 'frozen',
      release: () => {
        if (released) return;
        released = true;
        if (state.captureClosed !== closure) return;
        if (closure.origin) {
          closure.owner = null;
          delete closure.recovery;
        } else this.reopen(workspaceId, 'capture');
      },
    };
    closure.owner = owner;
    return owner;
  }

  /** Tests this exact live freeze without creating a gate or recovering permission from a Boolean. */
  public ownsFreeze(workspaceId: string, owner: WorkspaceFrozenAdmission): boolean {
    const state = this.gates.get(workspaceId);
    return !!state && !state.closed && state.captureClosed?.owner === owner;
  }

  /** The recovery admission owner installs its exact two native bindings; replacing them retires old calls. */
  public bindRecovery(
    workspaceId: string,
    owner: WorkspaceFrozenAdmission,
    bindings: { readonly canonical?: object; readonly candidate: object }
  ): void {
    if (!this.ownsFreeze(workspaceId, owner))
      throw new Error('Workspace recovery freeze is not current.');
    this.gates.get(workspaceId)!.captureClosed!.recovery = { ...bindings };
  }

  /** A native exception belongs only to the current closure and exact installed binding object. */
  public isRecoveryBinding(
    workspaceId: string,
    owner: WorkspaceFrozenAdmission,
    binding: object
  ): boolean {
    if (!this.ownsFreeze(workspaceId, owner)) return false;
    const bindings = this.gates.get(workspaceId)!.captureClosed!.recovery;
    return !!bindings && (bindings.canonical === binding || bindings.candidate === binding);
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
    if (closure === 'capture') state.captureClosed = null;
    else state.closed = false;
  }

  /** Restores an owned closure without clearing a different lifecycle owner's exclusion. */
  public restoreClosed(workspaceId: string, closure: 'ordinary' | 'capture' = 'ordinary'): void {
    const state = this.state(workspaceId);
    if (closure === 'capture') state.captureClosed = { owner: null };
    else state.closed = true;
  }

  /** Tests ordinary exclusion or the capture-only exclusion required by already-owned low-level settlement. */
  public isClosed(workspaceId: string, exclusion: 'ordinary' | 'capture' = 'ordinary'): boolean {
    const state = this.state(workspaceId);
    return state.captureClosed !== null || (exclusion === 'ordinary' && state.closed);
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
      state = { admitted: 0, closed: false, captureClosed: null, waiters: new Set() };
      this.gates.set(workspaceId, state);
    }
    return state;
  }
}
