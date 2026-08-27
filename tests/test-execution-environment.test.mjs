import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('real-subscription entrypoint runs only the host runner after separate preflight', () => {
  assert.equal(
    rootManifest.scripts['test:e2e:real-subscription'],
    'bash scripts/test-env.sh host node apps/nanocore/e2e/provider-subscription-real-lifecycle-runner.mjs'
  );
});

test('image placement requires baked test-image identity in addition to executor metadata', () => {
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
      [fixtureScript, 'image', 'bash', '-c', 'printf STALE_IMAGE_ACCEPTED'],
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
      `inside-image placement accepted a stale build-input digest: ${result.stdout}`
    );
    assert.doesNotMatch(result.stdout, /STALE_IMAGE_ACCEPTED/u);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
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
