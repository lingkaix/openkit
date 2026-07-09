import { describe, expect, it } from 'vitest';

import { BootPolicyKernelError, loadBootPolicyKernel } from './policy.js';

describe('boot policy kernel loader', () => {
  it('loads a baseline policy kernel that can allow Core API calls', () => {
    const kernel = loadBootPolicyKernel();

    expect(
      kernel.evaluate({
        process: 'process:nanocore',
        operation: 'api.call',
        target: 'object:nanocore',
      })
    ).toMatchObject({
      effect: 'allow',
      reasons: [{ code: 'association-grant' }],
    });
  });

  it('keeps vault operations denied by default', () => {
    const kernel = loadBootPolicyKernel();

    expect(
      kernel.evaluate({
        process: 'process:nanocore',
        operation: 'vault.use',
        target: 'object:baseline-vault-secret',
      })
    ).toMatchObject({
      effect: 'deny',
      reasons: [{ code: 'restriction' }],
    });
  });

  it('fails closed when the baseline policy self-check cannot allow Core API calls', () => {
    expect(() =>
      loadBootPolicyKernel({
        associations: [],
      })
    ).toThrow(BootPolicyKernelError);
  });
});
