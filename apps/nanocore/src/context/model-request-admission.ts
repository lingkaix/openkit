import { Buffer } from 'node:buffer';

/** Complete final request and the selected physical model's capacity and output reserve. */
export interface ModelRequestAdmissionInput {
  readonly payload: unknown;
  readonly continuity?: string | undefined;
  readonly contextWindowTokens: number | undefined;
  readonly outputReserveTokens: number | undefined;
}

/** Fixed local refusal that the internal Agent Gateway maps to its existing loop outcome. */
export class ModelRequestAdmissionError extends Error {
  constructor(
    readonly code: 'internal_agent_context_unavailable' | 'internal_agent_context_exceeded',
    message: string
  ) {
    super(message);
    this.name = 'ModelRequestAdmissionError';
  }
}

/** Applies the accepted local estimate before inference; this is not exact token counting or a proved upper bound. */
export function admitModelRequest(input: ModelRequestAdmissionInput): void {
  const { contextWindowTokens, outputReserveTokens } = input;
  if (
    contextWindowTokens === undefined ||
    !Number.isSafeInteger(contextWindowTokens) ||
    contextWindowTokens <= 0 ||
    outputReserveTokens === undefined ||
    !Number.isSafeInteger(outputReserveTokens) ||
    outputReserveTokens < 0
  ) {
    throw new ModelRequestAdmissionError(
      'internal_agent_context_unavailable',
      'The selected model has no usable physical context bounds or output reserve.'
    );
  }
  const requestBytes = Buffer.byteLength(JSON.stringify(input.payload), 'utf8');
  const continuityBytes = Buffer.byteLength(input.continuity ?? '', 'utf8');
  const estimatedInputTokens = Math.ceil((requestBytes + continuityBytes) / 3) + 4096;
  if (estimatedInputTokens > contextWindowTokens - outputReserveTokens) {
    throw new ModelRequestAdmissionError(
      'internal_agent_context_exceeded',
      'The complete request estimate exceeds the selected model context capacity. Reduce input or retrieve a smaller excerpt.'
    );
  }
}
