/** Runs the real resident Harness on test-owned sockets for the NanoHost regression. */
import { runWorkerHarness } from '../harness.js';
import { redirectSandboxIntegrationListeners } from './ephemeral-integration.js';

const listeners = redirectSandboxIntegrationListeners(({ integrationTarget, nativeTarget }) => {
  process.stdout.write(
    `${JSON.stringify({
      integrationPort: Number(integrationTarget.port),
      nativePort: Number(nativeTarget.port),
    })}\n`
  );
});
try {
  await runWorkerHarness({
    releaseIdentity: { sourceCommit: 'a'.repeat(40), releaseTag: 'v0.1.0' },
  });
} finally {
  listeners.restore();
}
