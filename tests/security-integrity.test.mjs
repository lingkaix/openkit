import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
const { parse } = createRequire(join(root, 'package.json'))('yaml');
const directory = join(root, '.github/workflows');
const workflows = readdirSync(directory)
  .filter((name) => /\.ya?ml$/u.test(name))
  .map((name) => ({
    name,
    document: parse(readFileSync(join(directory, name), 'utf8')),
  }));
const ci = workflows.find(({ name }) => name === 'ci.yml').document;
const commands = (job) => (job.steps ?? []).map((step) => step.run ?? '').join('\n');
const declared = (job) => JSON.stringify(job);
const invokes = (job, script) =>
  new RegExp(`\\bnode(?:\\s+--[\\w=-]+)*\\s+(?:\\./)?scripts/${script}\\.mjs(?:\\s|$)`, 'mu').test(
    commands(job)
  );
const dependencies = (job) => (typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []));

/** The configuration oracle follows declared ordering, not job display names. */
function upstream(workflow, before, after, seen = new Set()) {
  if (before === after) return true;
  if (seen.has(after)) return false;
  seen.add(after);
  return dependencies(workflow.jobs[after]).some(
    (id) => workflow.jobs[id] && upstream(workflow, before, id, seen)
  );
}

function tagOnly(workflow, job) {
  const triggers = workflow.on ?? {};
  if (
    Object.keys(triggers).every((event) => event === 'push') &&
    triggers.push?.tags?.length &&
    !triggers.push.branches
  )
    return;
  assert.match(
    String(job.if),
    /github\.event_name\s*==\s*['"]push['"]/u,
    'Signing must require a push'
  );
  assert.match(
    String(job.if),
    /startsWith\(github\.ref,\s*['"]refs\/tags\//u,
    'Signing must require a release tag'
  );
  assert.doesNotMatch(String(job.if), /\|\|/u, 'Signing must not admit a non-tag alternative');
}

const attests = (step) => /^actions\/attest(?:-build-provenance)?@/u.test(step.uses ?? '');

test('tag publication declares SBOM production and attachment/checksum delivery for every subject family', () => {
  const producers = Object.entries(ci.jobs).filter(([, job]) => invokes(job, 'release-sbom'));
  assert.ok(producers.length > 0, 'Tag path must invoke the SBOM producer');
  for (const [id, job] of producers) {
    tagOnly(ci, job);
    assert.ok(
      upstream(ci, id, 'github-release'),
      'SBOM production must complete before release attachment publication'
    );
  }
  // The complete release manifest/record inventory can carry both indexes and platform digests;
  // no per-platform workflow matrix or particular command-line option is prescribed here.
  const path = [
    ...producers.map(([, job]) => declared(job)),
    declared(ci.jobs['github-release']),
  ].join('\n');
  assert.match(
    path,
    /manifest|image.*record/iu,
    'SBOM production must receive the released image subject inventory'
  );
  assert.match(
    path,
    /nanohost|portable.*asset/iu,
    'SBOM production must include NanoHost archive subjects'
  );
  assert.match(
    path,
    /SHA256SUMS/u,
    'Release attachments must bind SBOM bytes through the release checksum'
  );
  assert.match(path, /sbom/iu, 'SBOM attachments must enter the release publication path');
  assert.match(
    commands(ci.jobs['github-release']),
    /release-(?:assets|manifest)|gh release|release-sbom/u,
    'The tag path must publish the generated release assets'
  );
});

test('GitHub provenance signing covers image and archive subjects with tag-only short-lived authority', () => {
  const signingJobs = [];
  for (const { document } of workflows) {
    const global = document.permissions ?? {};
    assert.notEqual(global['id-token'], 'write', 'OIDC write must not be a workflow-wide grant');
    assert.notEqual(
      global.attestations,
      'write',
      'Attestation write must not be a workflow-wide grant'
    );
    for (const [id, job] of Object.entries(document.jobs ?? {})) {
      const signing = (job.steps ?? []).filter(attests);
      const permissions = job.permissions ?? global;
      if (
        signing.length ||
        permissions['id-token'] === 'write' ||
        permissions.attestations === 'write'
      ) {
        tagOnly(document, job);
        assert.equal(permissions['id-token'], 'write', 'Signing must use GitHub OIDC');
        assert.equal(
          permissions.attestations,
          'write',
          'Signing must declare attestation authority'
        );
        assert.ok(
          signing.length > 0,
          'Signing authority must belong to an actual GitHub attestation caller'
        );
        signingJobs.push({ document, id, job, signing });
      }
      for (const step of job.steps ?? []) {
        if (
          step.uses?.startsWith('docker/build-push-action@') &&
          (id === 'candidate-images' || step.with?.provenance !== undefined)
        )
          assert.equal(
            step.with?.provenance,
            false,
            'Release image BuildKit provenance must remain disabled'
          );
        assert.doesNotMatch(
          JSON.stringify(step),
          /secrets\.[A-Z_]*(?:SIGNING_KEY|PRIVATE_KEY|COSIGN_KEY)/u,
          'Provenance must not use a long-lived signing key'
        );
      }
    }
  }
  assert.ok(signingJobs.length > 0, 'Release path must produce GitHub provenance attestations');
  const image = signingJobs.flatMap(({ job, signing }) =>
    signing.filter(
      (step) =>
        step.with?.['subject-digest'] ||
        (step.with?.['subject-checksums'] && /manifest|image.*record/iu.test(declared(job)))
    )
  );
  assert.ok(image.length > 0, 'Immutable OCI subjects need digest-bound attestations');
  const coverage = signingJobs.map(({ job }) => declared(job)).join('\n');
  assert.match(
    coverage,
    /platform/iu,
    'Provenance must include platform manifests, not just indexes'
  );
  assert.match(
    coverage,
    /index|manifest/iu,
    'Provenance must include multi-platform index identities'
  );
  assert.match(coverage, /nanohost|portable.*asset/iu, 'Provenance must cover NanoHost archives');
  assert.match(coverage, /SHA256SUMS/u, 'Provenance must cover the exact checksum attachment');
  for (const { id, job } of signingJobs.filter(({ document }) => document === ci)) {
    assert.ok(
      upstream(ci, id, 'verify-release'),
      'Terminal verification must wait for provenance production'
    );
    assert.match(
      declared(job),
      /GITHUB_SHA|github\.sha|sourceCommit/u,
      'Signing must retain the current release source binding'
    );
  }
});

test('terminal release verification invokes integrity checks for the complete published release', () => {
  const terminal = ci.jobs['verify-release'];
  assert.ok(
    invokes(terminal, 'verify-release-integrity'),
    'Terminal job must actually invoke the integrity verifier'
  );
  const permissions = terminal.permissions ?? ci.permissions;
  assert.ok(
    Object.values(permissions).every((value) => value === 'read' || value === 'none'),
    'Integrity verification must not have writer authority'
  );
  const inputs = declared(terminal);
  assert.match(
    inputs,
    /GITHUB_REPOSITORY|github\.repository/u,
    'Verification must bind the release namespace'
  );
  assert.match(
    inputs,
    /GITHUB_REF_NAME|github\.ref_name/u,
    'Verification must bind the release tag'
  );
  assert.match(
    inputs,
    /GITHUB_SHA|github\.sha|sourceCommit/u,
    'Verification must bind the exact release source'
  );
  assert.match(
    inputs,
    /manifest|image.*record/iu,
    'Verifier must receive the complete image subject inventory'
  );
  assert.match(
    inputs,
    /SHA256SUMS|release.*asset/iu,
    'Verifier must receive the controlled attachment inventory'
  );
});

test('App Docker configuration produces or copies the fixed offline SBOM into the runtime image', () => {
  const catalog = JSON.parse(readFileSync(join(root, 'containers/images.json'), 'utf8'));
  const app = catalog.images.find((image) => image.id === 'app' && image.release);
  assert.ok(app, 'Released App image must be declared');
  const dockerfile = readFileSync(join(root, app.dockerfile), 'utf8').replace(/\\\n/g, ' ');
  const instructions = dockerfile.split('\n').filter((line) => !/^\s*#/u.test(line));
  assert.ok(
    instructions.some(
      (line) =>
        /^\s*(?:RUN|COPY|ADD)\b/iu.test(line) && line.includes('/app/security/sbom.cdx.json')
    ),
    'App build must produce or carry the fixed-path SBOM'
  );
  assert.ok(
    instructions.some(
      (line) =>
        /^\s*(?:RUN|COPY|ADD)\b/iu.test(line) && /release-sbom\.mjs|cyclonedx|sbom/iu.test(line)
    ),
    'Embedded inventory must have a declared producer or copied input'
  );
});
