import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8'));

test('release workflow serializes tag releases and pins third-party actions', () => {
  assert.deepEqual(workflow.on.push.tags, ['v*.*.*']);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.concurrency.group, /openkit-release/);

  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) {
        assert.match(
          step.uses,
          /^[^@]+@[a-f0-9]{40}$/,
          `${step.name} must use an immutable action ref`
        );
      }
    }
  }
});

test('release workflow smokes one digest on every platform before tag promotion', () => {
  const job = workflow.jobs['publish-container-images'];
  const existing = step(job, 'Inspect existing immutable identity');
  const candidate = step(job, 'Build digest-only release candidate');
  const smoke = step(job, 'Smoke every candidate platform');
  const promote = step(job, 'Promote the smoked digest');
  const verify = step(job, 'Verify promoted identity');
  const anonymous = step(job, 'Verify public worker base anonymous pull');
  const record = step(job, 'Write image release record');

  assert.equal(candidate.with.provenance, false);
  assert.match(candidate.with.outputs, /push-by-digest=true/);
  assert.equal(candidate.with.tags, undefined);
  assert.equal(candidate.if, "steps.existing.outputs.present == 'false'");
  assert.equal(smoke.if, "steps.existing.outputs.present == 'false'");
  assert.deepEqual(smoke.env, {
    DIGEST: actionExpression('steps.release.outputs.digest'),
    IMAGE: actionExpression('steps.image.outputs.image'),
    PLATFORMS: actionExpression('matrix.platforms'),
    SMOKE_COMMAND: actionExpression('matrix.smokeCommand'),
  });
  assert.equal(promote.if, "steps.existing.outputs.present == 'false'");
  assert.equal(promote.env.DIGEST, actionExpression('steps.release.outputs.digest'));
  assert.equal(promote.env.IMAGE, actionExpression('steps.image.outputs.image'));
  assert.equal(verify.env.DIGEST, actionExpression('steps.release.outputs.digest'));
  assert.equal(verify.env.LATEST_BEFORE, actionExpression('steps.existing.outputs.latest_before'));
  assert.deepEqual(existing.env, {
    LATEST_TAG: actionExpression('steps.image.outputs.latest_tag'),
    SHA_TAG: actionExpression('steps.image.outputs.sha_tag'),
    VERSION_TAG: actionExpression('steps.image.outputs.version_tag'),
    VERSION_WITHOUT_V_TAG: actionExpression('steps.image.outputs.version_without_v_tag'),
  });
  assert.ok(job.steps.indexOf(smoke) < job.steps.indexOf(promote));
  assert.ok(job.steps.indexOf(promote) < job.steps.indexOf(verify));
  assert.equal(anonymous.if, 'matrix.anonymousPull');
  assert.deepEqual(anonymous.env, {
    DIGEST: actionExpression('steps.release.outputs.digest'),
    IMAGE: actionExpression('steps.image.outputs.image'),
  });
  assert.ok(job.steps.indexOf(verify) < job.steps.indexOf(anonymous));
  assert.equal(record.env.ANONYMOUS_PULL, actionExpression('matrix.anonymousPull'));
});

test('release workflow publishes and independently verifies the portable release bundle', () => {
  const preflight = workflow.jobs['release-preflight'];
  const githubRelease = workflow.jobs['github-release'];
  const verify = workflow.jobs['verify-release'];
  const download = step(verify, 'Download and verify GitHub Release assets');
  const anonymous = step(verify, 'Verify public worker base without registry credentials');

  assert.equal(preflight.needs, 'test-image');
  assert.deepEqual(preflight.permissions, { contents: 'read', packages: 'read' });
  assert.deepEqual(githubRelease.needs, ['package-release-assets', 'publish-container-images']);
  assert.deepEqual(githubRelease.permissions, { contents: 'write' });
  assert.ok(step(githubRelease, 'Create immutable GitHub Release'));
  assert.deepEqual(verify.needs, ['test-image', 'github-release', 'publish-container-images']);
  assert.deepEqual(verify.permissions, { contents: 'read', packages: 'read' });
  assert.equal(download.env.GH_TOKEN, actionExpression('secrets.GITHUB_TOKEN'));
  assert.equal(download.env.TEST_IMAGE, actionExpression('needs.test-image.outputs.image'));
  assert.ok(verify.steps.indexOf(download) < verify.steps.indexOf(anonymous));
});

test('release workflow builds NanoHost natively and publishes one checksummed portable bundle', () => {
  const nativeEntry = Object.entries(workflow.jobs).find(
    ([, job]) => job['runs-on'] === 'ubuntu-24.04-arm'
  );
  assert.ok(nativeEntry, 'Missing native arm64 NanoHost build job');
  const [nativeJobId, nativeJob] = nativeEntry;
  assert.match(nativeJob.if, /refs\/tags/);
  const toolchain = nativeJob.steps.find((candidate) =>
    candidate.uses?.startsWith('jdx/mise-action@')
  );
  assert.ok(toolchain, 'Native build must provision the app-owned Rust pin through mise');
  assert.equal(toolchain.with?.working_directory, 'apps/nanohost');
  assert.equal(toolchain.with?.install_args, 'rust');
  const nativeCommands = (nativeJob.steps ?? [])
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.match(nativeCommands, /cargo build --locked --release/);
  assert.match(nativeCommands, /nanohost --version/);
  assert.doesNotMatch(nativeCommands, /rustup|mise (?:exec|run)/u);
  assert.ok(
    nativeJob.steps.some((candidate) => candidate.uses?.startsWith('actions/upload-artifact@')),
    'Native build must hand off the raw NanoHost binary'
  );

  const portable = workflow.jobs['package-release-assets'];
  assert.ok(portable.needs.includes(nativeJobId));
  assert.ok(
    portable.steps.some((candidate) => candidate.uses?.startsWith('actions/download-artifact@')),
    'Portable packaging must download the native binary'
  );
  const portableCommands = portable.steps
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.match(portableCommands, /verify-nanohost-release\.mjs/);
  assert.match(portableCommands, /openkit-nanohost-.*-linux-arm64\.tar\.gz/);
  assert.match(portableCommands, /sha256sum -c SHA256SUMS/);
  const pinStep = portable.steps.find(
    (candidate) =>
      candidate.id &&
      /GITHUB_OUTPUT/u.test(candidate.run ?? '') &&
      ['tag', 'commit', 'archive'].every((name) =>
        new RegExp(`(?:^|[^A-Za-z0-9_])${name}=`, 'u').test(candidate.run)
      )
  );
  assert.ok(pinStep, 'Portable packaging must parse the accepted OpenShell pin once');
  assert.doesNotMatch(portableCommands, /v0\.0\.99|8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032/u);
  assert.doesNotMatch(portableCommands, /openshell-gateway-aarch64-unknown-linux-gnu\.tar\.gz/u);
  const pinConsumer = portable.steps.find((candidate) =>
    /github\.com\/NVIDIA\/OpenShell\/releases\/download/u.test(candidate.run ?? '')
  );
  assert.ok(pinConsumer, 'Portable packaging must download the parsed OpenShell coordinates');
  const releaseCoordinate = pinConsumer.run
    .split('\n')
    .find((line) => line.includes('github.com/NVIDIA/OpenShell/releases/download'));
  const sourceCoordinate = pinConsumer.run
    .split('\n')
    .find((line) => line.includes('raw.githubusercontent.com/NVIDIA/OpenShell'));
  assert.ok(releaseCoordinate, 'Missing OpenShell release download coordinate');
  assert.ok(sourceCoordinate, 'Missing OpenShell source download coordinate');
  assert.match(releaseCoordinate, outputReference(pinStep, pinConsumer, 'tag'));
  assert.match(releaseCoordinate, outputReference(pinStep, pinConsumer, 'archive'));
  assert.match(sourceCoordinate, outputReference(pinStep, pinConsumer, 'commit'));

  const releaseCommands = workflow.jobs['github-release'].steps
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.match(releaseCommands, /openkit-skill-.*\.tar\.gz/);
  assert.match(releaseCommands, /openkit-nanohost-.*-linux-arm64\.tar\.gz/);
  assert.match(releaseCommands, /portable-assets\/SHA256SUMS/);

  const verificationCommands = workflow.jobs['verify-release'].steps
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.match(verificationCommands, /verify-nanohost-release\.mjs/);
  assert.match(verificationCommands, /openkit-nanohost-.*-linux-arm64\.tar\.gz/);
});

test('release workflow runs the fixed-path NanoHost installer gate in one host job', () => {
  const leaf = 'bash tests/support/nanohost-release-installer-live.sh';
  const matches = Object.entries(workflow.jobs).filter(([, job]) =>
    (job.steps ?? []).some((candidate) => candidate.run?.includes(leaf))
  );
  assert.equal(matches.length, 1, 'the NanoHost installer shell leaf must have one CI owner');
  const [jobId, job] = matches[0];
  assert.match(jobId, /nanohost.*installer|installer.*nanohost/u);
  assert.equal(job.container, undefined, 'the Bubblewrap gate must not run in test-env');
  assert.match(String(job['runs-on']), /^ubuntu-/u);
  const commands = (job.steps ?? [])
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.match(
    commands,
    /apt-get install(?:\s+-y)?\s+bubblewrap|apt-get install\s+[^\n]*bubblewrap/u
  );
  assert.match(commands, new RegExp(escapeRegExp(leaf), 'u'));
  assert.doesNotMatch(commands, /pnpm .*nanohost.*installer|scripts\/test-env\.sh/u);
});

test('workspace portability uses two runners only behind release or manual gates', () => {
  const source = workflow.jobs['workspace-portability-source'];
  const target = workflow.jobs['workspace-portability-target'];

  assert.equal(source.if, target.if);
  assert.match(source.if, /github\.event_name == 'push'/u);
  assert.match(source.if, /github\.event_name == 'workflow_dispatch'/u);
  assert.doesNotMatch(source.if, /pull_request/u);
  assert.ok(target.needs.includes('workspace-portability-source'));
  assert.ok(workflow.jobs['package-release-assets'].needs.includes('workspace-portability-target'));
});

test('app-image recovery smoke is manual, host-placed, opted in, and root-Node pinned', () => {
  const job = workflow.jobs['app-image-admin-recovery'];
  assert.equal(
    job.if,
    `github.event_name == 'workflow_dispatch' && contains(fromJSON('["smoke","release-gate","full"]'), inputs.gate)`
  );
  assert.doesNotMatch(job.if, /pull_request|github\.event_name == 'push'/u);
  assert.equal(job.container, undefined);
  assert.match(String(job['runs-on']), /^ubuntu-/u);

  const setup = step(job, 'Set up the pinned root Node toolchain');
  assert.match(setup.uses, /^jdx\/mise-action@[a-f0-9]{40}$/u);
  assert.deepEqual(setup.with, { install_args: 'node' });
  assert.equal(
    step(job, 'Build the disposable app image').run,
    'scripts/docker/build-image.sh app'
  );

  const smoke = step(job, 'Run the stopped-server recovery image smoke');
  assert.deepEqual(smoke.env, { OPENKIT_TEST_APP_IMAGE_RECOVERY: '1' });
  assert.equal(
    smoke.run,
    'bash scripts/test-env.sh host node --test scripts/docker/app-admin-recovery-smoke.test.mjs'
  );
});

function step(job, name) {
  const found = job.steps.find((candidate) => candidate.name === name);
  assert.ok(found, `Missing workflow step: ${name}`);
  return found;
}

/** Returns the serialized GitHub Actions expression parsed from workflow YAML. */
function actionExpression(value) {
  return `\${{ ${value} }}`;
}

function outputReference(producer, consumer, name) {
  const expression = actionExpression(`steps.${producer.id}.outputs.${name}`);
  if (consumer.run.includes(expression)) return new RegExp(escapeRegExp(expression), 'u');
  const environment = Object.entries(consumer.env ?? {}).find(([, value]) => value === expression);
  assert.ok(environment, `OpenShell ${name} output does not reach its download consumer`);
  const variable = escapeRegExp(environment[0]);
  return new RegExp(`(?:\\$${variable}(?![A-Za-z0-9_])|\\$\\{${variable}\\})`, 'u');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
