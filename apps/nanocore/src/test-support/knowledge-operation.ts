import { PRODUCT_OPERATION_DEFINITIONS, type ProductOperationId } from '@openkit/app-api-schemas';

/** Projects explicit Knowledge test selectors and supplied request bytes onto the definition route without supplying authority or request defaults. */
export function knowledgeOperationRequest(
  id: ProductOperationId,
  selectors: Record<string, unknown>,
  options: RequestInit = {}
): [string, RequestInit] {
  const definition = PRODUCT_OPERATION_DEFINITIONS[id];
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
    body = { ...input, ...selectors };
  }
  headers.set('content-type', 'application/json');
  return [
    `/api/app/operations/${id}`,
    { ...options, method: 'POST', headers, body: JSON.stringify(body) },
  ];
}
