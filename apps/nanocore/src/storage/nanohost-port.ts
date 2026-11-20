import type {
  ExecutionGrant,
  ExecutionProofReceipt,
  ExecutionProofSubmission,
} from './control-kernel-port.js';
import type {
  StorageIntent,
  StorageReceipt,
  StorageResult,
  StorageStatus,
} from './storage-owner.js';

/** A9 stages a physical epoch rollover even when no Turn or attempt exists. */
export type NanoHostEpochInvalidation = StorageIntent<
  'nanohost',
  'fence-vault-epoch',
  {
    readonly runtimeTargetId: string;
    readonly physicalEpoch: string;
    readonly holderReceiptIds: readonly string[];
  }
>;

/** A9 waits for the exact original holder set to be fenced before successor readiness. */
export type NanoHostEpochReceipt = StorageReceipt<
  NanoHostEpochInvalidation,
  { readonly fencedHolderReceiptIds: readonly string[] }
>;

/** A9 keeps native bindings, credentials and sequence evidence behind the extension's file handle. */
export interface NanoHostStore {
  status(): StorageStatus<'nanohost'>;
  /** Commit the original bounded proof intent before posting to Core. */
  stageEvidence(input: ExecutionProofSubmission): Promise<StorageResult<'nanohost', void>>;
  /** Inspect the original native operation and any staged proofs. */
  inspectEvidence(
    grant: ExecutionGrant
  ): Promise<StorageResult<'nanohost', readonly ExecutionProofSubmission[]>>;
  settleEvidence(receipt: ExecutionProofReceipt): Promise<StorageResult<'nanohost', void>>;
  /** Persist the invalidated generation and exact holders before asking Core to fence them. */
  stageEpochInvalidation(
    intent: NanoHostEpochInvalidation
  ): Promise<StorageResult<'nanohost', void>>;
  readEpochInvalidation(
    requestId: string
  ): Promise<StorageResult<'nanohost', NanoHostEpochInvalidation | null>>;
  settleEpochInvalidation(receipt: NanoHostEpochReceipt): Promise<StorageResult<'nanohost', void>>;
}
