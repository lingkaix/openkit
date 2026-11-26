import {
  WorkerCredentialBindingsSchema,
  type WorkerCredentialFileBinding,
  WorkerCredentialProtectionSchema,
  type WorkerCredentialReceipt,
  WorkerCredentialReceiptSchema,
} from '@openkit/config-schema';

/** Exact durable correlation shared by every execution backend operation. */
export interface ExecutionBackendCorrelation {
  readonly attemptId: string;
  readonly backendId: string;
  readonly bindingRef: string | null;
  readonly inputRef: string | null;
  readonly operationId: string;
}

/** Truthful acceptance of the exact operation; uncertainty never permits replay. */
export type ExecutionOperationDisposition = 'not_accepted' | 'accepted' | 'unknown';

/** Correlated observations do not decide the Core product outcome or release barriers. */
export interface ExecutionBackendObservation extends ExecutionBackendCorrelation {
  readonly credentialReceipts?: readonly WorkerCredentialReceipt[];
  readonly disposition: ExecutionOperationDisposition;
  readonly execution: 'pending' | 'running' | 'terminal' | 'unknown';
  readonly fenceRef: string | null;
  readonly outcomeRef: string | null;
}

/** Existing Core handoff owners must all settle before backend release can free exclusion. */
export interface ExecutionReleaseProof {
  readonly terminalHandoff: boolean;
  readonly output: boolean;
  readonly evidence: boolean;
  readonly outsideWorkspaceCollection: boolean;
  readonly integrationDrain: boolean;
  readonly routesRevoked: boolean;
}

/** The four operations owned by Compute Neutrality, lines 23–30. */
export interface ExecutionBackendPort {
  readonly id: string;
  /** Uses the original authority, finalized input and absolute deadline. */
  submit(
    input: ExecutionBackendCorrelation & {
      readonly deadline: string;
      readonly credentialBindings?: readonly WorkerCredentialFileBinding[];
    }
  ): Promise<ExecutionBackendObservation>;
  /** Reads the original operation without starting work or extending provider lifetime. */
  inspect(input: ExecutionBackendCorrelation): Promise<ExecutionBackendObservation | null>;
  /** Stops the original work after the Core fence. An acknowledgement does not prove release. */
  cancel(input: ExecutionBackendCorrelation): Promise<ExecutionBackendObservation>;
  /** Reports scoped release evidence after the required handoffs. Core decides which claims it covers. */
  release(input: ExecutionBackendCorrelation & { readonly proof: ExecutionReleaseProof }): Promise<
    ExecutionBackendCorrelation & {
      readonly state: 'pending' | 'released' | 'unknown';
      readonly fenceRef: string | null;
    }
  >;
}

/** The serving backend also supports the existing optional Login and credential operations. */
export interface ExecutionBackend extends ExecutionBackendPort {
  /** Reports the installed private Login path, independent of current placement or Vault authority. */
  supportsHarnessLogin?(): boolean;
  /** Live replacement uses the same admitted reference binding and private material supply. */
  replaceCredentialBinding?(
    input: ExecutionBackendCorrelation & {
      readonly binding: WorkerCredentialFileBinding;
      /** Compare before the effect; a concurrent or replayed replacement cannot overwrite a successor. */
      readonly expectedReceiptId: string;
      readonly credentialValue: string;
    },
    recheckAuthority: () => Promise<void>
  ): Promise<WorkerCredentialReceipt>;
  /** Standalone revoke must prove removal or preserve the existing execution fence. */
  revokeCredentialBinding?(
    input: ExecutionBackendCorrelation & {
      readonly declarationId: string;
      readonly planId: string;
      readonly receiptId: string;
    }
  ): Promise<{ readonly state: 'removed' | 'unknown'; readonly fenceRef: string | null }>;
}

/** Reject missing, surplus, mismatched or weaker protection before issuing Vault receipts. */
export function requireExecutionCredentialReceipts(
  bindings: readonly WorkerCredentialFileBinding[],
  receipts: readonly WorkerCredentialReceipt[] | undefined
): readonly WorkerCredentialReceipt[] {
  WorkerCredentialBindingsSchema.parse(bindings);
  if (bindings.length !== (receipts?.length ?? 0))
    throw new Error('Placement credential protection is unproved.');
  const parsed = (receipts ?? []).map((receipt) => WorkerCredentialReceiptSchema.parse(receipt));
  const remaining = new Set(parsed);
  for (const binding of bindings) {
    const receipt = [...remaining].find((value) => value.receiptId === binding.receiptId);
    if (
      !receipt ||
      receipt.declarationId !== binding.declarationId ||
      receipt.planId !== binding.planId ||
      receipt.materialVersion !== binding.material.version ||
      receipt.access !== binding.access ||
      !WorkerCredentialProtectionSchema.safeParse(receipt.realizedProtection).success
    )
      throw new Error('Placement credential protection is unproved.');
    remaining.delete(receipt);
  }
  return parsed;
}
