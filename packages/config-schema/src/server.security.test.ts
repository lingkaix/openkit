import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { OpenKitConfigSchema } from './server.js';

const kinds = ['osv-api', 'osv-records', 'kev', 'rss'];
const feed = (extra: Record<string, unknown> = {}) => ({
  id: 'fixture-feed',
  name: 'Fixture advisory source',
  kind: 'osv-records',
  location: 'https://feed.example.invalid/records',
  ...extra,
});
const config = (feeds: unknown[]) => ({ schemaVersion: 1, security: { feeds } });

// Runtime Security E3; structural admission is not administrator authorization.
describe('E3 authored Server feed configuration', () => {
  it('keeps schema version one and never inserts feeds or monitor enablement', () => {
    assert.deepEqual(OpenKitConfigSchema.parse({ schemaVersion: 1 }), { schemaVersion: 1 });
    assert.deepEqual(OpenKitConfigSchema.parse({ schemaVersion: 1, security: {} }), {
      schemaVersion: 1,
      security: {},
    });
    assert.deepEqual(OpenKitConfigSchema.parse(config([])), config([]));
  });

  it.each(kinds)('preserves a named HTTPS source for the closed %s kind', (kind) => {
    const authored = config([feed({ kind })]);
    assert.deepEqual(OpenKitConfigSchema.parse(authored), authored);
  });

  it('accepts an operator-selected local OSV records path, not an implicit remote default', () => {
    const authored = config([feed({ location: './fixtures/advisories.json' })]);
    assert.deepEqual(OpenKitConfigSchema.parse(authored), authored);
  });

  it('admits multiple distinct feed IDs without rewriting display names or locations', () => {
    const authored = config(
      kinds.map((kind, index) => feed({ id: `fixture-${index}`, name: `Fixture ${index}`, kind }))
    );
    assert.deepEqual(OpenKitConfigSchema.parse(authored), authored);
  });

  it.each(['osv', 'atom', 'shell', 'OSV-API'])('refuses unknown core kind %s', (kind) => {
    assert.equal(OpenKitConfigSchema.safeParse(config([feed({ kind })])).success, false);
  });

  it.each(['osv-api', 'kev', 'rss'])(
    'refuses local paths for %s before any feed contact',
    (kind) => {
      assert.equal(
        OpenKitConfigSchema.safeParse(config([feed({ kind, location: './fixtures/records.json' })]))
          .success,
        false
      );
    }
  );

  it.each([
    'http://feed.example.invalid/records',
    'ftp://feed.example.invalid/records',
    'file:///fixture/records.json',
    'data:application/json,{}',
  ])('does not reinterpret an unsupported URL as a local path: %s', (location) => {
    for (const kind of kinds)
      assert.equal(
        OpenKitConfigSchema.safeParse(config([feed({ kind, location })])).success,
        false
      );
  });

  it.each(['id', 'name', 'kind', 'location'])('refuses a missing core feed field: %s', (field) => {
    const source: Record<string, unknown> = feed();
    delete source[field];
    assert.equal(OpenKitConfigSchema.safeParse(config([source])).success, false);
  });

  it.each(['id', 'name', 'location'])('refuses blank %s fields', (field) => {
    for (const value of ['', '   '])
      assert.equal(
        OpenKitConfigSchema.safeParse(config([feed({ [field]: value })])).success,
        false
      );
  });

  it('refuses duplicate IDs even when kind, display name and location differ', () => {
    assert.equal(
      OpenKitConfigSchema.safeParse(
        config([
          feed(),
          feed({
            name: 'A different source',
            kind: 'rss',
            location: 'https://other.example.invalid/rss',
          }),
        ])
      ).success,
      false
    );
  });
});
