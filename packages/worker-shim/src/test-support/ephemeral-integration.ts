import { Server } from 'node:net';
import {
  openSandboxIntegration,
  SANDBOX_INTEGRATION_TARGET,
  SANDBOX_NATIVE_INFERENCE_TARGET,
} from '../integration-client.js';

// Retain the real factory when a Harness test spies on its exported entry point.
const openIntegration = openSandboxIntegration;

type BoundTargets = { integrationTarget: URL; nativeTarget: URL };

/** Redirects the two fixed loopback binds to kernel-allocated ports during fixture startup. */
export function redirectSandboxIntegrationListeners(onBound?: (targets: BoundTargets) => void) {
  const integrationTarget = new URL(`http://${SANDBOX_INTEGRATION_TARGET}`);
  const nativeTarget = new URL(`http://${SANDBOX_NATIVE_INFERENCE_TARGET}`);
  const targets = new Map([
    [Number(integrationTarget.port), integrationTarget],
    [Number(nativeTarget.port), nativeTarget],
  ]);
  const bound = new Set<number>();
  const originalListen = Server.prototype.listen;
  const boundTargets = (): BoundTargets => {
    if (bound.size !== targets.size) {
      throw new Error('Integration fixture did not bind both loopback listeners.');
    }
    return { integrationTarget, nativeTarget };
  };
  const restore = () => {
    Server.prototype.listen = originalListen;
  };
  Server.prototype.listen = function (this: Server, ...args: unknown[]) {
    const port = args[0];
    const target = typeof port === 'number' ? targets.get(port) : undefined;
    if (typeof port === 'number' && target && args[1] === target.hostname) {
      args[0] = 0;
      this.once('listening', () => {
        const address = this.address();
        if (!address || typeof address === 'string') {
          throw new Error('Integration fixture did not bind a TCP listener.');
        }
        target.port = String(address.port);
        bound.add(port);
        if (bound.size === targets.size) {
          restore();
          onBound?.(boundTargets());
        }
      });
    }
    return Reflect.apply(originalListen, this, args);
  };
  return { boundTargets, restore };
}

/** Opens the real Integration on test-owned ports. */
export async function openEphemeralSandboxIntegration(
  options: Parameters<typeof openSandboxIntegration>[0] = {}
) {
  const redirected = redirectSandboxIntegrationListeners();
  try {
    const integration = await openIntegration(options);
    try {
      return { integration, ...redirected.boundTargets() };
    } catch (error) {
      await integration.close();
      throw error;
    }
  } finally {
    redirected.restore();
  }
}
