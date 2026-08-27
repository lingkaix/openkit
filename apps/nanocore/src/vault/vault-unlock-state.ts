import { createLockedVaultBackend, type VaultBackend, VaultBackendError } from './vault-backend.js';
import { createEncryptedFileVaultBackend } from './vault-encrypted-file-backend.js';

/** Required raw encrypted-file unlock key length. */
const RAW_UNLOCK_KEY_BYTES = 32;

/** Input used to create process-local vault unlock state. */
export type CreateVaultUnlockStateInput = CreateEncryptedFileVaultUnlockStateInput;

/** Input used to create encrypted-file process-local vault unlock state. */
export interface CreateEncryptedFileVaultUnlockStateInput {
  /** Backend kind managed by this state holder. */
  readonly backendKind: 'encrypted-file';
  /** Encrypted-file store directory when backendKind is encrypted-file. */
  readonly storeDir: string;
  /** Milliseconds prior versions remain resolvable after rotation. */
  readonly rotationGraceMs?: number;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to unlock the encrypted-file backend. */
export interface VaultUnlockInput {
  /** Raw 32-byte encrypted-file master key. */
  readonly masterKey: Uint8Array;
}

/** Process-local vault unlock state. */
export interface VaultUnlockState {
  /**
   * Returns the current backend projection.
   *
   * @returns Locked or available vault backend.
   */
  backend(): VaultBackend;
  /**
   * Unlocks the encrypted-file backend with raw key material.
   *
   * @param input Raw key material.
   * @returns Available backend after unlock.
   * @throws VaultBackendError when key material is invalid.
   */
  unlock(input: VaultUnlockInput): VaultBackend;
  /**
   * Locks the backend and discards the available backend instance.
   *
   * @returns Locked backend projection.
   */
  lock(): VaultBackend;
}

/**
 * Creates process-local vault unlock state.
 *
 * @param input Backend kind, store directory, and optional backend settings.
 * @returns Vault unlock state holder.
 */
export function createVaultUnlockState(input: CreateVaultUnlockStateInput): VaultUnlockState {
  return new ProcessVaultUnlockState(input);
}

/** Process-local vault unlock state implementation. */
class ProcessVaultUnlockState implements VaultUnlockState {
  private readonly input: CreateVaultUnlockStateInput;

  private currentBackend: VaultBackend;

  private masterKey: Buffer | null = null;

  /**
   * Creates a locked vault state holder.
   *
   * @param input Backend kind, store directory, and optional backend settings.
   */
  public constructor(input: CreateVaultUnlockStateInput) {
    this.input = input;
    this.currentBackend = this.lockedBackend();
  }

  /**
   * Returns the current backend projection.
   *
   * @returns Locked or available vault backend.
   */
  public backend(): VaultBackend {
    return this.currentBackend;
  }

  /**
   * Unlocks the encrypted-file backend with raw key material.
   *
   * @param input Raw key material.
   * @returns Available backend after unlock.
   * @throws VaultBackendError when key material is invalid.
   */
  public unlock(input: VaultUnlockInput): VaultBackend {
    this.assertUnlockKey(input.masterKey);
    const masterKey = Buffer.from(input.masterKey);
    const backend = createEncryptedFileVaultBackend({
      isKeyActive: () => this.masterKey === masterKey,
      masterKey,
      ...(this.input.now ? { now: this.input.now } : {}),
      ...(this.input.rotationGraceMs != null
        ? { rotationGraceMs: this.input.rotationGraceMs }
        : {}),
      storeDir: this.input.storeDir,
    });
    const previousMasterKey = this.masterKey;

    this.masterKey = masterKey;
    this.currentBackend = backend;
    previousMasterKey?.fill(0);
    return backend;
  }

  /**
   * Locks the backend and discards the available backend instance.
   *
   * @returns Locked backend projection.
   */
  public lock(): VaultBackend {
    this.masterKey?.fill(0);
    this.masterKey = null;
    this.currentBackend = this.lockedBackend();
    return this.currentBackend;
  }

  /**
   * Builds the locked backend projection.
   *
   * @returns Locked vault backend.
   */
  private lockedBackend(): VaultBackend {
    return createLockedVaultBackend({
      diagnostic: 'Vault backend is locked.',
      kind: this.input.backendKind,
    });
  }

  /**
   * Validates encrypted-file unlock key material.
   *
   * @param key Candidate key material.
   * @throws VaultBackendError when the key is not the required size.
   */
  private assertUnlockKey(key: Uint8Array): void {
    if (key.byteLength !== RAW_UNLOCK_KEY_BYTES) {
      throw new VaultBackendError(
        'backend-unavailable',
        'Vault unlock key must contain exactly 32 bytes.'
      );
    }
  }
}
