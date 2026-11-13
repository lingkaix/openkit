// NEW-only: the reviewed opaque Gateway is version-searchable, never transitive-clearance evidence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const { addOpaqueGateway } = await import(
  pathToFileURL(join(root, 'scripts/release-sbom.mjs')).href
);
const native = {
  type: 'library',
  name: '@agentclientprotocol/sdk',
  version: '1.4.0',
  purl: 'pkg:npm/%40agentclientprotocol/sdk@1.4.0?source=PUBLIC_REGISTRY',
  'bom-ref': 'native-sdk-fixture',
};
const bom = () => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  components: [structuredClone(native)],
});

/** Use the accepted public schema with distinct synthetic archive and executable hashes. */
function releaseFixture() {
  const release = JSON.parse(
    readFileSync(join(root, 'apps/nanohost/openshell/release.json'), 'utf8')
  );
  release.version = '0.0.99';
  release.source.commit = 'a'.repeat(40);
  for (const [index, platform] of ['linux/amd64', 'linux/arm64'].entries()) {
    release.gateway.targets[platform].archive.sha256 = String(index * 2 + 1).repeat(64);
    release.gateway.targets[platform].executable.sha256 = String(index * 2 + 2).repeat(64);
  }
  return release;
}

test('each reviewed target is an exact opaque vendor component with explicitly unknown transitive coverage', () => {
  for (const platform of ['linux/amd64', 'linux/arm64']) {
    const release = releaseFixture();
    const result = addOpaqueGateway(bom(), { release, platform });
    const preserved = result.components.filter((component) => component.purl === native.purl);
    assert.deepEqual(preserved, [native], 'Native package identity must remain unchanged');
    assert.equal(
      result.components.length,
      2,
      'Opaque vendor input must not invent transitive components'
    );
    const vendor = result.components.find((component) => component.purl !== native.purl);
    assert.equal(vendor.version, '0.0.99', 'Vendor component must retain the reviewed version');
    assert.ok(
      typeof vendor.purl === 'string' &&
        vendor.purl.startsWith('pkg:') &&
        vendor.purl.includes('@0.0.99'),
      'Vendor must have a version-bound package identity'
    );
    assert.match(
      vendor.supplier?.name ?? '',
      /nvidia/iu,
      'Vendor component must identify its actual supplier'
    );
    const encoded = JSON.stringify(vendor);
    const target = release.gateway.targets[platform];
    assert.ok(
      encoded.includes(target.archive.sha256),
      'Opaque component must bind the exact reviewed target archive'
    );
    assert.ok(
      encoded.includes(target.executable.sha256),
      'Opaque component must bind the exact reviewed target binary'
    );
    const other =
      release.gateway.targets[platform === 'linux/amd64' ? 'linux/arm64' : 'linux/amd64'];
    assert.equal(
      encoded.includes(other.archive.sha256),
      false,
      'Opaque component must not substitute another target archive'
    );
    assert.equal(
      encoded.includes(other.executable.sha256),
      false,
      'Opaque component must not substitute another target binary'
    );
    const properties = Object.fromEntries(
      (vendor.properties ?? []).map(({ name, value }) => [name, value])
    );
    for (const [name, expected] of Object.entries({
      'openkit:transitive-coverage': 'unknown',
      'openkit:vulnerability-lookup': 'component-version-only',
      'openkit:clearance-authority': 'none',
      'openkit:purge-authority': 'none',
    }))
      assert.equal(properties[name], expected, 'Opaque coverage limits must remain explicit');
    assert.ok(
      typeof vendor['bom-ref'] === 'string' && vendor['bom-ref'].length > 0,
      'Vendor coverage needs a component reference'
    );
    assert.ok(
      (result.compositions ?? []).some(
        (composition) =>
          composition.aggregate === 'unknown' &&
          [...(composition.assemblies ?? []), ...(composition.dependencies ?? [])].includes(
            vendor['bom-ref']
          )
      ),
      'Unknown composition must bind the opaque vendor component'
    );
  }
});

test('opaque Gateway projection refuses invalid targets, malformed artifact hashes, and unreviewed versions', () => {
  for (const platform of ['linux/ppc64le', '', undefined]) {
    assert.throws(
      () => addOpaqueGateway(bom(), { release: releaseFixture(), platform }),
      Error,
      'Unsupported opaque target must refuse'
    );
  }
  for (const platform of ['linux/amd64', 'linux/arm64']) {
    for (const kind of ['archive', 'executable'])
      for (const hash of ['', 'a'.repeat(63), 'g'.repeat(64)]) {
        const release = releaseFixture();
        release.gateway.targets[platform][kind].sha256 = hash;
        assert.throws(
          () => addOpaqueGateway(bom(), { release, platform }),
          Error,
          'Malformed reviewed artifact hash must refuse'
        );
      }
    const release = releaseFixture();
    release.version = '0.0.100';
    assert.throws(
      () => addOpaqueGateway(bom(), { release, platform }),
      Error,
      'Unreviewed opaque vendor version must refuse'
    );
  }
});
