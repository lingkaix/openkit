import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as appSchemas from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { z } from 'zod';
import { isValidCredentialDestination } from './openkit-secrets.mjs';

const EMPTY_INPUT = z.object({}).strict();
const IDENTIFIER = z.string().min(1);
const CREDENTIAL_DESTINATION = z
  .string()
  .refine(isValidCredentialDestination, {
    message: 'A non-reserved named credential destination is required.',
  })
  .describe(
    'Required local slot: 1-64 lowercase letters, digits, underscores or hyphens, starting with a letter; admin, endpoint, default, current and the token prefix are reserved.'
  );
const OPENKIT_ACCESS_TOKEN = z.string().regex(/^okt_[A-Za-z0-9_-]+$/);
const ADMIN_RECOVERY_CREDENTIAL = strictScope({
  kind: z.literal('openkit-admin-recovery'),
  requestId: z.string().uuid(),
  tokenId: z.string().uuid(),
  ownerUserId: IDENTIFIER,
  expiresAt: z.string().datetime(),
  token: OPENKIT_ACCESS_TOKEN,
});
const STANDARD = Object.freeze({
  inputSensitivity: 'standard',
  outputSensitivity: 'redacted public response',
  requiredAccess: 'authenticated user',
  redaction: 'recursive credentials and secrets',
});
const SECRET_INPUT = Object.freeze({
  ...STANDARD,
  inputSensitivity: 'secret stdin',
});
const LOCAL_CREDENTIAL = Object.freeze({
  ...SECRET_INPUT,
  outputSensitivity: 'credential storage metadata only',
  requiredAccess: 'local credential-store access; no NanoCore actor',
});
const DEPLOYMENT_ADMIN_ACCESS = Object.freeze({
  requiredAccess: 'deployment admin: implicit local actor or server-admin bearer token',
});
const LOCAL_WORKSPACE_ARCHIVE_ACCESS = Object.freeze({
  requiredAccess:
    'canonical user: implicit local actor or server-admin bearer token; secret-safe local archive files',
});

/**
 * Creates one strict flat input schema by combining URL scope fields with a shared request body.
 *
 * @param {import('zod').ZodObject} requestSchema Shared request body schema.
 * @param {Record<string, import('zod').ZodType>} [scope] URL or query fields owned by the client method.
 * @returns {import('zod').ZodObject} Strict flat CLI input schema.
 */
function flatRequest(requestSchema, scope = {}) {
  return requestSchema.safeExtend(scope).strict();
}

/**
 * Creates one strict input schema from client-method scope fields.
 *
 * @param {Record<string, import('zod').ZodType>} scope URL or query fields owned by the client method.
 * @returns {import('zod').ZodObject} Strict flat CLI input schema.
 */
function strictScope(scope) {
  return z.object(scope).strict();
}

/**
 * Preserves a shared object schema while enforcing the CLI's strict unknown-key boundary.
 *
 * @param {import('zod').ZodObject} requestSchema Shared request schema.
 * @returns {import('zod').ZodObject} Strict shared request schema.
 */
function strictShared(requestSchema) {
  return requestSchema.strict();
}

/**
 * Removes client-method scope fields before forwarding a shared request body.
 *
 * @param {Record<string, unknown>} input Validated flat input.
 * @param {...string} keys Scope keys to remove.
 * @returns {Record<string, unknown>} Shared request body.
 */
function bodyWithout(input, ...keys) {
  const body = { ...input };
  for (const key of keys) {
    delete body[key];
  }
  return body;
}

/**
 * Creates a typed local CLI failure.
 *
 * @param {string} code Stable error code.
 * @param {string} message Public error message.
 * @param {unknown} [cause] Optional internal cause.
 * @returns {Error & {code: string, cause?: unknown}} Typed error.
 */
function localError(code, message, cause) {
  return Object.assign(new Error(message), { code, ...(cause === undefined ? {} : { cause }) });
}

/**
 * Preflights a named local sink, invokes issuance once, and returns only delivery metadata.
 *
 * @param {{credentialStore?: import('./openkit-secrets.mjs').OpenKitCredentialStore, endpoint: string}} context Local credential context.
 * @param {string} destination Explicit named destination.
 * @param {() => Promise<{token: string, record: unknown, rotatedRecord?: unknown}>} issue Public client issuance call.
 * @returns {Promise<object>} Redacted record and storage metadata.
 */
async function deliverNamedAccessToken({ credentialStore, endpoint }, destination, issue) {
  if (!isValidCredentialDestination(destination)) {
    throw localError(
      'invalid_credential_destination',
      'A non-reserved named credential destination is required.'
    );
  }
  if (
    !endpoint ||
    typeof credentialStore?.preflightNamedWrite !== 'function' ||
    typeof credentialStore.writeNamedToken !== 'function'
  ) {
    throw localError(
      'credential_storage_unavailable',
      'Named credential storage must be available before token issuance.'
    );
  }
  const slot = { baseUrl: endpoint, destination };
  try {
    credentialStore.preflightNamedWrite(slot);
  } catch (cause) {
    throw localError(
      'credential_storage_unavailable',
      'Named credential storage must be writable before token issuance.',
      cause
    );
  }
  const { token, record, rotatedRecord } = await issue();
  try {
    const credentialStorageBackend = credentialStore.writeNamedToken({ ...slot, token });
    return {
      record,
      ...(rotatedRecord === undefined ? {} : { rotatedRecord }),
      credentialStorageBackend,
      destination,
    };
  } catch (cause) {
    throw localError(
      'credential_storage_failed',
      'NanoCore issued the token, but named credential storage failed. Inspect token inventory before a new request; the secret cannot be recovered from NanoCore.',
      cause
    );
  }
}

/** Stores an actorless bootstrap result in the endpoint credential sink after preflighting it. */
async function deliverEndpointAccessToken({ credentialStore, endpoint }, issue) {
  if (
    typeof credentialStore?.preflightWrite !== 'function' ||
    typeof credentialStore.writeToken !== 'function' ||
    !endpoint
  )
    throw localError(
      'credential_storage_unavailable',
      'Endpoint credential storage must be available before bootstrap consumption.'
    );
  try {
    credentialStore.preflightWrite({ baseUrl: endpoint });
  } catch (cause) {
    throw localError(
      'credential_storage_unavailable',
      'Endpoint credential storage must be writable before bootstrap consumption.',
      cause
    );
  }
  const { token, record } = await issue();
  try {
    const credentialStorageBackend = credentialStore.writeToken({ baseUrl: endpoint, token });
    return { record, credentialStorageBackend };
  } catch (cause) {
    throw localError(
      'credential_storage_failed',
      'The bootstrap token was consumed, but the returned endpoint credential could not be stored.',
      cause
    );
  }
}

/** Derives secret delivery from credential/result facts without an independent online operation row. */
function secretDeliveryProjection(id, definition) {
  if (!definition.returnsOneTimeSecret) return {};
  const bootstrap = appSchemas.operationUsesBootstrapSecret(definition);
  return {
    outputSensitivity: 'redacted token records and credential storage metadata only',
    requiredAccess: bootstrap
      ? 'one-time server bootstrap token over HTTPS or loopback; no authenticated actor'
      : 'deployment admin: server-admin bearer token in server mode',
    inputSchema: bootstrap
      ? strictShared(definition.inputSchema)
      : flatRequest(definition.inputSchema, { destination: CREDENTIAL_DESTINATION }),
    handler: (context, input) =>
      bootstrap
        ? deliverEndpointAccessToken(context, () => context.client.operations[id](input))
        : deliverNamedAccessToken(context, input.destination, () =>
            context.client.operations[id](bodyWithout(input, 'destination'))
          ),
  };
}

/**
 * Opens one exact regular non-link archive and preserves its identity through stream acquisition.
 *
 * @param {string} sourcePath Caller-selected source path.
 * @returns {ReadableStream<Uint8Array>} Owned archive stream.
 */
function openWorkspaceArchive(sourcePath) {
  let fileDescriptor = null;
  try {
    const before = lstatSync(sourcePath);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error('not a regular file');
    }
    fileDescriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fileDescriptor);
    if (before.dev !== opened.dev || before.ino !== opened.ino || !opened.isFile()) {
      throw new Error('file identity changed');
    }
    const stream = createReadStream(sourcePath, { autoClose: true, fd: fileDescriptor });
    fileDescriptor = null;
    return Readable.toWeb(stream);
  } catch (cause) {
    if (fileDescriptor !== null) {
      closeSync(fileDescriptor);
    }
    throw localError('invalid_archive_source', 'Workspace archive source is unavailable.', cause);
  }
}

/**
 * Writes one response stream to a newly owned exact destination without overwriting any path.
 *
 * @param {string} destinationPath Caller-selected destination path.
 * @param {ReadableStream<Uint8Array>} stream Download response stream.
 * @returns {Promise<void>}
 */
async function writeWorkspaceArchive(destinationPath, stream) {
  let fileDescriptor = null;
  let identity = null;
  try {
    fileDescriptor = openSync(
      destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    fchmodSync(fileDescriptor, 0o600);
    identity = fstatSync(fileDescriptor);
    const output = createWriteStream(destinationPath, { autoClose: true, fd: fileDescriptor });
    fileDescriptor = null;
    await pipeline(Readable.fromWeb(stream), output);
    const published = lstatSync(destinationPath, { throwIfNoEntry: false });
    if (
      !published ||
      published.isSymbolicLink() ||
      !published.isFile() ||
      published.dev !== identity.dev ||
      published.ino !== identity.ino
    ) {
      throw new Error('Workspace archive destination identity changed during download.');
    }
  } catch (cause) {
    if (fileDescriptor !== null) {
      closeSync(fileDescriptor);
    }
    const code =
      cause?.code === 'EEXIST' || cause?.code === 'ELOOP'
        ? 'archive_destination_exists'
        : 'archive_download_failed';
    throw localError(code, 'Workspace archive destination could not be created.', cause);
  }
}

/**
 * Rejects content-bearing Agent Skill operations for one restricted Material.
 *
 * @param {unknown} sensitivity Material sensitivity read from the authoritative metadata route.
 * @returns {void}
 * @throws {ApiCallError} When canonical Material content must remain outside the Agent Skill.
 */
function requireAgentReadableMaterial(sensitivity) {
  if (sensitivity === 'restricted') {
    throw new ApiCallError(409, 'Restricted Material content is unavailable to the Agent Skill.', {
      code: 'sensitive_content',
    });
  }
}

/** Retained stream bindings add only CLI-local file inputs and exclusive sink effects. */
const archiveBindings = {
  'workspace.archive-download': {
    clientMethod: 'app.downloadWorkspaceExportArchive',
    inputSchema: strictShared(
      appSchemas.WORKSPACE_ARCHIVE_OPERATION_DEFINITIONS[
        'workspace.archive-download'
      ].inputSchema.safeExtend({ destinationPath: z.string().min(1) })
    ),
    mutating: true, // Exclusive local destination creation is a CLI effect.
    async handler({ client }, input) {
      const stream = await client.app.downloadWorkspaceExportArchive(
        input.workspaceId,
        input.exportId
      );
      await writeWorkspaceArchive(input.destinationPath, stream);
      return { downloaded: true };
    },
  },
  'workspace.archive-import-dry-run': {
    clientMethod: 'app.dryRunWorkspaceArchiveImport',
    inputSchema: strictShared(
      appSchemas.WORKSPACE_ARCHIVE_OPERATION_DEFINITIONS[
        'workspace.archive-import-dry-run'
      ].inputSchema.safeExtend({ sourcePath: z.string().min(1) })
    ),
    handler: ({ client }, input) =>
      client.app.dryRunWorkspaceArchiveImport(openWorkspaceArchive(input.sourcePath)),
  },
  'workspace.archive-import': {
    clientMethod: 'app.importWorkspaceArchive',
    inputSchema: strictShared(
      appSchemas.WORKSPACE_ARCHIVE_OPERATION_DEFINITIONS[
        'workspace.archive-import'
      ].inputSchema.safeExtend({ sourcePath: z.string().min(1) })
    ),
    handler: ({ client }, input) =>
      client.app.importWorkspaceArchive(openWorkspaceArchive(input.sourcePath), input.requestId),
  },
};

/**
 * The single transport-neutral OpenKit operation inventory.
 *
 * Each network handler invokes exactly one public Core Client operation. Local-only handlers touch
 * only the configured endpoint credential store.
 */
export const operationCatalog = [
  {
    ...LOCAL_CREDENTIAL,
    id: 'credential.store',
    source: 'local-only',
    clientMethod: null,
    localReason: 'Stores the configured endpoint credential without a NanoCore request.',
    group: 'credential',
    summary: 'Store one endpoint credential from stdin.',
    mutating: true,
    inputSchema: z.union([strictScope({ token: OPENKIT_ACCESS_TOKEN }), ADMIN_RECOVERY_CREDENTIAL]),
    handler: ({ credentialStore, endpoint }, input) => {
      if (typeof credentialStore?.writeToken !== 'function' || !endpoint) {
        throw localError(
          'credential_storage_unavailable',
          'Endpoint credential storage is unavailable.'
        );
      }
      return {
        credentialStorageBackend: credentialStore.writeToken({
          baseUrl: endpoint,
          token: input.token,
        }),
      };
    },
  },
  {
    ...LOCAL_CREDENTIAL,
    inputSensitivity: 'standard',
    id: 'credential.delete',
    source: 'local-only',
    clientMethod: null,
    localReason: 'Deletes the configured endpoint credential without a NanoCore request.',
    group: 'credential',
    summary: 'Delete the configured endpoint credential.',
    mutating: true,
    inputSchema: EMPTY_INPUT,
    handler: ({ credentialStore, endpoint }) => {
      if (typeof credentialStore?.deleteToken !== 'function' || !endpoint) {
        throw localError(
          'credential_storage_unavailable',
          'Endpoint credential storage is unavailable.'
        );
      }
      return { deleted: credentialStore.deleteToken({ baseUrl: endpoint }) };
    },
  },
  ...Object.entries(appSchemas.OPERATION_DEFINITIONS).map(([id, definition]) => ({
    ...STANDARD,
    ...(definition.scope.kind === 'server' ? DEPLOYMENT_ADMIN_ACCESS : {}),
    ...(Object.hasOwn(appSchemas.ADMINISTRATION_OPERATION_DEFINITIONS, id) &&
    definition.scope.kind !== 'server'
      ? {
          requiredAccess:
            definition.scope.kind === 'actor-quick-chat-workspace'
              ? 'deployment admin; private Quick Chat; exact human confirmation when required'
              : 'deployment admin; current Workspace and source-audience access; exact human confirmation when required',
        }
      : {}),
    ...(definition.scope.kind === 'user'
      ? { requiredAccess: 'canonical user: implicit local actor or server-admin bearer token' }
      : {}),
    ...('inputSensitivity' in definition ? { inputSensitivity: definition.inputSensitivity } : {}),
    ...(id === 'material.revision-save' ? { inputSensitivity: 'workspace content' } : {}),
    ...(id === 'material.revision-read' ? { outputSensitivity: 'workspace content' } : {}),
    id,
    source: 'app-api',
    appOperationId: id,
    clientMethod: `operations.${id}`,
    group: id.split('.')[0],
    summary: definition.description,
    mutating: definition.mutating,
    inputSchema: strictShared(definition.inputSchema),
    outputSchema: definition.outputSchema,
    handler: async ({ client }, input) => {
      if (id === 'material.create') requireAgentReadableMaterial(input.sensitivity);
      if (id === 'material.revision-read' || id === 'material.revision-save') {
        const { material } = await client.operations['material.read']({
          workspaceId: input.workspaceId,
          materialId: input.materialId,
        });
        requireAgentReadableMaterial(material.sensitivity);
      }
      return client.operations[id](input);
    },
    credentials: definition.credentials,
    ...secretDeliveryProjection(id, definition),
    ...(definition.binding === 'streaming'
      ? {
          ...LOCAL_WORKSPACE_ARCHIVE_ACCESS,
          inputSensitivity: 'host-local path',
          ...archiveBindings[id],
        }
      : {}),
  })),
];

/** Public capability exclusions that keep unsupported scope out of the operation catalog. */
export const operationExclusions = [
  {
    source: 'core-projection',
    name: 'meta',
    reason: 'Unauthenticated connection probing is a support binding, outside operation discovery.',
    owner: 'docs/specs/20261002-operation_definition.md',
  },
  {
    source: 'core-projection',
    name: 'subscribeTurnEvents',
    reason:
      'The CLI has no event subscription mode; bounded durable reads and the three owned archive streams remain available.',
    owner: 'docs/specs/20260910-agent_operator_skill.md',
  },
];

/**
 * Searches operation identity, capability group, and summary with native substring matching.
 *
 * @param {string} query Search query.
 * @returns {Array<Record<string, unknown>>} Concise operation metadata without handlers or schemas.
 */
export function searchOperations(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  return operationCatalog
    .filter((operation) =>
      `${operation.id} ${operation.group} ${operation.summary}`.toLowerCase().includes(normalized)
    )
    .map(publicMetadata);
}

/**
 * Describes one operation with a machine-readable JSON input schema.
 *
 * @param {string} id Stable operation id.
 * @returns {Record<string, unknown> | null} Public operation description, or null when unknown.
 */
export function describeOperation(id) {
  const operation = operationCatalog.find((candidate) => candidate.id === id);
  return operation
    ? {
        ...publicMetadata(operation),
        inputSchema: z.toJSONSchema(operation.inputSchema, { target: 'draft-7' }),
      }
    : null;
}

/**
 * Removes executable implementation fields from one catalog entry.
 *
 * @param {Record<string, unknown>} operation Catalog entry.
 * @returns {Record<string, unknown>} Public operation metadata.
 */
function publicMetadata(operation) {
  const { handler: _handler, inputSchema: _inputSchema, ...metadata } = operation;
  return metadata;
}
