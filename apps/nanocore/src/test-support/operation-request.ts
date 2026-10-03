import { OPERATION_DEFINITIONS, type OperationId } from '@openkit/app-api-schemas';

/** Projects explicit operation test selectors and supplied request bytes without authority, data or request defaults. */
export function operationRequest(
  id: OperationId,
  selectors: Record<string, unknown>,
  options: RequestInit = {}
): [string, RequestInit] {
  const definition = OPERATION_DEFINITIONS[id];
  const headers = new Headers(options.headers);
  let body: unknown = {};
  if (typeof options.body === 'string') {
    try {
      body = JSON.parse(options.body);
    } catch {
      return [`/api/app/operations/${id}`, { ...options, method: 'POST' }];
    }
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { requestId, ...input } = body as Record<string, unknown>;
    if (
      'requestId' in definition.inputSchema.shape &&
      requestId !== undefined &&
      !headers.has('x-openkit-request-id')
    )
      headers.set('x-openkit-request-id', String(requestId));
    body = {
      ...('requestId' in definition.inputSchema.shape &&
      (!headers.has('x-openkit-request-id') ||
        headers.get('x-openkit-request-id') === String(requestId))
        ? input
        : (body as Record<string, unknown>)),
      ...selectors,
    };
  }
  headers.set('content-type', 'application/json');
  return [
    `/api/app/operations/${id}`,
    { ...options, method: 'POST', headers, body: JSON.stringify(body) },
  ];
}
