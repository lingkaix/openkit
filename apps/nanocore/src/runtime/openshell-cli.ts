import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

/** Maximum wall time for one read-only OpenShell control command. */
const OPEN_SHELL_CONTROL_TIMEOUT_MS = 30_000;
/** Maximum wall time for one retained sandbox command, including CLI shutdown grace. */
const OPEN_SHELL_EXECUTION_TIMEOUT_MS = 905_000;
/** Maximum wall time for one backend materialization command. */
const OPEN_SHELL_MATERIALIZATION_TIMEOUT_MS = 120_000;
/** Official OpenShell CLI path for supported NanoCore hosts. */
const OPEN_SHELL_BINARY =
  process.platform === 'darwin' ? '/opt/homebrew/bin/openshell' : '/usr/bin/openshell';
/** Grace period between terminating and force-killing a timed-out CLI process group. */
const OPEN_SHELL_TERMINATION_GRACE_MS = 200;
/** Grace enforced by the detached command supervisor before force-killing its child group. */
const OPEN_SHELL_SUPERVISOR_TERMINATION_GRACE_MS = 100;
/** Detached Node program that retains timeout ownership after the NanoCore process disappears. */
const OPEN_SHELL_COMMAND_SUPERVISOR_SOURCE = `
const { spawn } = require('node:child_process');
const { Socket } = require('node:net');
const [timeoutValue, graceValue, binary, ...args] = process.argv.slice(1);
const timeoutMs = Number(timeoutValue);
const graceMs = Number(graceValue);
const detached = process.platform !== 'win32';
const child = spawn(binary, args, {
  detached,
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'],
});
let finished = false;
let forceKillTimer = null;
let parentChannel = null;
let terminatingExitCode = null;
const killChild = (signal) => {
  if (child.pid === undefined) return;
  try {
    if (detached) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
};
const terminateChild = () => {
  if (finished) return;
  killChild('SIGTERM');
  if (forceKillTimer === null) {
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      killChild('SIGKILL');
      finish(terminatingExitCode === null ? 1 : terminatingExitCode);
    }, graceMs);
  }
};
const abortChild = () => {
  if (finished) return;
  killChild('SIGKILL');
};
const finish = (code) => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  if (forceKillTimer !== null) clearTimeout(forceKillTimer);
  process.exit(code);
};
const deadline = setTimeout(terminateChild, timeoutMs);
process.on('SIGTERM', terminateChild);
process.on('SIGINT', terminateChild);
try {
  parentChannel = new Socket({ fd: 3, readable: true, writable: false });
  parentChannel.resume();
  parentChannel.once('end', abortChild);
  parentChannel.once('error', abortChild);
} catch {
  abortChild();
}
child.once('error', (error) => {
  process.stderr.write(String(error && error.message ? error.message : error));
  finish(127);
});
child.once('close', (code) => {
  const exitCode = code === null ? 1 : code;
  if (forceKillTimer !== null) {
    terminatingExitCode = exitCode;
    return;
  }
  finish(exitCode);
});
`;

/**
 * Completed OpenShell CLI command result.
 */
export interface OpenShellCommandResult {
  /** Process exit code, or null when the process ended without one. */
  exitCode: number | null;
  /** Captured stdout text. */
  stdout: string;
  /** Captured stderr text. */
  stderr: string;
}

/**
 * Options for one OpenShell command invocation.
 */
export interface OpenShellCommandOptions {
  /** Environment variables merged into the child process environment. */
  env?: Record<string, string>;
  /** Command timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Injectable command runner used by the OpenShell CLI adapter.
 */
export interface OpenShellCommandRunner {
  /**
   * Runs the OpenShell CLI with an argument vector.
   *
   * @param args CLI arguments after the binary name.
   * @param options Optional environment and timeout controls.
   * @returns Captured command result.
   */
  run(args: string[], options?: OpenShellCommandOptions): Promise<OpenShellCommandResult>;
}

/**
 * Compiles one timeout-owned command whose detached supervisor survives NanoCore termination.
 *
 * @param binary Executable to run.
 * @param args Exact executable argument vector.
 * @param timeoutMs Positive command wall-time limit.
 * @returns Node supervisor command and argument vector.
 */
export function compileOpenShellSupervisedCommand(
  binary: string,
  args: readonly string[],
  timeoutMs: number
): { readonly command: string; readonly args: string[] } {
  return {
    args: [
      '-e',
      OPEN_SHELL_COMMAND_SUPERVISOR_SOURCE,
      String(timeoutMs),
      String(OPEN_SHELL_SUPERVISOR_TERMINATION_GRACE_MS),
      binary,
      ...args,
    ],
    command: process.execPath,
  };
}

/**
 * Parsed `openshell status` summary.
 */
export interface OpenShellStatus {
  /** Active gateway name when the CLI reported one. */
  gateway: string | null;
  /** Gateway server endpoint when the CLI reported one. */
  server: string | null;
  /** Normalized gateway connection status. */
  status: 'connected' | 'unavailable' | 'unknown';
  /** Gateway or CLI version when present. */
  version: string | null;
  /** Product-safe error summary for failed status checks. */
  error?: string;
}

/**
 * Parsed `openshell gateway info` summary.
 */
export interface OpenShellGatewayInfo {
  /** Gateway name. */
  gateway: string | null;
  /** Gateway endpoint URL. */
  endpoint: string | null;
}

/**
 * OpenShell gateway target selected for one command.
 */
export interface OpenShellGatewayTargetInput {
  /** Optional gateway name to use instead of the active gateway. */
  gateway?: string;
  /** Optional direct gateway endpoint URL. */
  gatewayEndpoint?: string;
}

/** Inputs for creating or updating one OpenShell provider instance. */
export interface OpenShellProviderUpsertInput {
  /** Optional credential expiry timestamp for the provider credential key. */
  credentialExpiresAt?: string | undefined;
  /** Provider credential environment key consumed by OpenShell. */
  credentialKey: string;
  /** Secret credential value passed only through the child process environment. */
  credentialValue: string;
  /** OpenShell gateway name. */
  gateway?: string;
  /** Optional direct OpenShell gateway endpoint URL. */
  gatewayEndpoint?: string;
  /** Provider instance name. */
  name: string;
  /** OpenShell provider profile/type id. */
  providerType: string;
}

/** Product-safe provider upsert result. */
export interface OpenShellProviderUpsertResult {
  /** Provider name requested by NanoCore. */
  name: string;
}

/** Inputs for ensuring one immutable OpenShell provider profile. */
export interface OpenShellProviderProfileEnsureInput {
  /** OpenShell gateway name. */
  gateway?: string;
  /** Optional direct OpenShell gateway endpoint URL. */
  gatewayEndpoint?: string;
  /** Content-addressed provider profile id. */
  id: string;
  /** Host-local JSON profile path passed to OpenShell import. */
  path: string;
}

/** Product-safe immutable provider profile result. */
export interface OpenShellProviderProfileEnsureResult {
  /** Provider profile id verified or imported by NanoCore. */
  id: string;
}

/** Inputs for reading one OpenShell provider instance. */
export interface OpenShellProviderGetInput {
  /** OpenShell gateway name. */
  gateway?: string;
  /** Optional direct OpenShell gateway endpoint URL. */
  gatewayEndpoint?: string;
  /** Provider instance name. */
  name: string;
}

/** Product-safe provider inspection result. */
export interface OpenShellProviderInfo {
  /** Provider name requested by NanoCore. */
  name: string;
  /** Redacted OpenShell provider output. */
  stdout: string;
}

/** Inputs for reading one OpenShell provider refresh status. */
export interface OpenShellProviderRefreshStatusInput {
  /** Optional credential key to filter by. */
  credentialKey?: string;
  /** OpenShell gateway name. */
  gateway?: string;
  /** Optional direct OpenShell gateway endpoint URL. */
  gatewayEndpoint?: string;
  /** Provider instance name. */
  name: string;
}

/**
 * Inputs for `openshell sandbox create`.
 */
export interface OpenShellSandboxCreateInput {
  /** Command to run after sandbox creation. */
  command: string[];
  /** Optional CPU limit such as `2` or `500m`. */
  cpu?: string;
  /** Environment variables to inject into the sandbox command. */
  env?: Record<string, string>;
  /** Sandbox source image, Dockerfile path, build context, or community name. */
  from: string;
  /** OpenShell gateway name. */
  gateway?: string;
  /** Optional direct OpenShell gateway endpoint URL. */
  gatewayEndpoint?: string;
  /** Labels attached to the sandbox. */
  labels?: Record<string, string>;
  /** Optional memory limit such as `4Gi`. */
  memory?: string;
  /** Sandbox name. */
  name: string;
  /** Whether OpenShell should delete the sandbox after the initial command exits. */
  noKeep?: boolean;
  /** Optional path to a sandbox policy YAML file. */
  policyPath?: string;
  /** Provider names to attach to the sandbox. */
  providers?: string[];
  /** Local files to upload before the initial command runs. */
  uploads?: OpenShellSandboxUploadInput[];
}

/**
 * Product-safe sandbox creation summary.
 */
export interface OpenShellSandboxCreateResult {
  /** Sandbox name requested by NanoCore. */
  name: string;
  /** Raw stdout from OpenShell for diagnostics. */
  stdout: string;
}

/**
 * Inputs for executing one command in a retained OpenShell sandbox.
 */
export interface OpenShellSandboxExecInput {
  /** Command and arguments to execute inside the sandbox. */
  command: string[];
  /** Environment variables to inject into the sandbox command. */
  env?: Record<string, string>;
  /** OpenShell gateway name. */
  gateway?: string;
  /** Optional direct OpenShell gateway endpoint URL. */
  gatewayEndpoint?: string;
  /** Retained sandbox name. */
  name: string;
  /** Optional remote command timeout in seconds. */
  timeoutSeconds?: number;
  /** Optional working directory inside the sandbox. */
  workdir?: string;
}

/**
 * Local file upload passed to OpenShell sandbox creation.
 */
export interface OpenShellSandboxUploadInput {
  /** Host-local source path. */
  sourcePath: string;
  /** Optional worker-visible target path. */
  targetPath?: string;
}

/**
 * Inputs for downloading one file from an OpenShell sandbox.
 */
export interface OpenShellSandboxDownloadInput {
  /** Optional local destination path. */
  destinationPath?: string;
  /** OpenShell gateway name. */
  gateway?: string;
  /** Optional direct OpenShell gateway endpoint URL. */
  gatewayEndpoint?: string;
  /** Sandbox name. */
  name: string;
  /** Worker-visible source path inside the sandbox workspace. */
  sandboxPath: string;
}

/**
 * Product-safe OpenShell file operation result.
 */
export interface OpenShellSandboxFileResult {
  /** Raw stdout from OpenShell for diagnostics. */
  stdout: string;
}

/**
 * Options for the OpenShell CLI adapter.
 */
export interface OpenShellCliOptions {
  /** OpenShell command runner, injected by tests. */
  runner?: OpenShellCommandRunner;
}

/**
 * Child-process-backed OpenShell command runner.
 */
export class ChildProcessOpenShellRunner implements OpenShellCommandRunner {
  private readonly binary: string;

  /**
   * Creates a child-process runner for the installed OpenShell CLI.
   *
   * @param binary Executable used by focused process-runner tests.
   */
  public constructor(binary = OPEN_SHELL_BINARY) {
    this.binary = binary;
  }

  /**
   * Runs one OpenShell CLI process.
   *
   * @param args CLI arguments after the binary name.
   * @param options Optional environment and timeout controls.
   * @returns Captured process result.
   */
  public async run(
    args: string[],
    options: OpenShellCommandOptions = {}
  ): Promise<OpenShellCommandResult> {
    return new Promise((resolve, reject) => {
      const childEnv = {
        ...process.env,
        ...options.env,
      };
      delete childEnv.OPENSHELL_GATEWAY;
      delete childEnv.OPENSHELL_GATEWAY_ENDPOINT;
      delete childEnv.OPENSHELL_GATEWAY_INSECURE;
      const supervisedCommand =
        options.timeoutMs && options.timeoutMs > 0
          ? compileOpenShellSupervisedCommand(this.binary, args, options.timeoutMs)
          : null;
      const child = spawn(
        supervisedCommand?.command ?? this.binary,
        supervisedCommand?.args ?? args,
        {
          detached: process.platform !== 'win32',
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        }
      );
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const parentLivenessChannel = child.stdio[3];
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (settled) {
            return;
          }
          timedOut = true;
          terminateOpenShellProcess(child.pid, () => child.kill('SIGTERM'), 'SIGTERM');
          forceKillTimeout = setTimeout(() => {
            if (!settled) {
              terminateOpenShellProcess(child.pid, () => child.kill('SIGKILL'), 'SIGKILL');
            }
          }, OPEN_SHELL_TERMINATION_GRACE_MS);
        }, options.timeoutMs);
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.once('exit', () => {
        parentLivenessChannel?.destroy();
      });
      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }
        reject(error);
      });
      child.on('close', (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }
        if (timedOut) {
          reject(new Error(`OpenShell command timed out after ${options.timeoutMs}ms.`));
          return;
        }
        resolve({
          exitCode,
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        });
      });
    });
  }
}

/** Terminates one CLI process group, falling back to the direct child when unavailable. */
function terminateOpenShellProcess(
  pid: number | undefined,
  fallback: () => boolean,
  signal: NodeJS.Signals
): void {
  if (process.platform !== 'win32' && pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The process group may already have exited; direct-child termination remains idempotent.
    }
  }
  try {
    fallback();
  } catch {
    // Close/error settles the command; a vanished child needs no additional termination.
  }
}

/**
 * CLI adapter for the real OpenShell distribution.
 */
export class OpenShellCli {
  private readonly runner: OpenShellCommandRunner;

  /**
   * Creates an OpenShell CLI adapter.
   *
   * @param options Optional test runner.
   */
  public constructor(options: OpenShellCliOptions = {}) {
    this.runner = options.runner ?? new ChildProcessOpenShellRunner();
  }

  /**
   * Reads the installed OpenShell CLI version.
   *
   * @returns Semantic version string without the leading binary name.
   */
  public async version(): Promise<string> {
    const result = await this.runner.run(['--version'], {
      timeoutMs: OPEN_SHELL_CONTROL_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell version check failed: ${safeErrorText(result)}`);
    }

    return normalizeVersion(stripAnsi(result.stdout).trim());
  }

  /**
   * Reads gateway status.
   *
   * @param input Optional gateway target.
   * @returns Parsed status summary; failed connectivity returns `unavailable`.
   */
  public async status(input: OpenShellGatewayTargetInput = {}): Promise<OpenShellStatus> {
    const args = ['status'];

    if (input.gateway) {
      args.push('-g', input.gateway);
    }
    appendOpenShellGatewayFlags(args, input);

    const result = await this.runner.run(args, { timeoutMs: OPEN_SHELL_CONTROL_TIMEOUT_MS });
    const fields = parseCliFields(result.stdout);

    if (result.exitCode !== 0) {
      return {
        error: safeErrorText(result),
        gateway: fields.get('gateway') ?? null,
        server: fields.get('server') ?? null,
        status: 'unavailable',
        version: fields.get('version') ?? null,
      };
    }

    return {
      gateway: fields.get('gateway') ?? null,
      server: fields.get('server') ?? null,
      status: normalizeStatus(fields.get('status')),
      version: fields.get('version') ?? null,
    };
  }

  /**
   * Reads active gateway metadata.
   *
   * @returns Parsed gateway info.
   */
  public async gatewayInfo(input: OpenShellGatewayTargetInput = {}): Promise<OpenShellGatewayInfo> {
    const args = ['gateway', 'info'];

    if (input.gateway) {
      args.push('-g', input.gateway);
    }
    appendOpenShellGatewayFlags(args, input);

    const result = await this.runner.run(args, { timeoutMs: OPEN_SHELL_CONTROL_TIMEOUT_MS });

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell gateway info failed: ${safeErrorText(result)}`);
    }

    const fields = parseCliFields(result.stdout);

    return {
      endpoint: fields.get('gateway endpoint') ?? null,
      gateway: fields.get('gateway') ?? null,
    };
  }

  /**
   * Reads the gateway-global Providers v2 activation state.
   *
   * @param input Optional gateway target.
   * @returns True or false for an explicit setting, or null when unset.
   * @throws When the command fails or the pinned JSON shape is malformed.
   */
  public async providersV2Enabled(
    input: OpenShellGatewayTargetInput = {}
  ): Promise<boolean | null> {
    const args = ['settings', 'get', '--global', '--json'];

    if (input.gateway) {
      args.push('-g', input.gateway);
    }
    appendOpenShellGatewayFlags(args, input);
    const result = await this.runner.run(args, { timeoutMs: OPEN_SHELL_CONTROL_TIMEOUT_MS });

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell global settings check failed: ${safeErrorText(result)}`);
    }

    const parsed = parseOpenShellJsonObject(result.stdout, 'global settings');
    const settings = parsed.settings;

    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      throw new Error('OpenShell global settings omitted the settings object.');
    }
    const value = (settings as Record<string, unknown>).providers_v2_enabled;

    if (typeof value !== 'string') {
      throw new Error('OpenShell global settings omitted providers_v2_enabled.');
    }
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    if (value === '<unset>') {
      return null;
    }
    throw new Error('OpenShell global settings returned an invalid providers_v2_enabled value.');
  }

  /**
   * Creates or updates one OpenShell provider without putting credential values in argv.
   *
   * @param input Provider name, type, credential, and gateway selection.
   * @returns Product-safe provider upsert summary.
   */
  public async upsertProvider(
    input: OpenShellProviderUpsertInput
  ): Promise<OpenShellProviderUpsertResult> {
    const existingType = await this.existingProviderType(input);

    if (existingType !== null) {
      if (existingType !== input.providerType) {
        throw new Error(
          `OpenShell provider type mismatch for ${input.name}: expected ${input.providerType}; got ${existingType}.`
        );
      }
      await this.updateProviderCredential(input);
    } else {
      await this.createProvider(input);
      if (input.credentialExpiresAt) {
        await this.updateProviderExpiry(input);
      }
    }

    return { name: input.name };
  }

  /**
   * Ensures that one content-addressed provider profile exists with exact immutable content.
   *
   * @param input Provider profile id, JSON path, and gateway selection.
   * @returns Product-safe profile identity.
   * @throws When export, import, parsing, or immutable content verification fails.
   */
  public async ensureProviderProfile(
    input: OpenShellProviderProfileEnsureInput
  ): Promise<OpenShellProviderProfileEnsureResult> {
    const desiredProfile = parseOpenShellJsonObject(
      await readFile(input.path, 'utf8'),
      'generated provider profile'
    );

    if (desiredProfile.id !== input.id || 'resource_version' in desiredProfile) {
      throw new Error(`Invalid generated OpenShell provider profile identity: ${input.id}`);
    }

    const exportArgs = compileOpenShellProviderProfileExportArgs(input);
    const exported = await this.runner.run(exportArgs, {
      timeoutMs: OPEN_SHELL_MATERIALIZATION_TIMEOUT_MS,
    });

    if (exported.exitCode === 0) {
      assertOpenShellProviderProfileMatches(input.id, desiredProfile, exported.stdout);
      return { id: input.id };
    }
    if (!isOpenShellProviderProfileNotFound(exported)) {
      throw new Error(`OpenShell provider profile export failed: ${safeErrorText(exported)}`);
    }

    const imported = await this.runner.run(compileOpenShellProviderProfileImportArgs(input), {
      timeoutMs: OPEN_SHELL_MATERIALIZATION_TIMEOUT_MS,
    });

    if (imported.exitCode === 0) {
      return { id: input.id };
    }

    const importError = new Error(
      `OpenShell provider profile import failed: ${safeErrorText(imported)}`
    );
    const racedExport = await this.runner.run(exportArgs, {
      timeoutMs: OPEN_SHELL_MATERIALIZATION_TIMEOUT_MS,
    });

    if (racedExport.exitCode === 0) {
      try {
        assertOpenShellProviderProfileMatches(input.id, desiredProfile, racedExport.stdout);
        return { id: input.id };
      } catch (verificationError) {
        throw new AggregateError(
          [importError, verificationError],
          `OpenShell provider profile import race failed verification: ${input.id}`
        );
      }
    }

    throw new AggregateError(
      [
        importError,
        new Error(`OpenShell provider profile re-export failed: ${safeErrorText(racedExport)}`),
      ],
      `OpenShell provider profile import failed: ${input.id}`
    );
  }

  /**
   * Reads one OpenShell provider and redacts credential-looking values from CLI output.
   *
   * @param input Provider and gateway selection.
   * @returns Product-safe provider inspection result.
   */
  public async getProvider(input: OpenShellProviderGetInput): Promise<OpenShellProviderInfo> {
    const result = await this.runner.run(compileOpenShellProviderGetArgs(input), {
      timeoutMs: OPEN_SHELL_CONTROL_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `OpenShell provider get failed: ${redactProviderOutput(safeErrorText(result))}`
      );
    }

    return {
      name: input.name,
      stdout: redactProviderOutput(result.stdout),
    };
  }

  /**
   * Reads provider refresh status and redacts credential-looking values.
   *
   * @param input Provider, optional credential key, and gateway selection.
   * @returns Product-safe refresh status output.
   */
  public async getProviderRefreshStatus(
    input: OpenShellProviderRefreshStatusInput
  ): Promise<OpenShellProviderInfo> {
    const args = ['provider', 'refresh', 'status'];

    appendOpenShellProviderGatewayFlags(args, input);
    if (input.credentialKey) {
      args.push('--credential-key', input.credentialKey);
    }
    args.push(input.name);
    const result = await this.runner.run(args, { timeoutMs: OPEN_SHELL_CONTROL_TIMEOUT_MS });

    if (result.exitCode !== 0) {
      throw new Error(
        `OpenShell provider refresh status failed: ${redactProviderOutput(safeErrorText(result))}`
      );
    }

    return {
      name: input.name,
      stdout: redactProviderOutput(result.stdout),
    };
  }

  /**
   * Creates an OpenShell sandbox.
   *
   * @param input Sandbox create options.
   * @returns Product-safe sandbox creation summary.
   */
  public async createSandbox(
    input: OpenShellSandboxCreateInput
  ): Promise<OpenShellSandboxCreateResult> {
    const result = await this.runner.run(compileOpenShellSandboxCreateArgs(input), {
      timeoutMs: OPEN_SHELL_MATERIALIZATION_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell sandbox create failed: ${safeErrorText(result)}`);
    }

    return {
      name: input.name,
      stdout: result.stdout,
    };
  }

  /**
   * Executes one command in a retained OpenShell sandbox and waits for it to exit.
   *
   * @param input Sandbox execution request.
   * @returns Captured command result when the remote command succeeds.
   * @throws When OpenShell or the remote command exits unsuccessfully.
   */
  public async execSandbox(input: OpenShellSandboxExecInput): Promise<OpenShellCommandResult> {
    const result = await this.runner.run(compileOpenShellSandboxExecArgs(input), {
      timeoutMs: OPEN_SHELL_EXECUTION_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      const error = safeErrorText(result);

      throw new Error(
        `OpenShell sandbox exec failed with exit code ${result.exitCode ?? 'unknown'}${error ? `: ${error}` : '.'}`
      );
    }

    return result;
  }

  /**
   * Downloads one file from an OpenShell sandbox.
   *
   * @param input Download request.
   * @returns Product-safe download result.
   */
  public async downloadFile(
    input: OpenShellSandboxDownloadInput
  ): Promise<OpenShellSandboxFileResult> {
    const args = ['sandbox', 'download'];

    if (input.gateway) {
      args.push('--gateway', input.gateway);
    }
    appendOpenShellGatewayFlags(args, input);
    args.push(input.name, input.sandboxPath);
    if (input.destinationPath) {
      args.push(input.destinationPath);
    }

    const result = await this.runner.run(args, {
      timeoutMs: OPEN_SHELL_MATERIALIZATION_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell sandbox download failed: ${safeErrorText(result)}`);
    }

    return {
      stdout: result.stdout,
    };
  }

  /**
   * Reads the immutable type of an existing provider.
   *
   * @param input Provider and gateway selection.
   * @returns Existing provider type, or null when the provider does not exist.
   * @throws When inspection fails or omits the immutable type.
   */
  private async existingProviderType(input: OpenShellProviderUpsertInput): Promise<string | null> {
    const result = await this.runner.run(compileOpenShellProviderGetArgs(input), {
      timeoutMs: OPEN_SHELL_MATERIALIZATION_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      if (isOpenShellProviderNotFound(result)) {
        return null;
      }
      throw new Error(
        `OpenShell provider inspection failed: ${redactProviderOutput(safeErrorText(result))}`
      );
    }

    const providerType = parseCliFields(result.stdout).get('type');

    if (!providerType) {
      throw new Error(`OpenShell provider inspection omitted immutable type: ${input.name}`);
    }

    return providerType;
  }

  /**
   * Creates one OpenShell provider.
   *
   * @param input Provider and credential material.
   */
  private async createProvider(input: OpenShellProviderUpsertInput): Promise<void> {
    const args = [
      'provider',
      'create',
      '--name',
      input.name,
      '--type',
      input.providerType,
      '--credential',
      input.credentialKey,
    ];

    appendOpenShellProviderGatewayFlags(args, input);
    const result = await this.runner.run(args, {
      env: { [input.credentialKey]: input.credentialValue },
      timeoutMs: OPEN_SHELL_MATERIALIZATION_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell provider create failed: ${safeErrorText(result)}`);
    }
  }

  /**
   * Updates one OpenShell provider credential.
   *
   * @param input Provider and credential material.
   */
  private async updateProviderCredential(input: OpenShellProviderUpsertInput): Promise<void> {
    const args = ['provider', 'update', '--credential', input.credentialKey];

    if (input.credentialExpiresAt) {
      args.push('--credential-expires-at', `${input.credentialKey}=${input.credentialExpiresAt}`);
    }
    appendOpenShellProviderGatewayFlags(args, input);
    args.push(input.name);
    const result = await this.runner.run(args, {
      env: { [input.credentialKey]: input.credentialValue },
      timeoutMs: OPEN_SHELL_MATERIALIZATION_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell provider update failed: ${safeErrorText(result)}`);
    }
  }

  /**
   * Updates provider credential expiry after first creation.
   *
   * @param input Provider and expiry metadata.
   */
  private async updateProviderExpiry(input: OpenShellProviderUpsertInput): Promise<void> {
    const args = [
      'provider',
      'update',
      '--credential-expires-at',
      `${input.credentialKey}=${input.credentialExpiresAt}`,
    ];

    appendOpenShellProviderGatewayFlags(args, input);
    args.push(input.name);
    const result = await this.runner.run(args, {
      timeoutMs: OPEN_SHELL_MATERIALIZATION_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell provider expiry update failed: ${safeErrorText(result)}`);
    }
  }
}

/**
 * Compiles `openshell provider get` arguments.
 *
 * @param input Provider and gateway selection.
 * @returns CLI argument vector.
 */
function compileOpenShellProviderGetArgs(input: OpenShellProviderGetInput): string[] {
  const args = ['provider', 'get'];

  appendOpenShellProviderGatewayFlags(args, input);
  args.push(input.name);

  return args;
}

/**
 * Compiles immutable provider profile export arguments.
 *
 * @param input Provider profile and gateway selection.
 * @returns CLI argument vector.
 */
function compileOpenShellProviderProfileExportArgs(
  input: OpenShellProviderProfileEnsureInput
): string[] {
  const args = ['provider', 'profile', 'export', '--output', 'json'];

  appendOpenShellProviderGatewayFlags(args, input);
  args.push(input.id);
  return args;
}

/**
 * Compiles immutable provider profile import arguments.
 *
 * @param input Provider profile and gateway selection.
 * @returns CLI argument vector.
 */
function compileOpenShellProviderProfileImportArgs(
  input: OpenShellProviderProfileEnsureInput
): string[] {
  const args = ['provider', 'profile', 'import', '--file', input.path];

  appendOpenShellProviderGatewayFlags(args, input);
  return args;
}

/**
 * Parses one OpenShell JSON object.
 *
 * @param value JSON text.
 * @param label Product-safe source label.
 * @returns Parsed JSON object.
 * @throws When the text is not a JSON object.
 */
function parseOpenShellJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`OpenShell ${label} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`OpenShell ${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Verifies exported OpenShell profile content against the generated immutable profile.
 *
 * @param id Expected provider profile id.
 * @param desiredProfile Generated immutable profile.
 * @param exportedJson Gateway-exported profile JSON.
 * @throws When the exported profile differs after removing gateway resource metadata.
 */
function assertOpenShellProviderProfileMatches(
  id: string,
  desiredProfile: Record<string, unknown>,
  exportedJson: string
): void {
  const exportedProfile = parseOpenShellJsonObject(exportedJson, 'exported provider profile');

  delete exportedProfile.resource_version;
  if (!isDeepStrictEqual(exportedProfile, desiredProfile)) {
    throw new Error(`OpenShell provider profile content collision: ${id}`);
  }
}

/**
 * Checks the exact OpenShell 0.0.80 missing-profile diagnostic.
 *
 * @param result Failed provider profile export result.
 * @returns True only for the pinned missing-profile diagnostic.
 */
function isOpenShellProviderProfileNotFound(result: OpenShellCommandResult): boolean {
  return normalizedOpenShellErrorText(result).includes('provider profile not found');
}

/**
 * Checks the exact OpenShell 0.0.80 missing-provider diagnostic.
 *
 * @param result Failed provider inspection result.
 * @returns True only for the pinned missing-provider diagnostic.
 */
function isOpenShellProviderNotFound(result: OpenShellCommandResult): boolean {
  const error = normalizedOpenShellErrorText(result);

  return error.includes('provider not found') && !error.includes('provider profile not found');
}

/**
 * Normalizes one product-safe OpenShell error for exact diagnostic matching.
 *
 * @param result Failed OpenShell command result.
 * @returns Lowercase single-line error text.
 */
function normalizedOpenShellErrorText(result: OpenShellCommandResult): string {
  return safeErrorText(result)
    .replace(/[│\s]+/g, ' ')
    .toLowerCase();
}

/**
 * Compiles `openshell sandbox create` arguments from a sandbox materialization request.
 *
 * @param input Sandbox create request.
 * @returns CLI argument vector.
 */
export function compileOpenShellSandboxCreateArgs(input: OpenShellSandboxCreateInput): string[] {
  const args = ['sandbox', 'create', '--name', input.name, '--from', input.from];

  if (input.gateway) {
    args.push('--gateway', input.gateway);
  }
  appendOpenShellGatewayFlags(args, input);
  if (input.noKeep) {
    args.push('--no-keep');
  }
  if (input.policyPath) {
    args.push('--policy', input.policyPath);
  }
  if (input.cpu) {
    args.push('--cpu', input.cpu);
  }
  if (input.memory) {
    args.push('--memory', input.memory);
  }
  for (const provider of input.providers ?? []) {
    args.push('--provider', provider);
  }
  for (const upload of input.uploads ?? []) {
    args.push('--upload', compileOpenShellUpload(upload));
  }
  for (const [key, value] of Object.entries(input.labels ?? {})) {
    args.push('--label', `${key}=${value}`);
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    args.push('--env', `${key}=${value}`);
  }

  args.push('--', ...input.command);

  return args;
}

/**
 * Compiles `openshell sandbox exec` arguments for a retained sandbox command.
 *
 * @param input Sandbox execution request.
 * @returns CLI argument vector.
 */
export function compileOpenShellSandboxExecArgs(input: OpenShellSandboxExecInput): string[] {
  const args = ['sandbox', 'exec', '--name', input.name, '--no-tty'];

  if (input.gateway) {
    args.push('--gateway', input.gateway);
  }
  appendOpenShellGatewayFlags(args, input);
  if (input.workdir) {
    args.push('--workdir', input.workdir);
  }
  if (input.timeoutSeconds !== undefined) {
    args.push('--timeout', String(input.timeoutSeconds));
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    args.push('--env', `${key}=${value}`);
  }
  args.push('--', ...input.command);

  return args;
}

/**
 * Appends direct OpenShell gateway flags shared by gateway and sandbox commands.
 *
 * @param args Mutable argument vector.
 * @param input Gateway endpoint options.
 */
function appendOpenShellGatewayFlags(args: string[], input: { gatewayEndpoint?: string }): void {
  if (input.gatewayEndpoint) {
    args.push('--gateway-endpoint', input.gatewayEndpoint);
  }
}

/**
 * Appends gateway flags to an OpenShell provider command.
 *
 * @param args Mutable argument vector.
 * @param input Gateway endpoint options.
 */
function appendOpenShellProviderGatewayFlags(
  args: string[],
  input: { gateway?: string; gatewayEndpoint?: string }
): void {
  if (input.gateway) {
    args.push('--gateway', input.gateway);
  }
  appendOpenShellGatewayFlags(args, input);
}

/**
 * Compiles one OpenShell upload argument.
 *
 * @param upload Upload request.
 * @returns CLI upload value.
 */
function compileOpenShellUpload(upload: OpenShellSandboxUploadInput): string {
  if (!upload.targetPath) {
    return upload.sourcePath;
  }

  return `${upload.sourcePath}:${upload.targetPath}`;
}

/**
 * Removes ANSI escape sequences from OpenShell human-readable output.
 *
 * @param value Raw output.
 * @returns Output without terminal formatting escapes.
 */
function stripAnsi(value: string): string {
  const ansiEscape = String.fromCharCode(27);

  return value.replace(new RegExp(`${ansiEscape}\\[[0-9;]*m`, 'g'), '');
}

/**
 * Parses simple `Label: value` output lines from the OpenShell CLI.
 *
 * @param value CLI stdout.
 * @returns Lowercase label map.
 */
function parseCliFields(value: string): Map<string, string> {
  const fields = new Map<string, string>();

  for (const line of stripAnsi(value).split(/\r?\n/)) {
    const match = /^\s*([^:]+):\s*(.*?)\s*$/.exec(line);

    if (!match) {
      continue;
    }

    const key = match.at(1);
    const fieldValue = match.at(2);

    if (key === undefined || fieldValue === undefined) {
      continue;
    }

    fields.set(key.trim().toLowerCase(), fieldValue.trim());
  }

  return fields;
}

/**
 * Normalizes the OpenShell version output.
 *
 * @param value Raw version output.
 * @returns Version without a leading `openshell` token.
 */
function normalizeVersion(value: string): string {
  return value.replace(/^openshell\s+/i, '').trim();
}

/**
 * Normalizes gateway status labels.
 *
 * @param value Raw status label.
 * @returns Normalized status.
 */
function normalizeStatus(value: string | undefined): OpenShellStatus['status'] {
  if (!value) {
    return 'unknown';
  }

  return value.toLowerCase() === 'connected' ? 'connected' : 'unknown';
}

/**
 * Builds a short product-safe command error message.
 *
 * @param result Command result.
 * @returns Stderr or stdout summary.
 */
function safeErrorText(result: OpenShellCommandResult): string {
  return stripAnsi(result.stderr || result.stdout).trim();
}

/**
 * Redacts credential-looking provider output before it can enter NanoCore evidence.
 *
 * @param value Raw OpenShell provider output.
 * @returns Output with common secret shapes replaced.
 */
function redactProviderOutput(value: string): string {
  return stripAnsi(value)
    .replace(
      /^(\s*(?:credential|token|secret|password|api[ _-]?key)\s*[:=]\s*).+$/gim,
      '$1[redacted]'
    )
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
}
