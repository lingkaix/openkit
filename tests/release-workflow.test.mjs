import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8'));

test('test image jobs reap orphaned processes through Docker init', () => {
  const jobs = Object.entries(workflow.jobs).filter(
    ([, job]) => job.container?.image === actionExpression('needs.test-image.outputs.image')
  );
  assert.equal(jobs.length, 9);
  for (const [name, job] of jobs) {
    assert.equal(job.container.options, '--init', `${name} must reap orphaned processes`);
  }
});

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

test('candidate smoke runs every platform once against the same digest in a classic image store', () => {
  const { result, runs } = runCandidateSmoke();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(runs, [
    'run linux/amd64 ghcr.io/example/image@sha256:candidate candidate-smoke',
    'run linux/arm64 ghcr.io/example/image@sha256:candidate candidate-smoke',
  ]);
});

test('candidate smoke fails the step when a platform smoke fails', () => {
  const { result, runs } = runCandidateSmoke('linux/amd64');
  assert.equal(result.status, 42, result.stderr);
  assert.match(result.stderr, /smoke failed for linux\/amd64/u);
  assert.deepEqual(runs, [
    'run linux/amd64 ghcr.io/example/image@sha256:candidate candidate-smoke',
  ]);
});

/** Executes the workflow body with a per-reference, single-platform Docker store double. */
function runCandidateSmoke(failPlatform = '') {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-candidate-smoke-'));
  const stateFile = join(directory, 'state.json');
  const logFile = join(directory, 'runs.log');
  try {
    writeFileSync(stateFile, '{}');
    writeFileSync(logFile, '');
    writeFileSync(
      join(directory, 'docker'),
      `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.DOCKER_STATE, 'utf8'));
if (args.length === 6 && args[0] === 'run' && args[1] === '--rm' && args[2] === '--platform') {
  const [, , , platform, reference, command] = args;
  if (Object.hasOwn(state, reference) && state[reference] !== platform) {
    console.error('docker: cannot overwrite digest ' + reference.split('@')[1]);
    process.exit(125);
  }
  state[reference] = platform;
  writeFileSync(process.env.DOCKER_STATE, JSON.stringify(state));
  appendFileSync(process.env.DOCKER_LOG, 'run ' + platform + ' ' + reference + ' ' + command + '\\n');
  if (platform === process.env.FAIL_PLATFORM) {
    console.error('smoke failed for ' + platform);
    process.exit(42);
  }
} else if ((args.length === 3 && args[0] === 'image' && args[1] === 'rm') ||
           (args.length === 2 && args[0] === 'rmi')) {
  const reference = args.at(-1);
  if (!Object.hasOwn(state, reference)) {
    console.error('docker: no such image: ' + reference);
    process.exit(1);
  }
  delete state[reference];
  writeFileSync(process.env.DOCKER_STATE, JSON.stringify(state));
} else {
  console.error('unsupported docker arguments: ' + JSON.stringify(args));
  process.exit(1);
}
`,
      { mode: 0o755 }
    );
    const smoke = step(workflow.jobs['publish-container-images'], 'Smoke every candidate platform');
    const result = spawnSync('bash', ['-e', '-c', smoke.run], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        IMAGE: 'ghcr.io/example/image',
        DIGEST: 'sha256:candidate',
        PLATFORMS: 'linux/amd64,linux/arm64',
        SMOKE_COMMAND: 'candidate-smoke',
        DOCKER_STATE: stateFile,
        DOCKER_LOG: logFile,
        FAIL_PLATFORM: failPlatform,
      },
      encoding: 'utf8',
    });
    return { result, runs: readFileSync(logFile, 'utf8').trim().split('\n') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('manual release gate derives a nonpublishing worker image smoke matrix', () => {
  const matrixJob = workflow.jobs['container-image-matrix'];
  assert.match(
    matrixJob.if,
    /workflow_dispatch.*release-gate/u,
    'container image matrix must be available to the manual release gate'
  );
  assert.doesNotMatch(matrixJob.if, /release-preflight/u);
  assert.equal(matrixJob.needs, undefined);

  const producer = step(matrixJob, 'Read release image manifest');
  const outputFile = join(mkdtempSync(join(tmpdir(), 'openkit-release-matrix-')), 'output');
  try {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', producer.run], {
      cwd: process.cwd(),
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(outputFile, 'utf8');
    const matrix = JSON.parse(output.match(/^worker-matrix=(.+)$/m)?.[1] ?? '{}');
    assert.deepEqual(
      matrix.include.map(({ id, platform }) => `${id}:${platform}`),
      [
        'worker-common:linux/amd64',
        'worker-common:linux/arm64',
        'worker-runtimes:linux/amd64',
        'worker-runtimes:linux/arm64',
      ]
    );
    for (const image of matrix.include) {
      assert.equal(
        image.runtimes,
        image.id === 'worker-common' ? '' : 'codex,pi,opencode,deepseek'
      );
      assert.equal(image.runtime, undefined);
      assert.equal(image.target, image.id);
    }
  } finally {
    rmSync(join(outputFile, '..'), { recursive: true, force: true });
  }

  const smokeJob = workflow.jobs['smoke-worker-images'];
  assert.ok(smokeJob, 'missing manual worker image smoke job');
  assert.match(smokeJob.if, /workflow_dispatch.*release-gate/u);
  assert.deepEqual(smokeJob.permissions, { contents: 'read' });
  assert.equal(smokeJob.needs, 'container-image-matrix');
  assert.deepEqual(
    smokeJob.strategy.matrix,
    actionExpression('fromJSON(needs.container-image-matrix.outputs.worker-matrix)')
  );
  assert.ok(step(smokeJob, 'Set up QEMU').uses);
  assert.ok(step(smokeJob, 'Set up Docker Buildx').uses);
  assert.equal(step(smokeJob, 'Build worker image').with.load, true);
  assert.equal(step(smokeJob, 'Build worker image').with.push, false);
  assert.equal(
    workflow.jobs['publish-container-images'].if,
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"
  );
  assert.ok(workflow.jobs['publish-container-images'].needs.includes('release-preflight'));
  assert.ok(
    !(smokeJob.steps ?? []).some(
      (candidate) =>
        /docker\/(?:login|build-push-action)/u.test(candidate.uses ?? '') &&
        /login-action/u.test(candidate.uses ?? '')
    )
  );
  assert.equal(
    step(smokeJob, 'Run worker image smoke').run,
    'bash scripts/docker/smoke-image.sh "${' + 'IMAGE_ID}"'
  );
  assert.equal(
    step(smokeJob, 'Run worker image smoke').env.DOCKER_DEFAULT_PLATFORM,
    actionExpression('matrix.platform')
  );
});

test('release workflow publishes and independently verifies the portable release bundle', () => {
  const preflight = workflow.jobs['release-preflight'];
  const githubRelease = workflow.jobs['github-release'];
  const verify = workflow.jobs['verify-release'];
  const download = step(verify, 'Download and verify GitHub Release assets');
  const anonymous = step(verify, 'Verify public worker base without registry credentials');

  assert.equal(preflight.needs, 'test-image');
  assert.deepEqual(preflight.permissions, { contents: 'read', packages: 'read' });
  assert.deepEqual(githubRelease.needs, [
    'package-release-assets',
    'qualify-nanohost',
    'publish-container-images',
  ]);
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
  assert.match(portableCommands, /verifyOperationsSkillArchive/);
  assert.doesNotMatch(portableCommands, /openkit-skill-/);
  assert.match(portableCommands, /skills\/openkit-ops\/scripts\/openkit/);
  assert.match(portableCommands, /openkit-nanohost-.*-linux-(?:arm64|\$\{architecture\})\.tar\.gz/);
  assert.match(portableCommands, /openkit-ops-skill-.*\.tar\.gz/);
  assert.match(portableCommands, /sha256sum -c SHA256SUMS/);
  const releaseStep = portable.steps.find(
    (candidate) =>
      candidate.id &&
      /GITHUB_OUTPUT/u.test(candidate.run ?? '') &&
      ['tag', 'commit', 'archive'].every((name) =>
        new RegExp(`(?:^|[^A-Za-z0-9_])${name}=`, 'u').test(candidate.run)
      )
  );
  assert.ok(releaseStep, 'Portable packaging must parse the supported OpenShell release once');
  assert.doesNotMatch(portableCommands, /v0\.0\.99|8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032/u);
  assert.doesNotMatch(portableCommands, /openshell-gateway-aarch64-unknown-linux-gnu\.tar\.gz/u);
  const releaseConsumer = portable.steps.find((candidate) =>
    /github\.com\/NVIDIA\/OpenShell\/releases\/download/u.test(candidate.run ?? '')
  );
  assert.ok(releaseConsumer, 'Portable packaging must download the parsed OpenShell coordinates');
  const releaseCoordinates = releaseConsumer.run
    .split('\n')
    .filter((line) => line.includes('github.com/NVIDIA/OpenShell/releases/download'));
  const sourceCoordinate = releaseConsumer.run
    .split('\n')
    .find((line) => line.includes('raw.githubusercontent.com/NVIDIA/OpenShell'));
  assert.equal(releaseCoordinates.length, 2, 'Both target Gateway archives must be downloaded');
  assert.ok(sourceCoordinate, 'Missing OpenShell source download coordinate');
  for (const [index, output] of ['amd64_archive', 'archive'].entries()) {
    assert.match(releaseCoordinates[index], outputReference(releaseStep, releaseConsumer, 'tag'));
    assert.match(releaseCoordinates[index], outputReference(releaseStep, releaseConsumer, output));
  }
  assert.match(sourceCoordinate, outputReference(releaseStep, releaseConsumer, 'commit'));

  const releaseCommands = workflow.jobs['github-release'].steps
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.doesNotMatch(releaseCommands, /openkit-skill-.*\.tar\.gz/);
  assert.match(releaseCommands, /openkit-ops-skill-.*\.tar\.gz/);
  assert.match(releaseCommands, /openkit-nanohost-.*-linux-(?:arm64|\$\{architecture\})\.tar\.gz/);
  assert.match(releaseCommands, /portable-assets\/SHA256SUMS/);

  const verificationCommands = workflow.jobs['verify-release'].steps
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.match(verificationCommands, /verify-nanohost-release\.mjs/);
  assert.match(verificationCommands, /verifyOperationsSkillArchive/);
  assert.doesNotMatch(verificationCommands, /openkit-skill-/);
  assert.match(verificationCommands, /skills\/openkit-ops\/scripts\/openkit/);
  assert.match(
    verificationCommands,
    /openkit-nanohost-.*-linux-(?:arm64|\$\{architecture\})\.tar\.gz/
  );
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

test('release image metadata emits the plural catalog runtime label', () => {
  const identity = step(
    workflow.jobs['publish-container-images'],
    'Compute deterministic image identity'
  );
  assert.equal(identity.env.WORKER_RUNTIMES, actionExpression('matrix.runtimes'));
  assert.match(identity.run, /org\.openkit\.worker\.runtimes=/);
  assert.doesNotMatch(identity.run, /org\.openkit\.worker\.runtime=/);
});

test('release qualification runs both exact archives natively before publication', () => {
  const qualification = workflow.jobs['qualify-nanohost'];
  assert.ok(qualification, 'missing release-time NanoHost qualification');
  assert.equal(
    qualification.if,
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"
  );
  assert.equal(qualification.container, undefined);
  assert.equal(qualification.needs, 'package-release-assets');
  assert.deepEqual(qualification.permissions, { contents: 'read' });
  assert.deepEqual(qualification.strategy.matrix.include, [
    { runner: 'ubuntu-24.04', architecture: 'amd64' },
    { runner: 'ubuntu-24.04-arm', architecture: 'arm64' },
  ]);
  assert.equal(qualification['runs-on'], actionExpression('matrix.runner'));
  for (const architecture of ['amd64', 'arm64']) {
    const native = workflow.jobs[`build-nanohost-${architecture}`];
    assert.ok(native);
    assert.equal(native['runs-on'], architecture === 'amd64' ? 'ubuntu-24.04' : 'ubuntu-24.04-arm');
    assert.equal(native.if, qualification.if);
    assert.ok(
      workflow.jobs['package-release-assets'].needs.includes(`build-nanohost-${architecture}`)
    );
  }
  for (const publisher of ['github-release', 'publish-container-images']) {
    assert.ok(workflow.jobs[publisher].needs.includes('qualify-nanohost'));
  }
  const download = step(qualification, 'Download exact NanoHost archive and checksum');
  assert.equal(download.with.name, `nanohost-release-${actionExpression('matrix.architecture')}`);
  const commands = qualification.steps.map((entry) => entry.run ?? '').join('\n');
  assert.match(commands, /verify-nanohost-release\.mjs/);
  assert.match(commands, /install\.sh" --check-host/);
  assert.match(commands, /requirements-met/);
  assert.match(commands, /install\.sh" --check/);
  assert.match(commands, /ImageVersion/);
  assert.match(commands, /dpkg-query/);
  assert.doesNotMatch(commands, /systemctl|docker run|host:nanohost|worker.*job/);
});
