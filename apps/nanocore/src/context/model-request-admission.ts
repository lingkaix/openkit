/** Complete final request and the selected physical model's capacity and output reserve. */
export interface ModelRequestAdmissionInput {
  readonly payload: unknown;
  readonly continuity?: string | undefined;
  readonly contextWindowTokens: number | undefined;
  readonly outputReserveTokens: number | undefined;
}

/** Applies the engineer-approved local estimate before inference; this is not exact token counting. */
export function admitModelRequest(_input: ModelRequestAdmissionInput): void {}
