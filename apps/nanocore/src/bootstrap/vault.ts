import type { BootPhaseOutcome } from './phases.js';

/**
 * Checks the boot-time vault backend availability.
 *
 * @returns Degraded readiness while the first concrete backend is not unlocked.
 */
export function checkBootVaultBackend(): BootPhaseOutcome {
  return {
    status: 'degraded',
    reason: {
      code: 'vault.locked',
      message: 'Vault backend is locked until an unlock source is configured or supplied.',
      blocks: ['vault.read', 'vault.use', 'secret.inject'],
    },
  };
}
