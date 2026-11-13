import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { candidateMatrix } from '../scripts/release-candidate.mjs';
import { candidateJobs, publicationInputsAt } from '../scripts/release-publication-check.mjs';

const workflowBytes = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');
const workflow = parse(workflowBytes);

test('test image jobs reap orphaned processes through Docker init', () => {
  const jobs = Object.entries(workflow.jobs).filter(
    ([, job]) => job.container?.image === actionExpression('needs.test-image.outputs.image')
  );
  assert.ok(jobs.length > 0, 'test-image consumers must remain observable');
  for (const [name, job] of jobs) {
    assert.equal(job.container.options, '--init', `${name} must reap orphaned processes`);
  }
});

test('release workflow serializes tag releases and pins third-party actions', () => {
  assert.deepEqual(workflow.on.push.tags, ['v*.*.*-*']);
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

test('main pushes share one pending queue without cancelling the running head', () => {
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(
    workflow.concurrency.group,
    actionExpression(
      "startsWith(github.ref, 'refs/tags/v') && 'openkit-release' || format('openkit-ci-{0}', github.ref)"
    )
  );
});

test('publication admission requires the complete exact-head gate including L4', () => {
  for (const id of ['l0-l2', 'nano-core-e2e', 'web-e2e', 'smoke'])
    assert.ok(candidateJobs.includes(workflow.jobs[id].name), id);
});

test('release identity build arguments come from the exact candidate image owner', () => {
  const job = workflow.jobs['candidate-images'];
  const identity = step(job, 'Compute the exact-P intended image identity');
  const candidate = step(job, 'Build one native digest-only candidate');
  const workerBuild = step(workflow.jobs['smoke-worker-images'], 'Build worker image');
  assert.match(identity.run, /release-candidate\.mjs identity/u);
  assert.equal(identity.env.CANDIDATE_TAG, actionExpression('needs.candidate-plan.outputs.tag'));
  assert.equal(candidate.with['build-args'], actionExpression('steps.image.outputs.args'));
  assert.equal(workerBuild.with['build-args'], undefined);
  assert.ok(job.steps.indexOf(identity) < job.steps.indexOf(candidate));
  assert.ok(
    !workflow.jobs['publish-container-images'].steps.some((s) =>
      s.uses?.startsWith('docker/build-push-action@')
    )
  );
});

test('tag publication promotes the proved candidate digest without rebuilding or moving Latest early', () => {
  const job = workflow.jobs['publish-container-images'];
  const existing = step(job, 'Inspect existing immutable identity');
  const candidateJob = workflow.jobs['candidate-images'];
  const candidate = step(candidateJob, 'Build one native digest-only candidate');
  const smoke = step(candidateJob, 'Smoke and record the exact registry platform digest');
  const gate = workflow.jobs['release-security'];
  const selected = step(gate, 'Select the already-proved immutable candidate');
  const admission = step(gate, 'Admit every platform digest before publication');
  const retained = step(gate, 'Retain only the admitted immutable digest');
  const download = step(job, 'Download the security-admitted immutable candidate');
  const resolve = step(job, 'Consume the proved and security-admitted candidate digest');
  const promote = step(job, 'Promote the smoked digest');
  const verify = step(job, 'Verify promoted identity');
  const anonymous = step(job, 'Verify public worker base anonymous pull');
  const record = step(job, 'Write image release record');
  assert.equal(candidate.with.provenance, false);
  assert.match(candidate.with.outputs, /push-by-digest=true/);
  assert.equal(candidate.with.tags, undefined);
  assert.match(candidateJob.if, /needs\.candidate-plan\.outputs\.enabled == 'true'/u);
  assert.deepEqual(smoke.env, {
    IMAGE_ID: actionExpression('matrix.id'),
    CANDIDATE_TAG: actionExpression('needs.candidate-plan.outputs.tag'),
    PLATFORM: actionExpression('matrix.platform'),
    DIGEST: actionExpression('steps.candidate.outputs.digest'),
  });
  assert.match(smoke.run, /release-candidate\.mjs platform/u);
  assert.ok(candidateJob.steps.indexOf(candidate) < candidateJob.steps.indexOf(smoke));
  assert.deepEqual(gate.permissions, { contents: 'read', packages: 'read', actions: 'read' });
  assert.equal(gate.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')");
  for (const publisher of ['publish-container-images', 'publish-app-image'])
    assert.ok(workflow.jobs[publisher].needs.includes('release-security'), publisher);
  assert.match(selected.run, /release-candidate\.mjs fetch/u);
  assert.match(selected.run, /PRESENT.*true/u);
  assert.match(selected.run, /digest=\$\{EXISTING_DIGEST\}/u);
  assert.equal(admission.env.DIGEST, actionExpression('steps.selected.outputs.digest'));
  assert.equal(admission.env.PLATFORMS, actionExpression('matrix.platforms'));
  assert.match(admission.run, /release-security\.mjs.*--digest.*--platforms.*--output/u);
  assert.ok(gate.steps.indexOf(selected) < gate.steps.indexOf(admission));
  assert.ok(gate.steps.indexOf(admission) < gate.steps.indexOf(retained));
  assert.equal(retained.with['if-no-files-found'], 'error');
  assert.equal(download.with.name, retained.with.name);
  assert.equal(
    download.with.name,
    'security-admitted-' +
      actionExpression('matrix.id') +
      '-' +
      actionExpression('github.run_attempt')
  );
  assert.equal(download.with['run-id'], undefined);
  assert.ok(job.steps.indexOf(download) < job.steps.indexOf(resolve));
  assert.match(
    resolve.run,
    /readFileSync\(`security-admitted\/\$\{process\.env\.IMAGE_ID\}\.digest`/u
  );
  assert.match(
    resolve.run,
    /process\.env\.PRESENT === 'true'.*process\.env\.EXISTING_DIGEST !== digest/u
  );
  assert.match(resolve.run, /digest=\$\{digest\}/u);
  assert.doesNotMatch(
    job.steps.map((entry) => entry.run ?? '').join('\n'),
    /release-candidate\.mjs (?:fetch|select)/u
  );
  assert.ok(job.steps.indexOf(existing) < job.steps.indexOf(resolve));
  assert.ok(job.steps.indexOf(resolve) < job.steps.indexOf(promote));
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
  assert.ok(job.steps.indexOf(promote) < job.steps.indexOf(verify));
  assert.equal(anonymous.if, 'matrix.anonymousPull');
  assert.deepEqual(anonymous.env, {
    DIGEST: actionExpression('steps.release.outputs.digest'),
    IMAGE: actionExpression('steps.image.outputs.image'),
  });
  assert.ok(job.steps.indexOf(verify) < job.steps.indexOf(anonymous));
  assert.equal(record.env.ANONYMOUS_PULL, actionExpression('matrix.anonymousPull'));
  assert.match(promote.run, /imagetools create.*\$\{IMAGE\}@\$\{DIGEST\}/u);
});

test('candidate matrix smokes each catalog platform exactly once on a native runner', () => {
  const catalog = JSON.parse(readFileSync('containers/images.json', 'utf8')).images.filter(
    (i) => i.release
  );
  const matrix = candidateMatrix(catalog);
  const expected = catalog.flatMap((i) => i.platforms.map((p) => `${i.id}:${p}`)).sort();
  assert.deepEqual(matrix.include.map((i) => `${i.id}:${i.platform}`).sort(), expected);
  assert.equal(new Set(matrix.include.map((i) => i.jobName)).size, expected.length);
  for (const i of matrix.include)
    assert.equal(i.runner, i.platform === 'linux/arm64' ? 'ubuntu-24.04-arm' : 'ubuntu-24.04');
  assert.equal(workflow.jobs['candidate-images']['runs-on'], actionExpression('matrix.runner'));
});

test('any candidate platform failure prevents index assembly and tag promotion has no rebuild fallback', () => {
  const job = workflow.jobs['candidate-index'];
  assert.equal(workflow.jobs['candidate-images'].strategy['fail-fast'], false);
  assert.deepEqual(job.needs, ['candidate-plan', 'candidate-images', 'container-image-matrix']);
  assert.doesNotMatch(job.if, /always\(\)|failure\(\)/u);
  assert.equal(
    step(job, "Download this attempt's platform observations").with.pattern,
    'candidate-platform-$' + '{{ matrix.id }}-*-$' + '{{ github.run_attempt }}'
  );
  assert.equal(
    step(job, 'Retain the immutable candidate index record').with['if-no-files-found'],
    'error'
  );
  assert.equal(
    step(job, 'Retain the immutable candidate index record').with.name,
    'candidate-$' + '{{ matrix.id }}-$' + '{{ github.run_attempt }}'
  );
  assert.ok(
    !workflow.jobs['publish-container-images'].steps.some((s) =>
      s.uses?.startsWith('docker/build-push-action@')
    )
  );
});

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
    const app = JSON.parse(output.match(/^app-matrix=(.+)$/m)?.[1] ?? '{}');
    const workers = JSON.parse(output.match(/^worker-publication-matrix=(.+)$/m)?.[1] ?? '{}');
    assert.deepEqual(
      app.include.map((image) => image.id),
      ['app']
    );
    assert.deepEqual(
      workers.include.map((image) => image.id),
      ['worker-common', 'worker-runtimes']
    );
    assert.equal(
      workflow.jobs['publish-container-images'].strategy.matrix,
      actionExpression('fromJSON(needs.container-image-matrix.outputs.worker-publication-matrix)')
    );
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
      assert.equal(
        image.runner,
        image.platform === 'linux/arm64' ? 'ubuntu-24.04-arm' : 'ubuntu-24.04'
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
  assert.deepEqual(smokeJob.needs, ['container-image-matrix', 'candidate-plan']);
  assert.deepEqual(
    smokeJob.strategy.matrix,
    actionExpression('fromJSON(needs.container-image-matrix.outputs.worker-matrix)')
  );
  assert.equal(smokeJob['runs-on'], actionExpression('matrix.runner'));
  assert.ok(!smokeJob.steps.some((s) => s.uses?.startsWith('docker/setup-qemu-action@')));
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
    'publish-app-image',
  ]);
  assert.deepEqual(githubRelease.permissions, {
    contents: 'write',
    packages: 'read',
    'id-token': 'write',
    attestations: 'write',
  });
  assert.equal(
    githubRelease.if,
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"
  );
  assert.ok(step(githubRelease, 'Create immutable GitHub Release'));
  assert.deepEqual(verify.needs, [
    'test-image',
    'github-release',
    'publish-container-images',
    'publish-app-image',
  ]);
  assert.deepEqual(verify.permissions, {
    contents: 'read',
    packages: 'read',
    attestations: 'read',
  });
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
  assert.match(nativeCommands, /cargo auditable build --locked --release/);
  assert.match(nativeCommands, /install-security-tools\.mjs --tool cargo-auditable/u);
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
  assert.equal(job['runs-on'], actionExpression('matrix.runner'));
  assert.deepEqual(job.strategy.matrix.runner, ['ubuntu-24.04', 'ubuntu-26.04']);
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

test('app-image recovery smoke is main-push or manual, host-placed, opted in, and root-Node pinned', () => {
  const job = workflow.jobs['app-image-admin-recovery'];
  assert.equal(
    job.if,
    `(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && contains(fromJSON('["smoke","release-gate","full"]'), inputs.gate))`
  );
  assert.doesNotMatch(job.if, /pull_request/u);
  assert.equal(job.container, undefined);
  assert.match(String(job['runs-on']), /^ubuntu-/u);

  const setup = step(job, 'Set up the pinned root Node toolchain');
  assert.match(setup.uses, /^jdx\/mise-action@[a-f0-9]{40}$/u);
  // cache: false is the accepted control: the pinned zizmor toolchain runs without mise tool caches.
  assert.deepEqual(setup.with, { install_args: 'node', cache: false });
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

test('release notes are checked before publication and verified against the generator', () => {
  const preflightCommands = workflow.jobs['release-preflight'].steps
    .map((entry) => entry.run ?? '')
    .join('\n');
  const publishCommands = workflow.jobs['publish-container-images'].steps
    .map((entry) => entry.run ?? '')
    .join('\n');
  const githubRelease = workflow.jobs['github-release'];
  const create = step(githubRelease, 'Create release notes');
  const verifyDownload = step(
    workflow.jobs['verify-release'],
    'Download and verify GitHub Release assets'
  );

  assert.match(preflightCommands, /scripts\/release-notes\.mjs --check/);
  assert.ok(step(githubRelease, 'Checkout'));
  assert.match(create.run, /scripts\/release-notes\.mjs/);
  assert.match(create.run, /--output release-notes\.md/);
  assert.match(publishCommands, /imagetools', 'inspect', '--raw'/);
  assert.match(publishCommands, /Platform manifest/);
  assert.match(verifyDownload.run, /scripts\/release-notes\.mjs/);
  assert.match(verifyDownload.run, /--compare-body/);
  assert.doesNotMatch(workflowBytes, /R001 exact-product no-host-reboot runtime gate remains open/);
});

// Baselines retain reviewed job bytes; the test-image and installer conditions exclude only registry refresh.
// Other cadence changes are checked separately below.
// The complete job inventory. Whole-job digests are deliberately not recorded: reviewed security
// controls and action pin bumps change bytes without changing the graph, so the graph itself is
// enumerated and every checkout reference is checked for the accepted credential control.
const unchangedJobNames = [
  'container-image-matrix',
  'build-app-candidate',
  'smoke-app-native',
  'publish-app-image',
  'test-image',
  'pr-check',
  'nanohost-installer',
  'release-preflight',
  'web-e2e',
  'smoke',
  'build-nanohost-amd64',
  'build-nanohost-arm64',
  'package-release-assets',
  'qualify-nanohost',
  'publish-container-images',
  'github-release',
  'verify-release',
];

const candidateJobNames = [
  'candidate-registry',
  'candidate-plan',
  'candidate-images',
  'candidate-index',
];

const shardJobNames = ['l0-l2-plan', 'l0-l2-build', 'l0-l2-shards', 'l0-l2-coverage', 'l0-l2'];

test('the complete job graph stays enumerated and no checkout persists credentials', () => {
  const placementOwnedElsewhere = [
    'nano-core-e2e',
    'app-image-admin-recovery',
    'smoke-worker-images',
  ];
  assert.deepEqual(
    Object.keys(workflow.jobs)
      .filter((name) => !placementOwnedElsewhere.includes(name))
      .sort(),
    [
      ...unchangedJobNames,
      ...shardJobNames,
      ...candidateJobNames,
      'release-security',
      'image-security-diagnostic',
    ].sort()
  );
  for (const name of placementOwnedElsewhere)
    assert.ok(workflow.jobs[name], `the job ${name} is still declared`);

  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(job['runs-on'], `${name} declares a runner`);
    for (const entry of job.steps ?? []) {
      if (!entry.uses?.startsWith('actions/checkout@')) continue;
      assert.match(entry.uses, /@[a-f0-9]{40}$/u, `${name} pins the checkout action by SHA`);
      assert.equal(
        entry.with?.['persist-credentials'],
        false,
        `${name} leaves checkout credentials in the workspace`
      );
    }
  }
});

test('only complete L0-L2 shards, whole-owner coverage and NanoCore e2e read exact-job reuse evidence', () => {
  const selected = ['l0-l2-shards', 'l0-l2-coverage', 'nano-core-e2e'];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!selected.includes(name)) {
      assert.equal(
        job.permissions?.actions,
        [
          'publish-container-images',
          'build-app-candidate',
          'candidate-registry',
          'release-security',
          'image-security-diagnostic',
        ].includes(name)
          ? 'read'
          : undefined,
        name
      );
      assert.ok(!job.steps?.some((entry) => entry.id === 'reuse'), name);
      if (['release-security', 'image-security-diagnostic'].includes(name)) {
        assert.deepEqual(job.permissions, { contents: 'read', packages: 'read', actions: 'read' });
        assert.ok(!job.steps.some((entry) => /release-ci-reuse\.mjs/u.test(entry.run ?? '')), name);
      }
      if (name === 'image-security-diagnostic') {
        assert.match(job.if, /github\.ref == 'refs\/heads\/main'/u);
        const download = step(job, "Download this attempt's immutable candidate record");
        assert.equal(
          download.with.name,
          'candidate-' +
            actionExpression('matrix.id') +
            '-' +
            actionExpression('github.run_attempt')
        );
        assert.equal(download.with['run-id'], undefined);
        assert.match(
          step(job, 'Diagnose current platform digests without granting release admission').run,
          /release-security\.mjs --diagnostic --candidate/u
        );
      }
      continue;
    }
    const l0l2 = name !== 'nano-core-e2e';
    assert.deepEqual(job.permissions, { contents: 'read', packages: 'read', actions: 'read' });
    assert.deepEqual(
      job.needs,
      name === 'l0-l2-shards'
        ? ['test-image', 'l0-l2-plan', 'l0-l2-build']
        : name === 'l0-l2-coverage'
          ? ['test-image', 'l0-l2-plan', 'l0-l2-shards']
          : 'test-image'
    );
    assert.equal(job.container.image, actionExpression('needs.test-image.outputs.image'));
    assert.equal(job.steps[0].name, 'Checkout');
    const reuse = job.steps[1];
    assert.equal(reuse.id, 'reuse');
    assert.equal(
      reuse.if,
      l0l2
        ? "github.event_name == 'push'"
        : "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"
    );
    assert.deepEqual(
      reuse.env,
      l0l2
        ? {
            GITHUB_TOKEN: actionExpression('secrets.GITHUB_TOKEN'),
            SHARD_ID: actionExpression('matrix.id'),
          }
        : { GITHUB_TOKEN: actionExpression('secrets.GITHUB_TOKEN'), REUSE_JOB_NAME: job.name }
    );
    assert.match(reuse.run, /node scripts\/release-ci-reuse\.mjs/u);
    assert.match(reuse.run, /--repository "\$\{GITHUB_REPOSITORY\}"/u);
    assert.match(reuse.run, /--workflow ci\.yml/u);
    assert.match(reuse.run, /--sha "\$\{GITHUB_SHA\}"/u);
    assert.match(
      reuse.run,
      name === 'l0-l2-shards'
        ? /--job "L0-L2 shard \(\$\{SHARD_ID\}\)"/u
        : name === 'l0-l2-coverage'
          ? /--job "L0-L2 coverage \(\$\{SHARD_ID\}\)"/u
          : /--job "\$\{REUSE_JOB_NAME\}"/u
    );
    for (const later of job.steps.slice(2)) {
      if (later.uses?.startsWith('actions/upload-artifact@')) {
        assert.equal(later.if, name === 'l0-l2-shards' ? 'always()' : undefined);
        assert.equal(later.with['if-no-files-found'], 'error');
      } else if (later.name === 'Restore exact-commit execution evidence') {
        assert.equal(later.if, "steps.reuse.outputs.reused == 'true'");
      } else if (later.name === 'Inspect runner CPU and memory') {
        assert.equal(name, 'l0-l2-shards');
        assert.equal(later.if, "steps.reuse.outputs.reused != 'true' && matrix.id == 'nanocore-1'");
      } else assert.equal(later.if, "steps.reuse.outputs.reused != 'true'", later.name);
    }
  }
});

test('reuse shell succeeds for proof and falls back on either unavailable or erroneous API evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-release-reuse-step-'));
  try {
    writeFileSync(
      join(directory, 'node'),
      '#!/bin/sh\nprintf "%s\\n" "$REUSE_RESULT"\nexit "$REUSE_STATUS"\n',
      { mode: 0o755 }
    );
    for (const name of ['l0-l2-shards', 'l0-l2-coverage', 'nano-core-e2e']) {
      const reuse = step(
        workflow.jobs[name],
        name === 'l0-l2-shards'
          ? 'Reuse exact-commit candidate shard'
          : name === 'l0-l2-coverage'
            ? 'Reuse exact-commit candidate coverage'
            : 'Reuse exact-commit candidate job'
      );
      for (const status of [0, 1, 2]) {
        const output = join(directory, 'output');
        const summary = join(directory, 'summary');
        writeFileSync(output, '');
        writeFileSync(summary, '');
        const proof = 'Reused run 10 attempt 2 job 20';
        const result = spawnSync('sh', ['-e', '-c', reuse.run], {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            GITHUB_REPOSITORY: 'example/openkit',
            GITHUB_SHA: 'a'.repeat(40),
            REUSE_JOB_NAME: workflow.jobs[name].name,
            SHARD_ID: 'protocol',
            REUSE_RESULT: proof,
            REUSE_STATUS: String(status),
          },
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          readFileSync(output, 'utf8'),
          status === 0 && name !== 'nano-core-e2e'
            ? 'reused=true\nrun_id=10\nattempt=2\n'
            : `reused=${status === 0}\n`
        );
        assert.equal(readFileSync(summary, 'utf8'), status === 0 ? `${proof}\n` : '');
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('artifact reuse refuses malformed or ambiguous successful proof before publishing outputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-artifact-reuse-proof-'));
  try {
    writeFileSync(join(directory, 'node'), '#!/bin/sh\nprintf "%s\\n" "$REUSE_RESULT"\n', {
      mode: 0o755,
    });
    for (const id of ['l0-l2-shards', 'l0-l2-coverage']) {
      const reuse = workflow.jobs[id].steps.find((entry) => entry.id === 'reuse');
      for (const proof of [
        'Reused run 0 attempt 2 job 20',
        'Reused run 10 attempt 0 job 20',
        'Reused run 10 attempt 2 job x',
        'Reused run 10 attempt 2 job 20\nextra',
      ]) {
        const output = join(directory, 'output'),
          summary = join(directory, 'summary');
        writeFileSync(output, '');
        writeFileSync(summary, '');
        const result = spawnSync('sh', ['-eu', '-c', reuse.run], {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            GITHUB_REPOSITORY: 'example/openkit',
            GITHUB_SHA: 'a'.repeat(40),
            SHARD_ID: 'nanocore-1',
            REUSE_RESULT: proof,
          },
          encoding: 'utf8',
        });
        assert.notEqual(result.status, 0, proof);
        assert.match(result.stderr, /Invalid exact-job reuse proof/u);
        assert.equal(readFileSync(output, 'utf8'), '');
        assert.equal(readFileSync(summary, 'utf8'), '');
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Evaluate the finite GitHub job expressions with synthetic event contexts only. */
function jobRuns(id, event, ref, gate = '') {
  return Boolean(
    new Function(
      'github',
      'inputs',
      'contains',
      'fromJSON',
      'startsWith',
      'always',
      'needs',
      `return (${(workflow.jobs[id].if ?? 'true').replace(/needs\.([a-z0-9-]+)/g, "needs['$1']")});`
    )(
      { event_name: event, ref },
      { gate },
      (values, value) => values.includes(value),
      JSON.parse,
      (value, prefix) => value.startsWith(prefix),
      () => true,
      { 'candidate-plan': { outputs: { enabled: 'false' } } }
    )
  );
}

test('every main push runs the complete nonpublishing candidate gate without publishing', () => {
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.push['paths-ignore'], undefined);
  assert.equal(workflow.on.push.paths, undefined);
  const gate = [
    'l0-l2-plan',
    'l0-l2-shards',
    'l0-l2-coverage',
    'l0-l2',
    'nano-core-e2e',
    'web-e2e',
    'smoke',
    'app-image-admin-recovery',
    'container-image-matrix',
    'smoke-worker-images',
  ];
  for (const id of gate) {
    assert.equal(jobRuns(id, 'push', 'refs/heads/main'), true, id);
    assert.equal(jobRuns(id, 'workflow_dispatch', 'refs/heads/main', 'release-gate'), true, id);
    assert.equal(jobRuns(id, 'pull_request', 'refs/pull/1/merge'), false, id);
  }
  for (const id of [
    'publish-container-images',
    'build-app-candidate',
    'smoke-app-native',
    'publish-app-image',
    'github-release',
    'verify-release',
    'release-preflight',
    'package-release-assets',
    'qualify-nanohost',
  ]) {
    assert.equal(jobRuns(id, 'push', 'refs/heads/main'), false, id);
    assert.equal(jobRuns(id, 'push', 'refs/tags/v0.1.0-rc.6'), true, id);
  }
  for (const id of ['app-image-admin-recovery', 'smoke-worker-images'])
    assert.equal(jobRuns(id, 'push', 'refs/heads/feature'), false, id);
  for (const event of ['pull_request', 'push']) {
    assert.equal(jobRuns('web-e2e', event, 'refs/heads/feature'), false);
    assert.equal(jobRuns('web-e2e', event, 'refs/tags/v0.1.0-rc.9'), false);
  }
  assert.equal(jobRuns('web-e2e', 'workflow_dispatch', 'refs/heads/main', 'full'), true);
  assert.equal(jobRuns('web-e2e', 'workflow_dispatch', 'refs/heads/main', 'web-e2e'), true);
});

test('CI keeps NanoHost scheduling in its package and preserves inherited harness settings', () => {
  const nativePackage = JSON.parse(readFileSync('apps/nanohost/package.json', 'utf8'));
  assert.match(nativePackage.scripts.test, /\bcargo test\b.*--test-threads=1\b/u);
  const command = step(
    workflow.jobs['l0-l2-shards'],
    'Run one complete shard as the unprivileged image user'
  );
  const setup = command.run.slice(command.run.indexOf('\n') + 1, command.run.indexOf('runuser'));
  assert.doesNotMatch(setup, /chown|runuser/u);
  for (const id of ['native-nanohost', 'native-other', 'root', 'web']) {
    for (const inherited of [undefined, '7']) {
      const env = { ...process.env, SHARD_ID: id, GITHUB_WORKSPACE: process.cwd() };
      if (inherited === undefined) delete env.RUST_TEST_THREADS;
      else env.RUST_TEST_THREADS = inherited;
      const result = spawnSync(
        'sh',
        // Keep diagnostic output separate from the inherited-setting result channel.
        [
          '-eu',
          '-c',
          `exec 3>&1\nexec >/dev/null\n${setup}\nprintf %s "\${RUST_TEST_THREADS-unset}" >&3`,
        ],
        { env, encoding: 'utf8' }
      );
      assert.equal(result.status, 0, id);
      assert.equal(result.stdout, inherited ?? 'unset', id);
    }
  }
});

test('L0-L2 runs complete package coverage and native/root suites through a fail-closed aggregate', () => {
  const shards = workflow.jobs['l0-l2-shards'];
  const command = step(shards, 'Run one complete shard as the unprivileged image user');
  assert.match(command.run, /runuser -u node/u);
  assert.match(command.run, /node scripts\/ci-l0-l2\.mjs --run "\$\{SHARD_ID\}"/u);
  assert.equal(command.env.SHARD_ID, actionExpression('matrix.id'));
  assert.deepEqual(workflow.jobs['l0-l2'].needs, ['l0-l2-plan', 'l0-l2-shards', 'l0-l2-coverage']);
  assert.match(workflow.jobs['l0-l2'].if, /always\(\)/u);
  assert.match(
    step(workflow.jobs['l0-l2'], 'Require every shard job').run,
    /SHARDS_RESULT.*success.*COVERAGE_RESULT.*success/u
  );
  assert.match(
    step(workflow.jobs['l0-l2'], 'Require exactly one successful observation per shard').run,
    /--join temp\/ci-shards/u
  );
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.match(scripts['verify:l0-l2'], /pnpm run test:ci/u);
  assert.doesNotMatch(scripts['verify:l0-l2'], /test:unit|test:coverage/u);
  assert.match(scripts['test:ci'], /release-tests\.mjs/u);
});

test('App publication waits for exact-manifest smoke on both native hosts', () => {
  const build = workflow.jobs['build-app-candidate'];
  const native = workflow.jobs['smoke-app-native'];
  const publish = workflow.jobs['publish-app-image'];
  assert.ok(build, 'tag-stage App candidate admission is required');
  assert.equal(build.name, `Read ${actionExpression('matrix.id')} candidate`);
  assert.equal(publish.name, `Publish ${actionExpression('matrix.id')} image`);
  assert.ok(native, 'native App platform gate is required');
  assert.ok(publish, 'App promotion joins the native platform gate');
  assert.equal(native['runs-on'], actionExpression('matrix.runner'));
  assert.deepEqual(native.strategy.matrix.include, [
    { platform: 'linux/amd64', runner: 'ubuntu-24.04', architecture: 'X64' },
    { platform: 'linux/arm64', runner: 'ubuntu-24.04-arm', architecture: 'ARM64' },
  ]);
  assert.equal(native.strategy['fail-fast'], false);
  assert.ok(publish.needs.includes('smoke-app-native'));
  assert.ok(!native.steps.some((entry) => entry.uses?.startsWith('docker/setup-qemu-action@')));
});

test('native App evidence refuses missing, skipped, failed and mismatched platforms', async () => {
  const { verifyNativeEvidence, verifyNativeHost } = await import(
    '../scripts/release-app-native.mjs'
  );
  const candidate = {
    repository: 'example/openkit',
    source: 'a'.repeat(40),
    tag: 'v0.1.0-rc.8',
    runId: '123',
    attempt: '1',
    image: 'ghcr.io/example/openkit-app',
    digest: `sha256:${'b'.repeat(64)}`,
    platforms: ['amd64', 'arm64'].map((arch, i) => ({
      platform: `linux/${arch}`,
      digest: `sha256:${String(i + 1).repeat(64)}`,
    })),
  };
  const host = (architecture) => ({
    system: 'Linux',
    kernel: architecture === 'amd64' ? 'x86_64' : 'aarch64',
    node: architecture === 'amd64' ? 'x64' : 'arm64',
    runner: architecture === 'amd64' ? 'X64' : 'ARM64',
    docker: `linux/${architecture}`,
    endpoint: 'unix:///var/run/docker.sock',
  });
  const good = candidate.platforms.map((entry) => ({
    ...candidate,
    ...entry,
    indexDigest: candidate.digest,
    host: host(entry.platform.split('/')[1]),
    conclusion: 'success',
    negativeFixture: 'address-space-assertion',
    inheritedAddressSpace: 'unlimited',
  }));
  assert.doesNotThrow(() => verifyNativeEvidence(candidate, good));
  assert.throws(() => verifyNativeHost('linux/arm64', host('amd64')), /native host/);
  for (const key of ['kernel', 'node', 'runner', 'docker', 'endpoint']) {
    const changed = { ...host('arm64'), [key]: host('amd64')[key] };
    if (key === 'endpoint') changed.endpoint = 'tcp://remote:2375';
    assert.throws(() => verifyNativeHost('linux/arm64', changed), /native host/, key);
  }
  for (const conclusion of ['skipped', 'failure', 'cancelled', undefined]) {
    assert.throws(
      () => verifyNativeEvidence(candidate, [good[0], { ...good[1], conclusion }]),
      /native evidence/
    );
  }
  assert.throws(() => verifyNativeEvidence(candidate, good.slice(0, 1)), /native evidence/);
  assert.throws(() => verifyNativeEvidence(candidate, [good[0], good[0]]), /native evidence/);
  for (const field of [
    'source',
    'tag',
    'runId',
    'attempt',
    'repository',
    'image',
    'indexDigest',
    'digest',
    'negativeFixture',
    'inheritedAddressSpace',
  ]) {
    assert.throws(
      () => verifyNativeEvidence(candidate, [good[0], { ...good[1], [field]: 'wrong' }]),
      /native evidence/,
      field
    );
  }
});

test('Worker publication and final verification retain the reviewed cadence steps', () => {
  const steps = (name) => workflow.jobs[name].steps;
  const cadence = (name) => {
    const named = steps(name).map((entry) => entry.name);
    assert.ok(
      named.every((entry) => typeof entry === 'string' && entry.length > 0),
      `${name} declares an unnamed step`
    );
    return named;
  };

  assert.deepEqual(cadence('publish-container-images'), [
    'Checkout',
    'Set up Docker Buildx',
    'Log in to GHCR',
    'Compute deterministic image identity',
    'Inspect existing immutable identity',
    'Download the security-admitted immutable candidate',
    'Consume the proved and security-admitted candidate digest',
    'Promote the smoked digest',
    'Verify promoted identity',
    'Verify public worker base anonymous pull',
    'Write image release record',
    'Retain public image finding identifiers',
    'Upload image release record',
  ]);
  assert.deepEqual(cadence('github-release'), [
    'Checkout',
    'Download image release records',
    'Set up pinned release verification tools',
    'Install checksum-bound inventory and workflow tools',
    'Lint before registry credentials',
    'Set up release Docker Buildx',
    'Read-only release registry login',
    'Install verifier dependencies without lifecycle scripts',
    'Download portable release assets',
    'Generate every image platform and NanoHost archive SBOM',
    'Generate release manifest and checksum',
    'Bind all file and OCI index/platform subjects from the release manifest',
    'Attest all released image and NanoHost/SHA256SUMS subjects',
    'Create release notes',
    'Create immutable GitHub Release',
  ]);
  assert.deepEqual(cadence('verify-release'), [
    'Checkout',
    'Set up Docker Buildx',
    'Log in to GHCR',
    'Download image release records',
    'Set up pinned integrity verifier runtime',
    'Install integrity verifier dependencies without lifecycle scripts',
    'Verify every published image digest',
    'Download and verify GitHub Release assets',
    'Verify release SBOM bindings and native keyless attestations',
    'Verify public worker base without registry credentials',
  ]);

  // Publication promotes already-smoked bytes: no final job may construct a new image.
  for (const name of ['publish-container-images', 'github-release', 'verify-release']) {
    assert.ok(
      !steps(name).some((entry) => entry.uses?.startsWith('docker/build-push-action@')),
      `${name} rebuilds an image`
    );
    assert.equal(jobRuns(name, 'push', 'refs/tags/v0.1.0-rc.8'), true, name);
    assert.equal(jobRuns(name, 'push', 'refs/heads/main'), false, name);
  }

  // The verifier is read-only: it cannot publish or rewrite the release it checks.
  assert.deepEqual(workflow.jobs['verify-release'].permissions, {
    contents: 'read',
    packages: 'read',
    attestations: 'read',
  });
  assert.deepEqual(workflow.jobs['github-release'].permissions, {
    contents: 'write',
    packages: 'read',
    'id-token': 'write',
    attestations: 'write',
  });
  assert.equal(
    workflow.jobs['github-release'].if,
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"
  );
  assert.deepEqual(workflow.jobs['publish-container-images'].permissions, {
    contents: 'read',
    packages: 'write',
    actions: 'read',
  });
  const record = steps('publish-container-images').find(
    (entry) => entry.name === 'Upload image release record'
  );
  assert.equal(record.with['if-no-files-found'], 'error');
});

test('publication proof covers every App producer, consumer and native fixture byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-native-publication-'));
  try {
    const git = (args, input) => {
      const r = spawnSync('git', args, { cwd: root, input, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git(['init', '--initial-branch=main']);
    for (const directory of ['.github/workflows', 'scripts', 'containers'])
      mkdirSync(join(root, directory), { recursive: true });
    for (const file of [
      'scripts/release-app-native.mjs',
      'scripts/release-app-no-as-limit.c',
      'containers/images.json',
    ])
      writeFileSync(join(root, file), readFileSync(file));
    const jobs = [
      'publish-container-images',
      'github-release',
      'verify-release',
      'container-image-matrix',
      'build-app-candidate',
      'smoke-app-native',
      'publish-app-image',
    ];
    writeFileSync(
      join(root, '.github/workflows/ci.yml'),
      'jobs:\n' +
        jobs
          .map(
            (name) => `  ${name}:\n    steps:\n      - run: node scripts/release-app-native.mjs\n`
          )
          .join('')
    );
    const snapshot = () => {
      git(['add', '.']);
      return git(
        ['hash-object', '-t', 'commit', '-w', '--stdin'],
        `tree ${git(['write-tree'])}\nauthor Fixture <fixture.invalid> 0 +0000\ncommitter Fixture <fixture.invalid> 0 +0000\n\nFixture\n`
      );
    };
    const before = publicationInputsAt(root, snapshot());
    assert.deepEqual(Object.keys(before.jobs).sort(), jobs.sort());
    assert.deepEqual(
      Object.keys(before.files).sort(),
      [
        'containers/images.json',
        'scripts/release-app-native.mjs',
        'scripts/release-app-no-as-limit.c',
      ].sort()
    );
    writeFileSync(
      join(root, '.github/workflows/release-promotion.yml'),
      'jobs:\n  promote:\n    steps:\n      - run: node scripts/promotion-fixture.mjs\n'
    );
    writeFileSync(join(root, 'scripts/promotion-fixture.mjs'), 'export const version = 1;\n');
    const promoted = publicationInputsAt(root, snapshot());
    assert.ok(promoted.jobs['stable-promotion-workflow']);
    assert.ok(promoted.files['.github/workflows/release-promotion.yml']);
    assert.ok(promoted.files['scripts/promotion-fixture.mjs']);
    writeFileSync(join(root, 'scripts/promotion-fixture.mjs'), 'export const version = 2;\n');
    assert.notEqual(publicationInputsAt(root, snapshot()).sha256, promoted.sha256);
    writeFileSync(join(root, 'scripts/release-app-no-as-limit.c'), 'fixture changed\n');
    assert.notEqual(publicationInputsAt(root, snapshot()).sha256, before.sha256);
    const path = join(root, '.github/workflows/ci.yml');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('  smoke-app-native:\n', '  missing-native:\n')
    );
    assert.throws(
      () => publicationInputsAt(root, snapshot()),
      /publication job missing: smoke-app-native/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Harness admission only: stand-ins exercise driver outcomes, never container or product behavior.
test('native App driver admits success and refuses wrong host, false negatives, product failure and timeout', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-native-driver-'));
  try {
    const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
    const candidate = {
      repository: 'example/openkit',
      source: 'a'.repeat(40),
      tag: 'v0.1.0-rc.8',
      runId: '123',
      attempt: '1',
      image: 'ghcr.io/example/openkit-app',
      digest: `sha256:${'b'.repeat(64)}`,
      platforms: ['amd64', 'arm64'].map((arch, i) => ({
        platform: `linux/${arch}`,
        digest: `sha256:${String(i + 1).repeat(64)}`,
      })),
      smokeCommand: 'openkit-app-smoke',
      reused: false,
      latestBefore: '',
    };
    const input = join(root, 'candidate.json');
    writeFileSync(input, JSON.stringify(candidate));
    const bootstrap = `
      import { mock } from 'node:test';
      import { appendFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const mode = process.env.DRIVER_MODE;
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      mock.module('node:child_process', { namedExports: { spawnSync(program, args) {
        const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
        if (program === 'uname') return ok(args[0] === '-s' ? 'Linux' :
          mode === 'wrong-host' ? 'wrong-kernel' : arch === 'arm64' ? 'aarch64' : 'x86_64');
        if (program === 'cc') return ok();
        if (program !== 'docker') throw Error('Unexpected program ' + program);
        appendFileSync(process.env.DRIVER_LOG, JSON.stringify(args) + '\\n');
        if (args[0] === 'buildx') return ok(JSON.stringify({ manifests: ['amd64', 'arm64'].map((architecture, i) =>
          ({ platform: { os: 'linux', architecture }, digest: 'sha256:' + String(i + 1).repeat(64) })) }));
        if (args[0] === 'context') return ok(args[1] === 'show' ? 'default' : 'unix:///var/run/docker.sock');
        if (args[0] === 'info') return ok('linux/' + arch);
        if (args[0] === 'pull') return ok();
        if (args[0] !== 'run') throw Error('Unexpected Docker command ' + args[0]);
        if (args.includes('LD_PRELOAD=/tmp/no-as-limit.so')) {
          if (mode === 'negative-passes') return ok();
          if (mode === 'negative-unrelated') return { status: 1, stdout: '', stderr: 'unrelated failure' };
          if (mode === 'negative-timeout') return { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
          return { status: 1, stdout: '', stderr: 'ERR_ASSERTION 2147483648 Max address space unlimited unlimited bytes' };
        }
        if (args.includes('ulimit -v')) return ok(mode === 'inherited-limit' ? '2097152' : 'unlimited');
        if (mode === 'product-failure') return { status: 42, stdout: '', stderr: 'product failed' };
        if (mode === 'product-timeout') return { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
        return ok();
      } } });
      process.argv = [process.execPath, process.env.DRIVER_HELPER, 'smoke', process.env.DRIVER_INPUT, process.env.DRIVER_PLATFORM, process.env.DRIVER_OUTPUT];
      await import(pathToFileURL(process.env.DRIVER_HELPER).href);
    `;
    for (const mode of [
      'success',
      'wrong-host',
      'inherited-limit',
      'negative-passes',
      'negative-unrelated',
      'negative-timeout',
      'product-failure',
      'product-timeout',
    ]) {
      const output = join(root, `${mode}.json`);
      const log = join(root, `${mode}.log`);
      const r = spawnSync(
        process.execPath,
        ['--experimental-test-module-mocks', '--input-type=module', '--eval', bootstrap],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_SHA: candidate.source,
            GITHUB_REPOSITORY: candidate.repository,
            GITHUB_REPOSITORY_OWNER: 'example',
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: `refs/tags/${candidate.tag}`,
            GITHUB_REF_NAME: candidate.tag,
            GITHUB_RUN_ID: candidate.runId,
            GITHUB_RUN_ATTEMPT: candidate.attempt,
            RUNNER_ARCH: process.arch === 'arm64' ? 'ARM64' : 'X64',
            DOCKER_HOST: '',
            DOCKER_CONTEXT: '',
            DRIVER_MODE: mode,
            DRIVER_LOG: log,
            DRIVER_HELPER: join(process.cwd(), 'scripts/release-app-native.mjs'),
            DRIVER_INPUT: input,
            DRIVER_PLATFORM: platform,
            DRIVER_OUTPUT: output,
          },
        }
      );
      assert.equal(r.error, undefined);
      if (mode === 'success') {
        assert.equal(r.status, 0, r.stderr);
        assert.equal(JSON.parse(readFileSync(output, 'utf8')).conclusion, 'success');
      } else {
        assert.equal(r.status, 1, `${mode}: ${r.stderr}`);
        assert.throws(() => readFileSync(output), { code: 'ENOENT' }, mode);
      }
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const runs = calls.filter((args) => args[0] === 'run');
      if (mode === 'wrong-host') {
        assert.equal(runs.length, 0);
        assert.ok(!calls.some((args) => args[0] === 'pull'));
      }
      if (mode === 'success') {
        assert.equal(runs.length, 3);
        assert.ok(runs[1].includes('test "$(ulimit -v)" = unlimited; exec "$@"'));
        const manifest = candidate.platforms.find((p) => p.platform === platform).digest;
        assert.ok(runs.every((args) => args.includes(`${candidate.image}@${manifest}`)));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Cargo target cache retains the image-owned dictionary build output with its absolute include paths', () => {
  const dockerfile = readFileSync('containers/test-env/Dockerfile', 'utf8');
  const dictionary = dockerfile.match(/^ENV LINDERA_BUILD_DICTIONARY_CACHE_DIR="([^"]+)"$/mu)?.[1];
  assert.ok(dictionary);
  const cache = step(workflow.jobs['l0-l2-shards'], 'Cache locked build inputs and outputs');
  assert.ok(cache.with.path.trim().split('\n').includes(dictionary));
});

test('registry admission runs after complete gates with read-only package authority and supports observation-only refresh', () => {
  const job = workflow.jobs['candidate-registry'];
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', packages: 'read' });
  assert.deepEqual(job.needs, [
    'candidate-plan',
    'candidate-index',
    'l0-l2',
    'nano-core-e2e',
    'web-e2e',
    'smoke',
    'app-image-admin-recovery',
    'nanohost-installer',
  ]);
  for (const prerequisite of job.needs.filter((n) => n !== 'candidate-plan'))
    assert.ok(job.if.includes(`needs.${prerequisite}.result == 'success'`));
  assert.match(job.if, /inputs.gate == 'registry-admission'/);
  const inspect = step(job, 'Inspect retained candidate indexes and immutable release identities');
  assert.match(inspect.run, /release-registry-evidence.mjs/);
  assert.equal(inspect.env.GITHUB_TOKEN, actionExpression('secrets.GITHUB_TOKEN'));
  const retain = step(job, 'Retain exact-P registry admission evidence');
  assert.equal(retain.with.name, 'registry-admission-$' + '{{ github.run_attempt }}');
  assert.equal(retain.with['if-no-files-found'], 'error');
  assert.ok(!job.steps.some((s) => s.uses?.startsWith('docker/build-push-action@')));
});

test('registry-only refresh runs exactly the read-only observation job and preserves all existing bootstrap gates', () => {
  const selected = Object.keys(workflow.jobs).filter((id) =>
    jobRuns(id, 'workflow_dispatch', 'refs/heads/candidate', 'registry-admission')
  );
  assert.deepEqual(selected, ['candidate-registry']);
  // Publishing bootstrap runs for every push, tag and dispatch gate except the two job-local paths.
  for (const id of ['test-image', 'nanohost-installer']) {
    for (const [event, ref] of [
      ['push', 'refs/heads/main'],
      ['push', 'refs/tags/v0.1.0-rc.8'],
    ])
      assert.equal(jobRuns(id, event, ref), true, `${id}: ${event} ${ref}`);
    for (const gate of workflow.on.workflow_dispatch.inputs.gate.options.filter(
      (g) => !['registry-admission', 'pr-check'].includes(g)
    ))
      assert.equal(
        jobRuns(id, 'workflow_dispatch', 'refs/heads/candidate', gate),
        true,
        `${id}: ${gate}`
      );
  }
  // A pull request is not admitted to the publishing image job; it builds that image job-locally,
  // and the host-placed installer keeps its pull-request gate.
  assert.equal(jobRuns('test-image', 'pull_request', 'refs/pull/1/merge'), false);
  assert.equal(
    jobRuns('test-image', 'workflow_dispatch', 'refs/heads/candidate', 'pr-check'),
    false
  );
  assert.equal(jobRuns('pr-check', 'pull_request', 'refs/pull/1/merge'), true);
  assert.equal(jobRuns('pr-check', 'workflow_dispatch', 'refs/heads/candidate', 'pr-check'), true);
  assert.equal(jobRuns('nanohost-installer', 'pull_request', 'refs/pull/1/merge'), true);
});

// The tag joins fresh native proof to the already-qualified candidate without constructing new bytes.
test('App tag admission fetches the proved candidate and cannot rebuild it', () => {
  const job = workflow.jobs['build-app-candidate'];
  assert.ok(!job.steps.some((s) => s.uses?.startsWith('docker/build-push-action@')));
  assert.ok(!job.steps.some((s) => s.uses?.startsWith('docker/setup-qemu-action@')));
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', packages: 'read' });
  const fetch = step(job, 'Fetch proved App candidate');
  assert.match(fetch.run, /release-candidate\.mjs fetch --id app/);
  assert.equal(fetch.env.GITHUB_TOKEN, actionExpression('secrets.GITHUB_TOKEN'));
  const digest = step(job, 'Resolve candidate digest');
  assert.match(digest.run, /CANDIDATE_DIGEST/);
  assert.match(digest.run, /EXISTING_DIGEST/);
  assert.match(digest.run, /exit 1/);
  assert.ok(workflow.jobs['smoke-app-native'].needs === 'build-app-candidate');
  assert.ok(workflow.jobs['publish-app-image'].needs.includes('smoke-app-native'));
});

// Execute the workflow-owned digest branch; an unproved or different digest must never be a retry fallback.
test('App tag digest selection refuses missing proof and immutable disagreement', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-app-candidate-selection-'));
  const candidate = `sha256:${'a'.repeat(64)}`;
  const other = `sha256:${'b'.repeat(64)}`;
  try {
    for (const [name, present, digest, existing, success] of [
      ['new', 'false', candidate, '', true],
      ['exact-retry', 'true', candidate, candidate, true],
      ['different', 'true', candidate, other, false],
      ['missing', 'true', '', candidate, false],
      ['invalid', 'false', 'invalid', '', false],
    ]) {
      const output = join(root, name);
      const result = spawnSync(
        'bash',
        ['-c', step(workflow.jobs['build-app-candidate'], 'Resolve candidate digest').run],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PRESENT: present,
            CANDIDATE_DIGEST: digest,
            EXISTING_DIGEST: existing,
            GITHUB_OUTPUT: output,
          },
        }
      );
      assert.equal(result.status === 0, success, name);
      if (success) {
        assert.equal(readFileSync(output, 'utf8'), `digest=${candidate}\nreused=${present}\n`);
      } else {
        assert.throws(() => readFileSync(output), { code: 'ENOENT' }, name);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest publication is required before notes and the existing immutable uploader carries all five assets', () => {
  const publish = workflow.jobs['github-release'];
  const manifest = step(publish, 'Generate release manifest and checksum');
  assert.ok(
    publish.steps.indexOf(manifest) < publish.steps.indexOf(step(publish, 'Create release notes'))
  );
  assert.match(manifest.run, /release-record\.mjs[\s\S]*--publication-assets portable-assets/u);
  assert.match(
    step(publish, 'Create immutable GitHub Release').run,
    /portable-assets\/openkit-release-\$\{GITHUB_REF_NAME\}\.json/u
  );
  const verification = step(
    workflow.jobs['verify-release'],
    'Download and verify GitHub Release assets'
  ).run;
  assert.match(verification, /openkit-release-\$\{process.env.GITHUB_REF_NAME\}\.json/u);
  assert.match(
    verification,
    /release-record\.mjs[\s\S]*--verify-publication-assets release-download/u
  );
});

test('stable rehearsal is tag-only, authority-gated, serialized and has no construction path', () => {
  const stable = parse(readFileSync('.github/workflows/release-promotion.yml', 'utf8'));
  assert.deepEqual(stable.on.push.tags, ['v*.*.*', '!v*.*.*-*']);
  assert.deepEqual(Object.keys(stable.on), ['push']);
  assert.deepEqual(stable.permissions, {});
  assert.equal(stable.concurrency.group, 'openkit-release');
  assert.equal(stable.concurrency['cancel-in-progress'], false);
  const job = stable.jobs.promote;
  const authority = job.steps[0];
  assert.ok(authority.run, 'the promotion job opens with an executable authority check');
  assert.ok(!authority.uses, 'the authority check runs no action');
  assert.ok(job.steps.indexOf(authority) < job.steps.findIndex((entry) => entry.uses));

  const sha = 'a'.repeat(40);
  const rehearsal = {
    PATH: process.env.PATH,
    REPOSITORY: 'notrucked/openkit',
    FORK: 'false',
    GITHUB_REF_NAME: 'v0.0.42',
    GITHUB_SHA: sha,
    OPENKIT_STABLE_PROMOTION: '',
  };
  const production = {
    PATH: process.env.PATH,
    REPOSITORY: 'lingkaix/openkit',
    FORK: 'false',
    GITHUB_REF_NAME: 'v0.1.0',
    GITHUB_SHA: sha,
    OPENKIT_STABLE_PROMOTION: `v0.1.0@${sha}`,
  };
  /** Runs the released authority check exactly as the runner would, with no other input. */
  const authorityStatus = (environment) =>
    spawnSync('bash', ['-eo', 'pipefail', '-c', authority.run], {
      env: environment,
      encoding: 'utf8',
    }).status;
  assert.equal(
    authorityStatus(rehearsal),
    0,
    'the bounded synthetic scratch stable rehearsal runs'
  );
  assert.equal(
    authorityStatus(production),
    0,
    'the exact engineer authorization admits production'
  );
  for (const [name, environment] of [
    ['unauthorized production promotion', { ...production, OPENKIT_STABLE_PROMOTION: '' }],
    [
      'an authorization for another tag',
      { ...production, OPENKIT_STABLE_PROMOTION: `v0.1.1@${sha}` },
    ],
    [
      'an authorization for another commit',
      { ...production, OPENKIT_STABLE_PROMOTION: `v0.1.0@${'b'.repeat(40)}` },
    ],
    ['an authorization without its commit', { ...production, OPENKIT_STABLE_PROMOTION: 'v0.1.0' }],
    ['a forked repository', { ...production, FORK: 'true' }],
    [
      'a foreign repository holding the exact production authorization',
      { ...production, REPOSITORY: 'example/openkit' },
    ],
    [
      'a production repository promoting a bounded synthetic version',
      { ...rehearsal, REPOSITORY: 'lingkaix/openkit' },
    ],
  ])
    assert.notEqual(authorityStatus(environment), 0, `${name} stops before any effect`);

  const promote = step(job, 'Promote and verify exact published bytes');
  assert.equal(
    promote.env.OPENKIT_STABLE_PROMOTION,
    actionExpression('vars.OPENKIT_STABLE_PROMOTION'),
    'the driver re-reads the same engineer authorization'
  );
  assert.match(
    promote.run,
    /release-promotion\.mjs[\s\S]*--repository "\$\{GITHUB_REPOSITORY\}" --tag "\$\{GITHUB_REF_NAME\}"[\s\S]*--sha "\$\{GITHUB_SHA\}"/u
  );
  const commands = job.steps.map((s) => s.run ?? '').join('\n');
  assert.doesNotMatch(
    commands,
    /(?:docker|pnpm|cargo) (?:build|buildx build)|package-release-assets\.mjs/u
  );
  for (const entry of job.steps) if (entry.uses) assert.match(entry.uses, /^[^@]+@[a-f0-9]{40}$/u);
  assert.match(readFileSync('scripts/release-preflight.mjs', 'utf8'), /requirePrerelease: true/u);
});

test('partitioned coverage merges the complete current-attempt reports without a product build', () => {
  const plan = workflow.jobs['l0-l2-plan'];
  assert.equal(plan.outputs.coverage, actionExpression('steps.plan.outputs.coverage'));
  assert.match(step(plan, 'Derive complete deterministic owners').run, /--coverage-matrix/u);
  const merge = workflow.jobs['l0-l2-coverage'];
  assert.ok(merge, 'whole-owner coverage is a required job');
  assert.equal(merge.name, `L0-L2 coverage (${actionExpression('matrix.id')})`);
  assert.deepEqual(merge.needs, ['test-image', 'l0-l2-plan', 'l0-l2-shards']);
  assert.equal(
    merge.strategy.matrix,
    actionExpression('fromJSON(needs.l0-l2-plan.outputs.coverage)')
  );
  assert.equal(merge.container.image, actionExpression('needs.test-image.outputs.image'));
  assert.equal(merge.permissions.actions, 'read');
  assert.equal(merge.if, workflow.jobs['l0-l2-shards'].if);
  const download = step(merge, 'Download current-attempt coverage partitions');
  assert.equal(
    download.with.pattern,
    `l0-l2-${actionExpression('matrix.id')}-*-attempt-${actionExpression('github.run_attempt')}`
  );
  assert.equal(download.with.path, 'temp/ci-shards');
  assert.equal(download.with['merge-multiple'], true);
  const commands = merge.steps.map((entry) => entry.run ?? '').join('\n');
  assert.match(commands, /pnpm install --frozen-lockfile/u);
  assert.match(
    commands,
    /runuser -u node -- env HOME="\$\{HOME\}" node scripts\/ci-l0-l2\.mjs --merge-coverage/u
  );
  assert.doesNotMatch(commands, /pnpm[^\n]*\bbuild\b|--run /u);
  const retained = step(merge, 'Retain successful coverage evidence');
  assert.equal(
    retained.with.name,
    `l0-l2-${actionExpression('matrix.id')}-coverage-attempt-${actionExpression('github.run_attempt')}`
  );
  assert.match(retained.with.path, /-coverage\.json/u);
  assert.match(retained.with.path, /-merged-execution\.report/u);
  assert.doesNotMatch(retained.with.path, /blobs|\*|inventory/u);
  assert.deepEqual(workflow.jobs['l0-l2'].needs, ['l0-l2-plan', 'l0-l2-shards', 'l0-l2-coverage']);
});

test('exact-job reuse restores attempt-bound reports instead of manufacturing success', () => {
  for (const [id, artifact] of [
    ['l0-l2-shards', ''],
    ['l0-l2-coverage', '-coverage'],
  ]) {
    const job = workflow.jobs[id];
    assert.ok(job);
    const reuse = job.steps.find((entry) => entry.id === 'reuse');
    assert.doesNotMatch(reuse.run, /writeFileSync|mkdir|conclusion|rootNodeInventory/u);
    assert.match(reuse.run, /run_id=/u);
    assert.match(reuse.run, /attempt=/u);
    const restored = step(job, 'Restore exact-commit execution evidence');
    assert.equal(restored.if, "steps.reuse.outputs.reused == 'true'");
    assert.equal(restored.with['run-id'], actionExpression('steps.reuse.outputs.run_id'));
    assert.equal(restored.with['github-token'], actionExpression('secrets.GITHUB_TOKEN'));
    assert.equal(
      restored.with.name,
      `l0-l2-${actionExpression('matrix.id')}${artifact}-attempt-${actionExpression('steps.reuse.outputs.attempt')}`
    );
    assert.equal(restored.with.path, 'temp/ci-shards');
  }
  const cache = step(workflow.jobs['l0-l2-shards'], 'Cache locked build inputs and outputs');
  assert.match(cache.uses, /^actions\/cache\/restore@[a-f0-9]{40}$/u);
  const retained = workflow.jobs['l0-l2-shards'].steps.find((entry) =>
    entry.uses?.startsWith('actions/upload-artifact@')
  );
  assert.equal(
    retained.with.name,
    `l0-l2-${actionExpression('matrix.id')}-attempt-${actionExpression('github.run_attempt')}`
  );
  assert.equal(
    step(workflow.jobs['l0-l2'], 'Download complete shard observations').with.pattern,
    `l0-l2-*-attempt-${actionExpression('github.run_attempt')}`
  );
});

// F5 compares committed settled promises, so these checks require complete history.
test('only repository-check owners fetch full operation-contract history', () => {
  assert.equal(step(workflow.jobs['pr-check'], 'Checkout').with['fetch-depth'], 0);
  assert.equal(
    step(workflow.jobs['l0-l2-shards'], 'Checkout').with['fetch-depth'],
    "${{ matrix.id == 'static' && '0' || '1' }}"
  );
});
