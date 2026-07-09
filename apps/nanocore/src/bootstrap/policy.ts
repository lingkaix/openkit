import {
  type AccessRequest,
  evaluateAccess,
  type PolicyDecision,
  type PolicyState,
} from '@openkit/policy-kernel';

const BASELINE_POLICY_STATE: PolicyState = {
  elements: [
    { id: 'user:nanocore', kind: 'user' },
    { id: 'ua:core-process', kind: 'userAttribute' },
    { id: 'object:nanocore', kind: 'object' },
    { id: 'object:baseline-vault-secret', kind: 'object' },
    { id: 'oa:core-api', kind: 'objectAttribute' },
    { id: 'oa:vault-secrets', kind: 'objectAttribute' },
    { id: 'pc:core', kind: 'policyClass' },
  ],
  assignments: [
    { child: 'user:nanocore', parent: 'ua:core-process' },
    { child: 'object:nanocore', parent: 'oa:core-api' },
    { child: 'object:baseline-vault-secret', parent: 'oa:vault-secrets' },
    { child: 'ua:core-process', parent: 'pc:core' },
    { child: 'oa:core-api', parent: 'pc:core' },
    { child: 'oa:vault-secrets', parent: 'pc:core' },
  ],
  operations: [
    { id: 'api.call', accessRights: ['ar:core-api-call'] },
    { id: 'vault.use', accessRights: ['ar:vault-use'] },
  ],
  processUsers: [{ process: 'process:nanocore', user: 'user:nanocore' }],
  associations: [
    {
      id: 'assoc:core-api-call',
      userAttribute: 'ua:core-process',
      accessRights: ['ar:core-api-call'],
      targetAttribute: 'oa:core-api',
    },
    {
      id: 'assoc:baseline-vault-use',
      userAttribute: 'ua:core-process',
      accessRights: ['ar:vault-use'],
      targetAttribute: 'oa:vault-secrets',
    },
  ],
  prohibitions: [
    {
      id: 'deny:baseline-vault-use',
      kind: 'process',
      subject: 'process:nanocore',
      accessRights: ['ar:vault-use'],
      range: { type: 'disjunctive', include: ['oa:vault-secrets'] },
    },
  ],
};

/** Loaded NanoCore boot policy kernel. */
export interface BootPolicyKernel {
  /** Policy facts used by the kernel. */
  policy: PolicyState;
  /**
   * Evaluates one access request.
   *
   * @param request Access request to evaluate.
   * @returns Policy decision.
   */
  evaluate(request: AccessRequest): PolicyDecision;
}

/** Error thrown when NanoCore cannot load a usable boot policy kernel. */
export class BootPolicyKernelError extends Error {
  /**
   * Creates a policy kernel boot error.
   *
   * @param message Error message.
   */
  public constructor(message: string) {
    super(message);
    this.name = 'BootPolicyKernelError';
  }
}

/**
 * Loads the NanoCore boot policy kernel and verifies minimum allow and deny behavior.
 *
 * @param policyOverride Optional policy state overrides for tests.
 * @returns Loaded policy kernel.
 */
export function loadBootPolicyKernel(policyOverride: Partial<PolicyState> = {}): BootPolicyKernel {
  const policy: PolicyState = { ...BASELINE_POLICY_STATE, ...policyOverride };
  const kernel: BootPolicyKernel = {
    policy,
    evaluate: (request) => evaluateAccess(policy, request),
  };

  assertBaselineSelfCheck(kernel);

  return kernel;
}

/**
 * Verifies the minimum boot policy behavior NanoCore needs before serving product work.
 *
 * @param kernel Loaded policy kernel.
 */
function assertBaselineSelfCheck(kernel: BootPolicyKernel): void {
  const coreDecision = kernel.evaluate({
    process: 'process:nanocore',
    operation: 'api.call',
    target: 'object:nanocore',
  });

  if (coreDecision.effect !== 'allow') {
    throw new BootPolicyKernelError('Policy kernel failed baseline Core API allow self-check.');
  }

  const vaultDecision = kernel.evaluate({
    process: 'process:nanocore',
    operation: 'vault.use',
    target: 'object:baseline-vault-secret',
  });
  const explicitVaultDeny = vaultDecision.reasons.some((reason) => reason.code === 'restriction');

  if (vaultDecision.effect !== 'deny' || !explicitVaultDeny) {
    throw new BootPolicyKernelError('Policy kernel failed baseline vault deny self-check.');
  }
}
