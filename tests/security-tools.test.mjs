import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkWorkflows } from '../scripts/check-workflows.mjs';
import { installSecurityTool, verifyToolDownload } from '../scripts/install-security-tools.mjs';

/**
 * Supplemental oracle for Development Security "Supply-Chain Controls".
 *
 * The committed security tools are checksum-bound before installation, and the
 * pinned linter itself decides whether a workflow configuration is admitted. Every
 * workflow below is synthetic and temporary; the real checkout is never linted here.
 */

const registry = JSON.parse(
  readFileSync(new URL('../scripts/security-tools.json', import.meta.url), 'utf8')
);
const platform = { x64: 'amd64', arm64: 'arm64' }[process.arch];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A minimal workflow whose only variable part is its step list. */
const workflow = (steps) => `name: Fixture
on:
  push:
    branches: [main]
permissions: {}
jobs:
  fixture:
    runs-on: ubuntu-24.04
    steps:
${steps}`;

/** Lints one synthetic workflow in a throwaway repository and returns the outcome. */
function lint(source) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-workflow-lint-'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/fixture.yml'), source);
  const report = [];
  const [log, error] = [console.log, console.error];
  console.log = () => {};
  console.error = (...parts) => report.push(parts.join(' '));
  try {
    checkWorkflows({ repoRoot: root, all: true });
    return { refused: false, message: '', report: report.join('\n') };
  } catch (failure) {
    return { refused: true, message: failure.message, report: report.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('the tool registry binds a full checksum and the verifier admits only matching bytes', () => {
  assert.match(registry.zizmor.version, /^\d+\.\d+\.\d+$/u);
  const pin = registry.zizmor.platforms[platform];
  assert.ok(pin, `the registry pins the ${platform} platform`);
  assert.match(pin.sha256, /^[a-f0-9]{64}$/u, 'a checksum is never abbreviated');
  assert.match(pin.url, /^https:\/\//u);

  const payload = Buffer.from('development security tool fixture\n');
  const altered = Buffer.from('altered development security tool fixture\n');
  assert.doesNotThrow(() => verifyToolDownload(payload, digest(payload)));
  assert.throws(() => verifyToolDownload(altered, digest(payload)), /checksum mismatch/u);
  assert.throws(() => verifyToolDownload(payload, digest(altered)), /checksum mismatch/u);
  assert.throws(() => verifyToolDownload(payload, 'unknown-checksum'), /checksum mismatch/u);
});

test('an altered download is refused before any tool binary is installed', async () => {
  const destination = join(mkdtempSync(join(tmpdir(), 'openkit-security-tools-')), 'tools');
  const requested = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const bytes = new TextEncoder().encode('altered development security tool fixture');
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
  };
  try {
    await assert.rejects(
      installSecurityTool({ tool: 'zizmor', directory: destination }),
      /checksum mismatch/u
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(requested, [registry.zizmor.platforms[platform].url]);
  assert.equal(existsSync(join(destination, 'zizmor')), false, 'no unverified binary lands');
  assert.equal(existsSync(destination), false, 'the destination is never created');
});

test('the pinned linter admits a workflow with no findings', () => {
  const result = lint(workflow('      - name: Print\n        run: echo fixture\n'));
  assert.equal(result.refused, false, result.message);
  assert.equal(result.report, '', 'a clean workflow reports nothing');
});

test('the pinned linter refuses an action pinned to a tag', () => {
  const result = lint(
    workflow(
      '      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n'
    )
  );
  assert.equal(result.refused, true);
  assert.match(result.message, /Workflow lint refused/u);
  assert.match(result.report, /unpinned-uses/u);
});

test('the pinned linter refuses template injection into a shell command', () => {
  const result = lint(workflow(`      - run: echo "\${{ github.event.pull_request.title }}"\n`));
  assert.equal(result.refused, true);
  assert.match(result.message, /Workflow lint refused/u);
  assert.match(result.report, /template-injection/u);
});
