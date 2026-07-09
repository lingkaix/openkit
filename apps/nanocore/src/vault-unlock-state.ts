import { createLockedVaultBackend, type VaultBackend, VaultBackendError } from './vault-backend.js';
import { createEncryptedFileVaultBackend } from './vault-encrypted-file-backend.js';
import {
  createOsKeychainVaultBackend,
  type OsKeychainVaultAdapter,
} from './vault-os-keychain-backend.js';

/** Required raw encrypted-file unlock key length. */
const RAW_UNLOCK_KEY_BYTES = 32;

/** Input used to create process-local vault unlock state. */
export type CreateVaultUnlockStateInput =
  | CreateEncryptedFileVaultUnlockStateInput
  | CreateOsKeychainVaultUnlockStateInput;

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

/** Input used to create os-keychain process-local vault state. */
export interface CreateOsKeychainVaultUnlockStateInput {
  /** Backend kind managed by this state holder. */
  readonly backendKind: 'os-keychain';
  /** Stable deployment id used for keychain item namespacing. */
  readonly deploymentId: string;
  /** Optional platform keychain adapter. */
  readonly adapter?: OsKeychainVaultAdapter;
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

  /**
   * Creates a locked vault state holder.
   *
   * @param input Backend kind, store directory, and optional backend settings.
   */
  public constructor(input: CreateVaultUnlockStateInput) {
    this.input = input;
    this.currentBackend =
      input.backendKind === 'os-keychain' ? this.osKeychainBackend() : this.lockedBackend();
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
    if (this.input.backendKind === 'os-keychain') {
      throw new VaultBackendError(
        'backend-unavailable',
        'os-keychain vault backend does not use encrypted-file unlock keys.'
      );
    }

    this.assertUnlockKey(input.masterKey);
    this.currentBackend = createEncryptedFileVaultBackend({
      masterKey: Buffer.from(input.masterKey),
      ...(this.input.now ? { now: this.input.now } : {}),
      ...(this.input.rotationGraceMs != null
        ? { rotationGraceMs: this.input.rotationGraceMs }
        : {}),
      storeDir: this.input.storeDir,
    });
    return this.currentBackend;
  }

  /**
   * Locks the backend and discards the available backend instance.
   *
   * @returns Locked backend projection.
   */
  public lock(): VaultBackend {
    if (this.input.backendKind === 'os-keychain') {
      return this.currentBackend;
    }

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
   * Builds the os-keychain backend projection.
   *
   * @returns os-keychain vault backend.
   */
  private osKeychainBackend(): VaultBackend {
    if (this.input.backendKind !== 'os-keychain') {
      throw new VaultBackendError('backend-unavailable', 'Vault backend kind is not os-keychain.');
    }

    return createOsKeychainVaultBackend({
      ...(this.input.adapter ? { adapter: this.input.adapter } : {}),
      deploymentId: this.input.deploymentId,
      ...(this.input.now ? { now: this.input.now } : {}),
      ...(this.input.rotationGraceMs != null
        ? { rotationGraceMs: this.input.rotationGraceMs }
        : {}),
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
