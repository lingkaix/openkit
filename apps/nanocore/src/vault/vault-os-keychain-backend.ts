import { execFileSync } from 'node:child_process';

import {
  assertVaultEntryMetadata,
  type VaultBackend,
  VaultBackendError,
  type VaultEntryMetadata,
  type VaultListReferencesInput,
  type VaultReferenceInventoryEntry,
  type VaultResolveInput,
  type VaultRevokeInput,
  type VaultRotateInput,
  type VaultSecretMaterial,
  type VaultStoreInput,
} from './vault-backend.js';

/** Safe reference and deployment id characters for keychain item names. */
const SAFE_KEYCHAIN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Keychain account that stores the non-secret backend inventory index. */
const INDEX_ACCOUNT = '__index__';

/** Health projection returned by a platform keychain adapter. */
export interface OsKeychainVaultAdapterHealth {
  /** Adapter availability state. */
  readonly state: 'available' | 'locked' | 'unavailable';
  /** Redacted human-readable diagnostic. */
  readonly diagnostic: string;
}

/** Keychain item address used by the os-keychain vault backend. */
export interface OsKeychainVaultItemInput {
  /** Keychain service namespace. */
  readonly service: string;
  /** Keychain account name. */
  readonly account: string;
}

/** Platform keychain operations required by the os-keychain backend. */
export interface OsKeychainVaultAdapter {
  /** Returns redacted keychain health. */
  health(): OsKeychainVaultAdapterHealth;
  /**
   * Reads one keychain item.
   *
   * @param input Service and account identity.
   * @returns Stored item value, or null when absent.
   */
  get(input: OsKeychainVaultItemInput): string | null;
  /**
   * Writes one keychain item.
   *
   * @param input Service, account, and item value.
   */
  set(input: OsKeychainVaultItemInput & { value: string }): void;
  /**
   * Deletes one keychain item if present.
   *
   * @param input Service and account identity.
   */
  delete(input: OsKeychainVaultItemInput): void;
}

/** Input used to create an os-keychain vault backend. */
export interface CreateOsKeychainVaultBackendInput {
  /** Stable NanoCore deployment id used in the keychain service namespace. */
  readonly deploymentId: string;
  /** Optional platform adapter, injected by tests. */
  readonly adapter?: OsKeychainVaultAdapter;
  /** Optional process platform override, injected by tests. */
  readonly platform?: NodeJS.Platform;
  /** Optional command runner override, injected by tests. */
  readonly execFileSync?: typeof execFileSync;
  /** Milliseconds prior versions remain resolvable after rotation. */
  readonly rotationGraceMs?: number;
  /** Optional deterministic clock. */
  readonly now?: () => string;
  /** Optional service namespace prefix. */
  readonly servicePrefix?: string;
}

/** Durable non-secret inventory stored in the index keychain item. */
interface OsKeychainInventoryIndex {
  /** Indexed vault references by id. */
  readonly references: Record<string, VaultReferenceInventoryEntry>;
}

/** Secret-bearing keychain payload stored per vault reference. */
interface OsKeychainReferencePayload {
  /** Current material version. */
  readonly currentVersion: number;
  /** Stable vault reference id. */
  readonly referenceId: string;
  /** Explicit prior-version expiry timestamps by material version. */
  readonly versionExpirations: Record<string, string>;
  /** Base64 encoded material by version. */
  readonly versions: Record<string, string>;
}

/**
 * Creates an unlocked os-keychain vault backend.
 *
 * @param input Deployment namespace, optional adapter, and optional clock.
 * @returns Vault backend backed by a platform keychain.
 */
export function createOsKeychainVaultBackend(
  input: CreateOsKeychainVaultBackendInput
): VaultBackend {
  return new OsKeychainVaultBackend(input);
}

/** os-keychain vault backend implementation. */
class OsKeychainVaultBackend implements VaultBackend {
  public readonly kind = 'os-keychain' as const;

  private readonly adapter: OsKeychainVaultAdapter;

  private readonly now: () => string;

  private readonly rotationGraceMs: number;

  private readonly service: string;

  /**
   * Creates an os-keychain vault backend.
   *
   * @param input Deployment namespace, adapter, and optional clock.
   */
  public constructor(input: CreateOsKeychainVaultBackendInput) {
    assertSafeId(input.deploymentId, 'deployment');
    this.adapter =
      input.adapter ??
      createDefaultOsKeychainVaultAdapter(
        input.platform ?? process.platform,
        input.execFileSync ?? execFileSync
      );
    this.now = input.now ?? (() => new Date().toISOString());
    this.rotationGraceMs = input.rotationGraceMs ?? 0;
    this.service = `${input.servicePrefix ?? 'openkit'}.${input.deploymentId}.vault`;
  }

  /**
   * Returns redacted keychain health.
   *
   * @returns Backend health projection.
   */
  public health(): ReturnType<VaultBackend['health']> {
    const health = this.adapter.health();

    return {
      diagnostic:
        health.state === 'available' ? 'os-keychain vault backend is available' : health.diagnostic,
      kind: this.kind,
      state: health.state,
    };
  }

  /**
   * Resolves one keychain material version.
   *
   * @param input Reference and optional version to resolve.
   * @returns Secret material bytes.
   * @throws VaultBackendError when the reference/version is missing or unavailable.
   */
  public resolve(input: VaultResolveInput): VaultSecretMaterial {
    this.assertAvailable();
    assertSafeId(input.referenceId, 'reference');

    const inventory = this.index().references[input.referenceId];

    if (!inventory) {
      throw new VaultBackendError('reference-not-found', 'Vault reference material was not found.');
    }
    if (inventory.revoked) {
      throw new VaultBackendError('reference-revoked', 'Vault reference material is revoked.');
    }

    const version = input.version ?? inventory.currentVersion;
    const payload = this.requirePayload(input.referenceId);

    if (this.isExpiredVersion(payload, version)) {
      this.writePayload({
        ...payload,
        versions: omitKey(payload.versions, String(version)),
      });
      throw new VaultBackendError('version-expired', 'Vault reference material version expired.');
    }

    const encoded = payload.versions[String(version)];

    if (!encoded) {
      throw new VaultBackendError('reference-not-found', 'Vault reference material was not found.');
    }

    return Buffer.from(encoded, 'base64');
  }

  /**
   * Stores version 1 material for a new keychain reference.
   *
   * @param input Reference, material, and non-secret metadata.
   * @returns Non-secret inventory metadata.
   * @throws VaultBackendError when the reference already exists.
   */
  public store(input: VaultStoreInput): VaultReferenceInventoryEntry {
    this.assertAvailable();
    assertSafeId(input.referenceId, 'reference');
    assertVaultEntryMetadata(input.metadata);

    const index = this.index();

    if (index.references[input.referenceId]) {
      throw new VaultBackendError(
        'backend-unavailable',
        'Vault reference material already exists.'
      );
    }

    const updatedAt = this.now();

    this.writePayload({
      currentVersion: 1,
      referenceId: input.referenceId,
      versionExpirations: {},
      versions: { '1': encodeMaterial(input.material) },
    });

    const inventory = inventoryEntry({
      currentVersion: 1,
      metadata: input.metadata,
      referenceId: input.referenceId,
      revoked: false,
      updatedAt,
      versionCount: 1,
    });

    this.writeIndex({
      references: {
        ...index.references,
        [input.referenceId]: inventory,
      },
    });

    return inventory;
  }

  /**
   * Rotates one keychain reference.
   *
   * @param input Reference and replacement material.
   * @returns Non-secret inventory metadata after rotation.
   */
  public rotate(input: VaultRotateInput): VaultReferenceInventoryEntry {
    this.assertAvailable();
    assertSafeId(input.referenceId, 'reference');

    const index = this.index();
    const current = requireActiveInventory(index, input.referenceId);
    const payload = this.requirePayload(input.referenceId);
    const nextVersion = current.currentVersion + 1;
    const updatedAt = this.now();

    this.writePayload({
      currentVersion: nextVersion,
      referenceId: input.referenceId,
      versionExpirations: rotatedExpirations(payload, nextVersion, updatedAt, this.rotationGraceMs),
      versions: {
        ...payload.versions,
        [String(nextVersion)]: encodeMaterial(input.material),
      },
    });

    const inventory = {
      ...current,
      currentVersion: nextVersion,
      revoked: false,
      updatedAt,
      versionCount: nextVersion,
    };

    this.writeIndex({
      references: {
        ...index.references,
        [input.referenceId]: inventory,
      },
    });

    return inventory;
  }

  /**
   * Revokes every material version for one keychain reference.
   *
   * @param input Reference to revoke.
   * @returns Non-secret inventory metadata after revocation.
   */
  public revoke(input: VaultRevokeInput): VaultReferenceInventoryEntry {
    this.assertAvailable();
    assertSafeId(input.referenceId, 'reference');

    const index = this.index();
    const current = requireExistingInventory(index, input.referenceId);
    const inventory = {
      ...current,
      revoked: true,
      updatedAt: this.now(),
    };

    this.deleteItem(input.referenceId);
    this.writeIndex({
      references: {
        ...index.references,
        [input.referenceId]: inventory,
      },
    });

    return inventory;
  }

  /**
   * Lists non-secret keychain inventory metadata.
   *
   * @param input Optional owner-scope filters.
   * @returns Non-secret reference inventory rows.
   */
  public listReferences(input: VaultListReferencesInput = {}): VaultReferenceInventoryEntry[] {
    this.assertAvailable();

    return Object.values(this.index().references)
      .filter((entry) => matchesFilter(entry, input))
      .sort((left, right) => left.referenceId.localeCompare(right.referenceId));
  }

  /**
   * Reads and parses the keychain inventory index.
   *
   * @returns Non-secret inventory index.
   */
  private index(): OsKeychainInventoryIndex {
    const value = this.getItem(INDEX_ACCOUNT);

    if (!value) {
      return { references: {} };
    }

    return parseJson<OsKeychainInventoryIndex>(value);
  }

  /**
   * Writes the keychain inventory index.
   *
   * @param index Non-secret index.
   */
  private writeIndex(index: OsKeychainInventoryIndex): void {
    this.setItem(INDEX_ACCOUNT, JSON.stringify(index));
  }

  /**
   * Reads a reference payload or throws.
   *
   * @param referenceId Vault reference id.
   * @returns Secret-bearing payload.
   */
  private requirePayload(referenceId: string): OsKeychainReferencePayload {
    const value = this.getItem(referenceId);

    if (!value) {
      throw new VaultBackendError('reference-not-found', 'Vault reference material was not found.');
    }

    return parseJson<OsKeychainReferencePayload>(value);
  }

  /**
   * Writes a secret-bearing reference payload.
   *
   * @param payload Reference payload.
   */
  private writePayload(payload: OsKeychainReferencePayload): void {
    this.setItem(payload.referenceId, JSON.stringify(payload));
  }

  /**
   * Checks whether a non-current version has expired.
   *
   * @param payload Secret-bearing payload.
   * @param version Material version.
   * @returns True when the version has expired.
   */
  private isExpiredVersion(payload: OsKeychainReferencePayload, version: number): boolean {
    const expiresAt = payload.versionExpirations[String(version)];

    return expiresAt !== undefined && expiresAt <= this.now();
  }

  /**
   * Reads one keychain item with redacted typed failures.
   *
   * @param account Keychain account name.
   * @returns Stored item value, or null.
   */
  private getItem(account: string): string | null {
    try {
      return this.adapter.get({ account, service: this.service });
    } catch {
      throw new VaultBackendError('backend-unavailable', 'Keychain item read failed.');
    }
  }

  /**
   * Writes one keychain item with redacted typed failures.
   *
   * @param account Keychain account name.
   * @param value Item value.
   */
  private setItem(account: string, value: string): void {
    try {
      this.adapter.set({ account, service: this.service, value });
    } catch {
      throw new VaultBackendError('backend-unavailable', 'Keychain item write failed.');
    }
  }

  /**
   * Deletes one keychain item with redacted typed failures.
   *
   * @param account Keychain account name.
   */
  private deleteItem(account: string): void {
    try {
      this.adapter.delete({ account, service: this.service });
    } catch {
      throw new VaultBackendError('backend-unavailable', 'Keychain item delete failed.');
    }
  }

  /**
   * Fails operations when the platform keychain is not available.
   */
  private assertAvailable(): void {
    const health = this.health();

    if (health.state === 'locked') {
      throw new VaultBackendError('vault-locked', health.diagnostic);
    }
    if (health.state !== 'available') {
      throw new VaultBackendError('backend-unavailable', health.diagnostic);
    }
  }
}

/**
 * Creates the default platform keychain adapter for this process.
 *
 * @returns Platform keychain adapter.
 */
function createDefaultOsKeychainVaultAdapter(
  platform: NodeJS.Platform,
  execFile: typeof execFileSync
): OsKeychainVaultAdapter {
  if (platform === 'darwin') {
    return new MacOsSecurityKeychainAdapter(execFile);
  }
  if (platform === 'linux') {
    return new LinuxSecretServiceKeychainAdapter(execFile);
  }
  if (platform === 'win32') {
    return new WindowsCredentialManagerKeychainAdapter(execFile);
  }

  return new UnavailableKeychainAdapter();
}

/** macOS Keychain adapter using the built-in `security` CLI. */
class MacOsSecurityKeychainAdapter implements OsKeychainVaultAdapter {
  /**
   * Creates a macOS keychain adapter.
   *
   * @param execFile Command runner.
   */
  public constructor(private readonly execFile: typeof execFileSync) {}

  /**
   * Checks whether the macOS keychain command is reachable.
   *
   * @returns Redacted adapter health.
   */
  public health(): OsKeychainVaultAdapterHealth {
    try {
      this.execFile('security', ['list-keychains'], { stdio: 'ignore' });
      return { diagnostic: 'macOS Keychain available', state: 'available' };
    } catch {
      return { diagnostic: 'macOS Keychain unavailable', state: 'unavailable' };
    }
  }

  /**
   * Reads one macOS generic password.
   *
   * @param input Service and account identity.
   * @returns Stored value, or null when absent.
   */
  public get(input: OsKeychainVaultItemInput): string | null {
    try {
      return this.execFile(
        'security',
        ['find-generic-password', '-a', input.account, '-s', input.service, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch {
      return null;
    }
  }

  /**
   * Writes one macOS generic password.
   *
   * @param input Service, account, and value.
   */
  public set(input: OsKeychainVaultItemInput & { value: string }): void {
    this.execFile(
      'security',
      ['add-generic-password', '-a', input.account, '-s', input.service, '-w', input.value, '-U'],
      { stdio: 'ignore' }
    );
  }

  /**
   * Deletes one macOS generic password.
   *
   * @param input Service and account identity.
   */
  public delete(input: OsKeychainVaultItemInput): void {
    try {
      this.execFile(
        'security',
        ['delete-generic-password', '-a', input.account, '-s', input.service],
        {
          stdio: 'ignore',
        }
      );
    } catch {
      // Missing keychain items are already deleted.
    }
  }
}

/** Linux Secret Service adapter using the standard `secret-tool` CLI. */
class LinuxSecretServiceKeychainAdapter implements OsKeychainVaultAdapter {
  /**
   * Creates a Linux Secret Service adapter.
   *
   * @param execFile Command runner.
   */
  public constructor(private readonly execFile: typeof execFileSync) {}

  /**
   * Checks whether `secret-tool` is reachable.
   *
   * @returns Redacted adapter health.
   */
  public health(): OsKeychainVaultAdapterHealth {
    try {
      this.execFile('secret-tool', ['--version'], { stdio: 'ignore' });
      return { diagnostic: 'Linux Secret Service available', state: 'available' };
    } catch {
      return { diagnostic: 'Linux Secret Service unavailable', state: 'unavailable' };
    }
  }

  /**
   * Reads one Linux Secret Service item.
   *
   * @param input Service and account identity.
   * @returns Stored value, or null when absent.
   */
  public get(input: OsKeychainVaultItemInput): string | null {
    try {
      return this.execFile('secret-tool', this.lookupArgs(input), {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  }

  /**
   * Writes one Linux Secret Service item.
   *
   * @param input Service, account, and value.
   */
  public set(input: OsKeychainVaultItemInput & { value: string }): void {
    this.execFile(
      'secret-tool',
      ['store', `--label=OpenKit ${input.account}`, ...this.attrs(input)],
      {
        input: input.value,
        stdio: ['pipe', 'ignore', 'ignore'],
      }
    );
  }

  /**
   * Deletes one Linux Secret Service item if present.
   *
   * @param input Service and account identity.
   */
  public delete(input: OsKeychainVaultItemInput): void {
    try {
      this.execFile('secret-tool', ['clear', ...this.attrs(input)], { stdio: 'ignore' });
    } catch {
      // Missing Secret Service items are already deleted.
    }
  }

  /**
   * Builds lookup command arguments.
   *
   * @param input Service and account identity.
   * @returns `secret-tool lookup` arguments.
   */
  private lookupArgs(input: OsKeychainVaultItemInput): string[] {
    return ['lookup', ...this.attrs(input)];
  }

  /**
   * Builds stable Secret Service attributes.
   *
   * @param input Service and account identity.
   * @returns Attribute name/value pairs.
   */
  private attrs(input: OsKeychainVaultItemInput): string[] {
    return ['openkit-service', input.service, 'openkit-account', input.account];
  }
}

/** Windows Credential Manager adapter using PowerShell and the Credential API. */
class WindowsCredentialManagerKeychainAdapter implements OsKeychainVaultAdapter {
  /**
   * Creates a Windows Credential Manager adapter.
   *
   * @param execFile Command runner.
   */
  public constructor(private readonly execFile: typeof execFileSync) {}

  /**
   * Checks whether PowerShell is reachable.
   *
   * @returns Redacted adapter health.
   */
  public health(): OsKeychainVaultAdapterHealth {
    try {
      this.execFile('powershell.exe', windowsPowerShellArgs('$PSVersionTable'), {
        stdio: 'ignore',
      });
      return { diagnostic: 'Windows Credential Manager available', state: 'available' };
    } catch {
      return { diagnostic: 'Windows Credential Manager unavailable', state: 'unavailable' };
    }
  }

  /**
   * Reads one Windows generic credential.
   *
   * @param input Service and account identity.
   * @returns Stored value, or null when absent.
   */
  public get(input: OsKeychainVaultItemInput): string | null {
    try {
      return this.execFile(
        'powershell.exe',
        credentialManagerArgs(WINDOWS_CREDENTIAL_READ, input),
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
    } catch {
      return null;
    }
  }

  /**
   * Writes one Windows generic credential.
   *
   * @param input Service, account, and value.
   */
  public set(input: OsKeychainVaultItemInput & { value: string }): void {
    this.execFile('powershell.exe', credentialManagerArgs(WINDOWS_CREDENTIAL_WRITE, input), {
      input: input.value,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  }

  /**
   * Deletes one Windows generic credential if present.
   *
   * @param input Service and account identity.
   */
  public delete(input: OsKeychainVaultItemInput): void {
    try {
      this.execFile('powershell.exe', credentialManagerArgs(WINDOWS_CREDENTIAL_DELETE, input), {
        stdio: 'ignore',
      });
    } catch {
      // Missing Credential Manager items are already deleted.
    }
  }
}

/** PowerShell script for reading one Windows generic credential. */
const WINDOWS_CREDENTIAL_READ = `
param([string]$Service, [string]$Account)
$ErrorActionPreference = 'Stop'
$Target = $Service + ':' + $Account
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class OpenKitCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", EntryPoint="CredFree", SetLastError=true)]
  public static extern void CredFree(IntPtr buffer);
}
"@
$CredentialPointer = [IntPtr]::Zero
if (-not [OpenKitCredentialManager]::CredRead($Target, 1, 0, [ref]$CredentialPointer)) { exit 2 }
try {
  $Credential = [Runtime.InteropServices.Marshal]::PtrToStructure($CredentialPointer, [type][OpenKitCredentialManager+CREDENTIAL])
  [Runtime.InteropServices.Marshal]::PtrToStringUni($Credential.CredentialBlob, [int]($Credential.CredentialBlobSize / 2))
} finally {
  if ($CredentialPointer -ne [IntPtr]::Zero) { [OpenKitCredentialManager]::CredFree($CredentialPointer) }
}
`;

/** PowerShell script for writing one Windows generic credential from stdin. */
const WINDOWS_CREDENTIAL_WRITE = `
param([string]$Service, [string]$Account)
$ErrorActionPreference = 'Stop'
$Target = $Service + ':' + $Account
$Secret = [Console]::In.ReadToEnd()
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class OpenKitCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);
}
"@
$Blob = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($Secret)
try {
  $Credential = New-Object OpenKitCredentialManager+CREDENTIAL
  $Credential.Type = 1
  $Credential.TargetName = $Target
  $Credential.CredentialBlobSize = [Text.Encoding]::Unicode.GetByteCount($Secret)
  $Credential.CredentialBlob = $Blob
  $Credential.Persist = 2
  $Credential.UserName = $Account
  if (-not [OpenKitCredentialManager]::CredWrite([ref]$Credential, 0)) { exit 1 }
} finally {
  if ($Blob -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($Blob) }
}
`;

/** PowerShell script for deleting one Windows generic credential. */
const WINDOWS_CREDENTIAL_DELETE = `
param([string]$Service, [string]$Account)
$ErrorActionPreference = 'Stop'
$Target = $Service + ':' + $Account
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;

public static class OpenKitCredentialManager {
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, uint type, uint flags);
}
"@
[OpenKitCredentialManager]::CredDelete($Target, 1, 0) | Out-Null
`;

/**
 * Builds non-secret PowerShell arguments for a Credential Manager operation.
 *
 * @param script PowerShell script body.
 * @param input Service and account identity.
 * @returns PowerShell argv without secret material.
 */
function credentialManagerArgs(script: string, input: OsKeychainVaultItemInput): string[] {
  return [...windowsPowerShellArgs(script), input.service, input.account];
}

/**
 * Builds the stable non-secret PowerShell command prefix.
 *
 * @param script PowerShell script body.
 * @returns PowerShell argv with the script at a stable position.
 */
function windowsPowerShellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

/** Unavailable adapter for platforms without an implemented native adapter. */
class UnavailableKeychainAdapter implements OsKeychainVaultAdapter {
  /**
   * Reports unavailable native keychain support.
   *
   * @returns Redacted unavailable health.
   */
  public health(): OsKeychainVaultAdapterHealth {
    return {
      diagnostic: 'No native keychain adapter is implemented for this platform.',
      state: 'unavailable',
    };
  }

  /**
   * Reads no item because the adapter is unavailable.
   *
   * @param _input Service and account identity.
   * @returns Null.
   */
  public get(_input: OsKeychainVaultItemInput): string | null {
    return null;
  }

  /**
   * Fails writes because the adapter is unavailable.
   *
   * @param _input Service, account, and value.
   */
  public set(_input: OsKeychainVaultItemInput & { value: string }): void {
    throw new Error('Keychain unavailable.');
  }

  /**
   * Ignores deletes because the adapter is unavailable.
   *
   * @param _input Service and account identity.
   */
  public delete(_input: OsKeychainVaultItemInput): void {}
}

/**
 * Builds one non-secret inventory entry.
 *
 * @param input Reference id, metadata, version state, and timestamp.
 * @returns Inventory entry.
 */
function inventoryEntry(input: {
  currentVersion: number;
  metadata: VaultEntryMetadata;
  referenceId: string;
  revoked: boolean;
  updatedAt: string;
  versionCount: number;
}): VaultReferenceInventoryEntry {
  return {
    backendKind: 'os-keychain',
    currentVersion: input.currentVersion,
    ownerScope: input.metadata.ownerScope,
    referenceId: input.referenceId,
    revoked: input.revoked,
    updatedAt: input.updatedAt,
    versionCount: input.versionCount,
    ...(input.metadata.userId ? { userId: input.metadata.userId } : {}),
    ...(input.metadata.workspaceId ? { workspaceId: input.metadata.workspaceId } : {}),
  };
}

/**
 * Requires an existing inventory entry.
 *
 * @param index Inventory index.
 * @param referenceId Vault reference id.
 * @returns Existing inventory entry.
 */
function requireExistingInventory(
  index: OsKeychainInventoryIndex,
  referenceId: string
): VaultReferenceInventoryEntry {
  const inventory = index.references[referenceId];

  if (!inventory) {
    throw new VaultBackendError('reference-not-found', 'Vault reference material was not found.');
  }

  return inventory;
}

/**
 * Requires an existing non-revoked inventory entry.
 *
 * @param index Inventory index.
 * @param referenceId Vault reference id.
 * @returns Active inventory entry.
 */
function requireActiveInventory(
  index: OsKeychainInventoryIndex,
  referenceId: string
): VaultReferenceInventoryEntry {
  const inventory = requireExistingInventory(index, referenceId);

  if (inventory.revoked) {
    throw new VaultBackendError('reference-revoked', 'Vault reference material is revoked.');
  }

  return inventory;
}

/**
 * Computes prior-version expirations after rotation.
 *
 * @param payload Existing reference payload.
 * @param nextVersion Newly current version.
 * @param updatedAt Rotation timestamp.
 * @param rotationGraceMs Grace period in milliseconds.
 * @returns Version expiration map.
 */
function rotatedExpirations(
  payload: OsKeychainReferencePayload,
  nextVersion: number,
  updatedAt: string,
  rotationGraceMs: number
): Record<string, string> {
  const expirations = { ...payload.versionExpirations };

  for (let version = 1; version < nextVersion; version += 1) {
    const key = String(version);

    if (!expirations[key]) {
      expirations[key] = new Date(new Date(updatedAt).getTime() + rotationGraceMs).toISOString();
    }
  }

  return expirations;
}

/**
 * Checks whether an inventory entry matches list filters.
 *
 * @param entry Inventory entry.
 * @param input List filter.
 * @returns True when the entry should be returned.
 */
function matchesFilter(
  entry: VaultReferenceInventoryEntry,
  input: VaultListReferencesInput
): boolean {
  return (
    (input.ownerScope === undefined || entry.ownerScope === input.ownerScope) &&
    (input.workspaceId === undefined || entry.workspaceId === input.workspaceId) &&
    (input.userId === undefined || entry.userId === input.userId)
  );
}

/**
 * Encodes secret material for JSON keychain payload storage.
 *
 * @param material Secret material.
 * @returns Base64 encoded material.
 */
function encodeMaterial(material: VaultSecretMaterial): string {
  return Buffer.from(material).toString('base64');
}

/**
 * Returns a copy of an object without one key.
 *
 * @param value Source object.
 * @param key Key to omit.
 * @returns Object copy.
 */
function omitKey(value: Record<string, string>, key: string): Record<string, string> {
  const copy = { ...value };

  delete copy[key];

  return copy;
}

/**
 * Parses backend JSON with a redacted typed failure.
 *
 * @param value JSON string.
 * @returns Parsed JSON.
 */
function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new VaultBackendError('backend-unavailable', 'Keychain item format is invalid.');
  }
}

/**
 * Validates a deployment or reference id before using it in a keychain name.
 *
 * @param value Identifier value.
 * @param label Redacted identifier label.
 */
function assertSafeId(value: string, label: string): void {
  if (!SAFE_KEYCHAIN_ID_PATTERN.test(value)) {
    throw new VaultBackendError('backend-unavailable', `Invalid ${label} identifier.`);
  }
}
