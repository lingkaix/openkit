import { loadEncryptedFileVaultKeyFile } from '../vault/vault-key-file.js';
import type { VaultUnlockState } from '../vault/vault-unlock-state.js';
import type { BootPhaseOutcome } from './phases.js';

/**
 * Checks the boot-time vault backend availability.
 *
 * @param input Process vault state and optional encrypted-file key source.
 * @returns Ready when the backend is available, otherwise non-critical degraded readiness.
 */
export function checkBootVaultBackend(input: {
  readonly keyFilePath?: string;
  readonly vaultUnlockState: VaultUnlockState;
}): BootPhaseOutcome {
  const initialHealth = input.vaultUnlockState.backend().health();

  if (
    initialHealth.kind === 'encrypted-file' &&
    initialHealth.state !== 'available' &&
    input.keyFilePath
  ) {
    let masterKey: Buffer | undefined;

    try {
      masterKey = loadEncryptedFileVaultKeyFile({ keyFilePath: input.keyFilePath });
      input.vaultUnlockState.unlock({ masterKey });
    } catch {
      // Vault key failures remain a redacted, non-critical degraded boot condition.
    } finally {
      masterKey?.fill(0);
    }
  }

  if (input.vaultUnlockState.backend().health().state === 'available') {
    return { status: 'ok' };
  }

  return {
    status: 'degraded',
    reason: {
      code: 'vault.locked',
      message: 'Vault backend is locked until an unlock source is configured or supplied.',
      blocks: ['vault.read', 'vault.use', 'secret.inject'],
    },
  };
}
