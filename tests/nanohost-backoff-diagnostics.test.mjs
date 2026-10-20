// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const installer = readFileSync(
  new URL('../apps/nanohost/deploy/install.sh', import.meta.url),
  'utf8'
);
const start = installer.indexOf('def ignored_restart_step_diagnostic(');
const end = installer.indexOf('\ndef observe(', start);

// Exercise the actual checker's narrow exception, not a separate model of warning parsing.
test('only bundled Service backoff-key warnings are permitted degradation', () => {
  assert.ok(start >= 0 && end > start);
  const cases = [
    [
      "/archive/openkit-nanohost.service:17: Unknown key name 'RestartSteps' in section 'Service', ignoring.",
      true,
    ],
    [
      "openkit-nanohost.service:18: Unknown lvalue 'RestartMaxDelaySec' in section 'Service', ignoring.",
      true,
    ],
    [
      "/archive/openkit-nanohost.service:17: Unknown key name 'KillMode' in section 'Service', ignoring.",
      false,
    ],
    [
      "/archive/openkit-nanohost.service:17: Unknown key name 'RestartSteps' in section 'Unit', ignoring.",
      false,
    ],
    [
      "/archive/openkit-nanohost.service.d/override.conf:17: Unknown key name 'RestartSteps' in section 'Service', ignoring.",
      false,
    ],
    [
      "/other/openkit-nanohost.service:17: Unknown key name 'RestartSteps' in section 'Service', ignoring.",
      false,
    ],
    [
      "/archive/openkit-nanohost.service:17: Unknown key name 'RestartSteps' in section 'Service', ignoring. Permission denied",
      false,
    ],
    ['Failed to open /archive/openkit-nanohost.service', false],
  ];
  const code = `import json, re\nfrom pathlib import Path\n${installer.slice(start, end)}\ncases = json.loads(${JSON.stringify(JSON.stringify(cases))})\nfor line, expected in cases:\n    actual = ignored_restart_step_diagnostic(line, Path('/archive/openkit-nanohost.service'))\n    assert actual == expected, (line, actual, expected)\nprint(len(cases))\n`;
  const result = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', code], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), String(cases.length));
});
