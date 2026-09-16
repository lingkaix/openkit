import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = readFileSync(new URL('../scripts/dogfood/deploy.sh', import.meta.url), 'utf8');
const release = JSON.parse(
  readFileSync(new URL('../apps/nanohost/openshell/release.json', import.meta.url))
);
const workerDigest = `sha256:${'a'.repeat(64)}`;

/** Execute the actual Bash function with external effects replaced by bounded command doubles. */
function runFunction(name, setup, env) {
  const definition = script.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(definition, `Missing deployment function ${name}`);
  return spawnSync('bash', ['-c', `set -Eeuo pipefail\numask 077\n${definition}\n${setup}`], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

/** Create disposable inputs; no test invokes Docker, sudo, systemd, or the live deployment. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dogfood-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/nanohost/openshell'), { recursive: true });
  writeFileSync(join(root, 'apps/nanohost/openshell/release.json'), JSON.stringify(release));
  return root;
}

const buildSetup = `
BASE_DIR="$FIXTURE"
REPO_DIR="$FIXTURE"
ARTIFACT_DIR="$FIXTURE"
NANOHOST_ENV_SOURCE="$FIXTURE/nanohost.env"
SEED_IMAGE_HELPER="$FIXTURE/seed.py"
MISE_BIN=true
commit=fixture
uname() { printf '%s\\n' "$ARCH"; }
tar() { printf '{"schemaVersion":2,"manifests":[{"digest":"%s"}]}\\n' "$WORKER_DIGEST"; }
sudo() {
  [[ "$1" == -n ]]; shift
  printf '%s\\n' "$*" >> "$FIXTURE/effects"
  case "$1 $2" in
    'rm -f') command rm -f "$FIXTURE/worker-codex-fixture.oci.tar.partial" ;;
    'docker buildx') touch "$FIXTURE/worker-codex-fixture.oci.tar.partial" ;;
    'docker load'|'chown '* ) ;;
    'test -f') [[ "$3" == "/var/lib/openkit/nanohost-images/content/\${EXPECTED_SUPERVISOR#sha256:}" ]] ;;
    'python3 '*) printf 'seeded_digest=%s\\n' "$WORKER_DIGEST" ;;
    'install -D') ;;
    'install -m') command cp "$NANOHOST_ENV_SOURCE" "$FIXTURE/installed.env" ;;
    *) [[ "$1" == "$REPO_DIR/scripts/docker/smoke-image.sh" && "$2" == worker-codex ]] ;;
  esac
}
build_nanohost
`;

for (const [arch, platform] of [
  ['aarch64', 'linux/arm64'],
  ['x86_64', 'linux/amd64'],
]) {
  test(`NanoHost deploy selects ${platform} release metadata and removes obsolete env input`, (t) => {
    const root = fixture(t);
    const retained = '# deployment settings\nOPENKIT_NANOHOST_ID=dogfood\n';
    writeFileSync(
      join(root, 'nanohost.env'),
      `${retained}OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS=stale\n`
    );
    const result = runFunction('build_nanohost', buildSetup, {
      FIXTURE: root,
      ARCH: arch,
      WORKER_DIGEST: workerDigest,
      EXPECTED_SUPERVISOR: release.supervisor.platformDigests[platform],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'installed.env'), 'utf8'), retained);
    assert.ok(
      readFileSync(join(root, 'effects'), 'utf8').includes(
        `/content/${release.supervisor.platformDigests[platform].slice(7)}`
      )
    );
  });
}

for (const input of ['', 'OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS=stale\n']) {
  test(`NanoHost env cleanup succeeds with ${input ? 'only the obsolete setting' : 'an empty file'}`, (t) => {
    const root = fixture(t);
    writeFileSync(join(root, 'nanohost.env'), input);
    const result = runFunction('build_nanohost', buildSetup, {
      FIXTURE: root,
      ARCH: 'aarch64',
      WORKER_DIGEST: workerDigest,
      EXPECTED_SUPERVISOR: release.supervisor.platformDigests['linux/arm64'],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'installed.env'), 'utf8'), '');
  });
}

for (const invalid of ['missing', 'invalid']) {
  test(`NanoHost deploy rejects ${invalid} supervisor digest before install`, (t) => {
    const root = fixture(t);
    const metadata = structuredClone(release);
    if (invalid === 'missing') delete metadata.supervisor.platformDigests['linux/arm64'];
    else metadata.supervisor.platformDigests['linux/arm64'] = 'bad-digest';
    writeFileSync(join(root, 'apps/nanohost/openshell/release.json'), JSON.stringify(metadata));
    const result = runFunction('build_nanohost', buildSetup, {
      FIXTURE: root,
      ARCH: 'aarch64',
      WORKER_DIGEST: workerDigest,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /KeyError|digest resolution failed/);
    assert.ok(!readFileSync(join(root, 'effects'), 'utf8').includes('install '));
  });
}

test('App cutover passes every mount, environment option and image in one docker run', (t) => {
  const root = fixture(t);
  const result = runFunction(
    'replace_app',
    `
CONTAINER_NAME=openkit-staging
PREVIOUS_CONTAINER_NAME=openkit-staging-previous
BASE_DIR="$FIXTURE/base with spaces"
DATA_ROOT="$FIXTURE/data"
NANOHOST_CREDENTIALS_DIR="$FIXTURE/credentials"
WEB_ROOT="$FIXTURE/web"
APP_CADDYFILE="$FIXTURE/Caddyfile"
VAULT_KEY_FILE="$FIXTURE/vault.key"
ENV_FILE="$FIXTURE/app.env"
HOST_PORT=7080
sudo() {
  [[ "$1" == -n && "$2" == docker ]]; shift 2
  case "$1" in
    container) return 1 ;;
    run) printf '%s\\0' "$@" > "$FIXTURE/argv" ;;
    *) return 99 ;;
  esac
}
wait_for_app() { return 0; }
replace_app openkit/app:fixture fixture
`,
    { FIXTURE: root }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, 'data.backups')));
  const args = readFileSync(join(root, 'argv'), 'utf8').split('\0').slice(0, -1);
  assert.equal(args.at(-1), 'openkit/app:fixture');
  for (const [option, value] of [
    ['--volume', `${root}/data:/data/openkit`],
    ['--volume', `${root}/data.backups:/data/openkit.backups`],
    ['--volume', `${root}/credentials:/run/nanohost-credentials`],
    ['--mount', `type=bind,src=${root}/web,dst=/srv/web,readonly`],
    ['--mount', `type=bind,src=${root}/Caddyfile,dst=/etc/caddy/Caddyfile,readonly`],
    ['--mount', `type=bind,src=${root}/vault.key,dst=/run/secrets/openkit-vault.key,readonly`],
    ['--mount', `type=bind,src=${root}/base with spaces/workspaces-repos,dst=/srv/repos`],
    ['--env-file', `${root}/app.env`],
    ['--env', 'OPENKIT_DATA_ROOT=/data/openkit'],
  ]) {
    const index = args.indexOf(value);
    assert.ok(index > 0, `Missing argument ${value}`);
    assert.equal(args[index - 1], option);
  }
});

test('build_app uses repository containers/app/Dockerfile for NanoCore', (t) => {
  const root = fixture(t);
  const dockerfile = join(root, 'containers/app/Dockerfile');
  mkdirSync(join(root, 'containers/app'), { recursive: true });
  writeFileSync(dockerfile, 'FROM scratch\n');
  const setup = `
BASE_DIR="$FIXTURE"
REPO_DIR="$FIXTURE"
commit=fixture
sudo() {
  [[ "$1" == -n ]]; shift
  printf '%s\\n' "$*" >> "$FIXTURE/effects"
}
build_app
`;
  const result = runFunction('build_app', setup, { FIXTURE: root });
  assert.equal(result.status, 0, result.stderr);
  const effects = readFileSync(join(root, 'effects'), 'utf8');
  assert.match(effects, /docker build --file .*\/containers\/app\/Dockerfile/);
  assert.doesNotMatch(effects, /nanocore\.Dockerfile/);
});

test('sync_linked_repos fast-forwards a clean public OpenKit checkout and records the pin', (t) => {
  const root = fixture(t);
  const base = join(root, 'base');
  const linked = join(base, 'workspaces-repos', 'openkit');
  const remote = join(root, 'remote.git');
  mkdirSync(join(base, 'workspaces-repos'), { recursive: true });
  const init = spawnSync(
    'bash',
    [
      '-c',
      `
set -Eeuo pipefail
git init --bare "$REMOTE"
git clone "$REMOTE" "$LINKED"
git -C "$LINKED" checkout -b main
printf 'one\\n' > "$LINKED/README.md"
git -C "$LINKED" add README.md
git -C "$LINKED" -c user.name=test -c user.email=test@example.com commit -m one
git -C "$LINKED" push -u origin main
printf 'two\\n' > "$LINKED/README.md"
git -C "$LINKED" add README.md
git -C "$LINKED" -c user.name=test -c user.email=test@example.com commit -m two
git -C "$LINKED" push
git -C "$LINKED" reset --hard HEAD~1
`,
    ],
    {
      env: { ...process.env, REMOTE: remote, LINKED: linked },
      encoding: 'utf8',
    }
  );
  assert.equal(init.status, 0, init.stderr);
  const tip = spawnSync('git', ['-C', remote, 'rev-parse', 'main'], { encoding: 'utf8' });
  assert.equal(tip.status, 0, tip.stderr);
  const expected = tip.stdout.trim();
  const result = runFunction(
    'sync_linked_repos',
    `
BASE_DIR="$BASE"
LINKED_REPOS_DIR="$BASE/workspaces-repos"
LINKED_REPOS_PIN="$BASE/current-linked-repos"
REPO_URL="$REMOTE"
sync_linked_repos
`,
    { BASE: base, REMOTE: remote }
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const head = spawnSync('git', ['-C', linked, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  assert.equal(head.stdout.trim(), expected);
  assert.equal(
    readFileSync(join(base, 'current-linked-repos'), 'utf8').trim(),
    `openkit=${expected}`
  );
});

test('sync_linked_repos refuses a dirty linked checkout', (t) => {
  const root = fixture(t);
  const base = join(root, 'base');
  const linked = join(base, 'workspaces-repos', 'openkit');
  const remote = join(root, 'remote.git');
  mkdirSync(join(base, 'workspaces-repos'), { recursive: true });
  const init = spawnSync(
    'bash',
    [
      '-c',
      `
set -Eeuo pipefail
git init --bare "$REMOTE"
git clone "$REMOTE" "$LINKED"
git -C "$LINKED" checkout -b main
printf 'one\\n' > "$LINKED/README.md"
git -C "$LINKED" add README.md
git -C "$LINKED" -c user.name=test -c user.email=test@example.com commit -m one
git -C "$LINKED" push -u origin main
printf 'dirty\\n' > "$LINKED/README.md"
`,
    ],
    {
      env: { ...process.env, REMOTE: remote, LINKED: linked },
      encoding: 'utf8',
    }
  );
  assert.equal(init.status, 0, init.stderr);
  const result = runFunction(
    'sync_linked_repos',
    `
BASE_DIR="$BASE"
LINKED_REPOS_DIR="$BASE/workspaces-repos"
LINKED_REPOS_PIN="$BASE/current-linked-repos"
REPO_URL="$REMOTE"
sync_linked_repos
`,
    { BASE: base, REMOTE: remote }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local changes/);
});

for (const [repositorySource, replace] of [
  ['correct', false],
  ['missing', true],
  ['wrong', true],
]) {
  test(`Web update repairs ${repositorySource} repository mount without changing the image`, (t) => {
    const root = fixture(t);
    const result = runFunction(
      'ensure_app_mounts',
      `
BASE_DIR="$FIXTURE"
WEB_ROOT="$FIXTURE/web"
LINKED_REPOS_DIR="$FIXTURE/workspaces-repos"
DATA_ROOT="$FIXTURE/data"
CONTAINER_NAME=app
sudo() {
  case "$*" in
    *'/srv/web'*) printf '%s' "$WEB_ROOT" ;;
    *'/srv/repos'*)
      case "$REPOSITORY_SOURCE" in
        correct) printf '%s' "$LINKED_REPOS_DIR" ;;
        wrong) printf '/wrong' ;;
      esac ;;
    *'/data/openkit.backups'*) printf '%s' "$DATA_ROOT.backups" ;;
    *'Config.Image'*) printf 'openkit/app:retained' ;;
    *'Config.Labels'*) printf 'retained-commit' ;;
    *) return 99 ;;
  esac
}
replace_app() { printf '%s\\n' "$*" > "$FIXTURE/replaced"; }
ensure_app_mounts
`,
      { FIXTURE: root, REPOSITORY_SOURCE: repositorySource }
    );
    assert.equal(result.status, 0, result.stderr);
    if (replace) {
      assert.equal(
        readFileSync(join(root, 'replaced'), 'utf8'),
        'openkit/app:retained retained-commit\n'
      );
    } else {
      assert.throws(() => readFileSync(join(root, 'replaced')), { code: 'ENOENT' });
    }
  });
}

test('Web update restores a missing persistent data-root backup mount', (t) => {
  const root = fixture(t);
  const result = runFunction(
    'ensure_app_mounts',
    `
BASE_DIR="$FIXTURE"
WEB_ROOT="$FIXTURE/web"
LINKED_REPOS_DIR="$FIXTURE/workspaces-repos"
DATA_ROOT="$FIXTURE/data"
CONTAINER_NAME=app
sudo() {
  case "$*" in
    *'/srv/web'*) printf '%s' "$WEB_ROOT" ;;
    *'/srv/repos'*) printf '%s' "$LINKED_REPOS_DIR" ;;
    *'/data/openkit.backups'*) ;;
    *'Config.Image'*) printf 'openkit/app:retained' ;;
    *'Config.Labels'*) printf 'retained-commit' ;;
    *) return 99 ;;
  esac
}
replace_app() { printf '%s\\n' "$*" > "$FIXTURE/replaced"; }
ensure_app_mounts
`,
    { FIXTURE: root }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(root, 'replaced'), 'utf8'),
    'openkit/app:retained retained-commit\n'
  );
});
