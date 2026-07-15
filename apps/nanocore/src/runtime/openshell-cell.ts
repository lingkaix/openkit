import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const OPEN_SHELL_CELL_HELPER = '/usr/local/libexec/openkit-openshell-cell';
const OPEN_SHELL_CELL_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const OPEN_SHELL_CELL_SSH_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@[\]-]{0,254}$/;
const OPEN_SHELL_CELL_COMMAND_TIMEOUT_MS = 600_000;
const OPEN_SHELL_CELL_TERMINATION_GRACE_MS = 200;

/** Runs one fixed OpenShell Cell helper command without a shell. */
export interface OpenShellCellCommandRunner {
  /**
   * Runs one executable with exact arguments.
   *
   * @param command Executable path or name.
   * @param args Exact command arguments.
   * @returns Promise that resolves after a successful child exit.
   * @throws When the child process cannot start or exits unsuccessfully.
   */
  run(command: string, args: readonly string[]): Promise<void>;
}

/** Owns the privileged lifecycle boundary around one stock OpenShell Cell. */
export interface OpenShellCellLifecycle {
  /** Stable non-secret binding for the exact local or remote lifecycle target. */
  readonly targetId: string;

  /**
   * Claims a ready empty Cell for one durable backend session.
   *
   * @param ownerId Durable backend session id.
   * @returns Promise that resolves after the Cell is claimed.
   * @throws When the helper rejects or cannot prepare the Cell.
   */
  prepare(ownerId: string): Promise<void>;

  /**
   * Destroys the owner's Cell and leaves a verified empty replacement.
   *
   * @param ownerId Durable backend session id.
   * @returns Promise that resolves after replacement verification.
   * @throws When ownership or replacement verification fails.
   */
  recycle(ownerId: string): Promise<void>;
}

/** Shell-free local sudo or remote SSH adapter for the fixed OpenShell Cell helper. */
export class OpenShellCellController implements OpenShellCellLifecycle {
  private readonly runner: OpenShellCellCommandRunner;
  private readonly sshTarget: string | null;
  public readonly targetId: string;

  /**
   * Creates a Cell controller.
   *
   * @param options Optional command runner and remote SSH target.
   * @throws When the SSH target is unsafe.
   */
  public constructor(
    options: {
      readonly runner?: OpenShellCellCommandRunner;
      readonly sshTarget?: string;
    } = {}
  ) {
    this.runner = options.runner ?? DEFAULT_RUNNER;
    this.sshTarget = options.sshTarget ?? null;
    if (this.sshTarget !== null && !OPEN_SHELL_CELL_SSH_TARGET_PATTERN.test(this.sshTarget)) {
      throw new Error('OpenShell Cell SSH target is invalid.');
    }
    this.targetId = `cell-${createHash('sha256')
      .update(this.sshTarget ? `ssh:${this.sshTarget}` : 'local')
      .digest('hex')
      .slice(0, 24)}`;
  }

  /**
   * Claims a ready empty Cell for one durable backend session.
   *
   * @param ownerId Durable backend session id.
   * @returns Promise that resolves after the Cell is claimed.
   * @throws When the owner is unsafe or the helper fails.
   */
  public async prepare(ownerId: string): Promise<void> {
    await this.run('prepare', ownerId);
  }

  /**
   * Destroys the owner's Cell and leaves a verified empty replacement.
   *
   * @param ownerId Durable backend session id.
   * @returns Promise that resolves after replacement verification.
   * @throws When the owner is unsafe or the helper fails.
   */
  public async recycle(ownerId: string): Promise<void> {
    await this.run('recycle', ownerId);
  }

  /**
   * Runs one validated helper action and exposes only a bounded failure message.
   *
   * @param action Fixed helper action.
   * @param ownerId Durable backend session id.
   * @returns Promise that resolves after a successful helper exit.
   * @throws Error when the owner is unsafe or the helper fails.
   */
  private async run(action: 'prepare' | 'recycle', ownerId: string): Promise<void> {
    if (!OPEN_SHELL_CELL_OWNER_PATTERN.test(ownerId)) {
      throw new Error('OpenShell Cell owner id is invalid.');
    }

    try {
      if (this.sshTarget) {
        await this.runner.run('/usr/bin/ssh', [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'ForwardAgent=no',
          '-o',
          'ForwardX11=no',
          '-o',
          'PermitLocalCommand=no',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'ConnectTimeout=10',
          '-o',
          'ServerAliveInterval=10',
          '-o',
          'ServerAliveCountMax=2',
          this.sshTarget,
          '/usr/bin/sudo',
          '-n',
          OPEN_SHELL_CELL_HELPER,
          action,
          ownerId,
        ]);
      } else {
        await this.runner.run('/usr/bin/sudo', ['-n', OPEN_SHELL_CELL_HELPER, action, ownerId]);
      }
    } catch {
      throw new Error(`OpenShell Cell ${action} failed.`);
    }
  }
}

/** Child-process runner that supervises one shell-free command process group. */
export class ChildProcessOpenShellCellCommandRunner implements OpenShellCellCommandRunner {
  private readonly timeoutMs: number;
  private readonly terminationGraceMs: number;

  /**
   * Creates a command runner.
   *
   * @param timeoutMs Maximum command wall time; override only in focused process tests.
   * @param terminationGraceMs Delay between TERM and KILL; override only in focused tests.
   */
  public constructor(
    timeoutMs = OPEN_SHELL_CELL_COMMAND_TIMEOUT_MS,
    terminationGraceMs = OPEN_SHELL_CELL_TERMINATION_GRACE_MS
  ) {
    this.timeoutMs = timeoutMs;
    this.terminationGraceMs = terminationGraceMs;
  }

  /**
   * Runs one child in a separate POSIX process group without a shell.
   *
   * @param command Executable path or name.
   * @param args Exact command arguments.
   * @returns Promise that resolves after a successful child exit.
   * @throws When the child process cannot start or exits unsuccessfully.
   */
  public async run(command: string, args: readonly string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const detached = process.platform !== 'win32';
      const child = spawn(command, [...args], {
        detached,
        stdio: 'ignore',
      });
      let settled = false;
      let timedOut = false;
      let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;

      const deadline = setTimeout(() => {
        timedOut = true;
        terminate('SIGTERM');
        forceKillTimeout = setTimeout(() => {
          terminate('SIGKILL');
          settle(new Error(`OpenShell Cell command timed out after ${this.timeoutMs}ms.`));
        }, this.terminationGraceMs);
      }, this.timeoutMs);
      const settle = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadline);
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const terminate = (signal: NodeJS.Signals): void => {
        if (detached && child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // A vanished process group needs no additional termination.
          }
        }
        try {
          child.kill(signal);
        } catch {
          // Close/error settles the command when the direct child already exited.
        }
      };

      child.once('error', (error) => {
        if (!timedOut) {
          settle(error);
        }
      });
      child.once('close', (exitCode) => {
        if (timedOut) {
          return;
        }
        settle(
          exitCode === 0
            ? undefined
            : new Error(`OpenShell Cell command exited with code ${exitCode ?? 'unknown'}.`)
        );
      });
    });
  }
}

const DEFAULT_RUNNER = new ChildProcessOpenShellCellCommandRunner();
