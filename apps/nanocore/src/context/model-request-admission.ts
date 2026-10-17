import { Buffer } from 'node:buffer';

/** Complete serialized text request, native continuity, and existing model capacity. */
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

/** Estimates text input locally; this is neither exact token usage nor a proved upper bound. */
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
  const bytes =
    Buffer.byteLength(JSON.stringify(input.payload), 'utf8') +
    Buffer.byteLength(input.continuity ?? '', 'utf8');
  const estimatedInputTokens = Math.ceil(bytes / 3) + 4_096;
  if (estimatedInputTokens + (outputReserveTokens ?? 0) > contextWindowTokens) {
    throw new ModelRequestAdmissionError(
      'internal_agent_context_exceeded',
      'The complete request estimate exceeds the selected model context capacity. Reduce input or retrieve a smaller excerpt.'
    );
  }
}
