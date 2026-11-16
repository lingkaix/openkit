/** Transport bounds and syntax do not replace the schema-version-1 finding admission gate. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { readSecurityFindingRegister } from '../scripts/security-register.mjs';

const limit = 4 * 1024 * 1024;
const encode = (bytes) => `gzip+base64:${gzipSync(bytes).toString('base64')}`;
const refused = (value) =>
  assert.throws(() => readSecurityFindingRegister(value), {
    message: 'Release finding gate refused',
  });

test('raw JSON and gzip JSON retain the exact same register fields', () => {
  const register = {
    schemaVersion: 1,
    records: [{ decision: { reason: 'synthetic private text with Unicode: café 世界' } }],
  };
  const json = JSON.stringify(register);
  assert.deepEqual(readSecurityFindingRegister(json), register);
  assert.deepEqual(readSecurityFindingRegister(encode(json)), register);
});

test('gzip output admits exactly 4 MiB and refuses one byte above it', () => {
  const json = JSON.stringify('x'.repeat(limit - 2));
  assert.equal(Buffer.byteLength(json), limit);
  assert.equal(readSecurityFindingRegister(encode(json)), 'x'.repeat(limit - 2));
  refused(encode(JSON.stringify('x'.repeat(limit - 1))));
});

test('the decompressed cap covers the combined output of gzip members', () => {
  const compressed = Buffer.concat([
    gzipSync(`"${'x'.repeat(limit / 2)}`),
    gzipSync(`${'x'.repeat(limit / 2)}"`),
  ]);
  refused(`gzip+base64:${compressed.toString('base64')}`);
});

test('raw JSON keeps its existing parse behavior without a new transport cap', () => {
  const value = 'x'.repeat(limit);
  assert.equal(readSecurityFindingRegister(JSON.stringify(value)), value);
});

test('base64 refuses ignored characters, misplaced padding and URL-safe alphabet', () => {
  const payload = gzipSync('{"schemaVersion":1,"records":[]}').toString('base64');
  for (const invalid of [
    '',
    ` ${payload}`,
    `${payload}\n`,
    `${payload}!`,
    `=${payload}`,
    `${payload}===`,
    `-_${payload.slice(2)}`,
    payload.slice(0, -1),
  ])
    refused(`gzip+base64:${invalid}`);
});

test('base64 refuses noncanonical pad bits even when Buffer decodes the same gzip', () => {
  let compressed = gzipSync('"synthetic"');
  if (compressed.length % 3 === 0) compressed = Buffer.concat([compressed, Buffer.from([0])]);
  const payload = compressed.toString('base64');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const index = payload.indexOf('=') - 1;
  const changed =
    payload.slice(0, index) +
    alphabet[alphabet.indexOf(payload[index]) + 1] +
    payload.slice(index + 1);
  assert.deepEqual(Buffer.from(changed, 'base64'), compressed);
  assert.equal(readSecurityFindingRegister(`gzip+base64:${payload}`), 'synthetic');
  refused(`gzip+base64:${changed}`);
});

test('truncated gzip and checksum errors refuse without disclosing their bytes', () => {
  const bytes = gzipSync('{"reason":"synthetic-private-reason"}');
  refused(`gzip+base64:${bytes.subarray(0, -4).toString('base64')}`);
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 8] ^= 1;
  refused(`gzip+base64:${corrupt.toString('base64')}`);
});

test('malformed JSON, invalid UTF-8 and a BOM retain generic refusals', () => {
  refused('{"reason":"synthetic-private-reason"');
  refused(encode('{"reason":"synthetic-private-reason"'));
  refused(encode(Buffer.from([0x22, 0xff, 0x22])));
  refused(encode('\uFEFF{"schemaVersion":1,"records":[]}'));
  refused('\uFEFF{"schemaVersion":1,"records":[]}');
  for (const input of [undefined, null, {}, 1]) refused(input);
});
