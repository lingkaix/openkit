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

/** NanoCore's four-operation backend boundary; preparation uses existing supply and Workspace owners. */
export interface ExecutionBackend {
  readonly id: string;
  submit(
    input: ExecutionBackendCorrelation & { readonly deadline: string }
  ): Promise<ExecutionBackendObservation>;
  inspect(input: ExecutionBackendCorrelation): Promise<ExecutionBackendObservation | null>;
  cancel(input: ExecutionBackendCorrelation): Promise<ExecutionBackendObservation>;
  release(input: ExecutionBackendCorrelation & { readonly proof: ExecutionReleaseProof }): Promise<
    ExecutionBackendCorrelation & {
      readonly state: 'pending' | 'released' | 'unknown';
      readonly fenceRef: string | null;
    }
  >;
}
