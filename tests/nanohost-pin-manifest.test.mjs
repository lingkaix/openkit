import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const nanoHostRoot = join(repoRoot, 'apps', 'nanohost');
const pinRoot = join(nanoHostRoot, 'openshell-pin');
const manifestPath = join(pinRoot, 'manifest.md');
const protoRoot = join(pinRoot, 'proto');
const evidenceRoot = join(pinRoot, 'evidence');
const gitObjectRoot = join(evidenceRoot, 'git-objects');
const publisherChecksumRoot = join(evidenceRoot, 'publisher-checksums');
const extractedChecksumPath = join(evidenceRoot, 'extracted-checksums.sha256');
const compileProbeRoot = join(evidenceRoot, 'compile-probe');
const compileProbeReference = relative(repoRoot, compileProbeRoot);
const annexPath = join(repoRoot, 'docs', 'specs', '20260802-nanohost_runtime_and_transport.md');
const requiredCompileProbeFiles = ['Cargo.toml', 'Cargo.lock', 'src/main.rs', 'result.md'];
const gitObjectTypes = ['commit', 'tree', 'blob'];
const checksumPattern = /^sha256:[0-9a-f]{64}$/iu;
const jsonBlockPattern = /^[ \t]*```json[^\S\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gimu;
const placeholderPattern = /\b(?:todo|tbd|unknown|placeholder|unobserved|pending)\b/iu;
const requiredArtifactKinds = ['gateway-executable', 'supervisor-image', 'cli'];
const requiredSourceArtifacts = [
  {
    bundlePath: 'licenses/openshell-LICENSE',
    checksum: 'sha256:b967d1c87b93b7d61ebcf4f8737e6ad79e5433e743e49dff395a36fb3c327047',
    kind: 'redistribution-license',
    sourcePath: 'LICENSE',
  },
  {
    bundlePath: 'licenses/openshell-THIRD-PARTY-NOTICES',
    checksum: 'sha256:8c35aead093cbdfb3e11345d88cf2cb179f86391e859e4a7bc11539a0cc601f8',
    kind: 'redistribution-notices',
    sourcePath: 'THIRD-PARTY-NOTICES',
  },
];
const requiredRpcNames = [
  'CreateSandbox',
  'GetSandbox',
  'ListSandboxes',
  'DeleteSandbox',
  'ForwardTcp',
  'ConnectSupervisor',
  'RelayStream',
  'ExecSandbox',
  'ExecSandboxInteractive',
  'CreateSshSession',
  'RevokeSshSession',
];
const requiredConsumedSurfaceNames = [
  'protocol',
  'CLI',
  'SDK',
  'protobuf',
  'Gateway',
  'Supervisor',
  'provider',
  'policy',
  'authentication',
  'image',
  'lifecycle',
];
const requiredConstantNames = [
  'pending-claim-timeout',
  'forward-chunk-size',
  'relay-chunk-size',
  'gateway-pairing-buffer-size',
  'gateway-adaptive-http2-window',
  'client-adaptive-http2-window',
  'per-rpc-authorization-annotations',
  'forward-target-authorization-secret-marking',
];
const requiredInteractiveObservations = [
  'ExecSandboxInteractive',
  '1,048,576',
  'open_relay(Target::Ssh)',
  'authenticate_none("sandbox")',
  'peer PID',
  'missing exit',
  'single-use',
  'loopback',
];

test('the NanoHost OpenShell pin manifest preserves one exact consumed boundary', async (t) => {
  const { manifest, markdown } = readPinManifest();
  const source = expectRecord(manifest.source, 'exact pin provenance obligation failed');

  await t.test('records the exact stock raw exec implementation closures', () => {
    assert.equal(
      requiredRpcNames.length,
      11,
      'the consumed RPC root set must remain exactly eleven'
    );
    for (const observation of requiredInteractiveObservations) {
      assert.ok(
        markdown.includes(observation),
        `interactive-exec closure obligation failed: missing ${observation}`
      );
    }
    const probe = readFileSync(join(compileProbeRoot, 'src', 'main.rs'), 'utf8');
    assert.ok(probe.includes('ExecSandboxRequest'));
    assert.ok(probe.includes('.exec_sandbox('));
    assert.ok(probe.includes('mpsc::channel::<ExecSandboxInput>'));
    assert.ok(probe.includes('.exec_sandbox_interactive('));
    const probeResult = readFileSync(join(compileProbeRoot, 'result.md'), 'utf8');
    assert.match(probeResult, /ExecSandboxRequest/iu);
    assert.match(probeResult, /exec_sandbox\s*\(/iu);
    assert.match(probeResult, /exec_sandbox_interactive\s*\(/iu);
    assert.match(probeResult, /unary.*worker bootstrap/iu);
    assert.match(probeResult, /interactive.*single-file/iu);
    assert.match(markdown, /ExecSandbox.*only the unary worker bootstrap\/response monitor/iu);
    assert.match(markdown, /ExecSandboxInteractive.*only the fixed single-file helper/iu);
    assert.match(markdown, /timeout[_ -]?seconds\s*(?:=|:)\s*0/iu);
    assert.match(markdown, /stdin.*EOF/iu);
    assert.match(markdown, /missing Exit/iu);
    assert.match(markdown, /concurrent.*ForwardTcp/iu);
  });

  await t.test('records an exact tag and resolved commit', () => {
    assert.match(
      source.tag,
      /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u,
      'exact tag obligation failed: source.tag must be one exact release tag'
    );
    assert.match(
      source.commit,
      /^[0-9a-f]{40}$/iu,
      'resolved commit obligation failed: source.commit must be one full commit identity'
    );
  });

  await t.test('records complete non-shallow immutable-tag checkout evidence', () => {
    const checkout = expectRecord(source.checkout, 'snapshot evidence-quality obligation failed');
    assert.equal(
      checkout.complete,
      true,
      'snapshot evidence-quality obligation failed: checkout.complete must be true'
    );
    assert.equal(
      checkout.shallow,
      false,
      'snapshot evidence-quality obligation failed: checkout.shallow must be false'
    );
    assert.equal(
      checkout.clean,
      true,
      'snapshot evidence-quality obligation failed: checkout.clean must be true'
    );
    assert.equal(
      checkout.tag,
      source.tag,
      'snapshot evidence-quality obligation failed: checkout tag differs from source.tag'
    );
    assert.equal(
      checkout.commit,
      source.commit,
      'snapshot evidence-quality obligation failed: checkout commit differs from source.commit'
    );
  });

  await t.test('resolves the recorded pin identity against oracles outside the manifest', () => {
    assert.equal(
      source.commit,
      readSpecifiedPinCommit(),
      'external pin-identity obligation failed: source.commit differs from the commit the accepted Stock Realization Annex names for this pin'
    );
    assert.equal(
      readGitObject(source.commit).type,
      'commit',
      `external pin-identity obligation failed: retained evidence for ${source.commit} is not a git commit object`
    );
  });

  await t.test('preserves and individually checksums consumed interface definitions', async (t) => {
    assert.ok(
      Array.isArray(manifest.interfaceDefinitions) && manifest.interfaceDefinitions.length > 0,
      'consumed-interface-definition obligation failed: interfaceDefinitions must be non-empty'
    );
    const paths = new Set();

    for (const [index, value] of manifest.interfaceDefinitions.entries()) {
      const definition = expectRecord(
        value,
        `consumed-interface-definition obligation failed at entry ${index}`
      );
      await t.test(definition.path || `entry ${index}`, () => {
        assertObservedString(
          definition.path,
          `consumed-interface-definition obligation failed at entry ${index}: path`
        );
        assert.equal(
          isAbsolute(definition.path),
          false,
          `consumed-interface-definition obligation failed for ${definition.path}: path must be repository-relative`
        );
        const absolutePath = resolve(repoRoot, definition.path);
        const fromNanoHost = relative(nanoHostRoot, absolutePath);
        assert.ok(
          fromNanoHost && !fromNanoHost.startsWith('..') && !isAbsolute(fromNanoHost),
          `consumed-interface-definition obligation failed for ${definition.path}: file must stay inside apps/nanohost`
        );
        assert.equal(
          paths.has(definition.path),
          false,
          `consumed-interface-definition obligation failed: duplicate path ${definition.path}`
        );
        paths.add(definition.path);
        assert.ok(
          existsSync(absolutePath) && statSync(absolutePath).isFile(),
          `consumed-interface-definition obligation failed: missing vendored file ${definition.path}`
        );
        assert.match(
          definition.checksum,
          checksumPattern,
          `consumed-interface-definition checksum obligation failed for ${definition.path}: expected sha256:<digest>`
        );
        assert.equal(
          definition.checksum,
          sha256File(absolutePath),
          `consumed-interface-definition checksum obligation failed for ${definition.path}: recorded checksum does not match file bytes`
        );
        assertPinnedToSource(definition, source, `interface definition ${definition.path}`);
      });
    }

    await t.test('records the complete vendored protobuf import closure', () => {
      const vendoredPaths = readdirSync(protoRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.proto'))
        .map((entry) => relative(protoRoot, join(entry.parentPath, entry.name)));
      const recordedPaths = new Set(
        manifest.interfaceDefinitions.map((definition, index) => {
          const path = relative(protoRoot, resolve(repoRoot, definition.path));
          assert.ok(
            path && !path.startsWith('..') && !isAbsolute(path),
            `consumed-interface-definition completeness obligation failed at entry ${index}: ${definition.path} must stay inside apps/nanohost/openshell-pin/proto`
          );
          return path;
        })
      );
      const importsByPath = new Map(
        vendoredPaths.map((path) => [
          path,
          [
            ...readFileSync(join(protoRoot, path), 'utf8').matchAll(
              /^\s*import\s+(?:(?:public|weak)\s+)?"([^"]+)"\s*;/gmu
            ),
          ]
            .map((match) => match[1])
            .filter((target) => !target.startsWith('google/')),
        ])
      );
      const rpcNamesByPath = new Map(
        vendoredPaths.map((path) => [
          path,
          new Set(
            [
              ...readFileSync(join(protoRoot, path), 'utf8').matchAll(
                /^service\s+\w+\s*\{([\s\S]*?)^\}/gmu
              ),
            ]
              .flatMap((service) => [...service[1].matchAll(/^\s*rpc\s+(\w+)\s*\(/gmu)])
              .map((rpc) => rpc[1])
          ),
        ])
      );
      const pending = [];
      const visited = new Set();

      for (const rpc of requiredRpcNames) {
        const declaringPath = vendoredPaths.find((path) => rpcNamesByPath.get(path)?.has(rpc));
        assert.ok(
          declaringPath,
          `consumed-interface-definition completeness obligation failed: missing required RPC ${rpc}`
        );
        assert.ok(
          recordedPaths.has(declaringPath),
          `consumed-interface-definition completeness obligation failed: ${declaringPath} declares required RPC ${rpc} but is not recorded`
        );
        pending.push(declaringPath);
      }

      while (pending.length > 0) {
        const path = pending.pop();
        if (visited.has(path)) {
          continue;
        }
        visited.add(path);
        for (const target of importsByPath.get(path) ?? []) {
          assert.ok(
            recordedPaths.has(target),
            `consumed-interface-definition completeness obligation failed: ${path} imports unrecorded ${target}`
          );
          pending.push(target);
        }
      }

      for (const path of vendoredPaths) {
        assert.ok(
          recordedPaths.has(path),
          `consumed-interface-definition completeness obligation failed: unrecorded vendored file ${path}`
        );
      }
    });
  });

  await t.test(
    'proves vendored definition bytes are the bytes the pinned commit names',
    async (t) => {
      for (const definition of manifest.interfaceDefinitions) {
        const upstreamPath = relative(pinRoot, resolve(repoRoot, definition.path));
        await t.test(upstreamPath, () => {
          assert.ok(
            upstreamPath && !upstreamPath.startsWith('..') && !isAbsolute(upstreamPath),
            `vendored-byte identity obligation failed: ${definition.path} must stay inside apps/nanohost/openshell-pin`
          );
          assert.equal(
            gitObjectId('blob', readFileSync(resolve(repoRoot, definition.path))),
            resolveUpstreamBlobId(source.commit, upstreamPath),
            `vendored-byte identity obligation failed for ${upstreamPath}: vendored bytes are not the bytes ${source.commit} names at that path`
          );
        });
      }
    }
  );

  await t.test('records checksum identities for every named consumed artifact kind', async (t) => {
    assert.ok(
      Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0,
      'consumed-artifact checksum obligation failed: artifacts must be non-empty'
    );

    for (const [index, value] of manifest.artifacts.entries()) {
      const artifact = expectRecord(
        value,
        `consumed-artifact checksum obligation failed at entry ${index}`
      );
      assertObservedString(
        artifact.kind,
        `consumed-artifact checksum obligation failed at entry ${index}: kind`
      );
      assert.equal(
        typeof artifact.name,
        'string',
        `consumed-artifact checksum obligation failed for ${artifact.kind} entry ${index}: name must be a string`
      );
      assert.ok(
        artifact.name.trim(),
        `consumed-artifact checksum obligation failed for ${artifact.kind} entry ${index}: name must not be empty`
      );
      assert.doesNotMatch(
        artifact.name.trim(),
        /^(?:todo|tbd|unknown|placeholder|unobserved|pending)(?:\b|$)/iu,
        `consumed-artifact checksum obligation failed for ${artifact.kind} entry ${index}: name must not be a placeholder`
      );
      assert.match(
        artifact.checksum,
        checksumPattern,
        `consumed-artifact checksum obligation failed for ${artifact.kind} entry ${index}: expected sha256:<digest>`
      );
      assertPinnedToSource(artifact, source, `${artifact.kind} entry ${index}`);
    }

    for (const kind of requiredArtifactKinds) {
      await t.test(kind, () => {
        const entries = manifest.artifacts.filter((artifact) => artifact?.kind === kind);
        assert.ok(
          entries.length > 0,
          `consumed-artifact checksum obligation failed: missing ${kind}`
        );
      });
    }
  });

  await t.test(
    'resolves every consumed artifact against publisher-published digests',
    async (t) => {
      const names = new Set(manifest.artifacts.map((artifact) => artifact?.name));
      const supervisorIndexDigest =
        'sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6';
      const supervisorIndex = manifest.artifacts.filter(
        (artifact) => artifact?.representation === 'published-multi-platform-oci-index'
      );
      const supervisorPlatforms = manifest.artifacts.filter(
        (artifact) => artifact?.representation === 'tier-2-explicit-platform-oci-image'
      );

      assert.equal(supervisorIndex.length, 1, 'publisher-digest obligation failed: one index');
      assert.equal(supervisorIndex[0].checksum, supervisorIndexDigest);
      assert.equal(supervisorIndex[0].runtimeResolutionTier, undefined);
      assert.equal(
        supervisorPlatforms.length,
        2,
        'publisher-digest obligation failed: exactly two platform images'
      );
      assert.deepEqual(
        Object.fromEntries(
          supervisorPlatforms.map((artifact) => [artifact.platform, artifact.checksum])
        ),
        {
          'linux/amd64': 'sha256:4adea8392a81ef34b3cc3284e693ac3cc6c13362fad84a492d95b53b3eb403b9',
          'linux/arm64': 'sha256:b548fd939331d830cd9197f20fca9a5d95383c5e67f64929d632a37403115f38',
        }
      );
      for (const artifact of supervisorPlatforms) {
        assert.equal(artifact.parentIndex, supervisorIndexDigest);
        assert.equal(artifact.runtimeResolutionTier, 2);
        assert.ok(artifact.name.endsWith(`@${artifact.checksum}`));
      }

      for (const [index, artifact] of manifest.artifacts.entries()) {
        if (artifact.representation === 'source-file') {
          continue;
        }
        await t.test(artifact.name || `entry ${index}`, () => {
          if (artifact.derivedFrom !== undefined) {
            assert.ok(
              names.has(artifact.derivedFrom),
              `publisher-digest obligation failed for ${artifact.name}: derivedFrom ${artifact.derivedFrom} is not a recorded artifact`
            );
            return;
          }
          if (
            artifact.representation === 'published-multi-platform-oci-index' ||
            artifact.representation === 'tier-2-explicit-platform-oci-image'
          ) {
            return;
          }
          assertObservedString(
            artifact.publisherChecksumFile,
            `publisher-digest obligation failed for ${artifact.name}: publisherChecksumFile`
          );
          const digests = readPublisherChecksums(artifact.publisherChecksumFile);
          assert.ok(
            digests.has(artifact.name),
            `publisher-digest obligation failed: ${artifact.name} is not an entry of retained ${artifact.publisherChecksumFile}`
          );
          assert.equal(
            artifact.checksum,
            `sha256:${digests.get(artifact.name)}`,
            `publisher-digest obligation failed for ${artifact.name}: recorded checksum differs from the publisher-published digest`
          );
        });
      }
    }
  );

  await t.test(
    'binds redistributed source files to the accepted pin and fixed bundle paths',
    () => {
      const sourceArtifacts = manifest.artifacts.filter(
        (artifact) => artifact?.representation === 'source-file'
      );
      assert.equal(
        sourceArtifacts.length,
        requiredSourceArtifacts.length,
        'source-file obligation failed: expected exactly the two redistributed source files'
      );

      for (const expected of requiredSourceArtifacts) {
        const matches = sourceArtifacts.filter((artifact) => artifact?.kind === expected.kind);
        assert.equal(
          matches.length,
          1,
          `source-file obligation failed: ${expected.kind} must appear exactly once`
        );
        const artifact = matches[0];
        assert.equal(artifact.sourcePath, expected.sourcePath);
        assert.equal(artifact.bundlePath, expected.bundlePath);
        assert.equal(artifact.publisherChecksumFile, undefined);
        assert.match(artifact.checksum, checksumPattern);
        assert.equal(artifact.checksum, expected.checksum);
        assertPinnedToSource(artifact, source, expected.kind);
      }

      assert.equal(
        new Set(sourceArtifacts.map((artifact) => artifact.bundlePath)).size,
        sourceArtifacts.length,
        'source-file obligation failed: redistributed bundle paths must be distinct'
      );
    }
  );

  await t.test(
    'resolves every derived executable against retained extracted digests',
    async (t) => {
      const digests = readExtractedChecksums();
      const derived = manifest.artifacts.filter((artifact) => artifact?.derivedFrom !== undefined);

      assert.ok(
        derived.length > 0,
        'extracted-digest obligation failed: artifacts must record at least one derivedFrom executable'
      );

      for (const [index, artifact] of derived.entries()) {
        await t.test(artifact.name || `derived entry ${index}`, () => {
          assert.doesNotMatch(
            artifact.name.trim(),
            /^(?:todo|tbd|unknown|placeholder|unobserved|pending)(?:\b|$)/iu,
            `extracted-digest obligation failed for ${artifact.name}: name must not be a placeholder`
          );
          assert.doesNotMatch(
            artifact.name.trim(),
            placeholderPattern,
            `extracted-digest obligation failed for ${artifact.name}: name must not contain a placeholder token`
          );
          assert.ok(
            digests.has(artifact.name),
            `extracted-digest obligation failed: ${artifact.name} is not an entry of retained ${relative(repoRoot, extractedChecksumPath)}`
          );
          assert.equal(
            artifact.checksum,
            `sha256:${digests.get(artifact.name)}`,
            `extracted-digest obligation failed for ${artifact.name}: recorded checksum differs from the retained extracted digest`
          );
        });
      }
    }
  );

  await t.test('retains reproducible compile-probe evidence for the selected client', async (t) => {
    for (const file of requiredCompileProbeFiles) {
      await t.test(file, () => {
        const path = join(compileProbeRoot, file);
        assert.ok(
          existsSync(path) && statSync(path).isFile(),
          `compile-probe evidence obligation failed: missing ${relative(repoRoot, path)}`
        );
      });
    }

    await t.test('binds the recorded probe result to the pinned commit', () => {
      const resultPath = join(compileProbeRoot, 'result.md');
      assert.ok(
        existsSync(resultPath) && readFileSync(resultPath, 'utf8').includes(source.commit),
        `compile-probe evidence obligation failed: ${relative(repoRoot, resultPath)} does not record the pinned commit ${source.commit}`
      );
    });

    await t.test('cites the retained probe evidence from the manifest claim', () => {
      assert.ok(
        markdown.includes(compileProbeReference),
        `compile-probe evidence obligation failed: the manifest asserts a compile-probe result without citing ${compileProbeReference}`
      );
    });
  });

  await t.test('classifies every consumed surface difference', async (t) => {
    const rows = markdown
      .replace(jsonBlockPattern, '')
      .split(/\r?\n/u)
      .map((line) =>
        line
          .trim()
          .replace(/^\|/u, '')
          .replace(/\|$/u, '')
          .split('|')
          .map((cell) => cell.replace(/[*_`]/gu, '').trim())
      )
      .filter((cells) => cells.length >= 2);

    for (const surface of requiredConsumedSurfaceNames) {
      await t.test(surface, () => {
        const entries = rows.filter(([name]) => name.toLowerCase() === surface.toLowerCase());
        assert.ok(
          entries.length > 0,
          `consumed-surface disposition obligation failed: missing ${surface}`
        );
        assert.equal(
          entries.length,
          1,
          `consumed-surface disposition obligation failed: ${surface} must appear exactly once`
        );
        assert.match(
          entries[0][1],
          /^(?:compatible|adapted|blocking)$/iu,
          `consumed-surface disposition obligation failed: ${surface} carries no compatible, adapted, or blocking disposition`
        );
      });
    }
  });

  await t.test('records every observed upstream constant without placeholders', async (t) => {
    assert.ok(
      Array.isArray(manifest.observedUpstreamConstants),
      'observed-upstream-constant obligation failed: observedUpstreamConstants must be an array'
    );

    for (const name of requiredConstantNames) {
      await t.test(name, () => {
        const entries = manifest.observedUpstreamConstants.filter((entry) => entry?.name === name);
        assert.equal(
          entries.length,
          1,
          `observed-upstream-constant obligation failed: ${name} must be recorded exactly once`
        );
        const observation = expectRecord(
          entries[0],
          `observed-upstream-constant obligation failed for ${name}`
        );
        assertObservedValue(
          observation.value,
          `observed-upstream-constant obligation failed for ${name}: value`
        );
        assertPinnedToSource(observation, source, `observed constant ${name}`);
      });
    }
  });

  await t.test(
    'evidences every observed upstream constant in retained pinned source blobs',
    async (t) => {
      for (const name of requiredConstantNames) {
        await t.test(name, () => {
          const observation = expectRecord(
            manifest.observedUpstreamConstants.find((entry) => entry?.name === name),
            `constant-source evidence obligation failed for ${name}`
          );
          assert.ok(
            Array.isArray(observation.sourceLocations) && observation.sourceLocations.length > 0,
            `constant-source evidence obligation failed for ${name}: sourceLocations must be non-empty`
          );

          const sourceTexts = [];
          const excerpts = [];
          for (const [index, location] of observation.sourceLocations.entries()) {
            assertObservedString(
              location,
              `constant-source evidence obligation failed for ${name} sourceLocations[${index}]`
            );
            const { path: upstreamPath, ranges, leafPath } = parseSourceLocation(location);
            const blobId = resolveUpstreamBlobId(observation.commit, upstreamPath);
            const blob = readGitObject(blobId);
            assert.equal(
              blob.type,
              'blob',
              `constant-source evidence obligation failed for ${name}: ${upstreamPath} resolves to ${blobId} which is not a blob`
            );
            const sourceText = blob.payload.toString('utf8');
            sourceTexts.push(sourceText);
            for (const text of lineRangedExcerpts(
              sourceText,
              ranges,
              `constant-source evidence obligation failed for ${name} sourceLocations[${index}]`
            )) {
              excerpts.push({ text, leafPath });
            }
          }

          assertConstantValueEvidencedInExcerpts(
            observation.value,
            excerpts,
            sourceTexts.join('\n'),
            `constant-source evidence obligation failed for ${name}`
          );
        });
      }
    }
  );

  await t.test('resolves every recorded pin-boundary entry to one release', () => {
    for (const [collectionName, entries] of [
      ['interfaceDefinitions', manifest.interfaceDefinitions],
      ['artifacts', manifest.artifacts],
      ['observedUpstreamConstants', manifest.observedUpstreamConstants],
    ]) {
      assert.ok(
        Array.isArray(entries),
        `single-release obligation failed: ${collectionName} must be an array`
      );
      for (const [index, entry] of entries.entries()) {
        assertPinnedToSource(entry, source, `${collectionName}[${index}]`);
      }
    }
  });
});

/**
 * Reads the structured JSON block from the contracted Markdown pin manifest.
 *
 * @returns {{ manifest: Record<string, unknown>, markdown: string }} Parsed metadata and source Markdown.
 */
function readPinManifest() {
  assert.ok(
    existsSync(manifestPath),
    'pin-manifest location obligation failed: missing apps/nanohost/openshell-pin/manifest.md'
  );
  const markdown = readFileSync(manifestPath, 'utf8');
  const blocks = [...markdown.matchAll(jsonBlockPattern)];
  assert.equal(
    blocks.length,
    1,
    'pin-manifest structure obligation failed: manifest.md must contain exactly one fenced JSON metadata block'
  );
  return {
    manifest: expectRecord(
      JSON.parse(blocks[0][1]),
      'pin-manifest structure obligation failed: JSON metadata must be an object'
    ),
    markdown,
  };
}

/**
 * Requires an object record for one manifest section.
 *
 * @param {unknown} value Candidate value.
 * @param {string} message Obligation-specific failure message.
 * @returns {Record<string, any>} Object record.
 */
function expectRecord(value, message) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), message);
  return value;
}

/**
 * Requires one non-placeholder string.
 *
 * @param {unknown} value Candidate value.
 * @param {string} message Obligation-specific failure prefix.
 */
function assertObservedString(value, message) {
  assert.equal(typeof value, 'string', `${message} must be a string`);
  assert.ok(value.trim(), `${message} must not be empty`);
  assert.doesNotMatch(value.trim(), placeholderPattern, `${message} must not be a placeholder`);
}

/**
 * Requires a recorded observation while allowing boolean absence observations.
 *
 * @param {unknown} value Recorded upstream value.
 * @param {string} message Obligation-specific failure prefix.
 */
function assertObservedValue(value, message) {
  assert.notEqual(value, null, `${message} must not be null`);
  assert.notEqual(value, undefined, `${message} must be present`);
  if (typeof value === 'string') {
    assertObservedString(value, message);
    return;
  }
  if (Array.isArray(value)) {
    assert.ok(value.length > 0, `${message} must not be an empty array`);
    value.forEach((entry, index) => {
      assertObservedValue(entry, `${message}[${index}]`);
    });
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    assert.ok(entries.length > 0, `${message} must not be an empty object`);
    entries.forEach(([key, entry]) => {
      assertObservedValue(entry, `${message}.${key}`);
    });
    return;
  }
  assert.ok(
    typeof value === 'number' || typeof value === 'boolean',
    `${message} must be a concrete string, number, boolean, array, or object`
  );
}

/**
 * Proves that one recorded boundary entry uses the manifest's exact pin.
 *
 * @param {unknown} value Candidate boundary entry.
 * @param {Record<string, any>} source Manifest source provenance.
 * @param {string} description Entry description used in failures.
 */
function assertPinnedToSource(value, source, description) {
  const entry = expectRecord(value, `single-release obligation failed: invalid ${description}`);
  assert.equal(
    entry.tag,
    source.tag,
    `single-release obligation failed: ${description} tag differs from source.tag`
  );
  assert.equal(
    entry.commit,
    source.commit,
    `single-release obligation failed: ${description} commit differs from source.commit`
  );
}

/**
 * Reads the pinned commit the accepted Stock Realization Annex names, so the manifest is judged
 * against an owner it does not control rather than against its own recorded identity.
 *
 * @returns {string} Full commit identity printed by the annex `### Pin Manifest Location` section.
 */
function readSpecifiedPinCommit() {
  const section = /^### Pin Manifest Location$([\s\S]*?)(?=^### )/mu.exec(
    readFileSync(annexPath, 'utf8')
  );
  assert.ok(
    section,
    'external pin-identity obligation failed: the annex declares no Pin Manifest Location section'
  );
  const commits = new Set([...section[1].matchAll(/`([0-9a-f]{40})`/gu)].map((match) => match[1]));
  assert.equal(
    commits.size,
    1,
    `external pin-identity obligation failed: the annex Pin Manifest Location section names ${commits.size} commit identities instead of exactly one`
  );
  return [...commits][0];
}

/**
 * Calculates one git object identity from a raw object payload.
 *
 * @param {string} type Git object type.
 * @param {Buffer} payload Raw uncompressed object payload without its header.
 * @returns {string} Hexadecimal git object id.
 */
function gitObjectId(type, payload) {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`${type} ${payload.length}\0`, 'utf8'), payload]))
    .digest('hex');
}

/**
 * Reads one retained upstream git object and proves it hashes to the id its file name claims.
 *
 * Objects are retained as raw uncompressed payloads named by their own object id, so the object
 * type is recovered by finding the single type whose header reproduces that id.
 *
 * @param {string} id Expected hexadecimal git object id.
 * @returns {{ type: string, payload: Buffer }} Verified object type and payload.
 */
function readGitObject(id) {
  const path = join(gitObjectRoot, id);
  assert.ok(
    existsSync(path) && statSync(path).isFile(),
    `upstream-object evidence obligation failed: missing retained git object ${relative(repoRoot, path)}`
  );
  const payload = readFileSync(path);
  const type = gitObjectTypes.find((candidate) => gitObjectId(candidate, payload) === id);
  assert.ok(
    type,
    `upstream-object evidence obligation failed: retained object ${id} does not hash to its own name as a commit, tree, or blob`
  );
  return { type, payload };
}

/**
 * Parses one raw git tree payload into its named entries.
 *
 * @param {Buffer} payload Raw tree payload.
 * @returns {Map<string, { mode: string, id: string }>} Entries keyed by name.
 */
function parseGitTree(payload) {
  const entries = new Map();
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    const nul = payload.indexOf(0x00, space);
    entries.set(payload.subarray(space + 1, nul).toString('utf8'), {
      mode: payload.subarray(offset, space).toString('utf8'),
      id: payload.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/**
 * Walks the retained upstream tree chain from one commit to the blob it names at one path.
 *
 * @param {string} commit Pinned upstream commit identity.
 * @param {string} upstreamPath Repository-relative path inside the upstream project.
 * @returns {string} Blob object id the commit names at that path.
 */
function resolveUpstreamBlobId(commit, upstreamPath) {
  const root = readGitObject(commit);
  assert.equal(
    root.type,
    'commit',
    `upstream-object evidence obligation failed: retained object ${commit} is not a commit`
  );
  const rootTree = /^tree ([0-9a-f]{40})$/mu.exec(root.payload.toString('utf8'));
  assert.ok(
    rootTree,
    `upstream-object evidence obligation failed: retained commit ${commit} names no root tree`
  );

  const segments = upstreamPath.split('/');
  let treeId = rootTree[1];
  for (const [index, segment] of segments.entries()) {
    const tree = readGitObject(treeId);
    assert.equal(
      tree.type,
      'tree',
      `upstream-object evidence obligation failed: retained object ${treeId} is not a tree`
    );
    const entry = parseGitTree(tree.payload).get(segment);
    assert.ok(
      entry,
      `upstream-object evidence obligation failed: ${commit} names no ${segment} under ${segments.slice(0, index).join('/') || 'the root tree'}`
    );
    if (index === segments.length - 1) {
      return entry.id;
    }
    treeId = entry.id;
  }
  return treeId;
}

/**
 * Reads one retained publisher checksum file as its published name-to-digest entries.
 *
 * @param {string} name Publisher checksum file name recorded by the manifest.
 * @returns {Map<string, string>} Published SHA-256 digests keyed by artifact name.
 */
function readPublisherChecksums(name) {
  const path = join(publisherChecksumRoot, name);
  assert.ok(
    existsSync(path) && statSync(path).isFile(),
    `publisher-digest obligation failed: missing retained publisher checksum file ${relative(repoRoot, path)}`
  );
  const entries = new Map(
    [...readFileSync(path, 'utf8').matchAll(/^([0-9a-f]{64})\s+\*?(\S+)$/gimu)].map((match) => [
      match[2],
      match[1].toLowerCase(),
    ])
  );
  assert.ok(
    entries.size > 0,
    `publisher-digest obligation failed: retained ${name} records no published digest`
  );
  return entries;
}

/**
 * Reads the retained extracted-executable checksum file as publisher-style name-to-digest entries.
 *
 * The file uses the same `digest  name` line shape as publisher checksum files and must cover every
 * artifact that records `derivedFrom`.
 *
 * @returns {Map<string, string>} Extracted SHA-256 digests keyed by executable name.
 */
function readExtractedChecksums() {
  assert.ok(
    existsSync(extractedChecksumPath) && statSync(extractedChecksumPath).isFile(),
    `extracted-digest obligation failed: missing retained ${relative(repoRoot, extractedChecksumPath)}`
  );
  const entries = new Map(
    [
      ...readFileSync(extractedChecksumPath, 'utf8').matchAll(/^([0-9a-f]{64})\s+\*?(\S+)$/gimu),
    ].map((match) => [match[2], match[1].toLowerCase()])
  );
  assert.ok(
    entries.size > 0,
    `extracted-digest obligation failed: retained ${relative(repoRoot, extractedChecksumPath)} records no extracted digest`
  );
  return entries;
}

/**
 * Parses one recorded upstream `sourceLocations` entry into its path, line ranges, and optional
 * numeric leaf-path annotation.
 *
 * Accepts `path`, `path:62`, `path:24-25`, `path:24-25,336-394`, `path:62#bytes`, or
 * `path:25#logicalExpirySeconds`. Grammar: `path[:ranges][#leafPath]`. Each comma-separated range
 * segment is one inclusive 1-based line range (a lone integer is a single-line range). The optional
 * `#leafPath` names the numeric leaf under `value` that this location may evidence (for example
 * `#bytes` or `#logicalExpirySeconds`; nested leaves use dotted paths).
 *
 * @param {string} location Manifest `sourceLocations` entry.
 * @returns {{
 *   path: string,
 *   ranges: Array<{ start: number, end: number }>,
 *   leafPath: string | null
 * }} Path, parsed ranges, and leaf annotation; an empty `ranges` array means the whole blob is one
 *   excerpt; `leafPath` is null when the location is unannotated.
 */
function parseSourceLocation(location) {
  const hash = location.indexOf('#');
  let leafPath = null;
  let withoutLeaf = location;
  if (hash !== -1) {
    leafPath = location.slice(hash + 1);
    withoutLeaf = location.slice(0, hash);
    assert.ok(
      leafPath.length > 0,
      `constant-source evidence obligation failed: source location ${JSON.stringify(location)} has an empty #leafPath`
    );
    assert.match(
      leafPath,
      /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u,
      `constant-source evidence obligation failed: source location ${JSON.stringify(location)} has an invalid #leafPath`
    );
  }

  const separator = withoutLeaf.indexOf(':');
  if (separator === -1) {
    return { path: withoutLeaf, ranges: [], leafPath };
  }
  const path = withoutLeaf.slice(0, separator);
  const rangesText = withoutLeaf.slice(separator + 1).trim();
  if (!rangesText) {
    return { path, ranges: [], leafPath };
  }
  const ranges = rangesText.split(',').map((part, index) => {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part.trim());
    assert.ok(
      match,
      `constant-source evidence obligation failed: source location ${JSON.stringify(location)} has invalid line range at segment ${index}`
    );
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    assert.ok(
      Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start,
      `constant-source evidence obligation failed: source location ${JSON.stringify(location)} has non-positive or inverted line range at segment ${index}`
    );
    return { start, end };
  });
  return { path, ranges, leafPath };
}

/**
 * Cuts one UTF-8 source blob into the line-ranged excerpts named by `ranges`.
 *
 * @param {string} sourceText Full upstream blob text.
 * @param {Array<{ start: number, end: number }>} ranges Inclusive 1-based line ranges; empty means
 *   the whole blob is returned as the sole excerpt.
 * @param {string} message Obligation-specific failure prefix.
 * @returns {string[]} One excerpt string per range (or one whole-blob excerpt).
 */
function lineRangedExcerpts(sourceText, ranges, message) {
  if (ranges.length === 0) {
    return [sourceText];
  }
  const lines = sourceText.split(/\r?\n/u);
  return ranges.map(({ start, end }) => {
    assert.ok(
      end <= lines.length,
      `${message}: line range ${start}-${end} exceeds blob length ${lines.length}`
    );
    return lines.slice(start - 1, end).join('\n');
  });
}

/**
 * Collects every numeric leaf under one recorded constant value, preserving a dotted path for
 * failure messages.
 *
 * @param {unknown} value Recorded constant value from the manifest.
 * @param {string} [path] Path prefix for nested leaves.
 * @returns {Array<{ value: number, path: string }>} Numeric leaves in encounter order.
 */
function collectNumericLeaves(value, path = '') {
  if (typeof value === 'number') {
    return [{ value, path: path || 'value' }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectNumericLeaves(entry, path ? `${path}[${index}]` : `[${index}]`)
    );
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) =>
      collectNumericLeaves(entry, path ? `${path}.${key}` : key)
    );
  }
  return [];
}

/**
 * Reports whether one recorded number appears in source text as a token-bounded decimal literal or
 * as an owner-independent two-factor product that evaluates to it.
 *
 * Decimal evidence requires a Rust-literal-safe numeric token (`\b` boundaries; optional
 * underscores inside the literal) whose digit value equals the recorded number, so `10` does not
 * match inside `3600`. Accepted product shape (minimum): `A * B` / `A*B` with optional spaces
 * around `*` and optional underscores inside either numeric literal (for example `64 * 1024` or
 * `16*1_024` for `65536` / `16384`). Only exact finite products equal to the recorded number count.
 *
 * @param {number} value Recorded numeric leaf.
 * @param {string} sourceText One line-ranged excerpt (or other UTF-8 source fragment).
 * @returns {boolean} True when the number is evidenced in that text.
 */
function numberEvidencedInText(value, sourceText) {
  for (const match of sourceText.matchAll(/\b(\d[\d_]*)\b/gu)) {
    if (Number(match[1].replaceAll('_', '')) === value) {
      return true;
    }
  }
  for (const match of sourceText.matchAll(/\b(\d[\d_]*)\s*\*\s*(\d[\d_]*)\b/gu)) {
    const left = Number(match[1].replaceAll('_', ''));
    const right = Number(match[2].replaceAll('_', ''));
    if (Number.isFinite(left) && Number.isFinite(right) && left * right === value) {
      return true;
    }
  }
  return false;
}

/**
 * Selects the line-ranged excerpts that may evidence one numeric leaf.
 *
 * Annotated excerpts count only for the leaf named by their `#leafPath`. Unannotated excerpts may
 * evidence a numeric leaf only when the observation records exactly one numeric leaf; with multiple
 * numeric leaves they are ignored for numeric binding (they may still contribute joined text for
 * non-numeric leaves).
 *
 * @param {{ value: number, path: string }} leaf Numeric leaf from the recorded value.
 * @param {Array<{ text: string, leafPath: string | null }>} excerpts Annotated line-ranged excerpts.
 * @param {boolean} multipleNumericLeaves Whether the observation has more than one numeric leaf.
 * @returns {Array<{ text: string, leafPath: string | null }>} Candidate excerpts for this leaf.
 */
function excerptsForNumericLeaf(leaf, excerpts, multipleNumericLeaves) {
  return excerpts.filter((excerpt) => {
    if (excerpt.leafPath !== null) {
      return excerpt.leafPath === leaf.path;
    }
    return !multipleNumericLeaves;
  });
}

/**
 * Asserts that one recorded constant value is evidenced in retained pinned source material.
 *
 * Numeric leaves: each leaf must be evidenced via {@link numberEvidencedInText} in at least one
 * line-ranged excerpt from a `sourceLocations` entry annotated with that exact leaf path
 * (`#leafPath`). Unannotated locations may evidence a numeric leaf only when the observation has
 * exactly one numeric leaf; with multiple numeric leaves, unannotated locations are ignored for
 * numeric binding.
 *
 * Non-numeric leaves: booleans and strings must still appear in the joined cited blobs; arrays and
 * objects recurse the same way. Numeric leaves are not re-checked against the join.
 *
 * @param {unknown} value Recorded constant value from the manifest.
 * @param {Array<{ text: string, leafPath: string | null }>} excerpts Line-ranged UTF-8 excerpts from
 *   the cited upstream source blobs, each carrying its optional `#leafPath` annotation.
 * @param {string} joinedSourceText UTF-8 concatenation of the full cited upstream source blobs.
 * @param {string} message Obligation-specific failure prefix.
 */
function assertConstantValueEvidencedInExcerpts(value, excerpts, joinedSourceText, message) {
  assert.ok(
    Array.isArray(excerpts) && excerpts.length > 0,
    `${message}: sourceLocations must yield at least one line-ranged excerpt`
  );
  const numericLeaves = collectNumericLeaves(value);
  const multipleNumericLeaves = numericLeaves.length > 1;
  for (const leaf of numericLeaves) {
    const candidates = excerptsForNumericLeaf(leaf, excerpts, multipleNumericLeaves);
    assert.ok(
      candidates.length > 0,
      `${message}: recorded numeric leaf ${leaf.path}=${leaf.value} has no eligible line-ranged excerpt (annotate a sourceLocations entry with #${leaf.path})`
    );
    assert.ok(
      candidates.some((excerpt) => numberEvidencedInText(leaf.value, excerpt.text)),
      `${message}: recorded numeric leaf ${leaf.path}=${leaf.value} is not evidenced in any eligible line-ranged excerpt annotated for that leaf`
    );
  }
  assertNonNumericConstantValueEvidencedInText(value, joinedSourceText, message);
}

/**
 * Asserts non-numeric constant leaves against joined cited blob text; numeric leaves are skipped
 * because {@link assertConstantValueEvidencedInExcerpts} already binds them to leaf-annotated
 * line-ranged excerpts.
 *
 * @param {unknown} value Recorded constant value from the manifest.
 * @param {string} sourceText UTF-8 concatenation of the cited upstream source blobs.
 * @param {string} message Obligation-specific failure prefix.
 */
function assertNonNumericConstantValueEvidencedInText(value, sourceText, message) {
  if (typeof value === 'number') {
    return;
  }
  if (typeof value === 'boolean') {
    assert.ok(
      sourceText.includes(String(value)),
      `${message}: recorded boolean ${value} is not evidenced in the cited pinned source blobs`
    );
    return;
  }
  if (typeof value === 'string') {
    assert.ok(
      sourceText.includes(value),
      `${message}: recorded string ${JSON.stringify(value)} is not evidenced in the cited pinned source blobs`
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNonNumericConstantValueEvidencedInText(entry, sourceText, `${message}[${index}]`);
    });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertNonNumericConstantValueEvidencedInText(entry, sourceText, `${message}.${key}`);
    }
    return;
  }
  assert.fail(`${message}: unsupported constant value type ${typeof value}`);
}

/**
 * Calculates the SHA-256 identity of one vendored interface-definition file.
 *
 * @param {string} path Absolute file path.
 * @returns {string} Algorithm-qualified checksum identity.
 */
function sha256File(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}
