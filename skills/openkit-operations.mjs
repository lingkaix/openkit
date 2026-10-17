import { createHash } from 'node:crypto';
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
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as appSchemas from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { AccessTokenIdSchema, UserIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { acquireLocalEcosystemSkill } from '../apps/nanocore/dist/catalog/skill-local-source.js';
import {
  parseSkillImportSource,
  SkillSourceInputError,
} from '../apps/nanocore/dist/catalog/skill-source.js';
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
  tokenId: AccessTokenIdSchema,
  ownerUserId: UserIdSchema,
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
 * @param {'archive' | 'artifact'} [kind] Operation-specific fixed diagnostic class.
 * @returns {ReadableStream<Uint8Array>} Owned exact file stream.
 */
function openWorkspaceArchive(sourcePath, kind = 'archive') {
  let fileDescriptor = null;
  try {
    const before = lstatSync(sourcePath);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error('not a regular file');
    }
    fileDescriptor = openSync(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
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
    throw localError(
      `invalid_${kind}_source`,
      kind === 'archive'
        ? 'Workspace archive source is unavailable.'
        : 'Artifact source is unavailable.',
      cause
    );
  }
}

/**
 * Writes one response stream to a newly owned exact destination without overwriting any path.
 *
 * @param {string} destinationPath Caller-selected destination path.
 * @param {ReadableStream<Uint8Array>} stream Download response stream.
 * @param {{byteLength: number, contentDigest: string}} [expected] Exact Artifact download proof.
 * @returns {Promise<void>}
 */
async function writeWorkspaceArchive(destinationPath, stream, expected) {
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
    if (expected) {
      const hash = createHash('sha256');
      let byteLength = 0;
      const verify = new Transform({
        transform(chunk, _encoding, done) {
          byteLength += chunk.byteLength;
          if (byteLength > expected.byteLength)
            return done(new Error('Artifact download length mismatch.'));
          hash.update(chunk);
          done(null, chunk);
        },
        flush(done) {
          done(
            byteLength === expected.byteLength &&
              `sha256:${hash.digest('hex')}` === expected.contentDigest
              ? null
              : new Error('Artifact download digest mismatch.')
          );
        },
      });
      await pipeline(Readable.fromWeb(stream), verify, output);
    } else await pipeline(Readable.fromWeb(stream), output);
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
    const kind = expected ? 'artifact' : 'archive';
    const code =
      cause?.code === 'EEXIST' || cause?.code === 'ELOOP'
        ? `${kind}_destination_exists`
        : `${kind}_download_failed`;
    throw localError(
      code,
      expected
        ? 'Artifact destination could not be created or verified.'
        : 'Workspace archive destination could not be created.',
      cause
    );
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
  'artifact.import': {
    clientMethod: 'artifactFiles.import',
    inputSchema: strictShared(
      appSchemas.ARTIFACT_OPERATION_DEFINITIONS['artifact.import'].inputSchema.safeExtend({
        sourcePath: z.string().min(1),
      })
    ),
    handler: ({ client }, input) =>
      client.artifactFiles.import(
        bodyWithout(input, 'sourcePath'),
        openWorkspaceArchive(input.sourcePath, 'artifact')
      ),
  },
  'artifact.download': {
    clientMethod: 'artifactFiles.download',
    inputSchema: strictShared(
      appSchemas.ARTIFACT_OPERATION_DEFINITIONS['artifact.download'].inputSchema.safeExtend({
        destinationPath: z.string().min(1),
      })
    ),
    mutating: true, // Exclusive local destination creation is a CLI effect.
    async handler({ client }, input) {
      const downloaded = await client.artifactFiles.download(bodyWithout(input, 'destinationPath'));
      await writeWorkspaceArchive(input.destinationPath, downloaded.body, downloaded);
      return { downloaded: true };
    },
  },
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

/** Public capability exclusions that keep unsupported scope out of the operation catalog. */
export const operationExclusions = [
  {
    source: 'app-api',
    name: 'channel.discord.pair',
    reason:
      'A pairing challenge is delivered only in the authenticated Web account flow; it is not an access token or a CLI output.',
    owner: 'docs/specs/20260930-pending_requests.md',
  },
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
  ...Object.entries(appSchemas.OPERATION_DEFINITIONS)
    .filter(
      ([id, definition]) =>
        (definition.binding === 'json' || Object.hasOwn(archiveBindings, id)) &&
        !operationExclusions.some((entry) => entry.source === 'app-api' && entry.name === id)
    )
    .map(([id, definition]) => ({
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
      ...('inputSensitivity' in definition
        ? { inputSensitivity: definition.inputSensitivity }
        : {}),
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
        if (id === 'catalog.skill-import' && typeof input.source === 'string') {
          try {
            const source = parseSkillImportSource(input.source);
            if (source.kind === 'local') {
              const { tree } = acquireLocalEcosystemSkill({
                path: source.path,
                ...(input.sourceSubpath === undefined ? {} : { subpath: input.sourceSubpath }),
                ...(input.sourceSkillName === undefined
                  ? {}
                  : { skillName: input.sourceSkillName }),
              });
              input = { ...bodyWithout(input, 'source', 'sourceSubpath', 'sourceSkillName'), tree };
            }
          } catch (error) {
            if (error instanceof SkillSourceInputError)
              throw localError('invalid_skill_source', error.message);
            throw error;
          }
        }
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
            ...(id.startsWith('workspace.')
              ? LOCAL_WORKSPACE_ARCHIVE_ACCESS
              : {
                  requiredAccess:
                    'authenticated user; current Workspace and Artifact audience; explicit local file path',
                }),
            inputSensitivity: 'host-local path',
            ...archiveBindings[id],
          }
        : {}),
    })),
];

/**
 * Searches definition metadata and bounded discovery terms without creating dispatch aliases.
 *
 * @param {string} query Search query.
 * @param {{schema?: boolean}} [options] Explicit full-schema opt-in.
 * @returns {Array<Record<string, unknown>>} Identity and summary, with JSON schemas only when requested.
 */
export function searchOperations(query, { schema = false } = {}) {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) {
    return [];
  }
  return operationCatalog
    .filter(
      (operation) =>
        `${operation.id} ${operation.group} ${operation.summary}`
          .toLowerCase()
          .includes(normalized) ||
        (Object.hasOwn(DISCOVERY_ALIASES, normalized) &&
          DISCOVERY_ALIASES[normalized].some(
            (target) => operation.id === target || operation.group === target
          ))
    )
    .map((operation) => ({
      id: operation.id,
      summary: operation.summary.replace(/\s+/g, ' ').trim(),
      ...(schema
        ? {
            inputSchema: z.toJSONSchema(operation.inputSchema, { target: 'draft-7', io: 'input' }),
            ...(operation.outputSchema
              ? { outputSchema: z.toJSONSchema(operation.outputSchema, { target: 'draft-7' }) }
              : {}),
          }
        : {}),
    }));
}

// These terms select existing definition rows only. Invocation still requires their canonical ids.
const DISCOVERY_ALIASES = Object.freeze({
  update: ['app-update'],
  upgrade: ['app-update'],
  'app update': ['app-update'],
  preflight: ['app-update.preflight'],
  'update preflight': ['app-update.preflight'],
  connection: ['diagnostics.app'],
  version: ['diagnostics.app'],
  caller: ['caller.read'],
  'caller identity': ['caller.read'],
  identity: ['caller.read'],
  whoami: ['caller.read'],
  'who am i': ['caller.read'],
});

/**
 * Describes one operation with a shallow input contract or the explicit full JSON schema.
 *
 * @param {string} id Stable operation id.
 * @param {{schema?: boolean}} [options] Explicit full-schema opt-in.
 * @returns {Record<string, unknown> | null} Public operation description, or null when unknown.
 */
export function describeOperation(id, { schema = false } = {}) {
  const operation = operationCatalog.find((candidate) => candidate.id === id);
  if (!operation) return null;
  const inputSchema = z.toJSONSchema(operation.inputSchema, { target: 'draft-7', io: 'input' });
  return {
    ...publicMetadata(operation),
    inputSchema: schema ? inputSchema : compactInputContract(inputSchema),
  };
}

/**
 * Preserves each accepted flat input alternative and its required fields.
 * Nested product values use field summaries instead of expanding their contents.
 *
 * @param {Record<string, unknown>} schema Shared input schema or root alternative.
 * @returns {Record<string, unknown>} Shallow input contract.
 */
function compactInputContract(schema) {
  const contract = compactValueContract(schema);
  if (schema.properties) {
    contract.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => [
        name,
        compactValueContract(property),
      ])
    );
  }
  if (schema.required) contract.required = schema.required;
  if (Object.hasOwn(schema, 'additionalProperties')) {
    contract.additionalProperties = schema.additionalProperties;
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) {
      contract[key] = schema[key].map(compactInputContract);
    }
  }
  return contract;
}

/**
 * Keeps value kinds and scalar constraints without expanding nested product structures.
 * This is discovery guidance; the complete shared schema remains the validation authority.
 *
 * @param {Record<string, unknown>} schema Shared JSON schema node.
 * @returns {Record<string, unknown>} Compact field guidance.
 */
function compactValueContract(schema) {
  const contract = {};
  for (const key of [
    'type',
    'enum',
    'const',
    'description',
    'format',
    'pattern',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'uniqueItems',
    'minProperties',
    'maxProperties',
  ]) {
    if (Object.hasOwn(schema, key)) contract[key] = schema[key];
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) {
      contract[key] = schema[key].map(compactValueContract);
    }
  }
  return contract;
}

/**
 * Removes executable implementation fields from one catalog entry.
 *
 * @param {Record<string, unknown>} operation Catalog entry.
 * @returns {Record<string, unknown>} Public operation metadata.
 */
function publicMetadata(operation) {
  const {
    handler: _handler,
    inputSchema: _inputSchema,
    outputSchema: _outputSchema,
    ...metadata
  } = operation;
  return metadata;
}
