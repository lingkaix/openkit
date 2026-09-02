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
  /** Fetches one successful response body with an exact media type. */
  getStream(path: string, mediaType: string): Promise<ReadableStream<Uint8Array>>;
  /** Posts a JSON body and validates a JSON response. */
  postJson<TInput, TSchema extends z.ZodType>(
    path: string,
    input: TInput,
    schema: TSchema
  ): Promise<z.infer<TSchema>>;
  /** Posts one raw body and validates a JSON response. */
  postStream<TSchema extends z.ZodType>(
    path: string,
    body: BodyInit,
    headers: HeadersInit,
    schema: TSchema
  ): Promise<z.infer<TSchema>>;
  /** Puts a JSON body and validates a JSON response. */
  putJson<TInput, TSchema extends z.ZodType>(
    path: string,
    input: TInput,
    schema: TSchema
  ): Promise<z.infer<TSchema>>;
  /** Patches a JSON body and validates a JSON response. */
  patchJson<TInput, TSchema extends z.ZodType>(
    path: string,
    input: TInput,
    schema: TSchema
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

  const url = (path: string): string => `${normalizedBaseUrl}${path}`;

  const getJson: ClientTransport['getJson'] = async (path, schema) => {
    const response = await fetcher(url(path), {
      credentials: 'include',
      headers: mergeHeaders(),
      method: 'GET',
    });
    return parseJsonResponse(response, schema);
  };

  const getStream: ClientTransport['getStream'] = async (path, mediaType) => {
    const response = await fetcher(url(path), {
      credentials: 'include',
      headers: mergeHeaders(),
      method: 'GET',
    });
    if (!response.ok) {
      await parseJsonResponse(response, z.never());
      throw new Error('Unreachable response state.');
    }
    if (response.headers.get('content-type') !== mediaType || !response.body) {
      throw new ProtocolValidationError({
        path: [],
        code: 'invalid_payload',
        message: 'Response stream media type is incompatible.',
      });
    }
    return response.body;
  };

  const postJson: ClientTransport['postJson'] = async (path, input, schema) => {
    const response = await fetcher(url(path), {
      credentials: 'include',
      method: 'POST',
      headers: mergeHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    });

    return parseJsonResponse(response, schema);
  };

  const postStream: ClientTransport['postStream'] = async (path, body, headers, schema) => {
    const response = await fetcher(url(path), {
      body,
      credentials: 'include',
      duplex: 'half',
      headers: mergeHeaders(headers),
      method: 'POST',
    } as RequestInit & { duplex: 'half' });
    return parseJsonResponse(response, schema);
  };

  const putJson: ClientTransport['putJson'] = async (path, input, schema) => {
    const response = await fetcher(url(path), {
      credentials: 'include',
      method: 'PUT',
      headers: mergeHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    });

    return parseJsonResponse(response, schema);
  };

  const patchJson: ClientTransport['patchJson'] = async (path, input, schema) => {
    const response = await fetcher(url(path), {
      credentials: 'include',
      method: 'PATCH',
      headers: mergeHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    });

    return parseJsonResponse(response, schema);
  };

  const deleteEmpty: ClientTransport['deleteEmpty'] = async (path) => {
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
    patchJson,
    postJson,
    postStream,
    putJson,
    url,
  };
}
