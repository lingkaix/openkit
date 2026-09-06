import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Reads a UTF-8 repository file used as test-execution configuration evidence.
 *
 * @param {string} relativePath - Repository-relative file path.
 * @returns {string} File contents.
 */
const read = (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8');
const testEnvScript = read('scripts/test-env.sh');
const testImageDockerfile = read('containers/test-env/Dockerfile');
const testImageSmoke = join(repoRoot, 'containers/test-env/smoke.sh');
const smokeImageScript = join(repoRoot, 'scripts/docker/smoke-image.sh');
const rootManifest = JSON.parse(read('package.json'));
const webManifest = JSON.parse(read('apps/web/package.json'));
const ciWorkflow = parse(read('.github/workflows/ci.yml'));
const turboTasks = JSON.parse(read('turbo.json')).tasks;

test('real-subscription entrypoint runs only the host runner after separate preflight', () => {
  assert.equal(
    rootManifest.scripts['test:e2e:real-subscription'],
    'bash scripts/test-env.sh host node apps/nanocore/e2e/provider-subscription-real-lifecycle-runner.mjs'
  );
});

/** Leaf ordinary gates that wrap their command with `any` placement. */
const ordinaryAnyPlacedScripts = [
  'build',
  'build:openkit',
  'bundle:openkit',
  'test',
  'typecheck',
  'fmt',
  'format:check',
  'lint',
  'check:repo',
  'lint:staged',
  'commitmsg:check',
  'test:unit',
  'test:coverage',
  'test:e2e:nano',
  'test:e2e:web',
  'test:smoke',
  'test:e2e:real-subscription:preflight',
];

/** Host-only gates that wrap their command with `host` placement. */
const ordinaryHostPlacedScripts = [
  'app:run',
  'init',
  'test:e2e:real-codex',
  'test:e2e:real-provider',
  'test:e2e:real-subscription',
  'test:e2e:real-task-mode',
];

test('ordinary root scripts use any placement rather than image', () => {
  assert.deepEqual(
    Object.fromEntries(
      ordinaryAnyPlacedScripts.map((scriptName) => [
        scriptName,
        typeof rootManifest.scripts[scriptName] === 'string' &&
          /^bash scripts\/test-env\.sh any\b/u.test(rootManifest.scripts[scriptName]),
      ])
    ),
    Object.fromEntries(ordinaryAnyPlacedScripts.map((scriptName) => [scriptName, true]))
  );
  assert.deepEqual(
    Object.fromEntries(
      ordinaryHostPlacedScripts.map((scriptName) => [
        scriptName,
        typeof rootManifest.scripts[scriptName] === 'string' &&
          /^bash scripts\/test-env\.sh host\b/u.test(rootManifest.scripts[scriptName]),
      ])
    ),
    Object.fromEntries(ordinaryHostPlacedScripts.map((scriptName) => [scriptName, true]))
  );
  const installerEntries = Object.entries(rootManifest.scripts).filter(([, command]) =>
    command.endsWith('bash tests/support/nanohost-release-installer-live.sh')
  );
  assert.equal(installerEntries.length, 1, 'root must expose one NanoHost installer host command');
  assert.match(installerEntries[0][1], /^bash scripts\/test-env\.sh host\b/u);
  const placedRootScripts = Object.entries(rootManifest.scripts)
    .filter(
      ([, command]) => typeof command === 'string' && /\bscripts\/test-env\.sh\b/u.test(command)
    )
    .map(([name]) => name);
  const placedRootScriptSet = new Set(placedRootScripts);
  const aggregateScripts = ['verify', 'verify:full', 'verify:l0-l2', 'verify:release'];
  assert.deepEqual(
    Object.fromEntries(
      aggregateScripts.map((scriptName) => [
        scriptName,
        /test-env\.sh/u.test(rootManifest.scripts[scriptName] ?? ''),
      ])
    ),
    Object.fromEntries(aggregateScripts.map((scriptName) => [scriptName, false]))
  );
  assert.deepEqual(
    Object.fromEntries(
      placedRootScripts.map((scriptName) => {
        const tokens = (rootManifest.scripts[scriptName] ?? '')
          .split(/[\s;&|]+/u)
          .map((token) => token.replace(/^['"]+|['"]+$/gu, ''))
          .filter(Boolean);
        const callsPlaced = [];
        for (let index = 0; index < tokens.length; index += 1) {
          if (tokens[index] !== 'pnpm') continue;
          const name = tokens[index + 1] === 'run' ? tokens[index + 2] : tokens[index + 1];
          if (typeof name !== 'string' || name.startsWith('-')) continue;
          if (placedRootScriptSet.has(name) && !callsPlaced.includes(name)) callsPlaced.push(name);
        }
        return [scriptName, callsPlaced];
      })
    ),
    Object.fromEntries(placedRootScripts.map((scriptName) => [scriptName, []]))
  );
  const openkitCliEsbuild = /esbuild skills\/openkit-cli\.mjs(?:\s+--[^\s'"]+)+/u;
  const esbuildProducers = ['build', 'build:openkit', 'bundle:openkit', 'test:unit'].map(
    (scriptName) => (rootManifest.scripts[scriptName] ?? '').match(openkitCliEsbuild)?.[0] ?? ''
  );
  assert.ok(esbuildProducers[0], 'openkit-cli esbuild producer invocation is missing');
  assert.deepEqual(esbuildProducers, [
    esbuildProducers[0],
    esbuildProducers[0],
    esbuildProducers[0],
    esbuildProducers[0],
  ]);
});

test('workspace vitest test scripts select tap-flat reporter', () => {
  const observed = {};
  for (const workspaceDir of ['apps', 'packages']) {
    for (const entry of readdirSync(join(repoRoot, workspaceDir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relativePath = `${workspaceDir}/${entry.name}/package.json`;
      const command = JSON.parse(read(relativePath)).scripts?.test;
      if (typeof command === 'string' && /\bvitest\s+run\b/u.test(command)) {
        observed[relativePath] = /(^|\s)--reporter=tap-flat(\s|$)/u.test(command);
      }
    }
  }
  assert.ok(
    Object.keys(observed).length > 0,
    'no workspace package test script invokes vitest run'
  );
  assert.deepEqual(
    observed,
    Object.fromEntries(Object.keys(observed).map((relativePath) => [relativePath, true]))
  );
});

test('test-env placements are any and host', () => {
  assert.match(testEnvScript, /Usage: scripts\/test-env\.sh <any\|host>/u);
  assert.match(testEnvScript, /^\s*any\)/mu);
  assert.match(testEnvScript, /^\s*host\)/mu);
  assert.doesNotMatch(testEnvScript, /^\s*image\)/mu);
});

test('any placement runs the command directly by default', () => {
  const result = spawnSync(
    'bash',
    [join(repoRoot, 'scripts/test-env.sh'), 'any', 'printf', 'DIRECT_ANY'],
    { encoding: 'utf8', cwd: repoRoot }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'DIRECT_ANY');
  assert.doesNotMatch(result.stderr, /Unknown placement/u);
  assert.doesNotMatch(result.stderr, /Docker is required/u);
});

test('any placement labels host and image environments distinctly', () => {
  const hostEnvironment = { ...process.env };
  delete hostEnvironment.OPENKIT_TEST_EXECUTOR;
  delete hostEnvironment.OPENKIT_TEST_USE_IMAGE;
  const hostRun = spawnSync(
    'bash',
    [
      join(repoRoot, 'scripts/test-env.sh'),
      'any',
      'bash',
      '-c',
      'printf %s "$OPENKIT_TEST_ENVIRONMENT"',
    ],
    { encoding: 'utf8', cwd: repoRoot, env: hostEnvironment }
  );
  const imageFixture = prepareInImageFixture();

  try {
    const imageRun = spawnSync(
      'bash',
      [imageFixture.fixtureScript, 'any', 'bash', '-c', 'printf %s "$OPENKIT_TEST_ENVIRONMENT"'],
      {
        cwd: imageFixture.fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, OPENKIT_TEST_EXECUTOR: '1' },
      }
    );

    assert.equal(hostRun.status, 0, hostRun.stderr);
    assert.equal(imageRun.status, 0, imageRun.stderr);
    assert.equal(hostRun.stdout, 'host');
    assert.equal(imageRun.stdout, 'image');
  } finally {
    rmSync(imageFixture.fixtureRoot, { force: true, recursive: true });
  }
});

test('any placement does not re-run a failed command inside the image', () => {
  const result = spawnSync(
    'bash',
    [join(repoRoot, 'scripts/test-env.sh'), 'any', 'bash', '-c', 'exit 7'],
    { encoding: 'utf8', cwd: repoRoot }
  );

  assert.equal(result.status, 7, result.stderr);
  assert.doesNotMatch(result.stderr, /Unknown placement/u);
  assert.doesNotMatch(result.stderr, /Docker is required/u);
});

test('host placement refuses to run inside the test image', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-test-env-host-refuse-'));
  const fixtureScript = join(fixtureRoot, 'scripts/test-env.sh');
  const fixtureIdentity = join(fixtureRoot, 'openkit-test-env');

  try {
    mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true });
    writeFileSync(
      fixtureScript,
      testEnvScript.replaceAll('/etc/openkit-test-env', fixtureIdentity),
      { mode: 0o755 }
    );
    writeFileSync(fixtureIdentity, 'identity\n');
    const result = spawnSync('bash', [fixtureScript, 'host', 'printf', 'HOST_INSIDE_IMAGE'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, OPENKIT_TEST_EXECUTOR: '1' },
    });

    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout, /HOST_INSIDE_IMAGE/u);
    assert.match(result.stderr, /must run on the host/iu);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('in-image execution requires baked test-image identity in addition to executor metadata', () => {
  const functionBody = testEnvScript.match(/inside_test_image\(\)\s*\{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(functionBody, 'scripts/test-env.sh does not declare inside_test_image');
  assert.match(functionBody, /OPENKIT_TEST_EXECUTOR/u);
  const identityPath = functionBody.match(/-[efr]\s+["']?(\/[a-zA-Z0-9_./-]+)/u)?.[1];
  assert.ok(
    identityPath,
    'scripts/test-env.sh lets OPENKIT_TEST_EXECUTOR alone declare image placement'
  );
  assert.doesNotMatch(
    functionBody,
    /\|\|/u,
    'scripts/test-env.sh provides an alternate host-controlled image-identity branch'
  );
  assert.match(
    testImageDockerfile,
    new RegExp(`(?:COPY|RUN)[^\\n]*${identityPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'),
    `containers/test-env/Dockerfile does not bake ${identityPath}`
  );
});

test('inside-image placement rejects a stale build-input digest before running the check', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-test-env-stale-fast-path-'));
  const fixtureScript = join(fixtureRoot, 'scripts/test-env.sh');
  const fixtureIdentity = join(fixtureRoot, 'openkit-test-env');

  try {
    for (const directory of ['apps/web', 'containers/test-env', 'scripts/docker']) {
      mkdirSync(join(fixtureRoot, directory), { recursive: true });
    }
    writeFileSync(
      fixtureScript,
      testEnvScript
        .replaceAll('/etc/openkit-test-env', fixtureIdentity)
        .replaceAll('/workspace', fixtureRoot),
      { mode: 0o755 }
    );
    writeFileSync(
      join(fixtureRoot, 'scripts/docker/test-image-tag.mjs'),
      read('scripts/docker/test-image-tag.mjs')
    );
    for (const relativePath of [
      'apps/web/package.json',
      'containers/images.json',
      'containers/test-env/Dockerfile',
      'containers/test-env/smoke.sh',
    ]) {
      writeFileSync(join(fixtureRoot, relativePath), read(relativePath));
    }
    writeFileSync(fixtureIdentity, 'sha256:stale\n');
    writeFileSync(`${fixtureIdentity}-build-input-digest`, 'sha256:stale\n');

    const result = spawnSync(
      'bash',
      [fixtureScript, 'any', 'bash', '-c', 'printf STALE_IMAGE_ACCEPTED'],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          OPENKIT_TEST_EXECUTOR: '1',
          OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST: 'sha256:stale',
        },
      }
    );

    assert.notEqual(
      result.status,
      0,
      `inside-image any placement accepted a stale build-input digest: ${result.stdout}`
    );
    assert.doesNotMatch(result.stderr, /Unknown placement/u);
    assert.match(result.stderr, /build-input digest/iu);
    assert.doesNotMatch(result.stdout, /STALE_IMAGE_ACCEPTED/u);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('test image uses the exact worker baseline Node digest and does not derive worker-common', () => {
  const workerFrom = read('containers/workers/Dockerfile').match(
    /^FROM (node:\d+\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}) AS worker-common$/mu
  )?.[1];
  const testEnvFrom = testImageDockerfile.match(/^FROM (\S+)$/mu)?.[1];

  assert.ok(
    workerFrom,
    'containers/workers/Dockerfile does not declare a digest-pinned Node worker-common base'
  );
  assert.equal(
    testEnvFrom,
    workerFrom,
    'containers/test-env/Dockerfile Node FROM drifted from the worker baseline digest'
  );
  assert.doesNotMatch(
    testImageDockerfile,
    /^FROM worker-common\b/mu,
    'containers/test-env/Dockerfile derives from worker-common; it is an internal sibling of that public base'
  );
});

test('test image does not globally select the internal self-check executor', () => {
  assert.doesNotMatch(
    testImageDockerfile,
    /^\s*ENV\s+OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR\b/mu,
    'containers/test-env/Dockerfile changes NanoCore default worker behavior for ordinary tests'
  );
});

test('test image installs the exact workspace Playwright version', () => {
  const workspaceDeclaration = webManifest.devDependencies['@playwright/test'];
  const workspaceVersion = workspaceDeclaration.replace(/^[~^]/u, '');
  const dockerVersion = testImageDockerfile.match(/playwright@(\d+\.\d+\.\d+)\s+install/u)?.[1];

  assert.deepEqual(
    {
      dockerVersion,
      workspaceDeclaration,
      workspaceDeclarationIsExact: /^\d+\.\d+\.\d+$/u.test(workspaceDeclaration),
    },
    {
      dockerVersion: workspaceVersion,
      workspaceDeclaration: workspaceVersion,
      workspaceDeclarationIsExact: true,
    }
  );
});

test('test image smoke requires Playwright headless-shell and rejects Xvfb', () => {
  const browserRoot = mkdtempSync(join(tmpdir(), 'openkit-test-env-browser-smoke-'));
  const fakeBin = join(browserRoot, 'bin');

  try {
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'Xvfb'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    mkdirSync(join(browserRoot, 'chromium-123'));
    const arbitraryChromium = spawnSync('bash', [testImageSmoke], {
      encoding: 'utf8',
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot },
    });
    rmSync(join(browserRoot, 'chromium-123'), { recursive: true });
    mkdirSync(join(browserRoot, 'chromium_headless_shell-123'));
    const headlessShell = spawnSync('bash', [testImageSmoke], {
      encoding: 'utf8',
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot },
    });
    const forbiddenXvfb = spawnSync('bash', [testImageSmoke], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        PLAYWRIGHT_BROWSERS_PATH: browserRoot,
      },
    });

    assert.deepEqual(
      {
        arbitraryChromiumStatus: arbitraryChromium.status,
        forbiddenXvfbStatus: forbiddenXvfb.status,
        headlessShellStatus: headlessShell.status,
      },
      {
        arbitraryChromiumStatus: 1,
        forbiddenXvfbStatus: 1,
        headlessShellStatus: 0,
      }
    );
  } finally {
    rmSync(browserRoot, { force: true, recursive: true });
  }
});

test('smoke-image verifies the test-env build-input label before execution', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-test-image-smoke-'));
  const fakeBin = join(fixtureRoot, 'bin');
  const dockerLog = join(fixtureRoot, 'docker.log');
  const expectedDigest = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts/docker/test-image-tag.mjs'), '--digest'],
    { encoding: 'utf8' }
  );

  try {
    assert.equal(expectedDigest.status, 0, expectedDigest.stderr);
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, 'docker'),
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$*" == *inspect* ]]; then
  printf '%s\n' "$FAKE_TEST_IMAGE_LABEL"
  exit 0
fi
if [[ "$1" == "run" ]]; then
  exit 0
fi
exit 97
`,
      { mode: 0o755 }
    );
    const baseEnv = {
      ...process.env,
      FAKE_DOCKER_LOG: dockerLog,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    };
    const mismatched = spawnSync('bash', [smokeImageScript, 'test-env', 'openkit/test-env:test'], {
      encoding: 'utf8',
      env: { ...baseEnv, FAKE_TEST_IMAGE_LABEL: 'sha256:mismatched' },
    });
    const mismatchedLog = readFileSync(dockerLog, 'utf8');
    writeFileSync(dockerLog, '');
    const matched = spawnSync('bash', [smokeImageScript, 'test-env', 'openkit/test-env:test'], {
      encoding: 'utf8',
      env: { ...baseEnv, FAKE_TEST_IMAGE_LABEL: expectedDigest.stdout.trim() },
    });
    const matchedLog = readFileSync(dockerLog, 'utf8');

    assert.deepEqual(
      { matchedStatus: matched.status, mismatchedStatus: mismatched.status },
      { matchedStatus: 0, mismatchedStatus: 1 }
    );
    assert.doesNotMatch(mismatchedLog, /^run\b/mu);
    assert.match(matchedLog, /inspect/u);
    assert.match(matchedLog, /^run\b/mu);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('test image content tag changes with every manifest-selected build input', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-test-image-tag-'));
  const tagScript = join(fixtureRoot, 'scripts/docker/test-image-tag.mjs');
  const fixtureWebManifest = join(fixtureRoot, 'apps/web/package.json');
  const fixtureImageManifest = join(fixtureRoot, 'containers/images.json');
  const fixtureManifest = {
    images: [
      {
        context: '.',
        dockerfile: 'containers/test-env/Dockerfile',
        id: 'test-env',
        localTag: 'openkit/test-env:dev',
        platforms: ['linux/amd64'],
        repository: 'openkit-test-env',
        smoke: 'containers/test-env/smoke.sh',
      },
    ],
    registry: 'ghcr.io',
  };

  try {
    for (const directory of ['apps/web', 'containers/test-env', 'scripts/docker']) {
      mkdirSync(join(fixtureRoot, directory), { recursive: true });
    }
    writeFileSync(tagScript, read('scripts/docker/test-image-tag.mjs'));
    writeFileSync(fixtureImageManifest, JSON.stringify(fixtureManifest));
    writeFileSync(join(fixtureRoot, 'containers/test-env/Dockerfile'), testImageDockerfile);
    writeFileSync(
      join(fixtureRoot, 'containers/test-env/smoke.sh'),
      read('containers/test-env/smoke.sh')
    );
    writeFileSync(fixtureWebManifest, `${JSON.stringify(webManifest)}\n`);

    const before = spawnSync(process.execPath, [tagScript], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });
    assert.equal(before.status, 0, before.stderr);
    writeFileSync(
      fixtureWebManifest,
      `${JSON.stringify({
        ...webManifest,
        devDependencies: {
          ...webManifest.devDependencies,
          '@playwright/test': '99.0.0',
        },
      })}\n`
    );
    const after = spawnSync(process.execPath, [tagScript], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });
    assert.equal(after.status, 0, after.stderr);
    writeFileSync(fixtureWebManifest, `${JSON.stringify(webManifest)}\n`);
    writeFileSync(
      fixtureImageManifest,
      JSON.stringify({
        ...fixtureManifest,
        images: [{ ...fixtureManifest.images[0], context: 'containers/test-env' }],
      })
    );
    const afterContextChange = spawnSync(process.execPath, [tagScript], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });
    assert.equal(afterContextChange.status, 0, afterContextChange.stderr);
    writeFileSync(
      fixtureImageManifest,
      JSON.stringify({
        ...fixtureManifest,
        images: [{ ...fixtureManifest.images[0], platforms: ['linux/arm64'] }],
      })
    );
    const afterPlatformsChange = spawnSync(process.execPath, [tagScript], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });
    assert.equal(afterPlatformsChange.status, 0, afterPlatformsChange.stderr);

    assert.deepEqual(
      {
        contextChangesTag: before.stdout.trim() !== afterContextChange.stdout.trim(),
        platformsChangesTag: before.stdout.trim() !== afterPlatformsChange.stdout.trim(),
        webManifestChangesTag: before.stdout.trim() !== after.stdout.trim(),
      },
      {
        contextChangesTag: true,
        platformsChangesTag: true,
        webManifestChangesTag: true,
      },
      'test image tag does not cover every manifest-selected build input'
    );
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

/**
 * Builds a checkout-shaped fixture of test-env.sh that is already inside the image.
 *
 * When `digestFileContents` is omitted, the baked digest matches the fixture tree so an in-image `any` command can run.
 *
 * @param {string} [digestFileContents] Optional mismatched digest file body.
 * @returns {{ fixtureRoot: string, fixtureScript: string }} Fixture paths.
 */
function prepareInImageFixture(digestFileContents) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-test-env-in-image-'));
  const fixtureScript = join(fixtureRoot, 'scripts/test-env.sh');
  const fixtureIdentity = join(fixtureRoot, 'openkit-test-env');

  for (const directory of ['apps/web', 'containers/test-env', 'scripts/docker']) {
    mkdirSync(join(fixtureRoot, directory), { recursive: true });
  }
  writeFileSync(
    fixtureScript,
    testEnvScript
      .replaceAll('/etc/openkit-test-env', fixtureIdentity)
      .replaceAll('/workspace', fixtureRoot),
    { mode: 0o755 }
  );
  writeFileSync(
    join(fixtureRoot, 'scripts/docker/test-image-tag.mjs'),
    read('scripts/docker/test-image-tag.mjs')
  );
  for (const relativePath of [
    'apps/web/package.json',
    'containers/images.json',
    'containers/test-env/Dockerfile',
    'containers/test-env/smoke.sh',
  ]) {
    writeFileSync(join(fixtureRoot, relativePath), read(relativePath));
  }
  writeFileSync(fixtureIdentity, 'identity\n');
  const digest =
    digestFileContents ??
    spawnSync(
      process.execPath,
      [join(fixtureRoot, 'scripts/docker/test-image-tag.mjs'), '--digest'],
      { cwd: fixtureRoot, encoding: 'utf8' }
    ).stdout;
  writeFileSync(
    `${fixtureIdentity}-build-input-digest`,
    digest.endsWith('\n') ? digest : `${digest}\n`
  );
  return { fixtureRoot, fixtureScript };
}

/**
 * Resolves the git `safe.directory` values one merged workflow environment declares.
 *
 * @param {Record<string, unknown>} env - Merged workflow-level and job-level environment map.
 * @returns {string[]} Declared `safe.directory` values in declaration order.
 */
const declaredGitSafeDirectories = (env) => {
  const declared = [];
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  for (let index = 0; index < count; index += 1) {
    if (env[`GIT_CONFIG_KEY_${index}`] !== 'safe.directory') continue;
    const value = env[`GIT_CONFIG_VALUE_${index}`];
    if (typeof value === 'string' && value.length > 0) declared.push(value);
  }
  return declared;
};

/**
 * Reads the workspace dependency graph from every app and package manifest.
 *
 * @returns {Map<string, string[]>} Package name to its declared workspace dependency names.
 */
const readWorkspaceGraph = () => {
  const graph = new Map();
  for (const workspaceDir of ['apps', 'packages']) {
    for (const entry of readdirSync(join(repoRoot, workspaceDir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(repoRoot, workspaceDir, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const declared = { ...manifest.dependencies, ...manifest.devDependencies };
      graph.set(
        manifest.name,
        Object.entries(declared)
          .filter(([, range]) => typeof range === 'string' && range.startsWith('workspace:'))
          .map(([name]) => name)
      );
    }
  }
  return graph;
};

/**
 * Resolves the transitive workspace dependencies of one package, excluding the package itself.
 *
 * @param {Map<string, string[]>} graph - Workspace dependency graph.
 * @param {string} packageName - Package whose dependencies are resolved.
 * @returns {Set<string>} Transitive workspace dependency names.
 */
const workspaceDependencyClosure = (graph, packageName) => {
  const resolved = new Set();
  const pending = [...(graph.get(packageName) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || resolved.has(next)) continue;
    resolved.add(next);
    pending.push(...(graph.get(next) ?? []));
  }
  return resolved;
};

/**
 * Asks Turbo which packages one build selection would build.
 *
 * @param {string[]} filters - Turbo `--filter` values taken from a root gate command.
 * @returns {Set<string>} Package names Turbo selects for the build task.
 */
const turboBuildSelection = (filters) => {
  const result = spawnSync(
    join(repoRoot, 'node_modules/.bin/turbo'),
    ['run', 'build', ...filters.map((filter) => `--filter=${filter}`), '--dry=json'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );

  assert.equal(result.status, 0, result.stderr);
  return new Set(
    JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))).tasks.map((task) => task.package)
  );
};

// The image runs as root while the bind-mounted checkout keeps the runner user's ownership, so
// every gate placed in the image reaches a repository git refuses to read until the checkout is
// declared safe. `actions/checkout` declares it only under a temporary HOME its own steps use.
// The container checkout is `/__w/<repository>/<repository>`; no repository file names the GitHub
// repository independently, so one shared same-segment path is the strongest available static
// check. It rejects a wildcard, which would disable the ownership check for every repository, and
// a prefix or mismatched pair, which would leave the checkout uncovered.
test('every image-placed CI gate can run git against the checked-out repository', () => {
  const containerJobs = Object.entries(ciWorkflow.jobs).filter(([, job]) => job.container);

  assert.ok(containerJobs.length > 0, 'no CI job is placed inside the test execution image');

  const declared = Object.fromEntries(
    containerJobs.map(([jobId, job]) => [
      jobId,
      declaredGitSafeDirectories({ ...ciWorkflow.env, ...job.env }),
    ])
  );
  const distinct = new Set(Object.values(declared).flat());

  assert.deepEqual(
    Object.fromEntries(Object.entries(declared).map(([jobId, values]) => [jobId, values.length])),
    Object.fromEntries(Object.keys(declared).map((jobId) => [jobId, 1]))
  );
  assert.equal(
    distinct.size,
    1,
    `image-placed jobs disagree on the safe checkout path: ${[...distinct]}`
  );
  assert.match([...distinct][0], /^\/__w\/([^/]+)\/\1$/u);
});

// A workspace package publishes its types and entry through `dist`, which `.gitignore` excludes, so
// a gate that compiles or imports a dependent package must build the dependency graph rather than
// the single package. The selection is read back from Turbo rather than from the command text,
// because a filter that looks plausible can still select the wrong packages: `@openkit/protocol^...`
// selects five packages although `@openkit/protocol` declares no workspace dependency at all.
test('gates that compile or import a workspace package build its dependencies first', () => {
  assert.deepEqual(
    Object.fromEntries(
      ['typecheck', 'test'].map((taskName) => [
        taskName,
        (turboTasks[taskName]?.dependsOn ?? []).includes('^build'),
      ])
    ),
    { test: true, typecheck: true }
  );

  const graph = readWorkspaceGraph();
  const exercisedPackages = {
    'test:e2e:nano': ['@openkit/nanocore'],
    'test:e2e:web': ['@openkit/nanocore', '@openkit/web'],
    'test:smoke': ['@openkit/nanocore', '@openkit/web'],
  };
  const unbuilt = Object.fromEntries(
    Object.entries(exercisedPackages).map(([scriptName, packageNames]) => {
      const command = rootManifest.scripts[scriptName] ?? '';
      const filters = [...command.matchAll(/--filter=(\S+)/gu)].map((match) => match[1]);
      const selected = filters.length === 0 ? new Set() : turboBuildSelection(filters);
      const required = packageNames.flatMap((packageName) => [
        ...workspaceDependencyClosure(graph, packageName),
      ]);
      return [scriptName, [...new Set(required)].filter((name) => !selected.has(name)).sort()];
    })
  );

  assert.deepEqual(
    unbuilt,
    Object.fromEntries(Object.keys(exercisedPackages).map((scriptName) => [scriptName, []]))
  );
});
