import { WorkspaceFreezeRefusalSchema } from '@openkit/app-api-schemas';
import { MetaResponseSchema, PROTOCOL_VERSION } from '@openkit/protocol';
import { z } from 'zod';
import { ApiCallError, ProtocolValidationError } from './errors.js';
import { type FetchLike, parseJsonResponse } from './http.js';

/** Cancellation belongs to the original caller, outside the serialized operation input. */
export interface ClientRequestOptions {
  readonly signal?: AbortSignal;
}

/** Shared HTTP transport used by every sub-client. */
export interface ClientTransport {
  /** Normalized base URL without a trailing slash. */
  readonly baseUrl: string;
  /** Fetch implementation shared by HTTP and SSE helpers. */
  readonly fetch: FetchLike;
  /** Static headers applied to every HTTP request. */
  readonly headers?: HeadersInit | undefined;
  /** Fetches and validates a JSON response. */
  getJson<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    options?: ClientRequestOptions
  ): Promise<z.infer<TSchema>>;
  /** Reads one exact-media body; a supplied logical selector uses JSON POST. */
  getStream(
    path: string,
    mediaType: string,
    input?: unknown,
    options?: ClientRequestOptions
  ): Promise<ReadableStream<Uint8Array>>;
  /** Posts a JSON body and validates JSON or declared empty-success logical null. */
  postJson<TInput, TSchema extends z.ZodType>(
    path: string,
    input: TInput,
    schema: TSchema,
    extraHeaders?: HeadersInit,
    emptySuccess?: boolean,
    options?: ClientRequestOptions
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
    extraHeaders?: HeadersInit,
    options?: ClientRequestOptions
  ): Promise<z.infer<TSchema>>;
  /** Patches a JSON body and validates a JSON response. */
  patchJson<TInput, TSchema extends z.ZodType>(
    path: string,
    input: TInput,
    schema: TSchema,
    extraHeaders?: HeadersInit,
    options?: ClientRequestOptions
  ): Promise<z.infer<TSchema>>;
  /** Deletes a resource with an empty successful response. */
  deleteEmpty(path: string): Promise<void>;
  /** Deletes a resource with a JSON command body. */
  deleteJson<TInput>(path: string, input: TInput, options?: ClientRequestOptions): Promise<void>;
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
  /** Optional lifetime cancellation for this client instance. */
  signal?: AbortSignal;
}

/** Waits only behind a definite admission refusal; cancellation never authorizes a resend. */
async function waitForCaptureRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
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

  let authentication = new AbortController();

  /** Replays only complete JSON requests that the authorized server gate definitely refused. */
  const fetchJsonRequest = async (
    path: string,
    init: RequestInit,
    requestOptions?: ClientRequestOptions
  ): Promise<Response> => {
    const signal = AbortSignal.any([
      authentication.signal,
      ...[options.signal, requestOptions?.signal].filter(
        (value): value is AbortSignal => value !== undefined
      ),
    ]);
    const headers = new Headers(init.headers);
    const deadline = performance.now() + 20_000;
    let retried = false;
    for (;;) {
      signal.throwIfAborted();
      const remaining = deadline - performance.now();
      // A timeout after resend is an unknown response, not the prior definite refusal.
      const attemptSignal = retried
        ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(remaining)))])
        : signal;
      const response = await fetcher(url(path), {
        ...init,
        headers: new Headers(headers),
        signal: attemptSignal,
      });
      const context = response.headers.get('x-openkit-retry-context');
      if (
        response.status !== 409 ||
        response.headers.get('Retry-After') !== '1' ||
        !context ||
        !/^[a-f0-9]{64}$/.test(context) ||
        (headers.has('x-openkit-retry-context') &&
          headers.get('x-openkit-retry-context') !== context)
      )
        return response;
      let refusal: unknown;
      try {
        await parseJsonResponse(response.clone(), z.never());
      } catch (error) {
        refusal = error;
      }
      if (!(refusal instanceof ApiCallError) || refusal.code !== 'workspace_frozen')
        return response;
      const parsed = WorkspaceFreezeRefusalSchema.safeParse(refusal.details);
      if (!parsed.success || !parsed.data.retryable || parsed.data.operation !== 'capture')
        return response;
      signal.throwIfAborted();
      const wait = Math.min(1_000, deadline - performance.now());
      if (wait <= 0) return response;
      await waitForCaptureRetry(wait, signal);
      if (performance.now() >= deadline) return response;
      headers.set('x-openkit-retry-context', context);
      await response.body?.cancel();
      retried = true;
    }
  };

  const getJson: ClientTransport['getJson'] = async (path, schema, requestOptions) => {
    const response = await fetchJsonRequest(
      path,
      {
        credentials: 'include',
        headers: mergeHeaders(),
        method: 'GET',
      },
      requestOptions
    );
    return parseJsonResponse(response, schema);
  };

  let contractAdmitted = false;

  /** Admits this release-coupled consumer before its first effectful request. */
  const admitContract = async (requestOptions?: ClientRequestOptions): Promise<void> => {
    if (contractAdmitted) return;
    const meta = await getJson('/api/meta', MetaResponseSchema, requestOptions);
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

  const getStream: ClientTransport['getStream'] = async (
    path,
    mediaType,
    input,
    requestOptions
  ) => {
    if (input !== undefined) await admitContract(requestOptions);
    const response =
      input === undefined
        ? await getDownload(path)
        : await fetchJsonRequest(
            path,
            {
              credentials: 'include',
              method: 'POST',
              headers: jsonHeaders(),
              body: JSON.stringify(input),
            },
            requestOptions
          );
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
    emptySuccess = false,
    requestOptions?: ClientRequestOptions
  ): Promise<z.infer<TSchema>> => {
    if (
      ['/api/auth/sign-in/email', '/api/auth/sign-up/email', '/api/auth/sign-out'].includes(path)
    ) {
      authentication.abort(
        new DOMException('Authentication changed during the request.', 'AbortError')
      );
      authentication = new AbortController();
    }
    await admitContract(requestOptions);
    const response = await fetchJsonRequest(
      path,
      {
        credentials: 'include',
        method,
        headers: jsonHeaders(extraHeaders),
        body: JSON.stringify(input),
      },
      requestOptions
    );

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

  const deleteJson: ClientTransport['deleteJson'] = async (path, input, requestOptions) => {
    await admitContract(requestOptions);
    const response = await fetchJsonRequest(
      path,
      {
        credentials: 'include',
        method: 'DELETE',
        headers: mergeHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(input),
      },
      requestOptions
    );

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
    patchJson: (path, input, schema, headers, requestOptions) =>
      sendJson('PATCH', path, input, schema, headers, false, requestOptions),
    postJson: (path, input, schema, headers, emptySuccess, requestOptions) =>
      sendJson('POST', path, input, schema, headers, emptySuccess, requestOptions),
    getDownload,
    postStream,
    putJson: (path, input, schema, headers, requestOptions) =>
      sendJson('PUT', path, input, schema, headers, false, requestOptions),
    url,
  };
}
