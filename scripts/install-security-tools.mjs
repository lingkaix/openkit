#!/usr/bin/env node
/** Install only the committed, checksum-bound development security tools. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Refuse modified tool bytes before extraction or execution. */
export function verifyToolDownload(bytes, sha256) {
  if (
    !/^[a-f0-9]{64}$/u.test(sha256 ?? '') ||
    createHash('sha256').update(bytes).digest('hex') !== sha256
  )
    throw Error('Security tool checksum mismatch');
}

/** Install a named tool from its fixed release; platform selection never changes its version. */
export async function installSecurityTool({ tool, directory, architecture = process.arch }) {
  const pins = JSON.parse(readFileSync(new URL('./security-tools.json', import.meta.url), 'utf8'));
  const pin = pins[tool];
  const platform = { x64: 'amd64', arm64: 'arm64' }[architecture];
  const asset = pin?.platforms?.[platform];
  if (process.platform !== 'linux' || !asset) throw Error('Unsupported security tool or platform');
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error(`Security tool download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyToolDownload(bytes, asset.sha256);
  const temporary = mkdtempSync(join(tmpdir(), 'openkit-security-tools-'));
  try {
    const archive = join(temporary, 'download');
    const binary = join(temporary, tool);
    writeFileSync(archive, bytes, { flag: 'wx' });
    if (asset.member) {
      const executable = execFileSync('tar', ['-xOf', archive, asset.member], {
        maxBuffer: 256 * 1024 * 1024,
        timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      writeFileSync(binary, executable, { flag: 'wx', mode: 0o755 });
    } else {
      copyFileSync(archive, binary);
      chmodSync(binary, 0o755);
    }
    mkdirSync(resolve(directory), { recursive: true });
    copyFileSync(binary, join(resolve(directory), tool));
    chmodSync(join(resolve(directory), tool), 0o755);
    console.log(`Installed ${tool} ${pin.version} with verified SHA-256`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Install only when the operator supplies both the tool and destination. */
async function main() {
  const { values } = parseArgs({
    options: { tool: { type: 'string' }, directory: { type: 'string' } },
  });
  if (!values.tool || !values.directory)
    throw Error('Use --tool <name> --directory <tool-directory>');
  await installSecurityTool({ tool: values.tool, directory: values.directory });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Security tool installation failed; no unverified tool was installed');
    process.exitCode = 1;
  });
