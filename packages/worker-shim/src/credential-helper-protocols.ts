import { Buffer } from 'node:buffer';

const MAX_BYTES = 65_536;
const KUBE_VERSIONS = ['client.authentication.k8s.io/v1', 'client.authentication.k8s.io/v1beta1'];
const GIT_ATTRIBUTES = new Set(['protocol', 'host', 'path', 'username', 'password']);

/** Published process protocol selected by the caller, with no transport authority. */
export type CredentialHelperProtocol = 'git' | 'docker' | 'aws' | 'kubernetes' | 'google';

/** Complete native input supplied in memory; the codec reads no process environment. */
export interface CredentialHelperInput {
  /** Native protocol to decode. */
  readonly protocol: CredentialHelperProtocol;
  /** Native operation; token-producing protocols default to get. */
  readonly operation?: string;
  /** Native stdin, or injected KUBERNETES_EXEC_INFO for Kubernetes. */
  readonly input?: string;
}

/** Parsed request for an injected effect; no field selects a Vault reference. */
export type CredentialHelperRequest =
  | {
      readonly protocol: 'git';
      readonly operation: 'get' | 'store' | 'erase';
      readonly attributes: Record<string, string>;
    }
  | { readonly protocol: 'docker'; readonly operation: 'get' | 'erase'; readonly target: string }
  | { readonly protocol: 'aws' | 'google'; readonly operation: 'get' }
  | {
      readonly protocol: 'kubernetes';
      readonly operation: 'get';
      readonly apiVersion: string;
      readonly interactive: boolean;
    };

/** Injected effect whose native response is validated before any output is returned. */
export type ResolveCredentialHelper = (
  request: CredentialHelperRequest
) => unknown | Promise<unknown>;

/** Complete process output; this codec never writes streams or diagnostics. */
export interface CredentialHelperReply {
  /** Zero on a complete valid response, one on refusal. */
  readonly exitCode: number;
  /** Bounded native response or the fixed Google error document. */
  readonly stdout: string;
  /** Fixed refusal text for protocols other than Google. */
  readonly stderr: string;
}

/** Reject internally without retaining input or callback diagnostics. */
function invalid(): never {
  throw new Error('Invalid credential helper message.');
}

/** Require an object, excluding arrays, before reading native fields. */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

/** Check individual strings before serialization can allocate an oversized response. */
function text(value: unknown, nonempty = true): string {
  if (
    typeof value !== 'string' ||
    (nonempty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > MAX_BYTES
  )
    invalid();
  return value;
}

/** Validate a calendar timestamp without consulting a clock or checking freshness. */
function timestamp(value: unknown): string {
  const result = text(value);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      result
    );
  if (!match) invalid();
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const y = Number(year);
  const m = Number(month);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    m < 1 ||
    m > 12 ||
    Number(day) < 1 ||
    Number(day) > days[m - 1]! ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 ||
    Number(offsetMinute ?? 0) > 59 ||
    !Number.isFinite(Date.parse(result))
  )
    invalid();
  return result;
}

/** Parse the bounded, non-negotiating Git scalar subset; ignore additive attributes. */
function gitAttributes(input: string): Record<string, string> {
  if (/[\0\r]/.test(input)) invalid();
  const attributes: Record<string, string> = {};
  const seen = new Set<string>();
  const lines = input.split('\n');
  let terminated = false;
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line, 'utf8') + (index < lines.length - 1 ? 1 : 0) > 65_535) invalid();
    if (!line) {
      terminated = true;
      continue;
    }
    if (terminated) invalid();
    const equals = line.indexOf('=');
    if (equals < 1) invalid();
    const key = line.slice(0, equals);
    // This helper advertises no state or authentication negotiation capabilities.
    if (key.endsWith('[]')) continue;
    if (seen.has(key)) invalid();
    seen.add(key);
    if (GIT_ATTRIBUTES.has(key)) attributes[key] = line.slice(equals + 1);
  }
  if (Object.keys(attributes).length === 0) invalid();
  return attributes;
}

/** Admit one native operation before invoking any injected effect. */
function requestFor(input: CredentialHelperInput): CredentialHelperRequest {
  const value = text(input.input ?? '', false);
  const operation = input.operation;
  switch (input.protocol) {
    case 'git':
      if (operation !== 'get' && operation !== 'store' && operation !== 'erase') invalid();
      return { protocol: 'git', operation, attributes: gitAttributes(value) };
    case 'docker': {
      // Store is refused before parsing its credential-bearing JSON input.
      if (operation !== 'get' && operation !== 'erase') invalid();
      const target = value.endsWith('\n') ? value.slice(0, -1) : value;
      if (!target.trim() || /[\0\r\n]/.test(target)) invalid();
      return { protocol: 'docker', operation, target };
    }
    case 'aws':
    case 'google':
      if ((operation !== undefined && operation !== 'get') || value !== '') invalid();
      return { protocol: input.protocol, operation: 'get' };
    case 'kubernetes': {
      if (operation !== undefined && operation !== 'get') invalid();
      const info = object(JSON.parse(value));
      const spec = object(info.spec);
      const apiVersion = text(info.apiVersion);
      if (
        info.kind !== 'ExecCredential' ||
        !KUBE_VERSIONS.includes(apiVersion) ||
        typeof spec.interactive !== 'boolean'
      )
        invalid();
      return {
        protocol: 'kubernetes',
        operation: 'get',
        apiVersion,
        interactive: spec.interactive,
      };
    }
    default:
      return invalid();
  }
}

/** Project only native AWS fields; optional expiration has no local refresh semantics. */
function awsResponse(value: Record<string, unknown>): Record<string, unknown> {
  if (value.Version !== 1) invalid();
  const result: Record<string, unknown> = {
    Version: 1,
    AccessKeyId: text(value.AccessKeyId),
    SecretAccessKey: text(value.SecretAccessKey),
  };
  const session = value.SessionToken;
  const expiry = value.Expiration;
  if (session !== undefined) result.SessionToken = text(session);
  if (expiry !== undefined) result.Expiration = timestamp(expiry);
  return result;
}

/** Project token and/or paired client-certificate fields in the negotiated native version. */
function kubeResponse(value: Record<string, unknown>, apiVersion: string): Record<string, unknown> {
  if (value.apiVersion !== apiVersion || value.kind !== 'ExecCredential') invalid();
  const status = object(value.status);
  const token = status.token;
  const certificate = status.clientCertificateData;
  const key = status.clientKeyData;
  const expiry = status.expirationTimestamp;
  const result: Record<string, unknown> = {};
  if (token !== undefined) result.token = text(token);
  if (certificate !== undefined || key !== undefined) {
    result.clientCertificateData = text(certificate);
    result.clientKeyData = text(key);
  }
  if (Object.keys(result).length === 0) invalid();
  if (expiry !== undefined) result.expirationTimestamp = timestamp(expiry);
  return { apiVersion, kind: 'ExecCredential', status: result };
}

/** Project one supported executable-sourced subject token without an output-file cache. */
function googleResponse(value: Record<string, unknown>): Record<string, unknown> {
  if (value.version !== 1 || value.success !== true) invalid();
  const tokenType = value.token_type;
  const result: Record<string, unknown> = { version: 1, success: true, token_type: tokenType };
  if (
    tokenType === 'urn:ietf:params:oauth:token-type:id_token' ||
    tokenType === 'urn:ietf:params:oauth:token-type:jwt'
  )
    result.id_token = text(value.id_token);
  else if (tokenType === 'urn:ietf:params:oauth:token-type:saml2')
    result.saml_response = text(value.saml_response);
  else invalid();
  const expiry = value.expiration_time;
  if (expiry !== undefined) {
    if (typeof expiry !== 'number' || !Number.isSafeInteger(expiry) || expiry < 0) invalid();
    result.expiration_time = expiry;
  }
  return result;
}

/** Serialize only validated native output, with no partial response on failure. */
function responseFor(request: CredentialHelperRequest, value: unknown): string {
  if (request.protocol === 'git') {
    if (request.operation !== 'get') return '';
    const result = value === null ? {} : object(value);
    let output = '';
    for (const key of ['username', 'password']) {
      const field = result[key];
      if (field === undefined) continue;
      const scalar = text(field, false);
      if (/[\0\r\n]/.test(scalar)) invalid();
      output += `${key}=${scalar}\n`;
    }
    return `${output}\n`;
  }
  if (request.protocol === 'docker' && request.operation === 'erase') return '';
  const result = object(value);
  let output: Record<string, unknown>;
  switch (request.protocol) {
    case 'docker':
      output = { Username: text(result.Username), Secret: text(result.Secret) };
      break;
    case 'aws':
      output = awsResponse(result);
      break;
    case 'kubernetes':
      output = kubeResponse(result, request.apiVersion);
      break;
    case 'google':
      output = googleResponse(result);
      break;
  }
  return `${JSON.stringify(output)}\n`;
}

/**
 * Decode one bounded native process request and validate its injected response.
 * No transport, credential source, cache, clock or process stream is owned here.
 * @param input Complete native protocol input.
 * @param resolve Injected effect; the caller owns fresh authorization and lifecycle.
 * @returns Complete native success or fixed value-free refusal, never partial output.
 */
export async function runCredentialHelper(
  input: CredentialHelperInput,
  resolve: ResolveCredentialHelper
): Promise<CredentialHelperReply> {
  try {
    const request = requestFor(input);
    const stdout = responseFor(request, await resolve(request));
    if (Buffer.byteLength(stdout, 'utf8') > MAX_BYTES) invalid();
    return { exitCode: 0, stdout, stderr: '' };
  } catch {
    return input.protocol === 'google'
      ? {
          exitCode: 1,
          stdout: `${JSON.stringify({ version: 1, success: false, code: 'credential_error', message: 'Credential unavailable' })}\n`,
          stderr: '',
        }
      : { exitCode: 1, stdout: '', stderr: 'Credential unavailable\n' };
  }
}
