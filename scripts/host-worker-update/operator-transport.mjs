/** Fixed operator inspection through the independently retained staging SSH binding. */
import { runBoundedProcess } from './bounded-process.mjs';

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
async function inspectProcess(alias, input, signal) {
  const result = await runBoundedProcess('ssh',
    sshArguments(alias, 'sudo -n /usr/lib/openkit/nanohost inspect'), {
      input, signal, timeoutMs: 10_000, maxStdoutBytes: 16_384, maxStderrBytes: 256,
    });
  if (result.exitCode !== 0 || result.stderr.length !== 0) throw Error(unavailable);
  return result;
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
