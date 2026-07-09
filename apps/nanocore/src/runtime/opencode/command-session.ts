import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionFactory,
  AgentSessionState,
  CreateAgentSessionInput,
} from '../types.js';

/**
 * Quotes one prompt argument for the shell command surface.
 */
function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Agent session that starts local OpenCode work through a configured command surface.
 */
export class OpenCodeCommandAgentSession implements AgentSession {
  public readonly id: string;
  public readonly environmentPackage: CreateAgentSessionInput['environmentPackage'];
  public readonly threadId: string;

  private readonly command: string;
  private readonly cwd: string;
  private readonly environment: Record<string, string>;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private state: AgentSessionState = 'bound';
  private activeProcess: ChildProcessWithoutNullStreams | null = null;

  /**
   * Creates an OpenCode command-backed agent session.
   */
  public constructor(input: CreateAgentSessionInput) {
    const command = input.agent.config.command ?? 'opencode run --format default';

    this.id = input.id;
    this.environmentPackage = input.environmentPackage;
    this.threadId = input.threadId;
    this.command = command;
    this.cwd = input.workspaceCwd ?? input.agent.config.workspaceRoot;
    this.environment = {
      ...input.agent.config.environment,
      ...(input.workspaceRoots.length > 0
        ? { OPENKIT_WORKSPACE_ROOTS: JSON.stringify(input.workspaceRoots) }
        : {}),
    };
  }

  /**
   * Registers a session event listener.
   */
  public onEvent(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Starts one OpenCode command process for the turn and streams stdout as assistant text.
   */
  public async startTurn(turnId: string, input: string): Promise<void> {
    this.state = 'running';
    this.emit({
      type: 'turn-started',
      turnId,
      startedAt: new Date().toISOString(),
    });

    const child = spawn(`${this.command} ${quoteShellArg(input)}`, {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.environment,
        OPENKIT_THREAD_ID: this.threadId,
        OPENKIT_TURN_ID: turnId,
      },
      shell: true,
      stdio: 'pipe',
    });

    this.activeProcess = child;
    child.stdout.on('data', (chunk: Buffer) => {
      const delta = chunk.toString();

      if (delta) {
        this.emit({ type: 'agent-message-delta', turnId, delta });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const delta = chunk.toString();

      if (delta) {
        this.emit({ type: 'agent-message-delta', turnId, delta });
      }
    });
    child.once('error', (error) => {
      this.state = 'failed';
      this.activeProcess = null;
      this.emit({
        type: 'turn-completed',
        turnId,
        status: 'failed',
        stopReason: 'error',
        completedAt: new Date().toISOString(),
        error: {
          code: 'opencode_command_failed',
          message: error.message,
        },
      });
    });
    child.once('exit', (code, signal) => {
      this.state = code === 0 ? 'bound' : 'failed';
      this.activeProcess = null;
      this.emit({
        type: 'turn-completed',
        turnId,
        status: code === 0 ? 'completed' : 'failed',
        stopReason: code === 0 ? 'completed' : 'error',
        completedAt: new Date().toISOString(),
        ...(code === 0
          ? {}
          : {
              error: {
                code: 'opencode_command_exited',
                message: signal
                  ? `OpenCode command exited with signal ${signal}.`
                  : `OpenCode command exited with code ${code ?? 'unknown'}.`,
              },
            }),
      });
    });

    child.stdin.end();
  }

  /**
   * Interrupts the active OpenCode command process.
   */
  public async interruptTurn(turnId: string): Promise<void> {
    if (!this.activeProcess) {
      return;
    }

    this.activeProcess.kill('SIGINT');
    this.emit({
      type: 'turn-completed',
      turnId,
      status: 'interrupted',
      stopReason: 'aborted',
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Closes any active process owned by this session.
   */
  public async close(): Promise<void> {
    this.state = 'exited';
    this.activeProcess?.kill();
    this.activeProcess = null;
  }

  /**
   * Returns the current agent-session state.
   */
  public getState(): AgentSessionState {
    return this.state;
  }

  /**
   * Emits one normalized session event.
   */
  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/**
 * Creates OpenCode command-backed sessions.
 */
export class OpenCodeCommandAgentSessionFactory implements AgentSessionFactory {
  /**
   * Creates one OpenCode command session.
   */
  public async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    return new OpenCodeCommandAgentSession(input);
  }
}
