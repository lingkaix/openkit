import { MetaResponseSchema, PROTOCOL_VERSION } from '@openkit/protocol';
import { z } from 'zod';
import { ProtocolValidationError } from './errors.js';
import { type FetchLike, parseJsonResponse } from './http.js';

/** Shared HTTP transport used by every sub-client. */
export interface ClientTransport {
  /** Normalized base URL without a trailing slash. */
  readonly baseUrl: string;
  /** Fetch implementation shared by HTTP and SSE helpers. */
  readonly fetch: FetchLike;
  /** Static headers applied to every HTTP request. */
  readonly headers?: HeadersInit | undefined;
  /** Fetches and validates a JSON response. */
  getJson<TSchema extends z.ZodType>(path: string, schema: TSchema): Promise<z.infer<TSchema>>;
  /** Reads one exact-media body; a supplied logical selector uses JSON POST. */
  getStream(path: string, mediaType: string, input?: unknown): Promise<ReadableStream<Uint8Array>>;
  /** Posts a JSON body and validates JSON or declared empty-success logical null. */
  postJson<TInput, TSchema extends z.ZodType>(
    path: string,
    input: TInput,
    schema: TSchema,
    extraHeaders?: HeadersInit,
    emptySuccess?: boolean
  ): Promise<z.infer<TSchema>>;
  /** Posts one raw body and validates a JSON response. */
  postStream<TSchema extends z.ZodType>(
    path: string,
    body: BodyInit,
    headers: HeadersInit,
    schema: TSchema
  ): Promise<z.infer<TSchema>>;
  /** Fetches a successful download response without consuming its body or metadata. */
  getDownload(path: string): Promise<Response>;
  /** Puts a JSON body and validates a JSON response. */
  putJson<TInput, TSchema extends z.ZodType>(
    path: string,
    input: TInput,
    schema: TSchema,
    extraHeaders?: HeadersInit
  ): Promise<z.infer<TSchema>>;
  /** Patches a JSON body and validates a JSON response. */
  patchJson<TInput, TSchema extends z.ZodType>(
    path: string,
    input: TInput,
    schema: TSchema,
    extraHeaders?: HeadersInit
  ): Promise<z.infer<TSchema>>;
  /** Deletes a resource with an empty successful response. */
  deleteEmpty(path: string): Promise<void>;
  /** Deletes a resource with a JSON command body. */
  deleteJson<TInput>(path: string, input: TInput): Promise<void>;
  /** Converts an API path into an absolute request URL. */
  url(path: string): string;
}

/** Options for creating the shared HTTP transport. */
export interface ClientTransportOptions {
  /** Base URL for NanoCore. */
  baseUrl: string;
  /** Optional fetch implementation for tests and non-browser hosts. */
  fetch?: FetchLike;
  /** Optional static headers for authenticated deployments. */
  headers?: HeadersInit;
}

/** Creates the shared HTTP transport used by sub-clients. */
export function createClientTransport(options: ClientTransportOptions): ClientTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  const normalizedBaseUrl = options.baseUrl.replace(/\/$/, '');

  if (fetcher === undefined) {
    throw new Error('fetch is required to create the core client');
  }

  const mergeHeaders = (headers?: HeadersInit): Headers => {
    const merged = new Headers(options.headers);

    new Headers(headers).forEach((value, key) => {
      merged.set(key, value);
    });

    return merged;
  };

  const jsonHeaders = (extraHeaders?: HeadersInit): Headers => {
    const merged = mergeHeaders({ 'content-type': 'application/json' });
    if (extraHeaders) {
      new Headers(extraHeaders).forEach((value, key) => {
        merged.set(key, value);
      });
    }
    return merged;
  };

  const url = (path: string): string => `${normalizedBaseUrl}${path}`;

  const getJson: ClientTransport['getJson'] = async (path, schema) => {
    const response = await fetcher(url(path), {
      credentials: 'include',
      headers: mergeHeaders(),
      method: 'GET',
    });
    return parseJsonResponse(response, schema);
  };

  let contractAdmitted = false;

  /** Admits this release-coupled consumer before its first effectful request. */
  const admitContract = async (): Promise<void> => {
    if (contractAdmitted) return;
    const meta = await getJson('/api/meta', MetaResponseSchema);
    if (meta.protocolVersion !== PROTOCOL_VERSION) {
      throw new ProtocolValidationError({
        path: ['protocolVersion'],
        code: 'incompatible_protocol',
        message: 'NanoCore protocol identity is incompatible with this client.',
      });
    }
    contractAdmitted = true;
  };

  const getDownload: ClientTransport['getDownload'] = async (path) => {
    const response = await fetcher(url(path), {
      credentials: 'include',
      headers: mergeHeaders(),
      method: 'GET',
    });
    if (!response.ok) {
      await parseJsonResponse(response, z.never());
      throw new Error('Unreachable response state.');
    }
    return response;
  };

  const getStream: ClientTransport['getStream'] = async (path, mediaType, input) => {
    if (input !== undefined) await admitContract();
    const response =
      input === undefined
        ? await getDownload(path)
        : await fetcher(url(path), {
            credentials: 'include',
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify(input),
          });
    if (!response.ok) {
      await parseJsonResponse(response, z.never());
      throw new Error('Unreachable response state.');
    }
    if (response.headers.get('content-type') !== mediaType || !response.body) {
      try {
        await response.body?.cancel();
      } catch {
        // Body disposal cannot replace the original protocol refusal.
      }
      throw new ProtocolValidationError({
        path: [],
        code: 'invalid_payload',
        message: 'Response stream media type is incompatible.',
      });
    }
    return response.body;
  };

  /** Applies the shared wire policy for JSON mutations; each public method keeps its HTTP verb. */
  const sendJson = async <TSchema extends z.ZodType>(
    method: 'POST' | 'PUT' | 'PATCH',
    path: string,
    input: unknown,
    schema: TSchema,
    extraHeaders?: HeadersInit,
    emptySuccess = false
  ): Promise<z.infer<TSchema>> => {
    await admitContract();
    const response = await fetcher(url(path), {
      credentials: 'include',
      method,
      headers: jsonHeaders(extraHeaders),
      body: JSON.stringify(input),
    });

    if (emptySuccess && response.ok) {
      if (response.status !== 204 || (await response.arrayBuffer()).byteLength !== 0) {
        throw new ProtocolValidationError({
          path: [],
          code: 'invalid_payload',
          message: 'Declared empty success requires HTTP 204 with no response bytes.',
        });
      }
      return schema.parse(null);
    }
    return parseJsonResponse(response, schema);
  };

  const postStream: ClientTransport['postStream'] = async (path, body, headers, schema) => {
    await admitContract();
    const response = await fetcher(url(path), {
      body,
      credentials: 'include',
      duplex: 'half',
      headers: mergeHeaders(headers),
      method: 'POST',
    } as RequestInit & { duplex: 'half' });
    return parseJsonResponse(response, schema);
  };

  const deleteEmpty: ClientTransport['deleteEmpty'] = async (path) => {
    await admitContract();
    const response = await fetcher(url(path), {
      credentials: 'include',
      headers: mergeHeaders(),
      method: 'DELETE',
    });

    if (response.ok) {
      return;
    }

    await parseJsonResponse(response, z.null());
  };

  const deleteJson: ClientTransport['deleteJson'] = async (path, input) => {
    await admitContract();
    const response = await fetcher(url(path), {
      credentials: 'include',
      method: 'DELETE',
      headers: mergeHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    });

    if (response.ok) {
      return;
    }

    await parseJsonResponse(response, z.null());
  };

  return {
    baseUrl: normalizedBaseUrl,
    deleteEmpty,
    deleteJson,
    fetch: fetcher,
    getJson,
    getStream,
    headers: options.headers,
    patchJson: (path, input, schema, headers) => sendJson('PATCH', path, input, schema, headers),
    postJson: (path, input, schema, headers, emptySuccess) =>
      sendJson('POST', path, input, schema, headers, emptySuccess),
    getDownload,
    postStream,
    putJson: (path, input, schema, headers) => sendJson('PUT', path, input, schema, headers),
    url,
  };
}
