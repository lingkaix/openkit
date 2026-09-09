import { describe, expect, it } from 'vitest';

import { filterConstrainsRecordId } from './filter.js';

describe('filterConstrainsRecordId', () => {
  const recordId = '11111111-1111-4111-8111-111111111111';

  it('accepts a top-level AND that includes exact id equality', () => {
    expect(filterConstrainsRecordId(`id = "${recordId}" && active = true`, recordId)).toBe(true);
  });

  it('rejects OR, grouping, and string-split lookalikes', () => {
    expect(filterConstrainsRecordId(`id = "${recordId}" || active = true`, recordId)).toBe(false);
    expect(filterConstrainsRecordId(`(id = "${recordId}") && active = true`, recordId)).toBe(false);
    expect(filterConstrainsRecordId(`note = "hello" && active = true`, recordId)).toBe(false);
  });
});
