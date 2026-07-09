import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const KEYCHAIN_SERVICE = 'openkit.nanocore.token';
/** Warning emitted when MCP stores NanoCore credentials outside the OS keychain. */
export const ENCRYPTED_FALLBACK_CREDENTIAL_STORAGE_WARNING =
  'OpenKit MCP is using encrypted-file NanoCore token storage because no OS keychain token was available.';

/** Input for reading one stored NanoCore token. */
export interface ReadNanoCoreTokenInput {
  /** NanoCore endpoint URL used as the credential account key. */
  baseUrl: string;
}

/** Input for writing one stored NanoCore token. */
export interface WriteNanoCoreTokenInput extends ReadNanoCoreTokenInput {
  /** Plaintext OpenKit access token to store. */
  token: string;
}

/** Credential backend that stored a NanoCore token. */
export type NanoCoreCredentialStorageBackend = 'encrypted-file' | 'os-keychain';

/** Desktop credential store used by the MCP server. */
export interface NanoCoreCredentialStore {
  /**
   * Reads a stored NanoCore token.
   *
   * @param input NanoCore endpoint lookup key.
   * @returns Plaintext token when the platform store has one.
   */
  readNanoCoreToken(input: ReadNanoCoreTokenInput): string | null;
  /**
   * Writes a NanoCore token for future MCP process launches.
   *
   * @param input NanoCore endpoint key and token.
   * @returns Storage backend that accepted the token.
   */
  writeNanoCoreToken?(input: WriteNanoCoreTokenInput): NanoCoreCredentialStorageBackend;
}

/** Options for creating the default desktop credential store. */
export interface CreateDefaultNanoCoreCredentialStoreOptions {
  /** Platform name, defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Synchronous command runner, injectable for tests. */
  execFile?: typeof execFileSync;
  /** OpenKit user config directory, defaults to the platform config location. */
  configDir?: string;
  /** Machine-scoped key seed, injectable for tests. */
  machineId?: string;
  /** Warning sink used when degraded fallback storage is used. */
  warn?: (message: string) => void;
}

/**
 * Creates the default desktop credential store reader.
 *
 * @param options Optional platform and command runner overrides.
 * @returns Credential store reader.
 */
export function createDefaultNanoCoreCredentialStore(
  options: CreateDefaultNanoCoreCredentialStoreOptions = {}
): NanoCoreCredentialStore {
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? execFileSync;
  const configDir = options.configDir ?? defaultOpenKitConfigDir(platform);
  let machineId = options.machineId;
  let encryptedFallbackStorageWarned = false;
  const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  const warnEncryptedFallbackStorage = () => {
    if (encryptedFallbackStorageWarned) {
      return;
    }
    encryptedFallbackStorageWarned = true;
    warn(ENCRYPTED_FALLBACK_CREDENTIAL_STORAGE_WARNING);
  };
  const resolveMachineId = () => {
    machineId ??= readMachineId(platform, execFile);
    return machineId;
  };

  return {
    readNanoCoreToken(input) {
      const keychainToken = readPlatformKeychainToken(platform, execFile, input.baseUrl);
      if (keychainToken) {
        return keychainToken;
      }
      const fallbackToken = readEncryptedFallbackToken(
        configDir,
        resolveMachineId(),
        input.baseUrl
      );
      if (fallbackToken) {
        warnEncryptedFallbackStorage();
      }
      return fallbackToken;
    },
    writeNanoCoreToken(input) {
      if (writePlatformKeychainToken(platform, execFile, input.baseUrl, input.token)) {
        return 'os-keychain';
      }
      writeEncryptedFallbackToken(configDir, resolveMachineId(), input.baseUrl, input.token);
      warnEncryptedFallbackStorage();
      return 'encrypted-file';
    },
  };
}

/**
 * Reads a token from the current platform keychain.
 *
 * @param platform Current platform.
 * @param execFile Command runner.
 * @param baseUrl NanoCore endpoint account key.
 * @returns Stored token or null.
 */
function readPlatformKeychainToken(
  platform: NodeJS.Platform,
  execFile: typeof execFileSync,
  baseUrl: string
): string | null {
  if (platform === 'darwin') {
    return readMacOsKeychainToken(execFile, baseUrl);
  }
  if (platform === 'linux') {
    return readSecretServiceToken(execFile, baseUrl);
  }
  if (platform === 'win32') {
    return readWindowsCredentialManagerToken(execFile, baseUrl);
  }
  return null;
}

/**
 * Writes a token to the current platform keychain when the CLI can avoid secret argv.
 *
 * @param platform Current platform.
 * @param execFile Command runner.
 * @param baseUrl NanoCore endpoint account key.
 * @param token OpenKit access token.
 * @returns True when the platform keychain accepted the token.
 */
function writePlatformKeychainToken(
  platform: NodeJS.Platform,
  execFile: typeof execFileSync,
  baseUrl: string,
  token: string
): boolean {
  const normalized = normalizeStoredNanoCoreToken(token);
  if (!normalized) {
    throw new Error('Only OpenKit access tokens can be stored.');
  }

  if (platform === 'linux') {
    return writeKeychainCommand(
      execFile,
      'secret-tool',
      [
        'store',
        '--label',
        'OpenKit NanoCore token',
        'application',
        'openkit',
        'nanocore-url',
        baseUrl,
      ],
      normalized
    );
  }
  if (platform === 'win32') {
    return writeKeychainCommand(
      execFile,
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_CREDENTIAL_WRITE,
        KEYCHAIN_SERVICE,
        baseUrl,
      ],
      normalized
    );
  }

  return false;
}

/**
 * Normalizes stored token material.
 *
 * @param value Raw stored value.
 * @returns Trimmed OpenKit token or null.
 */
export function normalizeStoredNanoCoreToken(value: string | null | undefined): string | null {
  const token = value?.trim();
  return token?.startsWith('okt_') ? token : null;
}

/**
 * Reads a macOS Keychain generic password.
 *
 * @param execFile Command runner.
 * @param baseUrl NanoCore endpoint account key.
 * @returns Stored token or null.
 */
function readMacOsKeychainToken(execFile: typeof execFileSync, baseUrl: string): string | null {
  return readKeychainCommand(execFile, 'security', [
    'find-generic-password',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    baseUrl,
    '-w',
  ]);
}

/**
 * Reads a Linux Secret Service entry through `secret-tool`.
 *
 * @param execFile Command runner.
 * @param baseUrl NanoCore endpoint account key.
 * @returns Stored token or null.
 */
function readSecretServiceToken(execFile: typeof execFileSync, baseUrl: string): string | null {
  return readKeychainCommand(execFile, 'secret-tool', [
    'lookup',
    'application',
    'openkit',
    'nanocore-url',
    baseUrl,
  ]);
}

/**
 * Reads a Windows Credential Manager generic credential.
 *
 * @param execFile Command runner.
 * @param baseUrl NanoCore endpoint account key.
 * @returns Stored token or null.
 */
function readWindowsCredentialManagerToken(
  execFile: typeof execFileSync,
  baseUrl: string
): string | null {
  return readKeychainCommand(execFile, 'powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    WINDOWS_CREDENTIAL_READ,
    KEYCHAIN_SERVICE,
    baseUrl,
  ]);
}

/**
 * Runs one credential command and suppresses unavailable-store failures.
 *
 * @param execFile Command runner.
 * @param command Command name.
 * @param args Command arguments.
 * @returns Stored token or null.
 */
function readKeychainCommand(
  execFile: typeof execFileSync,
  command: string,
  args: string[]
): string | null {
  try {
    const output = execFile(command, args, keychainExecOptions());
    return normalizeStoredNanoCoreToken(output);
  } catch {
    return null;
  }
}

/**
 * Builds non-interactive keychain command options.
 *
 * @returns Exec options.
 */
function keychainExecOptions(): ExecFileSyncOptionsWithStringEncoding {
  return { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
}

/**
 * Runs one credential write command and suppresses unavailable-store failures.
 *
 * @param execFile Command runner.
 * @param command Command name.
 * @param args Command arguments.
 * @param token Plaintext token passed through stdin.
 * @returns True when the write command succeeded.
 */
function writeKeychainCommand(
  execFile: typeof execFileSync,
  command: string,
  args: string[],
  token: string
): boolean {
  try {
    execFile(command, args, keychainWriteOptions(token));
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds non-interactive keychain write command options.
 *
 * @param token Plaintext token for stdin.
 * @returns Exec options.
 */
function keychainWriteOptions(
  token: string
): ExecFileSyncOptionsWithStringEncoding & { input: string } {
  return { encoding: 'utf8', input: token, stdio: ['pipe', 'ignore', 'ignore'] };
}

interface EncryptedFallbackRecord {
  ciphertext: string;
  iv: string;
  salt: string;
  tag: string;
  version: 1;
}

/**
 * Writes one encrypted fallback token file.
 *
 * @param configDir OpenKit user config directory.
 * @param machineId Machine-scoped key seed.
 * @param baseUrl NanoCore endpoint key.
 * @param token OpenKit access token.
 * @returns Void.
 */
function writeEncryptedFallbackToken(
  configDir: string,
  machineId: string,
  baseUrl: string,
  token: string
): void {
  const normalized = normalizeStoredNanoCoreToken(token);
  if (!normalized) {
    throw new Error('Only OpenKit access tokens can be stored.');
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fallbackKey(machineId, salt), iv);
  cipher.setAAD(Buffer.from(baseUrl));
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const record: EncryptedFallbackRecord = {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    version: 1,
  };
  const path = fallbackCredentialPath(configDir, baseUrl);
  mkdirSync(join(configDir, 'credentials', 'nanocore'), { mode: 0o700, recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Reads one encrypted fallback token file.
 *
 * @param configDir OpenKit user config directory.
 * @param machineId Machine-scoped key seed.
 * @param baseUrl NanoCore endpoint key.
 * @returns Stored token or null.
 */
function readEncryptedFallbackToken(
  configDir: string,
  machineId: string,
  baseUrl: string
): string | null {
  const path = fallbackCredentialPath(configDir, baseUrl);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<EncryptedFallbackRecord>;
    if (record.version !== 1 || !record.ciphertext || !record.iv || !record.salt || !record.tag) {
      return null;
    }

    const salt = Buffer.from(record.salt, 'base64');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      fallbackKey(machineId, salt),
      Buffer.from(record.iv, 'base64')
    );
    decipher.setAAD(Buffer.from(baseUrl));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return normalizeStoredNanoCoreToken(plaintext);
  } catch {
    return null;
  }
}

/**
 * Resolves the encrypted fallback file path for one NanoCore URL.
 *
 * @param configDir OpenKit user config directory.
 * @param baseUrl NanoCore endpoint key.
 * @returns Fallback credential file path.
 */
function fallbackCredentialPath(configDir: string, baseUrl: string): string {
  const urlHash = createHash('sha256').update(baseUrl).digest('hex');
  return join(configDir, 'credentials', 'nanocore', `${urlHash}.json`);
}

/**
 * Derives a fallback encryption key from the local machine seed.
 *
 * @param machineId Machine-scoped key seed.
 * @param salt Random per-file salt.
 * @returns AES-256 key bytes.
 */
function fallbackKey(machineId: string, salt: Buffer): Buffer {
  return scryptSync(machineId, salt, 32);
}

/**
 * Resolves the default OpenKit config directory.
 *
 * @param platform Current platform.
 * @returns User config directory path.
 */
function defaultOpenKitConfigDir(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'OpenKit');
  }
  if (platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'OpenKit');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'openkit');
}

/**
 * Reads a stable machine-scoped key seed.
 *
 * @param platform Current platform.
 * @param execFile Command runner.
 * @returns Machine-scoped key seed.
 */
function readMachineId(platform: NodeJS.Platform, execFile: typeof execFileSync): string {
  if (platform === 'linux') {
    return readFirstFile(['/etc/machine-id', '/var/lib/dbus/machine-id']) ?? fallbackMachineId();
  }
  if (platform === 'darwin') {
    return readMacOsMachineId(execFile) ?? fallbackMachineId();
  }
  if (platform === 'win32') {
    return readWindowsMachineId(execFile) ?? fallbackMachineId();
  }
  return fallbackMachineId();
}

/**
 * Reads the first non-empty file from a path list.
 *
 * @param paths Candidate paths.
 * @returns Trimmed file content or null.
 */
function readFirstFile(paths: string[]): string | null {
  for (const path of paths) {
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (value) {
        return value;
      }
    } catch {
      // Try the next machine-id source.
    }
  }
  return null;
}

/**
 * Reads the macOS platform UUID.
 *
 * @param execFile Command runner.
 * @returns Platform UUID or null.
 */
function readMacOsMachineId(execFile: typeof execFileSync): string | null {
  try {
    const output = execFile(
      'ioreg',
      ['-rd1', '-c', 'IOPlatformExpertDevice'],
      keychainExecOptions()
    );
    return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads the Windows MachineGuid.
 *
 * @param execFile Command runner.
 * @returns MachineGuid or null.
 */
function readWindowsMachineId(execFile: typeof execFileSync): string | null {
  try {
    const output = execFile(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      keychainExecOptions()
    );
    return /MachineGuid\s+REG_SZ\s+([^\r\n]+)/.exec(output)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Builds a last-resort local key seed.
 *
 * @returns Host and user scoped fallback seed.
 */
function fallbackMachineId(): string {
  return `${hostname()}:${homedir()}`;
}

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

const WINDOWS_CREDENTIAL_WRITE = `
param([string]$Service, [string]$Account)
$ErrorActionPreference = 'Stop'
$Target = $Service + ':' + $Account
$Secret = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($Secret)) { exit 3 }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class OpenKitCredentialManagerWrite {
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
  public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
}
"@
$Bytes = [Text.Encoding]::Unicode.GetBytes($Secret)
$Blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($Bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($Bytes, 0, $Blob, $Bytes.Length)
  $Credential = New-Object OpenKitCredentialManagerWrite+CREDENTIAL
  $Credential.Type = 1
  $Credential.TargetName = $Target
  $Credential.CredentialBlobSize = [uint32]$Bytes.Length
  $Credential.CredentialBlob = $Blob
  $Credential.Persist = 2
  $Credential.UserName = 'OpenKit NanoCore'
  if (-not [OpenKitCredentialManagerWrite]::CredWrite([ref]$Credential, 0)) { exit 4 }
} finally {
  if ($Blob -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($Blob) }
}
`;
