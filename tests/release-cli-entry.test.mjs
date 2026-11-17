import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8'));

/** Script invocations that only a tag push runs; workflow_dispatch gates never execute them. */
function tagPushInvocations() {
  const invocations = new Set();
  for (const job of Object.values(workflow.jobs)) {
    const condition = String(job.if ?? '');
    if (!condition.includes('refs/tags/') || condition.includes('workflow_dispatch')) continue;
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
