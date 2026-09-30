import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { HostEvent, HostResponse, PiModelDescriptor } from '../channel.ts';

/** Source entry of the host process; Node strips its types directly. */
export const HOST_BIN = fileURLToPath(
  new URL('../bin/openkit-pi-runtime-host.ts', import.meta.url)
);

/** Fresh directories one AgentSession binding uses. */
export interface HostDirectories {
  readonly agentDir: string;
  readonly home: string;
  readonly root: string;
  readonly stateRoot: string;
  readonly workingDirectory: string;
}

/**
 * Creates the directories of one test binding under a new temporary root.
 *
 * @returns Real, absolute directory paths.
 */
export async function createHostDirectories(): Promise<HostDirectories> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-runtime-host-')));
  const directories = {
    agentDir: join(root, 'agent'),
    home: join(root, 'home'),
    root,
    stateRoot: join(root, 'state'),
    workingDirectory: join(root, 'work'),
  };
  for (const path of [
    directories.agentDir,
    directories.home,
    directories.stateRoot,
    directories.workingDirectory,
  ]) {
    await mkdir(path, { recursive: true });
  }
  return directories;
}

/**
 * Returns one fresh 43-character loopback credential.
 *
 * @returns Unpadded base64url of 32 random bytes.
 */
export function mintLoopbackCredential(): string {
  return randomBytes(32).toString('base64url');
}

/** A model descriptor with test defaults. */
export function modelDescriptor(
  modelId: string,
  overrides: Partial<PiModelDescriptor> = {}
): PiModelDescriptor {
  return {
    contextWindow: 32_000,
    inputModalities: ['text'],
    maxOutputTokens: 4_000,
    modelId,
    reasoning: false,
    ...overrides,
  };
}

/** A running host process and a client for its private channel. */
export class HostProcess {
  readonly #channel: Duplex;
  readonly child: ChildProcess;
  readonly events: HostEvent[] = [];
  readonly exited: Promise<number | null>;
  #nextId = 1;
  readonly #pending = new Map<number, (response: HostResponse) => void>();
  readonly #waiters: (() => void)[] = [];
  /** Responses without a request id. */
  readonly orphanResponses: HostResponse[] = [];
  stderr = '';
  stdout = '';

  private constructor(child: ChildProcess) {
    this.child = child;
    this.#channel = child.stdio[3] as Duplex;
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.stdout?.on('data', (chunk: Buffer) => {
      this.stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
    let buffer = '';
    this.#channel.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.lines.push(line);
        this.#frame(JSON.parse(line) as HostEvent | HostResponse);
        newline = buffer.indexOf('\n');
      }
    });
  }

  /**
   * Starts the host with the given environment and no arguments.
   *
   * @param env Complete child environment.
   * @returns The running host.
   */
  public static start(env: NodeJS.ProcessEnv): HostProcess {
    const child = spawn(process.execPath, ['--no-warnings', HOST_BIN], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    return new HostProcess(child);
  }

  /** Every raw line the channel carried so far, for secret-absence checks. */
  public readonly lines: string[] = [];

  /**
   * Sends one request and waits for its response.
   *
   * @param request Request fields without `id`.
   * @returns The response.
   */
  public request(request: Record<string, unknown>): Promise<HostResponse> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#channel.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  /** Writes one raw line to the channel. */
  public writeRaw(line: string): void {
    this.#channel.write(line);
  }

  /** Ends the Harness side of the channel, as a lost supervisor does. */
  public endChannel(): void {
    this.#channel.end();
  }

  /**
   * Waits until one event satisfies the predicate.
   *
   * @param predicate Event test.
   * @returns The first matching event.
   */
  public async waitForEvent<T extends HostEvent>(
    predicate: (event: HostEvent) => event is T
  ): Promise<T>;
  public async waitForEvent(predicate: (event: HostEvent) => boolean): Promise<HostEvent>;
  public async waitForEvent(predicate: (event: HostEvent) => boolean): Promise<HostEvent> {
    for (;;) {
      const found = this.events.find(predicate);
      if (found) return found;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  /**
   * Waits until a condition over the received frames holds.
   *
   * @param condition Checked after every frame.
   */
  public async waitUntil(condition: () => boolean): Promise<void> {
    while (!condition()) await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  /**
   * Waits for the settlement of one Turn.
   *
   * @param turnId Turn id.
   * @returns The `turn_settled` event.
   */
  public settled(turnId: string): Promise<Extract<HostEvent, { event: 'turn_settled' }>> {
    return this.waitForEvent(
      (event): event is Extract<HostEvent, { event: 'turn_settled' }> =>
        event.event === 'turn_settled' && event.turnId === turnId
    );
  }

  /** Kills the process if it is still running. */
  public kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }

  #frame(frame: HostEvent | HostResponse): void {
    if ('event' in frame) {
      this.events.push(frame);
    } else if (frame.id !== null && this.#pending.has(frame.id)) {
      const resolve = this.#pending.get(frame.id);
      this.#pending.delete(frame.id);
      resolve?.(frame);
    } else {
      this.orphanResponses.push(frame);
    }
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
}
