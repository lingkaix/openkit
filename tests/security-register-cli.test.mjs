/** Synthetic register transport must reach the unchanged gate through both release CLIs. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const digest = `sha256:${'a'.repeat(64)}`;
const finding = {
  id: 'OSV-2027-SYNTHETIC',
  artifact: digest,
  component: { purl: 'pkg:deb/debian/synthetic@1.0', location: 'linux/amd64:var/lib/dpkg/status' },
  advisoryIds: ['CVE-2027-10000'],
  class: 'C',
  knownExploited: false,
  fixAvailable: false,
};
const now = Date.now();
const iso = (offset) => new Date(now + offset).toISOString();
const { fixAvailable: _, ...binding } = finding;
const register = {
  schemaVersion: 1,
  records: [
    {
      ...binding,
      status: 'accepted',
      openedAt: iso(-60000),
      dueAt: iso(86400000),
      reachability: { judgment: 'unknown', evidence: [] },
      decider: { id: 'synthetic-engineer', role: 'engineer' },
      decision: { at: iso(-60000), reviewAt: iso(86400000), reason: 'synthetic-private-reason' },
      links: ['synthetic:private-link'],
    },
  ],
};
const encoded = (value) => `gzip+base64:${gzipSync(JSON.stringify(value)).toString('base64')}`;

/** Replace external observations only; both CLIs retain their actual reader and finding gate. */
function invoke(entry, payload, output) {
  const args =
    entry === 'check-security.mjs'
      ? [
          '--release',
          '--images-only',
          '--image',
          `linux/amd64=ghcr.io/notrucked/synthetic@${digest}`,
        ]
      : [
          '--image',
          'ghcr.io/notrucked/synthetic',
          '--digest',
          digest,
          '--platforms',
          'linux/amd64',
          '--output',
          output,
        ];
  const bootstrap = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { pathToFileURL } from 'node:url';
    const scanUrl = pathToFileURL(${JSON.stringify(join(root, 'scripts/security-scan.mjs'))}).href;
    const scan = await import(scanUrl);
    mock.module(scanUrl, { namedExports: { ...scan, scanImage: ({image,platform}) => {
      assert.equal(image, ${JSON.stringify(`ghcr.io/notrucked/synthetic@${digest}`)});
      assert.equal(platform, 'linux/amd64');
      return [${JSON.stringify(finding)}];
    } } });
    globalThis.fetch = async () => ({ok:true,arrayBuffer:async()=>Buffer.from(JSON.stringify({catalogVersion:'synthetic',vulnerabilities:[]}))});
    const child = await import('node:child_process');
    const execFileSync = (program,args,options) => program === 'docker'
      ? JSON.stringify({schemaVersion:2,manifests:[{digest:${JSON.stringify(digest)},platform:{os:'linux',architecture:'amd64'}}]})
      : child.execFileSync(program,args,options);
    mock.module('node:child_process', { defaultExport:{...child.default,execFileSync},namedExports:{...child,execFileSync} });
    const entry=${JSON.stringify(join(root, 'scripts', entry))};
    process.argv=[process.execPath,entry,...${JSON.stringify(args)}];
    await import(pathToFileURL(entry).href);
  `;
  const bootstrapFile = join(dirname(output), 'bootstrap.mjs');
  writeFileSync(bootstrapFile, bootstrap);
  return spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--no-warnings', bootstrapFile],
    {
      cwd: root,
      env: { ...process.env, OPENKIT_SECURITY_FINDINGS: payload },
      encoding: 'utf8',
      timeout: 15000,
    }
  );
}

for (const entry of ['check-security.mjs', 'release-security.mjs']) {
  for (const [format, payload] of [
    ['raw JSON', JSON.stringify(register)],
    ['gzip+base64', encoded(register)],
  ]) {
    test(`${entry} admits ${format} through the current exact-finding gate`, (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'security-register-cli-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const output = join(directory, 'admitted.digest');
      const result = invoke(entry, payload, output);
      assert.equal(result.status, 0, result.stderr);
      if (entry === 'release-security.mjs')
        assert.equal(readFileSync(output, 'utf8').trim(), digest);
    });
  }
  for (const [name, payload] of [
    ['missing exact finding', encoded({ schemaVersion: 1, records: [] })],
    ['bad base64', 'gzip+base64:synthetic-private-reason!'],
  ]) {
    test(`${entry} refuses ${name} without private text or an admission artifact`, (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'security-register-cli-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const output = join(directory, 'admitted.digest');
      const result = invoke(entry, payload, output);
      assert.equal(result.status, 1);
      const message =
        entry === 'check-security.mjs'
          ? 'Security check refused; no private assessment was printed'
          : 'Release security gate refused; no private assessment was printed';
      assert.equal(result.stderr.trim(), message);
      assert.equal(existsSync(output), false);
      assert.equal((result.stdout + result.stderr).includes('synthetic-private-reason'), false);
    });
  }
}
