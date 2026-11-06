/** Safe error code for operation adapters; dependency details are never published. */
export class AttentionError extends Error {
  constructor(
    public readonly code:
      | 'invalid_attention_input'
      | 'attention_not_found'
      | 'attention_not_eligible'
      | 'attention_not_sendable'
      | 'attention_channel_conflict'
      | 'attention_recovery_required'
      | 'attention_attempt_conflict'
  ) {
    super(code);
    this.name = 'AttentionError';
  }
}
