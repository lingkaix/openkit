/** Fixed operator inspection through the independently retained staging SSH binding. */
import { spawn } from 'node:child_process';

const unavailable = 'Operator transport unavailable; inspect before any new effect.';
const inspectionCommand = ['/usr/lib/openkit/nanohost', 'inspect'];

/** Keep host-key verification and the existing operator identity outside request data. */
function sshArguments(alias, command) {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '--',
    alias,
    command,
  ];
}

/** Collect bounded bytes, never truncate into success or retain a remote diagnostic. */
function inspectProcess(alias, input, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(unavailable));
    const child = spawn('ssh', sshArguments(alias, 'sudo -n /usr/lib/openkit/nanohost inspect'), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [],
      stderr = [];
    let outputBytes = 0,
      errorBytes = 0,
      settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', fail);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // Disconnecting SSH cannot prove the remote outcome. No dependent effect
      // or automatic retry is permitted, including when a descendant holds a pipe.
      child.kill('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(new Error(unavailable));
    };
    const timer = setTimeout(fail, 10_000);
    signal?.addEventListener('abort', fail, { once: true });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.stdout.on('data', (bytes) => {
      if (settled) return;
      outputBytes += bytes.length;
      if (outputBytes > 16_384) return fail();
      stdout.push(bytes);
    });
    child.stderr.on('data', (bytes) => {
      if (settled) return;
      errorBytes += bytes.length;
      if (errorBytes > 256) return fail();
      stderr.push(bytes);
    });
    child.on('close', (exitCode, exitSignal) => {
      if (settled) return;
      if (exitCode !== 0 || exitSignal !== null || errorBytes !== 0) return fail();
      settled = true;
      cleanup();
      resolve({
        exitCode,
        signal: exitSignal,
        timedOut: false,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    // Abort may have occurred between the pre-spawn test and listener registration.
    if (signal?.aborted) return fail();
    child.stdin.end(input);
  });
}

/**
 * Bind each fixed inspection to a fresh independent staging-record read.
 * This uses the external operator's SSH configuration, never the restricted App
 * update identity or a NanoCore runtime host-control channel.
 * @param {() => Promise<object>} deploymentRecord Independent protected record reader.
 * @returns {{runOperator: Function}} The bounded adapter consumed by host-observation.mjs.
 */
export function createOperatorTransport(deploymentRecord) {
  return {
    async runOperator(target, request) {
      try {
        const url = new URL(target);
        if (
          url.protocol !== 'https:' ||
          url.origin !== target ||
          url.username ||
          url.password ||
          url.hostname === 'a2'
        )
          throw new Error();
        if (typeof deploymentRecord !== 'function') throw new Error();
        const binding = await deploymentRecord();
        if (
          binding?.origin !== target ||
          binding.sshAlias !== 'a1' ||
          typeof binding.reference !== 'string' ||
          !binding.reference
        )
          throw new Error();
        if (
          !request ||
          typeof request !== 'object' ||
          Object.keys(request).some(
            (key) =>
              ![
                'command',
                'stdin',
                'timeoutMs',
                'maxStdoutBytes',
                'maxStderrBytes',
                'signal',
              ].includes(key)
          )
        )
          throw new Error();
        if (
          JSON.stringify(request.command) !== JSON.stringify(inspectionCommand) ||
          request.timeoutMs !== 10_000 ||
          request.maxStdoutBytes !== 16_384 ||
          request.maxStderrBytes !== 256
        )
          throw new Error();
        const body = JSON.parse(request.stdin);
        if (
          Object.keys(body).length !== 1 ||
          typeof body.nonce !== 'string' ||
          !/^[a-f0-9]{64}$/.test(body.nonce) ||
          JSON.stringify(body) !== request.stdin
        )
          throw new Error();
        if (request.signal !== undefined && !(request.signal instanceof AbortSignal))
          throw new Error();
        return await inspectProcess(binding.sshAlias, request.stdin, request.signal);
      } catch {
        throw new Error(unavailable);
      }
    },
  };
}
