#!/usr/bin/env node

import {
  ApiCallError,
  createCoreClient,
  createRequestId,
  ProtocolValidationError,
} from '@openkit/core-client';
import { PROTOCOL_VERSION } from '@openkit/protocol';

import packageMetadata from '../package.json' with { type: 'json' };
import { describeOperation, operationCatalog, searchOperations } from './openkit-operations.mjs';
import {
  createDefaultOpenKitCredentialStore,
  redactPublicValue,
  resolveCredential,
} from './openkit-secrets.mjs';

const INTERFACE_VERSION = packageMetadata.version;
const DEFAULT_ENDPOINT = 'http://127.0.0.1:3000';
const COMMAND_USAGE = Object.freeze({
  '': 'openkit --help',
  help: 'openkit help [command]',
  doctor: 'openkit doctor [--credential <name>]',
  ops: 'openkit ops <search|describe|call>',
  'ops search': 'openkit ops search <query> [--schema]',
  'ops describe': 'openkit ops describe <operation-id> [--schema]',
  'ops call': 'openkit ops call <operation-id> --input - [--credential <name>]',
});

/** Typed local failure projected through the CLI error envelope. */
class CliFailure extends Error {
  /**
   * Creates one bounded CLI failure.
   *
   * @param {string} code Stable error code.
   * @param {string} message Public error message.
   * @param {number} exitCode Process exit status.
   * @param {unknown} [details] Optional structured detail.
   */
  constructor(code, message, exitCode, details) {
    super(message);
    this.name = 'CliFailure';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

/**
 * Runs one CLI command and writes exactly one completed JSON envelope.
 *
 * @param {string[]} argv Command arguments without the executable path.
 * @param {NodeJS.ProcessEnv} env Process environment.
 * @returns {Promise<number>} Exit status.
 */
export async function run(argv, env = process.env) {
  const state = {
    command: commandName(argv),
    operation: undefined,
    requestId: undefined,
    secrets: /** @type {string[]} */ ([]),
  };

  try {
    const data = await dispatch(argv, env, state);
    writeEnvelope(
      {
        ok: true,
        command: state.command,
        ...(state.operation ? { operation: state.operation } : {}),
        ...(state.requestId ? { requestId: state.requestId } : {}),
        data,
      },
      state.secrets
    );
    return 0;
  } catch (error) {
    if (error instanceof ApiCallError && error.requestId) {
      state.requestId = error.requestId;
    }
    const failure = classifyFailure(error);
    writeEnvelope(
      {
        ok: false,
        command: state.command,
        ...(state.operation ? { operation: state.operation } : {}),
        ...(state.requestId ? { requestId: state.requestId } : {}),
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.details === undefined ? {} : { details: failure.details }),
        },
      },
      state.secrets
    );
    return failure.exitCode;
  }
}

/**
 * Dispatches one accepted command family.
 *
 * @param {string[]} argv Command arguments.
 * @param {NodeJS.ProcessEnv} env Process environment.
 * @param {{command: string, operation?: string, requestId?: string, secrets: string[]}} state Mutable envelope context.
 * @returns {Promise<unknown>} Command result data.
 */
async function dispatch(argv, env, state) {
  if (argv[0] === 'help' || argv.at(-1) === '--help') {
    state.command = 'help';
    return help(argv[0] === 'help' ? argv.slice(1) : argv.slice(0, -1));
  }
  const destination = argv.at(-2) === '--credential' ? argv.at(-1) : undefined;
  if (destination !== undefined) {
    argv = argv.slice(0, -2);
  }
  if (destination !== undefined && argv[0] !== 'doctor' && argv[1] !== 'call') {
    throw usageFailure();
  }
  if (argv.length === 1 && argv[0] === 'doctor') {
    state.command = 'doctor';
    return doctor(env, state, destination);
  }
  if (argv[0] !== 'ops') {
    throw usageFailure();
  }
  if (argv[1] === 'search' && argv.length >= 3) {
    state.command = 'ops.search';
    const schema = argv.at(-1) === '--schema';
    const query = argv.slice(2, schema ? -1 : undefined);
    if (query.length === 0 || query.some((part) => part.startsWith('--'))) {
      throw usageFailure();
    }
    return searchOperations(query.join(' '), { schema });
  }
  if (
    argv[1] === 'describe' &&
    (argv.length === 3 || (argv.length === 4 && argv[3] === '--schema'))
  ) {
    state.command = 'ops.describe';
    const description = describeOperation(argv[2], { schema: argv.length === 4 });
    if (!description) {
      throw new CliFailure('operation_not_found', `Unknown operation: ${argv[2]}`, 2);
    }
    return description;
  }
  if (argv[1] === 'call' && argv.length === 5 && argv[3] === '--input' && argv[4] === '-') {
    state.command = 'ops.call';
    state.operation = argv[2];
    return callOperation(argv[2], env, state, destination);
  }
  throw usageFailure();
}

/**
 * Returns local command guidance without resolving credentials or opening a connection.
 *
 * @param {string[]} command Accepted command family, or empty for root help.
 * @returns {Record<string, unknown>} JSON help data.
 */
function help(command) {
  const topic = command.join(' ');
  if (!Object.hasOwn(COMMAND_USAGE, topic)) {
    throw usageFailure();
  }
  return {
    topic: topic || 'openkit',
    usage: COMMAND_USAGE[topic],
    commands: Object.values(COMMAND_USAGE),
    input:
      'Pass one strict flat JSON object on stdin. Put path, query and body fields at the top level; do not add params, query or body wrappers. Shared nested product values remain valid.',
    examples: [
      { command: 'openkit ops call workspace.list --input -', stdin: {} },
      {
        command: 'openkit ops call app-update.status --input -',
        stdin: { requestId: '019957ff-2000-7000-8000-000000000001' },
      },
    ],
    update: [
      { command: 'openkit ops search update' },
      { command: 'openkit ops describe app-update.preflight' },
      { command: 'openkit ops call app-update.preflight --input -', stdin: {} },
      { command: 'openkit ops describe app-update.prepare' },
      { command: 'openkit ops describe app-update.start' },
    ],
    credentials:
      'Append --credential <name> to doctor or an authenticated ops call to use only that endpoint-scoped named credential. Clear OPENKIT_NANOCORE_TOKEN first. Missing named credentials fail without fallback. Omit the selector for endpoint administration.',
    schemas: 'Add --schema to search or describe for full shared JSON schemas.',
  };
}

/**
 * Runs the bounded connection and contract diagnostic.
 *
 * @param {NodeJS.ProcessEnv} env Process environment.
 * @param {{requestId?: string, secrets: string[]}} state Envelope context.
 * @param {string} [destination] Explicit named credential selection.
 * @returns {Promise<unknown>} Redacted diagnostic data.
 */
async function doctor(env, state, destination) {
  if (Number.parseInt(process.versions.node, 10) !== 24) {
    throw new CliFailure('unsupported_host', 'OpenKit requires Node.js 24.', 2);
  }
  const endpoint = resolveEndpoint(env);
  const credentialStore = createDefaultOpenKitCredentialStore();
  const credential = resolveCredential({ endpoint, env, store: credentialStore, destination });
  if (credential) {
    state.secrets.push(credential.token);
  }
  state.requestId = createRequestId();
  const client = createClient(endpoint, credential);
  const meta = await client.core.meta();
  if (meta.protocolVersion !== PROTOCOL_VERSION) {
    throw new CliFailure('incompatible_contract', 'NanoCore protocol is incompatible.', 3, {
      actual: meta.protocolVersion,
      expected: PROTOCOL_VERSION,
    });
  }
  const [diagnostics, preflight] = await Promise.allSettled([
    client.operations['diagnostics.app']({}),
    client.operations['app-update.preflight']({}),
  ]);
  const readiness = diagnostics.status === 'fulfilled' ? diagnostics.value.readiness : undefined;
  return {
    interfaceVersion: INTERFACE_VERSION,
    nodeVersion: process.versions.node,
    endpoint,
    authentication: credential?.source ?? 'unauthenticated-local',
    nanocore: {
      serviceAvailability: 'available',
      productWorkReadiness: readiness?.productWork ?? 'unknown',
      updateReadiness: readiness?.update ?? { state: 'unknown', qualification: 'prepare-required' },
      maintenanceSafety:
        preflight.status === 'fulfilled'
          ? { state: preflight.value.state, observation: preflight.value }
          : { state: 'unknown', observation: null },
      executionHost: readiness?.executionHost ?? {
        state: 'unknown',
        observedAt: null,
        observationAgeMs: null,
        liveProbe: false,
        freshEmpty: null,
      },
      protocolVersion: meta.protocolVersion,
      capabilities: meta.capabilities,
    },
  };
}

/**
 * Validates and invokes one catalog operation.
 *
 * @param {string} operationId Catalog operation id.
 * @param {NodeJS.ProcessEnv} env Process environment.
 * @param {{requestId?: string, secrets: string[]}} state Envelope context.
 * @param {string} [destination] Explicit named credential selection.
 * @returns {Promise<unknown>} Operation result.
 */
async function callOperation(operationId, env, state, destination) {
  const operation = operationCatalog.find((entry) => entry.id === operationId);
  if (!operation) {
    throw new CliFailure('operation_not_found', `Unknown operation: ${operationId}`, 2);
  }
  if (
    destination !== undefined &&
    (operation.source === 'local-only' ||
      (operation.credentials?.length === 1 && operation.credentials[0] === 'bootstrap-secret'))
  ) {
    throw usageFailure();
  }
  const rawInput = await readStdinObject();
  const input = validateInput(operation, rawInput);
  if (operation.inputSensitivity.startsWith('secret')) {
    state.secrets.push(...collectSensitiveStrings(input));
  }

  const endpoint = resolveEndpoint(env);
  const credentialStore = createDefaultOpenKitCredentialStore();
  if (operation.source === 'local-only') {
    return operation.handler({ client: null, credentialStore, endpoint }, input);
  }

  const credential =
    operation.credentials?.length === 1 && operation.credentials[0] === 'bootstrap-secret'
      ? null
      : resolveCredential({ endpoint, env, store: credentialStore, destination });
  if (credential) {
    state.secrets.push(credential.token);
  }
  state.requestId =
    typeof input.requestId === 'string' && input.requestId ? input.requestId : createRequestId();
  const client = createClient(endpoint, credential);
  return operation.handler({ client, credentialStore, endpoint }, input);
}

/**
 * Validates input, withholding request-derived issue details for secret operations.
 * Supplies a request id only when the shared schema permits it.
 *
 * @param {{mutating: boolean, source: string, inputSensitivity: string, inputSchema: {safeParse(value: unknown): {success: boolean, data?: object, error?: {issues: unknown[]}}}}} operation Catalog operation.
 * @param {Record<string, unknown>} rawInput Parsed stdin object.
 * @returns {Record<string, unknown>} Strict validated input.
 */
function validateInput(operation, rawInput) {
  const generated =
    operation.mutating && operation.source !== 'local-only' && rawInput.requestId === undefined
      ? { ...rawInput, requestId: createRequestId() }
      : rawInput;
  const withGenerated = operation.inputSchema.safeParse(generated);
  if (withGenerated.success) {
    return withGenerated.data;
  }
  const withoutGenerated =
    generated === rawInput ? withGenerated : operation.inputSchema.safeParse(rawInput);
  if (withoutGenerated.success) {
    return withoutGenerated.data;
  }
  if (operation.inputSensitivity.startsWith('secret')) {
    throw new CliFailure('invalid_input', 'Operation input failed schema validation.', 2);
  }
  throw new CliFailure('invalid_input', 'Operation input failed schema validation.', 2, {
    issues: withoutGenerated.error?.issues ?? withGenerated.error?.issues ?? [],
  });
}

/**
 * Creates a Core Client with fixed Agent Skill audit metadata.
 *
 * @param {string} endpoint NanoCore endpoint.
 * @param {{token: string} | null} credential Optional bearer credential.
 * @returns {ReturnType<typeof createCoreClient>} Public client.
 */
function createClient(endpoint, credential) {
  return createCoreClient({
    baseUrl: endpoint,
    headers: {
      'x-openkit-client-channel': 'openkit-cli',
      'x-openkit-client-source': 'agent-skill',
      ...(credential ? { authorization: `Bearer ${credential.token}` } : {}),
    },
  });
}

/**
 * Resolves and validates the configured NanoCore endpoint.
 *
 * @param {NodeJS.ProcessEnv} env Process environment.
 * @returns {string} HTTP endpoint without a trailing slash.
 */
function resolveEndpoint(env) {
  const value = env.OPENKIT_NANOCORE_URL?.trim() || DEFAULT_ENDPOINT;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('unsupported protocol');
    }
    return url.href.replace(/\/$/, '');
  } catch {
    throw new CliFailure('invalid_configuration', 'OPENKIT_NANOCORE_URL must be an HTTP URL.', 2);
  }
}

/**
 * Reads one strict JSON object from stdin.
 *
 * @returns {Promise<Record<string, unknown>>} Parsed object.
 */
async function readStdinObject() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch {
    throw new CliFailure('invalid_input', 'Standard input must be one JSON object.', 2);
  }
}

/**
 * Maps one thrown value to the bounded process failure contract.
 *
 * @param {unknown} error Thrown value.
 * @returns {{code: string, message: string, details?: unknown, exitCode: number}} Public failure.
 */
function classifyFailure(error) {
  if (error instanceof CliFailure) {
    return error;
  }
  if (error instanceof ApiCallError) {
    const details =
      error.details && typeof error.details === 'object' && !Array.isArray(error.details)
        ? { ...error.details, ...(error.path === undefined ? {} : { path: error.path }) }
        : error.details === undefined && error.path === undefined
          ? undefined
          : {
              ...(error.details === undefined ? {} : { value: error.details }),
              ...(error.path === undefined ? {} : { path: error.path }),
            };
    return {
      code: error.code ?? 'nanocore_rejected',
      message: error.message,
      ...(details === undefined ? {} : { details }),
      exitCode: error.status === 401 || error.status === 403 ? 3 : 4,
    };
  }
  if (error instanceof ProtocolValidationError) {
    return {
      code: 'incompatible_contract',
      message: error.message,
      details: { path: error.path },
      exitCode: 3,
    };
  }
  if (error instanceof TypeError) {
    return { code: 'connection_failed', message: error.message, exitCode: 3 };
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (/** @type {{code?: unknown}} */ (error).code) === 'string'
  ) {
    const code = /** @type {{code: string}} */ (error).code;
    return {
      code,
      message: error.message,
      exitCode: 2,
    };
  }
  return {
    code: 'internal_error',
    message: error instanceof Error ? error.message : 'Unexpected CLI failure.',
    exitCode: 1,
  };
}

/**
 * Writes one redacted JSON envelope to stdout.
 *
 * @param {unknown} envelope Completed envelope.
 * @param {readonly string[]} secrets Exact secrets to redact.
 * @returns {void}
 */
function writeEnvelope(envelope, secrets) {
  process.stdout.write(`${JSON.stringify(redactPublicValue(envelope, secrets))}\n`);
}

/**
 * Collects string leaves from sensitive input for exact output redaction.
 *
 * @param {unknown} value Input value.
 * @returns {string[]} String leaves.
 */
function collectSensitiveStrings(value) {
  if (typeof value === 'string') {
    return value ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectSensitiveStrings);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectSensitiveStrings);
  }
  return [];
}

/**
 * Infers the envelope command before detailed usage validation.
 *
 * @param {string[]} argv Command arguments.
 * @returns {string} Stable command name.
 */
function commandName(argv) {
  if (argv[0] === 'help' || argv.at(-1) === '--help') {
    return 'help';
  }
  if (argv[0] === 'doctor') {
    return 'doctor';
  }
  if (argv[0] === 'ops' && ['search', 'describe', 'call'].includes(argv[1])) {
    return `ops.${argv[1]}`;
  }
  return 'ops.search';
}

/**
 * Creates the common usage failure.
 *
 * @returns {CliFailure} Usage error.
 */
function usageFailure() {
  return new CliFailure('invalid_usage', `Usage: ${Object.values(COMMAND_USAGE).join(' | ')}`, 2);
}

if (process.argv[1]) {
  run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
