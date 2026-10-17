import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import {
  archiveBytes,
  archiveEntryDescriptions,
  cases,
  originalBytes,
  streamChunks,
} from './fixtures/large-context/corpus.mjs';

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const utf8 = new TextDecoder('utf-8', { fatal: true });

test('small originals retain exact byte size and independently frozen SHA-256', () => {
  for (const source of cases.originals) {
    const bytes = originalBytes(source.id);
    assert.equal(bytes.length, source.size, source.id);
    assert.equal(digest(bytes), source.sha256, source.id);
    assert.deepEqual(Buffer.from(bytes.toString('base64'), 'base64'), bytes);
    if (source.validUtf8) assert.equal(Buffer.from(utf8.decode(bytes)).compare(bytes), 0);
    else assert.throws(() => utf8.decode(bytes), TypeError);
  }
});

test('negative control detects changed original bytes using the same digest oracle', () => {
  const expected = cases.originals.find((source) => source.id === 'binary-invalid-utf8');
  const original = originalBytes(expected.id);
  assert.equal(digest(original), expected.sha256);
  const changed = Buffer.from(original);
  changed[1] ^= 1;
  assert.throws(() => assert.equal(digest(changed), expected.sha256), assert.AssertionError);
  assert.notEqual(digest(Buffer.from(original.toString('utf8'))), expected.sha256);
});

test('large file recipes have exact decimal edges and bounded sampled chunks', () => {
  assert.deepEqual(
    cases.streamRecipes.map((recipe) => recipe.size),
    [999999999, 1000000000, 1000000001]
  );
  for (const recipe of cases.streamRecipes) {
    for (const range of [
      { start: 0, end: 65537 },
      { start: recipe.size - 65537, end: recipe.size },
    ]) {
      const chunks = [...streamChunks(recipe, range)];
      assert.deepEqual(
        chunks.map((chunk) => chunk.length),
        [65536, 1]
      );
      assert.ok(chunks.every((chunk) => chunk.equals(Buffer.alloc(chunk.length))));
    }
    assert.deepEqual([...streamChunks(recipe, { start: recipe.size, end: recipe.size })], []);
    assert.throws(() => [...streamChunks(recipe, { end: recipe.size + 1 })], RangeError);
  }
  for (const submission of cases.fileCases) {
    const sizes =
      submission.fileSizes ??
      submission.fileRecipes.map((id) => {
        return cases.streamRecipes.find((recipe) => recipe.id === id).size;
      });
    const actual = sizes.reduce((total, size) => total + size, 0);
    assert.equal(actual, submission.combinedBytes);
    assert.equal(actual <= 1000000000, submission.withinSubmissionLimit);
  }
  for (const files of cases.workerFileCases) {
    assert.equal(
      files.fileSizes.reduce((sum, size) => sum + size, 0),
      files.combinedBytes
    );
    assert.deepEqual(
      files.fileSizes.map((size) => size <= 1000000000),
      files.expectedPerFileAdmission
    );
    assert.ok(files.combinedBytes > 1000000000);
  }
});

test('shared reserve fixture has two individually fitting but jointly excessive footprints', () => {
  const reserve = cases.scenarios.reserve;
  const footprints = reserve.contenders.map(
    (entry) =>
      entry.stagingBytes +
      entry.extractionBytes +
      entry.derivativeBytes +
      entry.publicationOverlapBytes
  );
  const committed = reserve.serverReserveBytes + reserve.existingInflightBytes;
  for (const footprint of footprints) {
    assert.equal(footprint, reserve.expectedFootprintEach);
    assert.equal(committed + footprint, reserve.expectedRequiredAlone);
    assert.ok(committed + footprint <= reserve.capacityBytes);
  }
  const together = committed + footprints.reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(together, reserve.expectedRequiredTogether);
  assert.ok(together > reserve.capacityBytes);
});

test('expansion and entry recipes describe exact edges without expanding bodies', () => {
  for (const recipe of cases.archiveRecipes) {
    let bytes = 0;
    let count = 0;
    for (const entry of archiveEntryDescriptions(recipe)) {
      assert.equal(entry.name, `entry-${String(count).padStart(6, '0')}.bin`);
      bytes += entry.size;
      count += 1;
    }
    assert.equal(bytes, recipe.actualExpandedBytes, recipe.id);
    assert.equal(count, recipe.actualEntries, recipe.id);
    assert.equal(bytes <= 4000000000, recipe.withinExpandedLimit, recipe.id);
    assert.equal(count <= 100000, recipe.withinEntryLimit, recipe.id);
  }
});

test('frozen ZIP bytes match their named structures, payload digests and deliberate faults', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  for (const fixture of cases.archives) {
    const bytes = archiveBytes(fixture.id);
    assert.equal(bytes.length, fixture.size, fixture.id);
    assert.equal(digest(bytes), fixture.sha256, fixture.id);
    const end = bytes.lastIndexOf(Buffer.from('504b0506', 'hex'));
    assert.ok(end >= 0);
    assert.equal(bytes.length - end >= 22, fixture.completeEndRecord, fixture.id);
    for (const entry of fixture.entries) {
      // Inspect only frozen offsets. This is not an archive admission parser.
      const local = entry.localOffset;
      const central = entry.centralOffset;
      assert.equal(bytes.readUInt32LE(local), 0x04034b50);
      assert.equal(bytes.readUInt32LE(central), 0x02014b50);
      assert.equal(bytes.readUInt32LE(central + 42), local);
      assert.equal(bytes.readUInt16LE(local + 8), entry.method);
      assert.equal(bytes.readUInt16LE(central + 10), entry.method);
      assert.equal(bytes.readUInt32LE(local + 14), entry.declaredCrc32);
      assert.equal(bytes.readUInt32LE(central + 16), entry.declaredCrc32);
      assert.equal(bytes.readUInt32LE(local + 18), entry.compressedSize);
      assert.equal(bytes.readUInt32LE(central + 20), entry.compressedSize);
      assert.equal(bytes.readUInt32LE(local + 22), entry.declaredSize);
      assert.equal(bytes.readUInt32LE(central + 24), entry.declaredSize);
      assert.equal(bytes.readUInt32LE(central + 38) >>> 16, entry.unixMode);
      const name = Buffer.from(entry.name);
      assert.equal(bytes.readUInt16LE(local + 26), name.length);
      assert.equal(bytes.readUInt16LE(central + 28), name.length);
      assert.deepEqual(bytes.subarray(local + 30, local + 30 + name.length), name);
      assert.deepEqual(bytes.subarray(central + 46, central + 46 + name.length), name);
      const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
      const body =
        entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: 65536 }) : compressed;
      assert.equal(body.length, entry.actualSize);
      assert.equal(digest(body), entry.bodySha256);
      assert.equal(crc32(body), entry.actualCrc32);
      assert.equal(entry.actualCrc32 === entry.declaredCrc32, fixture.id !== 'bad-crc');
      assert.equal(entry.actualSize === entry.declaredSize, fixture.id !== 'forged-size');
    }
  }
  const nested = cases.archives.find((fixture) => fixture.id === 'nested').entries[0];
  const inner = archiveBytes('nested').subarray(
    nested.dataOffset,
    nested.dataOffset + nested.actualSize
  );
  assert.equal(inner.readUInt32LE(0), 0x04034b50);
  assert.equal(inner.readUInt32LE(inner.length - 22), 0x06054b50);
  assert.deepEqual(inner.subarray(30, 38), Buffer.from('note.txt'));
  assert.equal(
    cases.archives.find((fixture) => fixture.id === 'link').entries[0].unixMode & 0o170000,
    0o120000
  );
  assert.equal(
    cases.archives.find((fixture) => fixture.id === 'special').entries[0].unixMode & 0o170000,
    0o010000
  );
});

test('frozen preview and read ranges preserve UTF-8 and cover huge single lines', () => {
  for (const scenario of cases.scenarios.context.cases) {
    const bytes = originalBytes(scenario.original);
    const preview = bytes.subarray(...scenario.preview);
    assert.ok(preview.length <= 2048);
    utf8.decode(preview);
    const parts = [];
    let next = 0;
    for (const [start, end] of scenario.reads) {
      assert.equal(start, next);
      assert.ok(end > start);
      assert.ok(end - start <= 51200);
      const part = bytes.subarray(start, end);
      utf8.decode(part);
      assert.ok([...part].filter((byte) => byte === 10).length <= 2000);
      parts.push(part);
      next = end;
    }
    assert.equal(next, bytes.length);
    assert.deepEqual(Buffer.concat(parts), bytes);
    assert.ok([...preview].filter((byte) => byte === 10).length <= 50);
  }
  const cjk = originalBytes('cjk-single-line');
  assert.throws(() => utf8.decode(cjk.subarray(0, 2048)), TypeError);
  assert.throws(() => utf8.decode(cjk.subarray(0, 51200)), TypeError);
});

test('frozen raw-emission transcript has independently measurable content bytes', () => {
  const { events, parallel, expectedFinalBytes } = cases.scenarios.rawOutput;
  let total = 0;
  for (const event of events) {
    assert.equal(Buffer.byteLength(event.text), event.end - event.start);
    if (event.kind === 'emission') {
      assert.equal(event.expectedAdditionalBytes, Buffer.byteLength(event.text));
    } else assert.equal(event.expectedAdditionalBytes, 0);
    total += event.expectedAdditionalBytes;
    assert.equal(total, event.expectedAggregateBytes);
  }
  assert.equal(total, 23);
  assert.equal(total, expectedFinalBytes);
  const observed =
    parallel.initialBytes +
    parallel.concurrentEmissions.reduce((sum, event) => sum + event.bytes, 0);
  assert.equal(observed, parallel.observedTotalBytes);
  assert.ok(observed > 16777216);
  assert.equal(16777216 - parallel.initialBytes, 5);
});

test('private fixture digest and disclosure markers identify the frozen source bytes', () => {
  const { privateSource, forbiddenModelVisibleMarkers } = cases.scenarios.privacy;
  assert.equal(privateSource.digest, digest(Buffer.from(privateSource.body)));
  for (const field of ['title', 'body', 'digest', 'snippet', 'count']) {
    assert.ok(forbiddenModelVisibleMarkers.includes(String(privateSource[field])));
  }
});
