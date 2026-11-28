import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { runBiomeCheck } from '../scripts/check-biome.mjs';

function fakeChild({ status = 0, signal = null, stdout = '', stderr = '' }) {
  const child = new EventEmitter();
  child.stdout = Readable.from(stdout ? [stdout] : []);
  child.stderr = Readable.from(stderr ? [stderr] : []);
  queueMicrotask(() => {
    child.emit('exit', signal ? null : status, signal);
  });
  return child;
}

function collect() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return {
    stream,
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

function countBytes() {
  let total = 0;
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      total += chunk.length;
      callback();
    },
  });
  return {
    stream,
    total() {
      return total;
    },
  };
}

test('repository Biome commands use the checked-file guard', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.match(scripts['check:repo'], /node scripts\/check-biome\.mjs \./u);
  assert.match(
    scripts['format:check'],
    /node scripts\/check-biome\.mjs --formatter-enabled=true --linter-enabled=false \./u
  );
});

test('pinned Biome scans a checkout beneath temp while excluding checkout temp evidence', () => {
  const base = mkdtempSync(join(tmpdir(), 'openkit-biome-scope-'));
  try {
    const checkout = join(base, 'temp', 'checkout');
    mkdirSync(join(checkout, 'temp'), { recursive: true });
    copyFileSync('biome.json', join(checkout, 'biome.json'));
    writeFileSync(join(checkout, 'example.js'), 'export const kept = 1;\n');
    writeFileSync(join(checkout, 'temp', 'evidence.js'), 'this is not valid javascript\n');
    const result = spawnSync(
      'pnpm',
      ['exec', 'biome', 'check', '--config-path', checkout, checkout, '--verbose'],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /example\.js/u);
    assert.doesNotMatch(result.stdout, /evidence\.js/u);
    assert.match(result.stderr, /Checked 2 files in /u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a successful zero-file Biome scan is refused as source verification', async () => {
  const stderr = collect();
  const result = await runBiomeCheck(['.'], {
    spawn: () =>
      fakeChild({
        status: 0,
        stderr: 'Checked 0 files in 1ms. No fixes applied.\n',
      }),
    stdout: collect().stream,
    stderr: stderr.stream,
  });
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.match(stderr.text(), /zero files.*refus/iu);
});

test('Biome arguments and a positive checked-file result pass through unchanged', async () => {
  const calls = [];
  const stdout = collect();
  const stderr = collect();
  const result = await runBiomeCheck(['--formatter-enabled=true', '--linter-enabled=false', '.'], {
    spawn: (...args) => {
      calls.push(args);
      return fakeChild({
        status: 0,
        stdout: 'kept stdout\n',
        stderr: 'Checked 2 files in 1ms. No fixes applied.\n',
      });
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(stdout.text(), 'kept stdout\n');
  assert.equal(stderr.text(), 'Checked 2 files in 1ms. No fixes applied.\n');
  assert.deepEqual(calls, [
    [
      'pnpm',
      ['exec', 'biome', 'check', '--formatter-enabled=true', '--linter-enabled=false', '.'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ],
  ]);
});

test('a missing checked-file count or Biome failure cannot become a pass', async () => {
  const missingErr = collect();
  const missing = await runBiomeCheck(['.'], {
    spawn: () => fakeChild({ status: 0, stdout: '', stderr: '' }),
    stdout: collect().stream,
    stderr: missingErr.stream,
  });
  assert.equal(missing.status, 1);
  assert.match(missingErr.text(), /did not report its checked-file count/u);

  const failedErr = collect();
  const failed = await runBiomeCheck(['.'], {
    spawn: () =>
      fakeChild({
        status: 7,
        stderr: 'Checked 0 files in 1ms. No fixes applied.\n',
      }),
    stdout: collect().stream,
    stderr: failedErr.stream,
  });
  assert.equal(failed.status, 7);
  assert.equal(failed.signal, null);
  assert.doesNotMatch(failedErr.text(), /zero files.*refus/iu);
});

test('a large child result keeps its exit status and both output streams', async () => {
  const bytes = 67174400;
  const stdout = countBytes();
  const stderr = countBytes();
  const result = await runBiomeCheck(['.'], {
    spawn: () =>
      spawn(process.execPath, [
        '-e',
        `process.stdout.write(Buffer.alloc(${bytes}, 97), () => process.exit(7));`,
      ]),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(result.status, 7);
  assert.equal(result.signal, null);
  assert.equal(stdout.total(), bytes);
  assert.equal(stderr.total(), 0);
});

for (const channel of ['stdout', 'stderr']) {
  test(`a long ${channel} line preserves every byte and exit 7 with a 64 MiB heap`, async () => {
    const bytes = 67174400;
    const root = mkdtempSync(join(tmpdir(), 'openkit-biome-long-line-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'pnpm'),
        [
          '#!/usr/bin/env node',
          'const chunk = Buffer.alloc(65536, 97);',
          `let remaining = ${bytes};`,
          'const write = () => {',
          '  if (remaining === 0) return process.exit(7);',
          '  remaining -= chunk.length;',
          `  process.${channel}.write(chunk, write);`,
          '};',
          'write();',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      const child = spawn(
        process.execPath,
        ['--max-old-space-size=64', resolve('scripts/check-biome.mjs'), '.'],
        { env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } }
      );
      let forwarded = 0;
      let unchanged = true;
      let otherOutput = '';
      child[channel].on('data', (chunk) => {
        forwarded += chunk.length;
        unchanged &&= chunk.every((byte) => byte === 97);
      });
      child[channel === 'stdout' ? 'stderr' : 'stdout'].on('data', (chunk) => {
        otherOutput += chunk.toString('utf8');
      });
      const outcome = await new Promise((resolveFinished, reject) => {
        child.once('error', reject);
        child.once('close', (status, signal) => resolveFinished({ status, signal }));
      });
      assert.deepEqual(outcome, { status: 7, signal: null }, otherOutput);
      assert.equal(forwarded, bytes);
      assert.equal(unchanged, true);
      assert.equal(otherOutput, '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a signalled child is reported as that signal', async () => {
  const stderr = collect();
  const result = await runBiomeCheck(['.'], {
    spawn: () => spawn(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']),
    stdout: collect().stream,
    stderr: stderr.stream,
  });
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.doesNotMatch(stderr.text(), /ENOBUFS/u);
});

test('the parent ends by the same signal as the child', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-biome-signal-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'pnpm'),
      '#!/usr/bin/env node\nprocess.kill(process.pid, "SIGTERM");\n',
      { mode: 0o755 }
    );
    const result = spawnSync(process.execPath, [resolve('scripts/check-biome.mjs'), '.'], {
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, null);
    assert.equal(result.signal, 'SIGTERM');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('progress lines are visible before the child is released', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-biome-progress-'));
  const release = join(root, 'release');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'pnpm'),
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'fs.writeSync(1, "progress-1\\n");',
      'fs.writeSync(2, "progress-2\\n");',
      'const release = process.env.OPENKIT_BIOME_RELEASE;',
      'const deadline = Date.now() + 5000;',
      'const wait = () => {',
      '  if (fs.existsSync(release)) process.exit(7);',
      '  if (Date.now() > deadline) process.exit(9);',
      '  setTimeout(wait, 15);',
      '};',
      'wait();',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  const child = spawn(process.execPath, [resolve('scripts/check-biome.mjs'), '.'], {
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      OPENKIT_BIOME_RELEASE: release,
    },
  });
  let out = '';
  let err = '';
  let finished = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  child.on('exit', (status, signal) => {
    finished = { status, signal };
  });
  try {
    const visible = await new Promise((resolveVisible) => {
      const timer = setTimeout(() => resolveVisible(false), 3000);
      const check = () => {
        if (finished) {
          clearTimeout(timer);
          resolveVisible(false);
          return;
        }
        if (out.includes('progress-1') && err.includes('progress-2') && child.exitCode === null) {
          clearTimeout(timer);
          resolveVisible(true);
        }
      };
      child.stdout.on('data', check);
      child.stderr.on('data', check);
      child.on('exit', check);
    });
    assert.equal(visible, true, `stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err)}`);
    assert.equal(child.exitCode, null);
    writeFileSync(release, 'go\n');
    const outcome = await new Promise((resolveFinished) => {
      if (finished) {
        resolveFinished(finished);
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolveFinished({ status: null, signal: 'TIMEOUT' });
      }, 3000);
      child.on('exit', (status, signal) => {
        clearTimeout(timer);
        resolveFinished({ status, signal });
      });
    });
    assert.equal(outcome.signal, null);
    assert.equal(outcome.status, 7);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('a colored Biome summary counts checked files and keeps its original bytes', async () => {
  const base = mkdtempSync(join(tmpdir(), 'openkit-biome-color-'));
  try {
    const file = join(base, 'example.js');
    writeFileSync(file, 'export const kept = 1;\n');
    const stdout = collect();
    const stderr = collect();
    const result = await runBiomeCheck(['--colors=force', file], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    const forwarded = stderr.text();
    assert.equal(result.status, 0, forwarded);
    assert.equal(result.signal, null);
    const esc = String.fromCharCode(0x1b);
    const coloredCount = `${esc}[34mChecked 1 file in `;
    assert.equal(forwarded.includes(coloredCount), true);
    const plain = forwarded.replace(new RegExp(`${esc}\\[[0-9;]*m`, 'gu'), '');
    assert.match(plain, /Checked 1 file in /u);

    const coloredZero = [
      `${esc}[0m${esc}[34mChecked 0 files in 3`,
      `${esc}[0m${esc}[0m${esc}[2m${esc}[34mms${esc}[0m.\n`,
    ].join('');
    const refusedErr = collect();
    const refused = await runBiomeCheck(['.'], {
      spawn: () => fakeChild({ status: 0, stderr: coloredZero }),
      stdout: collect().stream,
      stderr: refusedErr.stream,
    });
    assert.equal(refused.status, 1);
    assert.match(refusedErr.text(), /zero files.*refus/iu);
    assert.equal(refusedErr.text().includes(coloredZero), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unfinished stdout line does not hide a complete stderr summary', async () => {
  const stderr = collect();
  const result = await runBiomeCheck(['.'], {
    spawn: () =>
      fakeChild({
        status: 0,
        stdout: 'progress',
        stderr: 'Checked 1 file in 2ms. No fixes applied.\n',
      }),
    stdout: collect().stream,
    stderr: stderr.stream,
  });
  assert.equal(result.status, 0, stderr.text());
  assert.equal(result.signal, null);
  assert.doesNotMatch(stderr.text(), /refus/iu);
});

test('a summary split across the two channels is not a checked-file count', async () => {
  const stderr = collect();
  const result = await runBiomeCheck(['.'], {
    spawn: () =>
      fakeChild({
        status: 0,
        stdout: 'Checked ',
        stderr: '1 file in 2ms.',
      }),
    stdout: collect().stream,
    stderr: stderr.stream,
  });
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.match(stderr.text(), /did not report its checked-file count/u);
});

for (const channel of ['stdout', 'stderr']) {
  test(`a ${channel} CRLF summary is recognized across chunks`, async () => {
    const stdout = collect();
    const stderr = collect();
    const result = await runBiomeCheck(['.'], {
      spawn: () => {
        const child = fakeChild({ status: 0 });
        child[channel] = Readable.from(['Checked ', '1 file in 2ms.', '\r', '\n']);
        return child;
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal((channel === 'stdout' ? stdout : stderr).text(), 'Checked 1 file in 2ms.\r\n');
    assert.equal((channel === 'stdout' ? stderr : stdout).text(), '');
  });
}

test('a complete summary stays valid after 5000 trailing characters in the same chunk', async () => {
  const stderr = collect();
  const summary = `Checked 1 file in 2ms. No fixes applied.\n${'x'.repeat(5000)}`;
  const result = await runBiomeCheck(['.'], {
    spawn: () => fakeChild({ status: 0, stderr: summary }),
    stdout: collect().stream,
    stderr: stderr.stream,
  });
  assert.equal(result.status, 0, stderr.text());
  assert.equal(result.signal, null);
  assert.equal(stderr.text(), summary);
});
