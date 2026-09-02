import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const miseConfig = read('.mise.toml');
const nanohostMiseConfig = read('apps/nanohost/mise.toml');
const rootManifest = JSON.parse(read('package.json'));
const nodeVersionFile = read('.node-version').trim();
const nvmrc = read('.nvmrc').trim();
const ciWorkflow = read('.github/workflows/ci.yml');
const lefthookConfig = read('lefthook.yml');
const repoInitScript = read('scripts/repo-init.sh');
const testImageDockerfile = read('containers/test-env/Dockerfile');

/**
 * Reads one `[tools]` version from a mise.toml body without a TOML dependency.
 *
 * The file is deliberately small enough that a line read is sufficient, and a
 * parser dependency here would outweigh the invariant it serves.
 *
 * @param {string} source Text of the mise.toml file.
 * @param {string} relativePath Path used in assertion messages.
 * @param {string} tool Tool key as it appears in the `[tools]` table.
 * @returns {string} Declared version value.
 */
function misePinFrom(source, relativePath, tool) {
  const match = source.match(new RegExp(`^${tool}\\s*=\\s*"([^"]+)"`, 'mu'));
  assert.ok(match, `${relativePath} does not pin ${tool}`);
  return match[1];
}

/**
 * Reads one `[tools]` version from root `.mise.toml`.
 *
 * @param {string} tool Tool key as it appears in the `[tools]` table.
 * @returns {string} Declared version value.
 */
function misePin(tool) {
  return misePinFrom(miseConfig, '.mise.toml', tool);
}

/**
 * Reads one pinned version out of the test execution image Dockerfile.
 *
 * @param {RegExp} pattern Pattern whose first capture group is the version.
 * @param {string} description Human name of the pin, used in the failure message.
 * @returns {string} Declared version value.
 */
function testImagePin(pattern, description) {
  const match = testImageDockerfile.match(pattern);
  assert.ok(match, `containers/test-env/Dockerfile does not pin ${description}`);
  return match[1];
}

test('.mise.toml stays a version anchor and defines no tasks', () => {
  // docs/toolchain.md Toolchain Provisioning Boundary: root package.json owns the
  // command surface, so a mise task table would restore a second owner for it.
  assert.doesNotMatch(
    miseConfig,
    /^\[tasks[.\]]/mu,
    '.mise.toml defines tasks; repository commands are owned by root package.json scripts'
  );
});

test('every declaration of the pnpm version agrees', () => {
  const pinned = misePin('pnpm');
  assert.match(
    pinned,
    /^\d+\.\d+\.\d+$/u,
    `.mise.toml pnpm pin "${pinned}" is not an exact version`
  );
  assert.equal(rootManifest.packageManager, `pnpm@${pinned}`);
  assert.equal(testImagePin(/corepack prepare pnpm@(\S+) --activate/u, 'pnpm'), pinned);
});

test('every declaration of the exact Node version agrees', () => {
  const pinned = misePin('node');
  assert.match(
    pinned,
    /^\d+\.\d+\.\d+$/u,
    `.mise.toml Node pin "${pinned}" is not an exact version`
  );
  assert.equal(nodeVersionFile, pinned);
  assert.equal(nvmrc, pinned);
  assert.equal(rootManifest.engines.node, pinned);
});

test('every declaration of the exact Biome version agrees', () => {
  const pinned = misePin('biome');
  assert.match(
    pinned,
    /^\d+\.\d+\.\d+$/u,
    `.mise.toml Biome pin "${pinned}" is not an exact version`
  );
  assert.equal(rootManifest.devDependencies['@biomejs/biome'], pinned);
});

test('the NanoHost Rust pin and the test image Rust pin agree exactly', () => {
  // apps/nanohost/mise.toml owns the NanoHost-scoped Rust version. The test
  // execution image must mirror that exact version without mise: the stable
  // parseable declaration is a single Dockerfile line
  // `ENV RUST_VERSION=<major.minor.patch>` (unquoted), which rustup install
  // steps must consume rather than hard-coding a second literal.
  const pinned = misePinFrom(nanohostMiseConfig, 'apps/nanohost/mise.toml', 'rust');
  assert.match(
    pinned,
    /^\d+\.\d+\.\d+$/u,
    `apps/nanohost/mise.toml Rust pin "${pinned}" is not an exact version`
  );
  assert.equal(
    testImagePin(/^ENV RUST_VERSION=(\d+\.\d+\.\d+)\s*$/mu, 'an exact RUST_VERSION'),
    pinned
  );
});

test('the generic test execution image does not provision Codex', () => {
  // docs/toolchain.md Test Execution Environment: real Codex checks run on the host or in a dedicated worker image.
  assert.doesNotMatch(
    testImageDockerfile,
    /codex/iu,
    'containers/test-env/Dockerfile provisions Codex; the generic repository-gate image must not install a worker runtime'
  );
});

test('CI keeps Node and pnpm in test-env and uses the app-owned Rust setup path', () => {
  // docs/toolchain.md Test Execution Environment: any-placed Node and pnpm gates
  // take those runtimes from test-env, while the native NanoHost job follows its
  // app-scoped mise Rust owner instead of adding a rustup mirror.
  assert.doesNotMatch(
    ciWorkflow,
    /uses:\s*pnpm\/action-setup@/u,
    'ci.yml provisions pnpm directly; the test execution image already pins it'
  );
  assert.doesNotMatch(
    ciWorkflow,
    /uses:\s*actions\/setup-node@/u,
    'ci.yml provisions Node directly; the test execution image already pins it'
  );
  assert.doesNotMatch(
    ciWorkflow,
    /\brustup(?:\s|$)/u,
    'ci.yml bypasses the NanoHost-scoped mise Rust pin with rustup'
  );
});

test('root hook gates use any placement and do not require Docker', () => {
  for (const scriptName of ['lint:staged', 'commitmsg:check']) {
    assert.match(
      rootManifest.scripts[scriptName],
      /^bash scripts\/test-env\.sh any\b/u,
      `package.json script ${scriptName} still requires image placement`
    );
    assert.doesNotMatch(
      rootManifest.scripts[scriptName],
      /test-env\.sh image\b/u,
      `package.json script ${scriptName} still names retired image placement`
    );
  }
});

test('the tracked hooks activate the root any-placed gates', () => {
  // CONTRIBUTING.md Local Validation Workflow: initialized repositories run
  // staged checks before commit and validate Conventional Commit messages.
  assert.match(
    lefthookConfig,
    /^commit-msg:\s*[\s\S]*?^\s+run:\s*pnpm run commitmsg:check -- \{1\}\s*$/mu,
    'lefthook.yml does not activate commit-msg through the root commitmsg:check any-placement script'
  );
  assert.match(
    lefthookConfig,
    /^pre-commit:\s*[\s\S]*?^\s+run:\s*pnpm run lint:staged\s*$/mu,
    'lefthook.yml does not activate pre-commit through the root lint:staged any-placement script'
  );
  assert.doesNotMatch(
    lefthookConfig,
    /^\s+run:\s*bash scripts\/check-commit-msg\.sh\s/mu,
    'lefthook.yml invokes the commit-message checker directly on the host'
  );
});

test('tracked lefthook config is the single hook configuration owner', () => {
  assert.deepEqual(
    {
      exampleConfigExists: existsSync(new URL('../lefthook.example.yml', import.meta.url)),
      repoInitPromotesExample: repoInitScript.includes('lefthook.example.yml'),
    },
    {
      exampleConfigExists: false,
      repoInitPromotesExample: false,
    },
    'lefthook.example.yml and its repo-init promotion duplicate the tracked lefthook.yml owner'
  );
});

test('CI derives the test image build context and Dockerfile from the image manifest', () => {
  const testImageJob = ciWorkflow.match(
    /\n {2}test-image:\n(?: {4}.*\n|\n)+?(?=\n {2}pr-check:)/u
  )?.[0];
  assert.ok(testImageJob, 'ci.yml does not declare the test-image job');
  assert.match(
    testImageJob,
    /containers\/images\.json/u,
    'ci.yml test-image job does not read containers/images.json'
  );
  assert.match(
    testImageJob,
    /context:\s*\$\{\{\s*steps\.expected\.outputs\.context\s*\}\}/u,
    'ci.yml test-image build context is not derived from the manifest output'
  );
  assert.match(
    testImageJob,
    /file:\s*\$\{\{\s*steps\.expected\.outputs\.dockerfile\s*\}\}/u,
    'ci.yml test-image Dockerfile is not derived from the manifest output'
  );
});

test('every any-placed CI gate runs inside the test execution image', () => {
  const gateJobs = ['pr-check', 'l0-l2', 'nano-core-e2e', 'web-e2e', 'smoke', 'release-preflight'];

  for (const job of gateJobs) {
    const block = ciWorkflow.match(new RegExp(`\\n  ${job}:\\n(?:    .*\\n|\\n)+`, 'u'));
    assert.ok(block, `ci.yml does not declare the ${job} job`);
    assert.match(
      block[0],
      /container:\s*\n\s*image:\s*\$\{\{\s*needs\.test-image\.outputs\.image\s*\}\}/u,
      `ci.yml job ${job} does not run inside the test execution image`
    );
  }
});

test('the one NanoHost installer host gate runs outside the test image', () => {
  const leaf = 'bash tests/support/nanohost-release-installer-live.sh';
  const jobBlocks = [...ciWorkflow.matchAll(/\n {2}([a-z0-9-]+):\n((?: {4}.*\n|\n)+)/gu)].filter(
    ([, , body]) => body.includes(leaf)
  );
  assert.equal(jobBlocks.length, 1, 'ci.yml must invoke the installer shell leaf in one job');
  const [, jobName, body] = jobBlocks[0];
  assert.match(jobName, /nanohost.*installer|installer.*nanohost/u);
  assert.doesNotMatch(body, /^ {4}container:/mu);
  assert.match(body, /apt-get install[^\n]*bubblewrap/u);
  assert.match(body, new RegExp(`run:\\s*${escapeRegExp(leaf)}`, 'u'));
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
