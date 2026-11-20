import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8'));

/** Script invocations that only a tag push runs; workflow_dispatch gates never execute them. */
function tagPushInvocations() {
  const invocations = new Set();
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const condition = String(job.if ?? '');
    if (
      id !== 'smoke-app-native' &&
      (!condition.includes('refs/tags/') || condition.includes('workflow_dispatch'))
    )
      continue;
    for (const step of job.steps ?? []) {
      for (const match of String(step.run ?? '').matchAll(
        /\bnode[ \t]+((?:\.\.\/)*scripts\/[\w.-]+\.mjs)(?:[ \t]+([a-z][a-z-]*)\b)?/gu
      ))
        invocations.add([basename(match[1]), match[2]].filter(Boolean).join(' '));
    }
  }
  return invocations;
}

test('every tag-push publication CLI evaluates its module graph and refuses missing input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-release-cli-entry-'));
  const missing = join(directory, 'missing');
  const sha = '0'.repeat(40);
  // Moded entries reach their mode handler; the SBOM modes await dynamic imports there.
  const modeProbes = {
    'release-app-native.mjs join': ['join', `${missing}.json`, missing],
    'release-app-native.mjs record': ['record', `${missing}.json`],
    'release-app-native.mjs smoke': ['smoke', `${missing}.json`, 'linux/amd64', missing],
    'release-candidate.mjs fetch': ['fetch', '--directory', missing],
    'release-direct.mjs fetch': ['fetch', 'v0.2.0', missing],
    'release-direct.mjs publish': ['publish', 'v0.2.0', missing, missing],
    'release-sbom.mjs release': [
      'release',
      ...['--records', missing, '--assets', missing, '--repository', 'example/openkit'],
      ...['--tag', 'v0.0.0-rc.1', '--sha', sha],
    ],
    'release-sbom.mjs subjects': [
      'subjects',
      ...['--assets', missing, '--repository', 'example/openkit', '--sha', sha],
      ...['--output', join(directory, 'subjects.txt')],
    ],
  };
  try {
    const invocations = tagPushInvocations();
    assert.ok(invocations.has('release-sbom.mjs release'), 'publication jobs must stay observable');
    assert.deepEqual(
      Object.keys(modeProbes).filter((key) => !invocations.has(key)),
      [],
      'every mode probe must match a tag-push invocation'
    );
    for (const invocation of invocations) {
      const [script, mode] = invocation.split(' ');
      assert.ok(!mode || modeProbes[invocation], `${invocation} needs a mode probe`);
      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), 'scripts', script), ...(modeProbes[invocation] ?? ['--cli-probe'])],
        {
          cwd: directory,
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: directory },
          timeout: 60000,
        }
      );
      assert.doesNotMatch(result.stderr, /unsettled top-level await/u, invocation);
      assert.equal(
        result.status,
        1,
        `${invocation} must refuse cleanly, not exit ${result.status}`
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Node script entries an image build runs from a directory populated only by COPY scripts/... */
function imageScriptInvocations() {
  const invocations = [];
  for (const image of ['app', 'test-env', 'workers']) {
    const stages = new Map();
    let copied = new Map();
    const lines = readFileSync(join(process.cwd(), 'containers', image, 'Dockerfile'), 'utf8')
      .replace(/\\\n/gu, ' ')
      .split('\n');
    for (const line of lines) {
      const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/iu);
      if (from) {
        copied = new Map([...(stages.get(from[1]) ?? new Map())].map(([k, v]) => [k, new Set(v)]));
        if (from[2]) stages.set(from[2], copied);
        continue;
      }
      const copy = line.match(/^COPY\s+((?:--(?!from)\S+\s+)*)(.+)$/iu);
      if (copy) {
        const paths = copy[2].trim().split(/\s+/u);
        const target = paths.pop();
        if (target.endsWith('/') && paths.every((path) => /^scripts\/[\w.-]+$/u.test(path)))
          copied.set(target, new Set([...(copied.get(target) ?? []), ...paths]));
        continue;
      }
      if (!/^RUN\s/iu.test(line)) continue;
      for (const match of line.matchAll(
        /\bnode[ \t]+(\/\S*\/)([\w.-]+\.mjs)(?:[ \t]+([a-z][a-z-]*)\b)?/gu
      ))
        if (copied.has(match[1]))
          invocations.push({
            name: [match[2], match[3]].filter(Boolean).join(' '),
            label: `${image} ${match[1]}${match[2]}`,
            sources: [...copied.get(match[1])],
          });
    }
  }
  return invocations;
}

test('every image-built script entry loads from exactly its copied scripts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-image-cli-entry-'));
  const missing = join(directory, 'missing');
  // Each probe refuses before any download, external tool or output write.
  const probes = {
    'download-native-client-tools.mjs': [],
    'install-security-tools.mjs': ['--cli-probe'],
    'release-sbom.mjs rootfs': [
      ...['rootfs', '--root', missing, '--id', 'app', '--platform', 'linux/amd64'],
      ...['--output', join(missing, 'sbom.cdx.json')],
    ],
  };
  try {
    const invocations = imageScriptInvocations();
    assert.ok(
      invocations.some(({ name }) => name === 'release-sbom.mjs rootfs'),
      'the App inventory stage must stay observable'
    );
    for (const [index, { name, label, sources }] of invocations.entries()) {
      assert.ok(probes[name], `${label} needs a probe`);
      const copy = join(directory, String(index));
      mkdirSync(copy);
      for (const source of sources)
        copyFileSync(join(process.cwd(), source), join(copy, basename(source)));
      const result = spawnSync(
        process.execPath,
        [join(copy, name.split(' ')[0]), ...probes[name]],
        {
          cwd: directory,
          encoding: 'utf8',
          env: { PATH: missing, HOME: directory },
          timeout: 60000,
        }
      );
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|unsettled top-level await/u, label);
      assert.equal(result.status, 1, `${label} must refuse cleanly, not exit ${result.status}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the SBOM CLI prints only its own fixed refusal reason', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-sbom-refusal-'));
  const missing = join(directory, 'private-input-path');
  const refuse = (sha) =>
    spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'release-sbom.mjs'),
        ...['release', '--records', missing, '--assets', missing],
        ...['--repository', 'example/openkit', '--tag', 'v0.0.0-rc.1', '--sha', sha],
      ],
      { cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: directory } }
    );
  try {
    const own = refuse('not-a-commit');
    assert.equal(own.status, 1);
    assert.match(own.stderr, /^Reason: Release source identity refused$/mu);
    // A filesystem error is not a fixed refusal and may name private input.
    const foreign = refuse('0'.repeat(40));
    assert.equal(foreign.status, 1);
    assert.doesNotMatch(foreign.stderr, /Reason:|private-input-path/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
