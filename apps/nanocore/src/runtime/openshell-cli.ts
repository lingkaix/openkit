import { spawn } from 'node:child_process';

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
 * Inputs for reading OpenShell gateway metadata.
 */
export interface OpenShellGatewayInfoInput {
  /** Optional gateway name to inspect instead of the active gateway. */
  gateway?: string;
  /** Optional direct gateway endpoint URL. */
  gatewayEndpoint?: string;
  /** Whether to skip TLS verification for the direct gateway endpoint. */
  gatewayInsecure?: boolean;
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
  /** Whether to skip TLS verification for the direct gateway endpoint. */
  gatewayInsecure?: boolean;
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

/** Inputs for reading one OpenShell provider instance. */
export interface OpenShellProviderGetInput {
  /** OpenShell gateway name. */
  gateway?: string;
  /** Optional direct OpenShell gateway endpoint URL. */
  gatewayEndpoint?: string;
  /** Whether to skip TLS verification for the direct gateway endpoint. */
  gatewayInsecure?: boolean;
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
  /** Whether to skip TLS verification for the direct gateway endpoint. */
  gatewayInsecure?: boolean;
  /** Provider instance name. */
  name: string;
}

/** Inputs for detaching one provider from one sandbox. */
export interface OpenShellProviderDetachInput {
  /** OpenShell gateway name. */
  gateway?: string;
  /** Optional direct OpenShell gateway endpoint URL. */
  gatewayEndpoint?: string;
  /** Whether to skip TLS verification for the direct gateway endpoint. */
  gatewayInsecure?: boolean;
  /** Sandbox name. */
  name: string;
  /** Provider name to detach from the sandbox. */
  provider: string;
}

/**
 * Parsed `openshell doctor check` summary.
 */
export interface OpenShellDoctorStatus {
  /** Whether all doctor checks passed. */
  ok: boolean;
  /** Docker check summary when present. */
  docker: string | null;
  /** Product-safe error summary for failed doctor checks. */
  error?: string;
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
  /** Whether to skip TLS verification for the direct gateway endpoint. */
  gatewayInsecure?: boolean;
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
  /** Whether to skip TLS verification for the direct gateway endpoint. */
  gatewayInsecure?: boolean;
  /** Sandbox name. */
  name: string;
  /** Worker-visible source path inside the sandbox workspace. */
  sandboxPath: string;
}

/**
 * Inputs for deleting one OpenShell sandbox.
 */
export interface OpenShellSandboxDeleteInput {
  /** OpenShell gateway name. */
  gateway?: string;
  /** Optional direct OpenShell gateway endpoint URL. */
  gatewayEndpoint?: string;
  /** Whether to skip TLS verification for the direct gateway endpoint. */
  gatewayInsecure?: boolean;
  /** Sandbox name. */
  name: string;
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
  /** OpenShell binary name or absolute path. */
  binary?: string;
}

/**
 * Child-process-backed OpenShell command runner.
 */
export class ChildProcessOpenShellRunner implements OpenShellCommandRunner {
  private readonly binary: string;

  /**
   * Creates a child-process runner for the installed OpenShell CLI.
   *
   * @param binary OpenShell binary name or path.
   */
  public constructor(binary = 'openshell') {
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
      const child = spawn(this.binary, args, {
        env: {
          ...process.env,
          ...options.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`OpenShell command timed out after ${options.timeoutMs}ms.`));
        }, options.timeoutMs);
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
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
        resolve({
          exitCode,
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        });
      });
    });
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
   * @param options Optional runner or binary override.
   */
  public constructor(options: OpenShellCliOptions = {}) {
    this.runner = options.runner ?? new ChildProcessOpenShellRunner(options.binary);
  }

  /**
   * Reads the installed OpenShell CLI version.
   *
   * @returns Semantic version string without the leading binary name.
   */
  public async version(): Promise<string> {
    const result = await this.runner.run(['--version']);

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell version check failed: ${safeErrorText(result)}`);
    }

    return normalizeVersion(stripAnsi(result.stdout).trim());
  }

  /**
   * Reads active gateway status.
   *
   * @returns Parsed status summary; failed connectivity returns `unavailable`.
   */
  public async status(): Promise<OpenShellStatus> {
    const result = await this.runner.run(['status']);
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
  public async gatewayInfo(input: OpenShellGatewayInfoInput = {}): Promise<OpenShellGatewayInfo> {
    const args = ['gateway', 'info'];

    if (input.gateway) {
      args.push('-g', input.gateway);
    }
    appendOpenShellGatewayFlags(args, input);

    const result = await this.runner.run(args);

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
   * Creates or updates one OpenShell provider without putting credential values in argv.
   *
   * @param input Provider name, type, credential, and gateway selection.
   * @returns Product-safe provider upsert summary.
   */
  public async upsertProvider(
    input: OpenShellProviderUpsertInput
  ): Promise<OpenShellProviderUpsertResult> {
    const exists = await this.providerExists(input);

    if (exists) {
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
   * Reads one OpenShell provider and redacts credential-looking values from CLI output.
   *
   * @param input Provider and gateway selection.
   * @returns Product-safe provider inspection result.
   */
  public async getProvider(input: OpenShellProviderGetInput): Promise<OpenShellProviderInfo> {
    const result = await this.runner.run(compileOpenShellProviderGetArgs(input));

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
    const result = await this.runner.run(args);

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
   * Detaches one provider from one OpenShell sandbox.
   *
   * @param input Sandbox and provider selection.
   * @returns Product-safe detach result.
   */
  public async detachProvider(
    input: OpenShellProviderDetachInput
  ): Promise<OpenShellSandboxFileResult> {
    const args = ['sandbox', 'provider', 'detach'];

    if (input.gateway) {
      args.push('--gateway', input.gateway);
    }
    appendOpenShellGatewayFlags(args, input);
    args.push(input.name, input.provider);

    const result = await this.runner.run(args);

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell provider detach failed: ${safeErrorText(result)}`);
    }

    return {
      stdout: result.stdout,
    };
  }

  /**
   * Runs OpenShell doctor checks for local prerequisites.
   *
   * @returns Parsed doctor summary.
   */
  public async doctorCheck(): Promise<OpenShellDoctorStatus> {
    const result = await this.runner.run(['doctor', 'check']);
    const docker = parseDoctorLine(result.stdout, 'Docker');

    if (result.exitCode !== 0) {
      return {
        docker,
        error: safeErrorText(result),
        ok: false,
      };
    }

    return {
      docker,
      ok: true,
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
    const result = await this.runner.run(compileOpenShellSandboxCreateArgs(input));

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell sandbox create failed: ${safeErrorText(result)}`);
    }

    return {
      name: input.name,
      stdout: result.stdout,
    };
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

    const result = await this.runner.run(args);

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell sandbox download failed: ${safeErrorText(result)}`);
    }

    return {
      stdout: result.stdout,
    };
  }

  /**
   * Deletes one OpenShell sandbox.
   *
   * @param input Delete request.
   * @returns Product-safe delete result.
   */
  public async deleteSandbox(
    input: OpenShellSandboxDeleteInput
  ): Promise<OpenShellSandboxFileResult> {
    const args = ['sandbox', 'delete'];

    if (input.gateway) {
      args.push('--gateway', input.gateway);
    }
    appendOpenShellGatewayFlags(args, input);
    args.push(input.name);

    const result = await this.runner.run(args);

    if (result.exitCode !== 0) {
      throw new Error(`OpenShell sandbox delete failed: ${safeErrorText(result)}`);
    }

    return {
      stdout: result.stdout,
    };
  }

  /**
   * Checks whether an OpenShell provider exists.
   *
   * @param input Provider and gateway selection.
   * @returns True when the provider exists.
   */
  private async providerExists(input: OpenShellProviderUpsertInput): Promise<boolean> {
    return (await this.runner.run(compileOpenShellProviderGetArgs(input))).exitCode === 0;
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
    const result = await this.runner.run(args);

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
 * Appends direct OpenShell gateway flags shared by gateway and sandbox commands.
 *
 * @param args Mutable argument vector.
 * @param input Gateway endpoint options.
 */
function appendOpenShellGatewayFlags(
  args: string[],
  input: { gatewayEndpoint?: string; gatewayInsecure?: boolean }
): void {
  if (input.gatewayEndpoint) {
    args.push('--gateway-endpoint', input.gatewayEndpoint);
  }
  if (input.gatewayInsecure) {
    args.push('--gateway-insecure');
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
  input: { gateway?: string; gatewayEndpoint?: string; gatewayInsecure?: boolean }
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
 * Parses one doctor check line by label.
 *
 * @param value CLI stdout.
 * @param label Doctor check label.
 * @returns Parsed check summary or null.
 */
function parseDoctorLine(value: string, label: string): string | null {
  const prefix = label.toLowerCase();

  for (const line of stripAnsi(value).split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed.toLowerCase().startsWith(prefix)) {
      continue;
    }

    return trimmed.replace(new RegExp(`^${label}\\s*\\.+\\s*`, 'i'), '').trim();
  }

  return null;
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
