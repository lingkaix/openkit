import { Buffer } from 'node:buffer';
import {
  WORKER_CREDENTIAL_HELPER_BODY_MAX_BYTES,
  type WorkerCredentialHelperCommand,
  WorkerCredentialHelperCommandSchema,
  type WorkerCredentialHelperReply,
  WorkerCredentialHelperReplySchema,
} from '@openkit/worker-protocol';
import {
  type CredentialHelperProtocol,
  type CredentialHelperReply,
  type CredentialHelperRequest,
  runCredentialHelper,
} from './credential-helper-protocols.js';

/** The only native helper route, on the existing session loopback ingress. */
export const CREDENTIAL_HELPER_NATIVE_PATH = '/worker-control/credential-helper';

/** Git may supply a partial context; only the current admitted declaration can complete it. */
export type NativeCredentialHelperCommand =
  | Exclude<WorkerCredentialHelperCommand, { protocol: 'git' }>
  | {
      readonly protocol: 'git';
      readonly operation: 'get';
      readonly attributes: {
        readonly protocol?: string | undefined;
        readonly host?: string | undefined;
        readonly path?: string | undefined;
      };
    };

/** Reads only these explicit native/helper protocol inputs, never an ambient credential file. */
type HelperEnvironment = Readonly<Record<string, string | undefined>>;

function unavailable(): never {
  throw new Error('Credential unavailable.');
}

/** Collect a whole bounded private response before returning any credential to a caller. */
async function privateReply(response: Response): Promise<WorkerCredentialHelperReply> {
  if (
    !response.ok ||
    !response.headers
      .get('cache-control')
      ?.split(',')
      .some((value) => value.trim() === 'no-store') ||
    !response.headers.get('content-type')?.startsWith('application/json')
  ) {
    await response.body?.cancel().catch(() => undefined);
    unavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) unavailable();
  const bytes = Buffer.allocUnsafe(WORKER_CREDENTIAL_HELPER_BODY_MAX_BYTES);
  let length = 0;
  let complete = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > bytes.byteLength - length) unavailable();
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const parsed = WorkerCredentialHelperReplySchema.safeParse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
  );
  if (!parsed.success) unavailable();
  return parsed.data;
}

/** One request, without redirects, retry, output-file cache or another credential source. */
export async function requestNativeCredentialHelper(
  command: NativeCredentialHelperCommand,
  environment: HelperEnvironment
): Promise<WorkerCredentialHelperReply> {
  const target = environment.OPENKIT_CREDENTIAL_HELPER_URL;
  const credential = environment.OPENKIT_CREDENTIAL_HELPER_TOKEN;
  if (!target || !credential || !/^[A-Za-z0-9_-]{43}$/.test(credential)) unavailable();
  const url = new URL(target);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== CREDENTIAL_HELPER_NATIVE_PATH ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    unavailable();
  const body = JSON.stringify(command);
  if (Buffer.byteLength(body) > WORKER_CREDENTIAL_HELPER_BODY_MAX_BYTES) unavailable();
  const signal = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal,
  });
  const reply = await privateReply(response);
  signal.throwIfAborted();
  return reply;
}

/** Convert only native selectors; no material, lineage or Vault identity enters a request. */
function commandFor(
  request: CredentialHelperRequest,
  environment: HelperEnvironment
): NativeCredentialHelperCommand {
  if (request.protocol === 'git') {
    if (request.operation !== 'get') unavailable();
    const { protocol, host, path } = request.attributes;
    return {
      protocol: 'git',
      operation: 'get',
      attributes: {
        ...(protocol !== undefined ? { protocol } : {}),
        ...(host !== undefined ? { host } : {}),
        ...(path !== undefined ? { path } : {}),
      },
    };
  }
  if (request.protocol === 'google') {
    if (environment.GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE !== undefined) unavailable();
    return WorkerCredentialHelperCommandSchema.parse({
      protocol: 'google',
      operation: 'get',
      audience: environment.GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE,
      subjectTokenType: environment.GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE,
    });
  }
  return WorkerCredentialHelperCommandSchema.parse(request);
}

/** Native process facade; store/erase never cross Core and all diagnostics stay value-free. */
export async function runNativeCredentialHelper(input: {
  readonly protocol: CredentialHelperProtocol;
  readonly operation?: string;
  readonly stdin?: string;
  readonly environment: HelperEnvironment;
}): Promise<CredentialHelperReply> {
  return runCredentialHelper(
    {
      protocol: input.protocol,
      ...(input.operation !== undefined ? { operation: input.operation } : {}),
      input:
        input.protocol === 'kubernetes'
          ? (input.environment.KUBERNETES_EXEC_INFO ?? '')
          : (input.stdin ?? ''),
    },
    async (request) => {
      if (request.operation !== 'get') return {};
      const reply = await requestNativeCredentialHelper(
        commandFor(request, input.environment),
        input.environment
      );
      if (!('credential' in reply)) unavailable();
      return reply.credential;
    }
  );
}
