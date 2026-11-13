// NEW-only supplement: known credential forms are not ordinary prose or source templates.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const { findCredentialForms } = await import(
  pathToFileURL(join(root, 'scripts/credential-patterns.mjs')).href
);
const releaseSafety = await import(pathToFileURL(join(root, 'scripts/release-safety.mjs')).href);
const prefix = 'okt_';
const genuine = prefix + 'Q'.repeat(40);
const markedFake = prefix + 'FAKE_' + 'Q'.repeat(40);

// Assertions expose counts and booleans only, never matched values.
test('ordinary Bearer prose is not a known credential form', () => {
  for (const text of [
    'Bearer configuration is described in this guide.',
    'Bearer authentication requires a token from the operator.',
  ]) {
    assert.equal(
      findCredentialForms(text).length,
      0,
      'Ordinary prose must not match a credential form'
    );
  }
});

test('Bearer carrying a runtime-built known credential prefix is detected', () => {
  assert.ok(
    findCredentialForms(`Authorization: Bearer ${genuine}`).length > 0,
    'Known-prefix credential must remain detectable'
  );
});

test('Authorization Bearer marked fake remains covered by release literal masking', () => {
  const text = `Authorization: Bearer ${markedFake}`;
  assert.equal(
    findCredentialForms(text).length,
    0,
    'Marked fake must not become a genuine known form'
  );
  const redacted = releaseSafety.redact(text);
  assert.ok(
    redacted.includes('[redacted]'),
    'Authorization literal rule must still mask the value'
  );
  assert.equal(
    redacted.includes(markedFake),
    false,
    'Authorization literal rule must not retain the marked value'
  );
});

test('URL source interpolation is not a literal username and password', () => {
  const template = 'https://$' + '{username}:$' + '{password}@example.invalid/path';
  assert.equal(
    findCredentialForms(template).length,
    0,
    'Source interpolation must not match literal credentials'
  );
});

test('runtime-built literal URL user information remains detectable', () => {
  const username = ['fixture', 'user'].join('-');
  const password = ['synthetic', 'password', 'only'].join('-');
  const literal = `https://${username}:${password}@example.invalid/path`;
  assert.ok(
    findCredentialForms(literal).length > 0,
    'Literal URL credentials must remain detectable'
  );
});
