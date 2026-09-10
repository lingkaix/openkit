import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';

import type { AppUpdateStatusResponse } from '@openkit/app-api-schemas';
import type { OpenKitAppUpdateConfig } from '@openkit/config-schema';

import {
  APP_UPDATE_RECEIPT_LIMIT_BYTES,
  type AppUpdateHostCommand,
  encodeAppUpdateHostCommand,
  parseAppUpdateHostOutput,
} from './host-request.js';

/** Result of one helper invocation. */
export type AppUpdateHostResult =
  | { readonly ok: true; readonly status: AppUpdateStatusResponse }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Process-independent host helper transport. */
export interface AppUpdateHostTransport {
  /** Sends one closed helper command and returns the host observation. */
  invoke(command: AppUpdateHostCommand): Promise<AppUpdateHostResult>;
}

const SSH_TIMEOUT_MS = 20_000;

/** Minimal child-process surface used by the SSH helper invoke. */
export interface AppUpdateHostChild {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
}

/**
 * Builds the fixed SSH argument vector for the configured App-update identity.
 *
 * @param config Boot-bound App-update SSH configuration.
 * @returns Argument vector with no remote command or shell interpolation.
 */
export function buildAppUpdateSshArgs(config: OpenKitAppUpdateConfig): string[] {
  return [
    '-F',
    '/dev/null',
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${config.knownHostsFile}`,
    '-o',
    `IdentityFile=${config.identityFile}`,
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'RequestTTY=no',
    '-p',
    String(config.port),
    '--',
    `${config.user}@${config.host}`,
  ];
}

/**
 * Rejects App-update identity files that are missing, linked, or inside Data Root.
 *
 * @param path Candidate absolute identity or known-hosts path.
 * @param dataRoot NanoCore data root, when configured.
 */
export function assertAppUpdateSecretPath(path: string, dataRoot: string | null): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('App-update SSH identity must be a regular file.');
  }

  if (!dataRoot) {
    return;
  }

  const candidate = realpathSync(path);
  const root = realpathSync(dataRoot);
  if (candidate === root || candidate.startsWith(`${root}${sep}`)) {
    throw new Error('App-update SSH identity must stay outside Data Root.');
  }
}

/**
 * Reads one helper process with a bounded stdout cap and closed stdin error handling.
 *
 * @param child Spawned SSH or test double.
 * @param stdin Closed helper command bytes.
 * @param options Optional deadline override for tests.
 * @returns Host observation or coded failure.
 */
export function invokeAppUpdateHostChild(
  child: AppUpdateHostChild,
  stdin: Buffer,
  options?: { readonly timeoutMs?: number }
): Promise<AppUpdateHostResult> {
  return new Promise<AppUpdateHostResult>((resolveResult) => {
    const stdout: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (result: AppUpdateHostResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        code: 'app_update_unavailable',
        message: 'App-update host helper did not answer before the deadline.',
      });
    }, options?.timeoutMs ?? SSH_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      received += chunk.byteLength;
      if (received > APP_UPDATE_RECEIPT_LIMIT_BYTES) {
        stdout.length = 0;
        child.kill('SIGKILL');
        finish({
          ok: false,
          code: 'app_update_recovery_required',
          message: 'App-update host output exceeds the 64 KiB receipt limit.',
        });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.resume();
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') {
        return;
      }
      finish({
        ok: false,
        code: 'app_update_unavailable',
        message: 'App-update host helper input failed.',
      });
    });
    child.on('error', () =>
      finish({
        ok: false,
        code: 'app_update_unavailable',
        message: 'App-update host helper could not start.',
      })
    );
    child.on('close', (_exitCode) => {
      const output = Buffer.concat(stdout);
      if (output.byteLength === 0) {
        finish({
          ok: false,
          code: 'app_update_unavailable',
          message: 'App-update host helper returned no observation.',
        });
        return;
      }
      finish(parseAppUpdateHostOutput(output));
    });
    child.stdin?.end(stdin);
  });
}

/**
 * Classifies a missing, linked, or in-tree App-update identity without exposing the path.
 *
 * @param path Candidate absolute identity or known-hosts path.
 * @param dataRoot NanoCore data root, when configured.
 * @returns Coded unavailable result, or null when the path is a regular file outside Data Root.
 */
function classifyAppUpdateSecretPath(
  path: string,
  dataRoot: string | null
): AppUpdateHostResult | null {
  try {
    assertAppUpdateSecretPath(path, dataRoot);
    return null;
  } catch {
    return {
      ok: false,
      code: 'app_update_unavailable',
      message: 'App-update SSH identity is not a usable regular file.',
    };
  }
}

/**
 * Creates the production SSH transport bound to one boot-time App-update identity.
 *
 * Missing, linked, or in-tree identity files keep Core serving and classify helper
 * invokes as unavailable. They do not throw from app construction.
 *
 * @param config Boot-bound SSH configuration.
 * @param dataRoot NanoCore data root used to reject in-tree keys.
 * @returns Host transport.
 */
export function createSshAppUpdateHostTransport(
  config: OpenKitAppUpdateConfig,
  dataRoot: string | null
): AppUpdateHostTransport {
  const args = buildAppUpdateSshArgs(config);

  return {
    invoke: async (command) => {
      const identityError =
        classifyAppUpdateSecretPath(config.identityFile, dataRoot) ??
        classifyAppUpdateSecretPath(config.knownHostsFile, dataRoot);
      if (identityError) {
        return identityError;
      }
      const stdin = encodeAppUpdateHostCommand(command);
      return await invokeAppUpdateHostChild(
        spawn('ssh', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
        stdin
      );
    },
  };
}
