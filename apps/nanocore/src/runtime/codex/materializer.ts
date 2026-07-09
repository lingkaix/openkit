import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import type { ResolvedAgentSetup } from '../../agents/setup-resolver.js';

/**
 * Codex local agent config fields used by the legacy Codex adapter.
 */
export interface CodexLocalAgentConfig {
  /** Optional process command. */
  command: string | null;
  /** Environment variables merged into the spawned agent process. */
  environment: Record<string, string>;
  /** Working directory for the agent process and Codex thread. */
  workspaceRoot: string;
}

/**
 * Runtime-native file emitted by an agent materializer.
 */
export interface CodexGeneratedFile {
  /** Relative file path inside the runtime directory. */
  path: string;
  /** Serialized file content. */
  content: string;
}

/**
 * Stdio JSON-RPC transport launch payload used by the Codex app-server client.
 */
export interface CodexTransportPayload {
  /** Working directory for the spawned process. */
  cwd: string;
  /** Environment variables merged into the spawned process. */
  environment: Record<string, string>;
  /** Optional agent command. */
  command?: string;
  /** Transport implementation kind. */
  kind: 'stdio-json-rpc';
}

/**
 * Codex `thread/start` request payload.
 */
export interface CodexThreadStartPayload {
  /** Codex thread working directory. */
  cwd: string;
  /** Codex approval policy. */
  approvalPolicy: 'on-request';
  /** Codex sandbox policy. */
  sandbox: 'danger-full-access';
  /** Whether raw experimental events are requested. */
  experimentalRawEvents: false;
  /** Whether Codex extended-history persistence is requested. */
  persistExtendedHistory: false;
}

/**
 * Complete Codex launch payload before an agent session is created.
 */
export interface CodexLaunchPayload {
  /** Runtime-native files generated for this launch. */
  generatedFiles: CodexGeneratedFile[];
  /** Codex thread-start request body. */
  threadStart: CodexThreadStartPayload;
  /** Process transport launch payload. */
  transport: CodexTransportPayload;
}

/**
 * Options for materializing a Codex launch from a resolved setup.
 */
export interface CodexMaterializerOptions {
  /** Environment variables to pass into the Codex process. */
  environment?: Record<string, string>;
  /** Workspace root to pass to the Codex process and thread. */
  workspaceRoot: string;
}

/**
 * Creates the Codex launch payload that matches the current local Codex adapter behavior.
 *
 * @param config Product-visible Codex local agent config.
 * @param workspaceRoots Materialized workspace roots captured for this launch.
 * @returns Codex launch payload.
 */
export function createCodexLaunchPayload(
  config: CodexLocalAgentConfig,
  workspaceRoots: MaterializedWorkspaceRoot[] = []
): CodexLaunchPayload {
  return {
    generatedFiles: [],
    threadStart: {
      cwd: config.workspaceRoot,
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    },
    transport: {
      cwd: config.workspaceRoot,
      environment: {
        ...config.environment,
        ...(workspaceRoots.length > 0
          ? { OPENKIT_WORKSPACE_ROOTS: JSON.stringify(workspaceRoots) }
          : {}),
      },
      ...(config.command ? { command: config.command } : {}),
      kind: 'stdio-json-rpc',
    },
  };
}

/**
 * Materializes a Codex launch payload from a resolved agent setup.
 *
 * @param setup Resolved agent setup.
 * @param options Late-bound runtime options.
 * @returns Codex launch payload.
 * @throws Error when the resolved setup is not a Codex local setup.
 */
export function materializeCodexLaunchPayload(
  setup: ResolvedAgentSetup,
  options: CodexMaterializerOptions
): CodexLaunchPayload {
  if (setup.runtime.kind !== 'codex' || setup.deployment.mode !== 'local') {
    throw new Error(
      `Unsupported Codex materialization target: ${setup.runtime.kind}/${setup.deployment.mode}.`
    );
  }

  return createCodexLaunchPayload({
    command: materializeCommand(setup.deployment.config),
    environment: options.environment ?? {},
    workspaceRoot: options.workspaceRoot,
  });
}

/**
 * Converts a resolved deployment block into the spawn command string.
 *
 * @param deployment Active resolved deployment block.
 * @returns Spawn command string, or null when the transport should use its default command.
 */
function materializeCommand(deployment: Record<string, unknown>): string | null {
  const command = deployment.command;

  if (typeof command !== 'string') {
    return null;
  }

  const args = deployment.args;

  if (!Array.isArray(args)) {
    return command;
  }

  const stringArgs = args.filter((arg): arg is string => typeof arg === 'string');

  return [command, ...stringArgs].join(' ');
}
