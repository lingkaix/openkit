// NEW-only native JS descriptor interop; unknown installed package roots remain incomplete software.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { normalizeRuntimeDescriptors, assertSbom } = await import(
  pathToFileURL(join(process.cwd(), 'scripts/release-sbom.mjs')).href
);
const sha = 'a'.repeat(40);
const subject = { kind: 'image', id: 'app', platform: 'linux/amd64', sha };
const parentPurl = 'pkg:npm/solid-js@1.9.9?source=PUBLIC_REGISTRY';
const property = (name, value) => ({ name, value });
const locationProperties = (path) => [
  property('syft:package:foundBy', 'javascript-package-cataloger'),
  property('syft:location:0:path', path),
];

function inventory() {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      properties: [
        property('openkit:artifact-source', 'image:app:linux/amd64'),
        property('openkit:platform', subject.platform),
        property('openkit:source-commit', sha),
      ],
    },
    components: [
      {
        type: 'library',
        name: 'solid-js',
        version: '1.9.9',
        purl: parentPurl,
        'bom-ref': 'native-parent',
        properties: locationProperties('/app/node_modules/solid-js/package.json'),
      },
      {
        type: 'library',
        name: 'h',
        purl: 'pkg:npm/solid-js/h@UNKNOWN',
        'bom-ref': 'native-export-descriptor',
        properties: locationProperties('/app/node_modules/solid-js/h/package.json'),
      },
      {
        type: 'library',
        name: 'adduser',
        version: '3.134',
        purl: 'pkg:deb/debian/adduser@3.134?arch=all&distro=bookworm',
        'bom-ref': 'native-debian-package',
      },
    ],
  };
}

test('only parent-owned export descriptors become files while unknown installed packages still refuse', () => {
  const input = inventory();
  const parent = structuredClone(input.components[0]);
  const descriptor = structuredClone(input.components[1]);
  const normalized = normalizeRuntimeDescriptors(input);
  assert.equal(normalized.components.length, 3, 'Normalization must not omit native components');
  assert.deepEqual(
    normalized.components.find((entry) => entry['bom-ref'] === parent['bom-ref']),
    parent,
    'The installed parent package must retain its exact native identity'
  );
  const converted = normalized.components.find(
    (entry) => entry['bom-ref'] === descriptor['bom-ref']
  );
  const expected = {
    ...descriptor,
    type: 'file',
    properties: [...descriptor.properties, property('openkit:package-descriptor-of', parentPurl)],
  };
  // Property ordering is not part of CycloneDX identity.
  const canonical = (component) => ({
    ...component,
    properties: [...component.properties].sort((a, b) => a.name.localeCompare(b.name)),
  });
  assert.deepEqual(
    canonical(converted),
    canonical(expected),
    'Descriptor conversion must preserve native data and bind only the exact parent'
  );
  assert.equal(
    Object.hasOwn(converted, 'version'),
    false,
    'Descriptor normalization must not invent a version'
  );
  assert.doesNotThrow(
    () => assertSbom(normalized, subject),
    'Parent-owned file descriptor must not invalidate complete software inventory'
  );

  for (const path of [
    '/app/node_modules/solid-js/node_modules/unknown/package.json',
    '/app/node_modules/unknown/package.json',
  ]) {
    const separate = inventory();
    separate.components[1] = {
      type: 'library',
      name: 'unknown',
      purl: 'pkg:npm/unknown@UNKNOWN',
      'bom-ref': 'native-unknown-installed-package',
      properties: locationProperties(path),
    };
    const original = structuredClone(separate.components[1]);
    const incomplete = normalizeRuntimeDescriptors(separate);
    const unknown = incomplete.components.find(
      (entry) => entry['bom-ref'] === 'native-unknown-installed-package'
    );
    assert.deepEqual(
      unknown,
      original,
      'Unknown installed roots must remain software rather than descriptors'
    );
    assert.throws(
      () => assertSbom(incomplete, subject),
      Error,
      'Unknown installed software must still fail package completeness'
    );
  }
});
