import { Server } from 'node:net';
import { vi } from 'vitest';
import {
  openSandboxIntegration,
  SANDBOX_INTEGRATION_TARGET,
  SANDBOX_NATIVE_INFERENCE_TARGET,
} from '../integration-client.js';

// Retain the real factory when a Harness test spies on its exported entry point.
const openIntegration = openSandboxIntegration;

/** Opens the real Integration on test-owned ports without changing its fixed production targets. */
export async function openEphemeralSandboxIntegration(
  options: Parameters<typeof openSandboxIntegration>[0] = {}
) {
  const target = new URL(`http://${SANDBOX_INTEGRATION_TARGET}`);
  const nativeTarget = new URL(`http://${SANDBOX_NATIVE_INFERENCE_TARGET}`);
  const listeners = new Map<number, Server>();
  const originalListen = Server.prototype.listen;
  const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
    this: Server,
    ...args: unknown[]
  ) {
    const port = args[0];
    if (port === Number(target.port) || port === Number(nativeTarget.port)) {
      listeners.set(port, this);
      args[0] = 0;
    }
    return Reflect.apply(originalListen, this, args);
  });
  try {
    const integration = await openIntegration(options);
    for (const url of [target, nativeTarget]) {
      const address = listeners.get(Number(url.port))?.address();
      if (!address || typeof address === 'string') {
        await integration.close();
        throw new Error('Integration fixture did not bind its loopback listener.');
      }
      url.port = String(address.port);
    }
    return { integration, integrationTarget: target, nativeTarget };
  } finally {
    listen.mockRestore();
  }
}
