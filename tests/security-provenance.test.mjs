// NEW-only provenance policy/subject projection checks, not a cryptographic verification claim.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const { attestationArguments } = await import(
  pathToFileURL(join(root, 'scripts/verify-release-integrity.mjs')).href
);
const { provenanceSubjects } = await import(
  pathToFileURL(join(root, 'scripts/release-sbom.mjs')).href
);
const repository = 'lingkaix/openkit';
const sha = 'a'.repeat(40);
const subject = 'synthetic-archive.tar.gz';

/** Read native argv options without prescribing option ordering or equals syntax. */
function option(args, name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function policy(args, tag, workflow) {
  assert.ok(Array.isArray(args), 'Verifier must produce native argv');
  assert.deepEqual(
    args.slice(0, 2),
    ['attestation', 'verify'],
    'Native verifier must perform attestation verification'
  );
  assert.ok(args.includes(subject), 'Native verification must target the exact subject');
  assert.equal(
    option(args, '--repo') ?? option(args, '-R'),
    repository,
    'Attestation lookup must bind the repository'
  );
  assert.equal(
    option(args, '--source-ref'),
    `refs/tags/${tag}`,
    'Source ref must bind the exact release tag'
  );
  assert.equal(
    option(args, '--source-digest'),
    sha,
    'Source digest must bind the exact release commit'
  );
  const signer = option(args, '--signer-workflow');
  assert.ok(
    signer === `${repository}/.github/workflows/${workflow}` ||
      signer === `github.com/${repository}/.github/workflows/${workflow}`,
    'Signer must be the fixed release workflow'
  );
  assert.equal(
    option(args, '--cert-oidc-issuer'),
    'https://token.actions.githubusercontent.com',
    'Certificate issuer must be GitHub Actions'
  );
  assert.ok(
    args.includes('--deny-self-hosted-runners'),
    'Verifier must exclude self-hosted signing'
  );
  assert.equal(
    option(args, '--predicate-type'),
    'https://slsa.dev/provenance/v1',
    'Verifier must require SLSA v1'
  );
}

test('native attestation argv binds exact release identity and does not accept a signer override', () => {
  for (const [tag, workflow] of [
    ['v0.1.0-rc.1', 'ci.yml'],
    ['v0.1.0', 'release-promotion.yml'],
  ]) {
    const input = { subject, repository, tag, sha };
    policy(attestationArguments(input), tag, workflow);
    let override;
    try {
      override = attestationArguments({ ...input, signerWorkflow: 'foreign/repository/other.yml' });
    } catch (error) {
      assert.ok(error instanceof Error, 'Invalid caller override must refuse');
    }
    if (override !== undefined) policy(override, tag, workflow);
  }
});

test('release verification refuses foreign namespaces and invalid identities but retains bounded rehearsal', () => {
  const valid = { subject, repository, tag: 'v0.1.0-rc.1', sha };
  for (const change of [
    { repository: 'foreign/openkit' },
    { repository: 'lingkaix/other' },
    { repository: 'notrucked/openkit', tag: 'v1.0.0' },
    { tag: 'refs/heads/main' },
    { tag: 'main' },
    { tag: '' },
    { sha: 'a'.repeat(39) },
    { sha: 'z'.repeat(40) },
    { subject: '' },
  ])
    assert.throws(
      () => attestationArguments({ ...valid, ...change }),
      Error,
      'Invalid release identity must refuse'
    );
  assert.doesNotThrow(
    () => attestationArguments({ ...valid, repository: 'notrucked/openkit', tag: 'v0.0.3' }),
    'Bounded synthetic stable rehearsal must remain legal'
  );
  assert.doesNotThrow(
    () => attestationArguments({ ...valid, repository: 'notrucked/openkit', tag: 'v0.0.3-rc.1' }),
    'Bounded synthetic prerelease rehearsal must remain legal'
  );
});

test('provenance checksum rows bind every controlled file and every immutable catalog image subject', () => {
  const assetsDir = mkdtempSync(join(tmpdir(), 'security-provenance-'));
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  try {
    const tag = 'v0.1.0-rc.1';
    const filenames = [
      `openkit-ops-skill-${tag}.tar.gz`,
      ...['amd64', 'arm64'].map((arch) => `openkit-nanohost-${tag}-linux-${arch}.tar.gz`),
    ];
    const files = new Map(
      filenames.map((name, index) => [name, Buffer.from(`synthetic controlled archive ${index}\n`)])
    );
    const catalog = JSON.parse(
      readFileSync(join(root, 'containers/images.json'), 'utf8')
    ).images.filter((image) => image.release);
    assert.equal(catalog.length, 3, 'Fixture must cover the complete three-image catalog');
    let ordinal = 0;
    const digest = () => `sha256:${(++ordinal).toString(16).padStart(64, '0')}`;
    const images = catalog.map((image) => {
      assert.equal(image.platforms.length, 2, 'Fixture must cover both catalog platforms');
      return {
        id: image.id,
        image: `ghcr.io/lingkaix/${image.repository}`,
        digest: digest(),
        platforms: image.platforms.map((platform) => ({ platform, digest: digest() })),
      };
    });
    const manifest = {
      schemaVersion: 1,
      repository,
      tag,
      sourceCommit: sha,
      images,
      assets: filenames.map((name) => ({ name, sha256: hash(files.get(name)) })),
    };
    const manifestName = `openkit-release-${tag}.json`;
    files.set(manifestName, Buffer.from(JSON.stringify(manifest)));
    files.set(
      'SHA256SUMS',
      Buffer.from([...files].map(([name, bytes]) => `${hash(bytes)}  ${name}`).join('\n') + '\n')
    );
    for (const [name, bytes] of files) writeFileSync(join(assetsDir, name), bytes);
    const text = provenanceSubjects({ manifest, assetsDir });
    assert.equal(typeof text, 'string', 'Subject projection must produce standard checksum rows');
    const rows = text
      .trim()
      .split('\n')
      .map((line) => {
        const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/u);
        assert.ok(match, 'Every subject must be a SHA-256 checksum row');
        return { digest: match[1], name: match[2] };
      });
    assert.equal(
      rows.length,
      files.size + images.reduce((count, image) => count + 1 + image.platforms.length, 0),
      'Complete subject inventory must be retained without collapsing platforms'
    );
    for (const [name, bytes] of files) {
      const matches = rows.filter((row) => row.name === name || row.name === join(assetsDir, name));
      assert.equal(matches.length, 1, 'Each controlled file must have its own subject');
      assert.equal(matches[0].digest, hash(bytes), 'File subject must bind the exact bytes');
    }
    for (const image of images)
      for (const identity of [image, ...image.platforms]) {
        const immutable = `${image.image}@${identity.digest}`;
        const matches = rows.filter(
          (row) => row.name === immutable || row.name === `oci://${immutable}`
        );
        assert.equal(
          matches.length,
          1,
          'Each index and platform needs an immutable OCI subject name'
        );
        assert.equal(
          matches[0].digest,
          identity.digest.slice('sha256:'.length),
          'OCI checksum row must retain the exact manifest digest'
        );
      }
  } finally {
    rmSync(assetsDir, { recursive: true, force: true });
  }
});
