// NEW-only native CycloneDX interop: descriptors are not versioned software packages.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { assertSbom } = await import(
  pathToFileURL(join(process.cwd(), 'scripts/release-sbom.mjs')).href
);
const sha = 'a'.repeat(40);
const subject = { kind: 'image', id: 'app', platform: 'linux/amd64', sha };

/** Standard native descriptors coexist with exact package coordinates in one inventory. */
function inventory() {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      properties: [
        { name: 'openkit:artifact-source', value: 'image:app:linux/amd64' },
        { name: 'openkit:platform', value: 'linux/amd64' },
        { name: 'openkit:source-commit', value: sha },
      ],
    },
    components: [
      {
        type: 'library',
        name: '@agentclientprotocol/sdk',
        version: '1.4.0',
        purl: 'pkg:npm/%40agentclientprotocol/sdk@1.4.0?source=PUBLIC_REGISTRY',
        'bom-ref': 'native-node-package',
      },
      {
        type: 'library',
        name: 'adduser',
        version: '3.134',
        purl: 'pkg:deb/debian/adduser@3.134?arch=all&distro=bookworm',
        'bom-ref': 'native-debian-package',
      },
      { type: 'file', name: '/usr/share/doc/adduser/copyright', 'bom-ref': 'native-file' },
      { type: 'operating-system', name: 'Debian', version: '12.15', 'bom-ref': 'native-os' },
    ],
  };
}

test('only Go stdlib admits native go-prefixed equivalent versions without rewriting coordinates', () => {
  const bom = inventory();
  const stdlib = {
    type: 'library',
    name: 'stdlib',
    version: 'go1.27.3',
    purl: 'pkg:golang/stdlib@1.27.3',
    'bom-ref': 'native-go-stdlib',
  };
  bom.components.push(stdlib);
  const original = structuredClone(bom);
  assert.equal(assertSbom(bom, subject), bom, 'Equivalent native Go stdlib spelling must admit');
  assert.deepEqual(
    bom,
    original,
    'Go stdlib validation must preserve both original version strings'
  );
  const mismatch = structuredClone(bom);
  mismatch.components.at(-1).version = 'go1.27.4';
  assert.throws(
    () => assertSbom(mismatch, subject),
    Error,
    'Different Go stdlib numeric versions must refuse'
  );
  const nonStdlib = structuredClone(bom);
  Object.assign(nonStdlib.components.at(-1), {
    name: 'example.invalid/module',
    purl: 'pkg:golang/example.invalid/module@1.27.3',
  });
  assert.throws(
    () => assertSbom(nonStdlib, subject),
    Error,
    'Go prefix equivalence must not apply to non-stdlib software'
  );
});

test('repeated package coordinates retain distinct native occurrences but duplicate references refuse', () => {
  const bom = inventory();
  const first = bom.components[0];
  first.evidence = {
    occurrences: [{ location: '/app/node_modules/@agentclientprotocol/sdk/package.json' }],
  };
  const second = structuredClone(first);
  second['bom-ref'] = 'native-node-package-second-location';
  second.evidence.occurrences[0].location =
    '/usr/local/lib/node_modules/@agentclientprotocol/sdk/package.json';
  bom.components.push(second);
  const original = structuredClone(bom);
  assert.equal(
    assertSbom(bom, subject),
    bom,
    'Repeated exact package coordinates with distinct references must admit'
  );
  assert.deepEqual(
    bom,
    original,
    'Validation must preserve distinct native components and occurrence locations'
  );
  const duplicate = structuredClone(bom);
  duplicate.components.at(-1)['bom-ref'] = first['bom-ref'];
  assert.throws(
    () => assertSbom(duplicate, subject),
    Error,
    'Duplicate component references must refuse'
  );
});

test('native file and OS descriptors admit without weakening software package completeness', () => {
  const bom = inventory();
  const original = structuredClone(bom);
  assert.equal(assertSbom(bom, subject), bom, 'Valid native inventory must return the input BOM');
  assert.deepEqual(
    bom,
    original,
    'Validation must not drop packages or invent descriptor coordinates'
  );
  for (const type of ['library', 'application']) {
    for (const field of ['purl', 'version']) {
      const incomplete = inventory();
      incomplete.components[0].type = type;
      delete incomplete.components[0][field];
      assert.throws(
        () => assertSbom(incomplete, subject),
        Error,
        'Software package missing an exact coordinate must still refuse'
      );
    }
  }
});
