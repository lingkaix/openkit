import { describe, expect, it } from 'vitest';
import { captureRetryContext, captureRetryHeaders } from './capture-retry-context.js';

// Vectors were produced by the earlier private sha256(JSON.stringify(tuple)) encoding; clients echo them back.
describe('captureRetryContext', () => {
  it('keeps the published retry binding bytes through the shared digest owner', () => {
    expect(captureRetryContext({ kind: 'session', userId: 'user_1', sessionId: 'sess_1' })).toBe(
      '3019bcd5e47d147b0e509ab448a4ddbe23ce1add742667c2c900a79f3bc18b2d'
    );
    expect(captureRetryContext({ kind: 'token', userId: 'user_2', tokenId: 'tok_2' })).toBe(
      '4f27d0b05aab31bb9702a48a6e33ecbd19e96afef069a4082b26f0568ce15eae'
    );
  });

  it('advertises no binding without a stable credential', () => {
    expect(captureRetryContext(undefined)).toBeUndefined();
    expect(captureRetryContext({ kind: 'session', userId: 'user_1' })).toBeUndefined();
    expect(captureRetryHeaders({ kind: 'local', userId: 'user_1' })).toEqual({
      'Retry-After': '1',
      'x-openkit-retry-context': captureRetryContext({ kind: 'local', userId: 'user_1' }),
    });
  });
});
