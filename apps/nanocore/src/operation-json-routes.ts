import {
  COMPOSER_TRANSCRIBE_MAX_BODY_BYTES,
  type JsonOperationId,
  OPERATION_DEFINITIONS,
  type OperationDefinition,
  operationUsesBootstrapSecret,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { asOperationError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { submitConversationFiles } from './conversation-file-routes.js';
import type { FsStore } from './lib/store.js';
import { decodeTranscriptionAudio } from './llm/audio-transcription.js';
import { registerAppApiRoute } from './openapi.js';
import {
  createOperationInvocation,
  type OperationInvocationDependencies,
} from './operation-composition.js';
import type { OperationInvocationContext } from './operation-contract.js';
import { OperationError, projectOperationError } from './operation-error.js';
import { parseOperationInput } from './operation-resolvers.js';

/** Operation framing selects JSON or conversation file bodies; native invocation owns complete parsing and admission. */
export function registerOperationJsonRoutes(
  dependencies: OperationInvocationDependencies & {
    app: Hono<{ Variables: AuthVariables }>;
    requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  }
): void {
  const { app, requestStore } = dependencies;
  for (const [id, declared] of Object.entries(OPERATION_DEFINITIONS)) {
    const definition: OperationDefinition = declared;
    if (definition.binding !== 'json') continue;
    registerAppApiRoute(app, id as JsonOperationId, async (c) => {
      // Initialize response headers so returned Responses and the HTTP error handler inherit the same cache policy.
      c.res.headers.set('Cache-Control', 'no-store');
      try {
        if (operationUsesBootstrapSecret(definition) && c.get('bootstrapSecretAdmission') !== true)
          throw new OperationError('core.auth.unauthenticated', 'Authentication required.', 401);
        if (
          definition.binaryRequestBody &&
          c.req.header('content-type') === definition.binaryRequestBody.mediaType
        ) {
          if (!dependencies.conversationService || !dependencies.fileAdmission)
            throw new OperationError(
              'operation_storage_unavailable',
              'File storage is unavailable.',
              503
            );
          return await submitConversationFiles(c, {
            ...dependencies,
            conversationService: dependencies.conversationService,
            fileAdmission: dependencies.fileAdmission,
            dataRoot: dependencies.dataRoot ?? null,
          });
        }
        const body = await readOperationBody(c, id);
        if (typeof body !== 'object' || body === null || Array.isArray(body))
          throw new OperationError(
            definition.invalidInputCode ?? 'invalid_request',
            'Invalid operation input.',
            400
          );
        const args = body as Record<string, unknown>;
        const requestId = c.req.header('x-openkit-request-id');
        if (definition.mutating && Object.hasOwn(args, 'requestId') && args.requestId !== requestId)
          throw new OperationError(
            'bound_input_conflict',
            'Request identity conflicts with its header.',
            403
          );
        const input =
          definition.mutating && 'requestId' in definition.inputSchema.shape
            ? { ...args, requestId }
            : args;
        // HTTP must refuse malformed input before selecting a request store; native entries independently use the same validator.
        const entry: OperationInvocationContext = operationUsesBootstrapSecret(definition)
          ? { kind: 'bootstrap', delivery: 'human', signal: c.req.raw.signal }
          : { kind: 'public', actor: c.get('actor'), delivery: 'human', signal: c.req.raw.signal };
        parseOperationInput(definition, input, entry);
        if (id === 'composer.transcribe' && typeof args.audio === 'string')
          decodeTranscriptionAudio(args.audio);
        let successStatus: 200 | 201 | 202 | 204 = definition.successStatus;
        const invoke = createOperationInvocation({
          ...dependencies,
          ...(entry.kind === 'bootstrap' ? {} : { store: requestStore(c) }),
        });
        const output = await invoke(id as JsonOperationId, input, {
          ...entry,
          observeSuccessStatus: (status) => {
            successStatus = status;
          },
        });
        return successStatus === 204 ? c.body(null, 204) : c.json(output, successStatus);
      } catch (error) {
        return asOperationError(error, projectOperationError(error));
      }
    });
  }
}

/** Reads JSON, counting composer.transcribe bytes before parse, including bodies without Content-Length. */
async function readOperationBody(
  c: Context<{ Variables: AuthVariables }>,
  id: string
): Promise<unknown> {
  if (id !== 'composer.transcribe') {
    return c.req.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    });
  }
  const declared = c.req.header('content-length');
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared)) {
      throw new OperationError('invalid_request', 'Invalid operation input.', 400);
    }
    if (Number(declared) > COMPOSER_TRANSCRIBE_MAX_BODY_BYTES) {
      throw new OperationError(
        'payload_too_large',
        'Transcription audio exceeds the size limit.',
        413
      );
    }
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > COMPOSER_TRANSCRIBE_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OperationError(
        'payload_too_large',
        'Transcription audio exceeds the size limit.',
        413
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
