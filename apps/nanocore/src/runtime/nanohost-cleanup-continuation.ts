import { isDeepStrictEqual } from 'node:util';
import type { NanoHostAcceptedFinalCommitment } from '../storage/core-journal-native.js';
import type {
  NanoHostRecoveryLease,
  NanoHostWorkerRecoveryState,
} from '../storage/nanohost-recovery-native.js';
import type { NanoHostRuntimeTargetRecord } from './nanohost-runtime-target-records.js';
import type { WorkerBackendSessionRecord } from './worker-backend-session-records.js';

/** Identifies the original command at the physical transport boundary. */
export interface NanoHostCleanupCommand {
  readonly kind: 'bridge.close' | 'sandbox.delete';
  readonly requestId: string;
}

/** The exact post-ACK snapshot that owns this process's first dispatch. */
export interface NanoHostCleanupClaim {
  readonly lease: NanoHostRecoveryLease;
  readonly session: WorkerBackendSessionRecord;
  readonly proof: NanoHostWorkerRecoveryState;
  readonly target: NanoHostRuntimeTargetRecord;
  readonly firstCommand: NanoHostCleanupCommand;
  readonly deleteRequestId: string;
}

const undispatchedCleanupClaim = Symbol('undispatchedCleanupClaim');

/** One live capability withdrawn from the dispatch producer before any command was queued. */
export interface NanoHostUndispatchedCleanupClaim {
  readonly [undispatchedCleanupClaim]: true;
  /** The guarded closeout supplies its reread of the opening, pending tuple and final receipt. */
  consume(
    opening: object,
    claim: NanoHostCleanupClaim,
    final: NanoHostAcceptedFinalCommitment
  ): NanoHostTransferredCleanupClaim | null;
}

/** Only the successful final consumer can use this admission function. */
export interface NanoHostTransferredCleanupClaim {
  readonly claim: NanoHostCleanupClaim;
  admit(command: NanoHostCleanupCommand): void;
  admittedDelete(requestId: string): boolean;
}

/** Claim-specific authority supplied only to the configured physical dispatcher. */
export interface NanoHostCleanupCarriage {
  readonly target: NanoHostRuntimeTargetRecord;
  readonly admit: (command: NanoHostCleanupCommand) => void;
  readonly assertCurrent: () => void;
  /** Native-only expiry must preserve capture sources without publishing them. */
  readonly captureReadOnly?: boolean;
  /** The original materialization has no Native Worker submission. */
  readonly cleanupOnly?: true;
}

/** Definite proof returned by the configured cleanup producer. */
export type NanoHostClaimedCleanupResult =
  | { readonly kind: 'deleted'; readonly requestId: string }
  | { readonly kind: 'idle-deleted'; readonly requestId: string; readonly observedAt: string }
  | { readonly kind: 'fenced-absence'; readonly originPhysicalEpoch: string };

/** The producer withdrew its dispatch right for this exact winning settled final. */
export class NanoHostCleanupFinalWon extends Error {
  constructor(
    readonly final: NanoHostAcceptedFinalCommitment,
    readonly undispatchedClaim: NanoHostUndispatchedCleanupClaim
  ) {
    super('The original final won before NanoHost cleanup queued a command.');
  }
}

/** Serializes first command admission and transfer of the same acknowledged claim. */
export function createNanoHostCleanupContinuation(
  opening: object,
  input: NanoHostCleanupClaim | Pick<NanoHostCleanupClaim, 'firstCommand' | 'deleteRequestId'>
) {
  const claim = structuredClone(input);
  let state: 'available' | 'admitted' | 'withdrawn' | 'consumed' = 'available';
  let lastCommand: NanoHostCleanupCommand | undefined;
  const admitNext = (command: NanoHostCleanupCommand) => {
    const expected = lastCommand === undefined && isDeepStrictEqual(command, claim.firstCommand);
    const next =
      lastCommand?.kind === 'bridge.close' &&
      command.kind === 'sandbox.delete' &&
      command.requestId === claim.deleteRequestId;
    if (!expected && !next) throw new Error('NanoHost cleanup has no live dispatch right.');
    lastCommand = command;
  };
  const admittedDelete = (requestId: string) =>
    lastCommand?.kind === 'sandbox.delete' && lastCommand.requestId === requestId;
  return {
    /** The original physical producer owns any work that has already entered the queue. */
    hasAdmittedCommand(): boolean {
      return state === 'admitted';
    },
    /** Checks that the exact delete was admitted before accepting its result proof. */
    admittedDelete(requestId: string): boolean {
      return state === 'admitted' && admittedDelete(requestId);
    },
    /** Runs synchronously in the actual transport immediately before inserting the command. */
    admit(command: NanoHostCleanupCommand): void {
      if (state !== 'available' && state !== 'admitted')
        throw new Error('NanoHost cleanup has no live dispatch right.');
      admitNext(command);
      state = 'admitted';
    },
    /** Withdraws the dispatch right immediately and binds its only possible consumer. */
    withdraw(final: NanoHostAcceptedFinalCommitment): NanoHostUndispatchedCleanupClaim | null {
      if (
        state !== 'available' ||
        !('lease' in claim) ||
        !isDeepStrictEqual(final.grant, claim.lease.grant)
      )
        return null;
      state = 'withdrawn';
      const commitment = structuredClone(final);
      return {
        [undispatchedCleanupClaim]: true,
        consume(candidateOpening, candidateClaim, candidateFinal) {
          if (
            state !== 'withdrawn' ||
            candidateOpening !== opening ||
            !isDeepStrictEqual(candidateClaim, claim) ||
            !isDeepStrictEqual(candidateFinal, commitment)
          )
            return null;
          state = 'consumed';
          return { claim: candidateClaim, admit: admitNext, admittedDelete };
        },
      };
    },
  };
}
