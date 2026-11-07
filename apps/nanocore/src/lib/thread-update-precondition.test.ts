import { describe, expect, it } from 'vitest';
import { assertThreadUpdatePrecondition, ThreadUpdatePreconditionError } from './store.js';

describe('thread update precondition', () => {
  it('accepts the same active title and refuses a rename or another status', () => {
    expect(() =>
      assertThreadUpdatePrecondition(
        { status: 'active', name: 'Initial' },
        { status: 'active', name: 'Initial' }
      )
    ).not.toThrow();
    expect(() =>
      assertThreadUpdatePrecondition(
        { status: 'active', name: 'Renamed' },
        { status: 'active', name: 'Initial' }
      )
    ).toThrow(ThreadUpdatePreconditionError);
    expect(() =>
      assertThreadUpdatePrecondition(
        { status: 'archived', name: 'Initial' },
        { status: 'active', name: 'Initial' }
      )
    ).toThrow(ThreadUpdatePreconditionError);
  });

  it('does nothing when the caller does not pass a precondition', () => {
    expect(() =>
      assertThreadUpdatePrecondition({ status: 'archived', name: 'Later' }, undefined)
    ).not.toThrow();
  });
});
