import { Buffer } from 'node:buffer';

/** Complete serialized request, native continuity, and existing model capacity. */
export interface ModelRequestAdmissionInput {
  readonly payload: unknown;
  readonly continuity?: string | undefined;
  readonly contextWindowTokens: number | undefined;
  readonly outputReserveTokens: number | undefined;
}

/** Fixed local refusal retained through stock error normalization by the calling owner. */
export class ModelRequestAdmissionError extends Error {
  /** Creates a refusal in the existing internal Agent context vocabulary. */
  public constructor(
    public readonly code: 'internal_agent_context_unavailable' | 'internal_agent_context_exceeded',
    message: string
  ) {
    super(message);
    this.name = 'ModelRequestAdmissionError';
  }
}

/** Estimates text and explicitly admitted inline image occurrences locally; neither allowance proves Provider token cost. */
export function admitModelRequest(input: ModelRequestAdmissionInput): void {
  const { contextWindowTokens, outputReserveTokens } = input;
  if (
    contextWindowTokens === undefined ||
    !Number.isSafeInteger(contextWindowTokens) ||
    contextWindowTokens <= 0 ||
    (outputReserveTokens !== undefined &&
      (!Number.isSafeInteger(outputReserveTokens) || outputReserveTokens <= 0))
  ) {
    throw new ModelRequestAdmissionError(
      'internal_agent_context_unavailable',
      'The selected model has no usable physical context bounds.'
    );
  }
  const projection = imageCountingProjection(input.payload);
  const bytes =
    Buffer.byteLength(JSON.stringify(projection.payload), 'utf8') +
    Buffer.byteLength(input.continuity ?? '', 'utf8');
  const estimatedInputTokens = Math.ceil(bytes / 3) + 4_096 + projection.images * 8_192;
  if (estimatedInputTokens + (outputReserveTokens ?? 0) > contextWindowTokens) {
    throw new ModelRequestAdmissionError(
      'internal_agent_context_exceeded',
      'The complete request estimate exceeds the selected model context capacity. Reduce input or retrieve a smaller excerpt.'
    );
  }
}

/** Replaces only transport-admitted Native Responses image values in a private counting projection; text, schemas and actual request bytes remain intact. */
function imageCountingProjection(payload: unknown): { payload: unknown; images: number } {
  const root = record(payload);
  if (!root || !Array.isArray(root.input)) return { payload, images: 0 };
  let images = 0;
  const content = (value: unknown) => {
    if (!Array.isArray(value)) return value;
    return value.map((part: unknown) => {
      const image = record(part);
      if (
        !image ||
        image.type !== 'input_image' ||
        Object.keys(image).some((key) => !['type', 'image_url', 'detail'].includes(key)) ||
        (image.detail !== undefined && !['auto', 'low', 'high'].includes(image.detail as string))
      )
        return part;
      const inline =
        typeof image.image_url === 'string'
          ? /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.image_url)
          : null;
      if (!inline || inline[1]!.length % 4 !== 0) return part;
      images++;
      return { ...image, image_url: '' };
    });
  };
  const input = root.input.map((value: unknown) => {
    const item = record(value);
    if (item?.role === 'user' && (item.type === undefined || item.type === 'message'))
      return { ...item, content: content(item.content) };
    if (item?.type === 'function_call_output') return { ...item, output: content(item.output) };
    return value;
  });
  return { payload: { ...root, input }, images };
}

/** Reads only JSON object positions; arrays and arbitrary string data are not image envelopes. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
