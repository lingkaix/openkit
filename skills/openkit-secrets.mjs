import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const KEYCHAIN_SERVICE = 'openkit.nanocore.token';
const OPENKIT_TOKEN_PATTERN = /okt_[A-Za-z0-9._~-]+/g;
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'`(])(?:\/|~\/|[A-Za-z]:[\\/]|\\\\|\/\/)\S*/g;

/** Warning emitted when the CLI stores NanoCore credentials outside the OS keychain. */
const ENCRYPTED_FALLBACK_CREDENTIAL_STORAGE_WARNING =
  'OpenKit CLI is using encrypted-file NanoCore token storage because no OS keychain token was available.';

/**
 * @typedef {'encrypted-file' | 'os-keychain'} OpenKitCredentialStorageBackend
 */

/**
 * @typedef {object} OpenKitCredentialStore
 * @property {(input: {baseUrl: string}) => string | null} readToken Reads one endpoint-scoped token.
 * @property {(input: {baseUrl: string}) => void} preflightWrite Verifies that encrypted fallback storage can be prepared without storing a probe credential.
 * @property {(input: {baseUrl: string, token: string}) => OpenKitCredentialStorageBackend} writeToken Stores one endpoint-scoped token.
 * @property {(input: {baseUrl: string}) => boolean} deleteToken Deletes every local credential for one endpoint.
 */

/**
 * Creates the default endpoint-scoped OpenKit credential store.
 *
 * @param {{platform?: NodeJS.Platform, execFile?: typeof execFileSync, configDir?: string, machineId?: string, warn?: (message: string) => void}} [options] Platform and test overrides.
 * @returns {OpenKitCredentialStore} Credential store.
 */
export function createDefaultOpenKitCredentialStore(options = {}) {
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? execFileSync;
  const configDir = options.configDir ?? defaultOpenKitConfigDir(platform);
  let machineId = options.machineId;
  let encryptedFallbackStorageWarned = false;
  const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));

  /** Emits the degraded-storage warning at most once for this store. */
  function warnEncryptedFallbackStorage() {
    if (encryptedFallbackStorageWarned) {
      return;
    }
    encryptedFallbackStorageWarned = true;
    warn(ENCRYPTED_FALLBACK_CREDENTIAL_STORAGE_WARNING);
  }

  /** Resolves the machine-scoped fallback key seed lazily. */
  function resolveMachineId() {
    machineId ??= readMachineId(platform, execFile);
    return machineId;
  }

  return {
    /**
     * Reads a token from the platform keychain, then the encrypted fallback.
     *
     * @param {{baseUrl: string}} input NanoCore endpoint lookup key.
     * @returns {string | null} Stored token or null.
     */
    readToken(input) {
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

    /**
     * Verifies the encrypted fallback prerequisites without storing probe material.
     *
     * @param {{baseUrl: string}} input NanoCore endpoint lookup key.
     * @returns {void}
     * @throws {Error} When the credential directory or machine-scoped key cannot be prepared.
     */
    preflightWrite(input) {
      preflightEncryptedFallback(configDir, resolveMachineId(), input.baseUrl);
    },

    /**
     * Writes a token to a stdin-safe platform keychain or the encrypted fallback.
     *
     * @param {{baseUrl: string, token: string}} input NanoCore endpoint and token.
     * @returns {OpenKitCredentialStorageBackend} Backend that accepted the token.
     * @throws {Error} When the token is not an OpenKit access token or fallback storage fails.
     */
    writeToken(input) {
      if (writePlatformKeychainToken(platform, execFile, input.baseUrl, input.token)) {
        return 'os-keychain';
      }
      writeEncryptedFallbackToken(configDir, resolveMachineId(), input.baseUrl, input.token);
      warnEncryptedFallbackStorage();
      return 'encrypted-file';
    },

    /**
     * Deletes platform and fallback credentials for one exact endpoint.
     *
     * @param {{baseUrl: string}} input NanoCore endpoint lookup key.
     * @returns {boolean} True when at least one credential was deleted.
     */
    deleteToken(input) {
      const keychainDeleted = deletePlatformKeychainToken(platform, execFile, input.baseUrl);
      const fallbackDeleted = deleteEncryptedFallbackToken(configDir, input.baseUrl);
      return keychainDeleted || fallbackDeleted;
    },
  };
}

/**
 * Normalizes stored token material.
 *
 * @param {string | null | undefined} value Raw stored value.
 * @returns {string | null} Trimmed OpenKit token or null.
 */
export function normalizeStoredOpenKitToken(value) {
  const token = value?.trim();
  return token?.startsWith('okt_') ? token : null;
}

/**
 * Resolves an endpoint credential from an explicit environment override or local storage.
 *
 * @param {{endpoint: string, env?: Partial<Record<'OPENKIT_NANOCORE_TOKEN', string>>, store?: Pick<OpenKitCredentialStore, 'readToken'>}} input Resolution inputs.
 * @returns {{source: 'environment' | 'store', token: string} | null} Resolved credential and its source, or null for unauthenticated local mode.
 * @throws {Error & {code: 'invalid_configuration'}} When a non-empty explicit override is not an OpenKit token.
 */
export function resolveCredential(input) {
  const explicit = input.env?.OPENKIT_NANOCORE_TOKEN?.trim();
  if (explicit) {
    const token = normalizeStoredOpenKitToken(explicit);
    if (!token) {
      throw invalidConfigurationError();
    }
    return { source: 'environment', token };
  }

  const stored = normalizeStoredOpenKitToken(input.store?.readToken({ baseUrl: input.endpoint }));
  return stored ? { source: 'store', token: stored } : null;
}

/**
 * Redacts credentials and host-local paths recursively from a public value.
 *
 * @param {unknown} value Value to redact.
 * @param {readonly string[]} [extraSecrets] Exact additional secrets to replace.
 * @returns {unknown} Deep-redacted value.
 */
export function redactPublicValue(value, extraSecrets = []) {
  if (typeof value === 'string') {
    return redactText(value, extraSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPublicValue(item, extraSecrets));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactPublicValue(child, extraSecrets)])
    );
  }
  return value;
}

/**
 * Builds the typed error for an invalid explicit credential override.
 *
 * @returns {Error & {code: 'invalid_configuration'}} Typed configuration error.
 */
function invalidConfigurationError() {
  return Object.assign(new Error('OPENKIT_NANOCORE_TOKEN must contain an OpenKit access token.'), {
    code: /** @type {const} */ ('invalid_configuration'),
  });
}

/**
 * Redacts credentials and local paths from one text value.
 *
 * @param {string} value Text to redact.
 * @param {readonly string[]} extraSecrets Exact additional secrets to replace.
 * @returns {string} Redacted text.
 */
function redactText(value, extraSecrets) {
  let redacted = value
    .replace(OPENKIT_TOKEN_PATTERN, '[redacted]')
    .replace(ABSOLUTE_PATH_PATTERN, (match) => {
      const prefix = /^[\s"'`(]/.test(match) ? match[0] : '';
      return `${prefix}[redacted-local-path]`;
    });
  for (const secret of extraSecrets) {
    if (secret) {
      redacted = redacted.split(secret).join('[redacted]');
    }
  }
  return redacted;
}

/**
 * Reads a token from the current platform keychain.
 *
 * @param {NodeJS.Platform} platform Current platform.
 * @param {typeof execFileSync} execFile Command runner.
 * @param {string} baseUrl NanoCore endpoint account key.
 * @returns {string | null} Stored token or null.
 */
function readPlatformKeychainToken(platform, execFile, baseUrl) {
  if (platform === 'darwin') {
    return readKeychainCommand(execFile, 'security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      baseUrl,
      '-w',
    ]);
  }
  if (platform === 'linux') {
    return readKeychainCommand(execFile, 'secret-tool', [
      'lookup',
      'application',
      'openkit',
      'nanocore-url',
      baseUrl,
    ]);
  }
  if (platform === 'win32') {
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
  return null;
}

/**
 * Writes a token to a platform keychain without placing secret material in argv.
 *
 * @param {NodeJS.Platform} platform Current platform.
 * @param {typeof execFileSync} execFile Command runner.
 * @param {string} baseUrl NanoCore endpoint account key.
 * @param {string} token OpenKit access token.
 * @returns {boolean} True when the platform keychain accepted the token.
 */
function writePlatformKeychainToken(platform, execFile, baseUrl, token) {
  const normalized = normalizeStoredOpenKitToken(token);
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
 * Deletes one exact endpoint entry from the current platform keychain.
 *
 * @param {NodeJS.Platform} platform Current platform.
 * @param {typeof execFileSync} execFile Command runner.
 * @param {string} baseUrl NanoCore endpoint account key.
 * @returns {boolean} True when the platform command deleted an entry.
 */
function deletePlatformKeychainToken(platform, execFile, baseUrl) {
  if (platform === 'darwin') {
    return deleteKeychainCommand(execFile, 'security', [
      'delete-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      baseUrl,
    ]);
  }
  if (platform === 'linux') {
    return deleteKeychainCommand(execFile, 'secret-tool', [
      'clear',
      'application',
      'openkit',
      'nanocore-url',
      baseUrl,
    ]);
  }
  if (platform === 'win32') {
    return deleteKeychainCommand(execFile, 'cmdkey.exe', [
      `/delete:${KEYCHAIN_SERVICE}:${baseUrl}`,
    ]);
  }
  return false;
}

/**
 * Runs one credential read command and suppresses unavailable-store failures.
 *
 * @param {typeof execFileSync} execFile Command runner.
 * @param {string} command Command name.
 * @param {string[]} args Command arguments.
 * @returns {string | null} Stored token or null.
 */
function readKeychainCommand(execFile, command, args) {
  try {
    return normalizeStoredOpenKitToken(execFile(command, args, keychainExecOptions()));
  } catch {
    return null;
  }
}

/**
 * Runs one credential write command and suppresses unavailable-store failures.
 *
 * @param {typeof execFileSync} execFile Command runner.
 * @param {string} command Command name.
 * @param {string[]} args Command arguments.
 * @param {string} token Plaintext token passed through stdin.
 * @returns {boolean} True when the command succeeded.
 */
function writeKeychainCommand(execFile, command, args, token) {
  try {
    execFile(command, args, keychainWriteOptions(token));
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one credential delete command and suppresses missing-store failures.
 *
 * @param {typeof execFileSync} execFile Command runner.
 * @param {string} command Command name.
 * @param {string[]} args Command arguments.
 * @returns {boolean} True when the command succeeded.
 */
function deleteKeychainCommand(execFile, command, args) {
  try {
    execFile(command, args, keychainDeleteOptions());
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds non-interactive keychain command options.
 *
 * @returns {{encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}} Exec options.
 */
function keychainExecOptions() {
  return { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
}

/**
 * Builds stdin-backed keychain write options.
 *
 * @param {string} token Plaintext token for stdin.
 * @returns {{encoding: 'utf8', input: string, stdio: ['pipe', 'ignore', 'ignore']}} Exec options.
 */
function keychainWriteOptions(token) {
  return { encoding: 'utf8', input: token, stdio: ['pipe', 'ignore', 'ignore'] };
}

/**
 * Builds non-interactive keychain delete options.
 *
 * @returns {{encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore']}} Exec options.
 */
function keychainDeleteOptions() {
  return { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] };
}

/**
 * Writes one encrypted fallback token file.
 *
 * @param {string} configDir OpenKit user config directory.
 * @param {string} machineId Machine-scoped key seed.
 * @param {string} baseUrl NanoCore endpoint key.
 * @param {string} token OpenKit access token.
 * @returns {void}
 */
function writeEncryptedFallbackToken(configDir, machineId, baseUrl, token) {
  const normalized = normalizeStoredOpenKitToken(token);
  if (!normalized) {
    throw new Error('Only OpenKit access tokens can be stored.');
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fallbackKey(machineId, salt), iv);
  cipher.setAAD(Buffer.from(baseUrl));
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const record = {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    version: 1,
  };
  const path = fallbackCredentialPath(configDir, baseUrl);
  ensureEncryptedFallbackDirectory(configDir);
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Verifies fallback directory and machine-key prerequisites without writing credential material.
 *
 * @param {string} configDir OpenKit user config directory.
 * @param {string} machineId Machine-scoped key seed.
 * @param {string} baseUrl NanoCore endpoint key.
 * @returns {void}
 */
function preflightEncryptedFallback(configDir, machineId, baseUrl) {
  ensureEncryptedFallbackDirectory(configDir);
  fallbackCredentialPath(configDir, baseUrl);
  fallbackKey(machineId, Buffer.alloc(16)).fill(0);
}

/**
 * Creates and verifies the owner-only encrypted credential directory.
 *
 * @param {string} configDir OpenKit user config directory.
 * @returns {void}
 */
function ensureEncryptedFallbackDirectory(configDir) {
  const directory = join(configDir, 'credentials', 'nanocore');
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  accessSync(directory, fsConstants.W_OK);
}

/**
 * Reads one encrypted fallback token file.
 *
 * @param {string} configDir OpenKit user config directory.
 * @param {string} machineId Machine-scoped key seed.
 * @param {string} baseUrl NanoCore endpoint key.
 * @returns {string | null} Stored token or null.
 */
function readEncryptedFallbackToken(configDir, machineId, baseUrl) {
  const path = fallbackCredentialPath(configDir, baseUrl);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
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
    return normalizeStoredOpenKitToken(plaintext);
  } catch {
    return null;
  }
}

/**
 * Deletes one encrypted fallback token file.
 *
 * @param {string} configDir OpenKit user config directory.
 * @param {string} baseUrl NanoCore endpoint key.
 * @returns {boolean} True when the file existed and was removed.
 */
function deleteEncryptedFallbackToken(configDir, baseUrl) {
  const path = fallbackCredentialPath(configDir, baseUrl);
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path);
  return true;
}

/**
 * Resolves the encrypted fallback file path for one NanoCore URL.
 *
 * @param {string} configDir OpenKit user config directory.
 * @param {string} baseUrl NanoCore endpoint key.
 * @returns {string} Fallback credential file path.
 */
function fallbackCredentialPath(configDir, baseUrl) {
  const urlHash = createHash('sha256').update(baseUrl).digest('hex');
  return join(configDir, 'credentials', 'nanocore', `${urlHash}.json`);
}

/**
 * Derives an encrypted fallback key from the local machine seed.
 *
 * @param {string} machineId Machine-scoped key seed.
 * @param {Buffer} salt Random per-file salt.
 * @returns {Buffer} AES-256 key bytes.
 */
function fallbackKey(machineId, salt) {
  return scryptSync(machineId, salt, 32);
}

/**
 * Resolves the default OpenKit config directory.
 *
 * @param {NodeJS.Platform} platform Current platform.
 * @returns {string} User config directory path.
 */
function defaultOpenKitConfigDir(platform) {
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
 * @param {NodeJS.Platform} platform Current platform.
 * @param {typeof execFileSync} execFile Command runner.
 * @returns {string} Machine-scoped key seed.
 */
function readMachineId(platform, execFile) {
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
 * @param {string[]} paths Candidate paths.
 * @returns {string | null} Trimmed file content or null.
 */
function readFirstFile(paths) {
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
 * @param {typeof execFileSync} execFile Command runner.
 * @returns {string | null} Platform UUID or null.
 */
function readMacOsMachineId(execFile) {
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
 * @param {typeof execFileSync} execFile Command runner.
 * @returns {string | null} MachineGuid or null.
 */
function readWindowsMachineId(execFile) {
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
 * Builds a last-resort host-and-user-scoped key seed.
 *
 * @returns {string} Local fallback seed.
 */
function fallbackMachineId() {
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
