import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { boundedJsonText, previewUtf8 } from './bounded-read-text.js';

it('preserves a leading source BOM when clipping a UTF-8 head at a partial code point', () => {
  const source = '\uFEFF雪more';
  expect(previewUtf8(Buffer.from(source), 'head', 5)).toBe('\uFEFF');
  expect(previewUtf8(Buffer.from(source), 'head', 6)).toBe('\uFEFF雪');
});

it('preserves a source BOM at the start of a selected UTF-8 tail', () => {
  const source = 'discarded\uFEFFtail';
  expect(previewUtf8(Buffer.from(source), 'tail', 7)).toBe('\uFEFFtail');
  expect(previewUtf8(Buffer.from(source), 'tail', 100)).toBe(source);
});

it('returns an actual JSON-bounded Unicode prefix without stripping a source character', () => {
  const source = '\uFEFF' + '雪🧊\n"'.repeat(500);
  const text = boundedJsonText(source, 1024);
  expect(text.startsWith('\uFEFF')).toBe(true);
  expect(source.startsWith(text)).toBe(true);
  expect(text.length).toBeLessThan(source.length);
  expect(Buffer.byteLength(JSON.stringify(text), 'utf8')).toBeLessThanOrEqual(1024);
});
