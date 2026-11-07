import { describe, expect, it } from 'vitest';
import { sanitizeTitle, titleSource } from './title-generation.js';

describe('title sanitizer', () => {
  it('strips a think block, a leading Title, markdown, quotes, and trailing punctuation', () => {
    expect(sanitizeTitle('<think>hidden</think>Title: **"#Fix the leak."**')).toBe('Fix the leak');
  });

  it('strips one leading Title only', () => {
    expect(sanitizeTitle('Title: Title: Keep the second label')).toBe(
      'Title: Keep the second label'
    );
  });

  it('keeps an underscore inside a source token', () => {
    expect(sanitizeTitle('SQLITE_BUSY')).toBe('SQLITE_BUSY');
  });

  it('rejects empty text and more than 80 code points', () => {
    expect(sanitizeTitle('<think>only</think>   ')).toBeNull();
    expect(sanitizeTitle('a'.repeat(81))).toBeNull();
    expect(sanitizeTitle('a'.repeat(80))).toBe('a'.repeat(80));
  });

  it('caps the product input at 500 code points', () => {
    expect([...titleSource('字'.repeat(627))]).toHaveLength(500);
  });
});
