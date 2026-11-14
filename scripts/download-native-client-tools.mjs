#!/usr/bin/env node
/** Download only the checksum-bound clients consumed by deterministic credential tests. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyToolDownload } from './install-security-tools.mjs';

/**
 * Stage verified archives/binaries; extraction and installation are separate image-build steps.
 *
 * @param {{ directory: string, architecture?: string }} options Destination and Node architecture.
 * @returns {Promise<void>} Resolves only after every committed supplier passes integrity verification.
 */
export async function downloadNativeClientTools({ directory, architecture = process.arch }) {
  if (process.platform !== 'linux' || architecture !== 'x64')
    throw Error('Unsupported native client platform or architecture');
  if (!directory) throw Error('A native client staging directory is required');
  const pins = JSON.parse(
    readFileSync(new URL('./native-client-tools.json', import.meta.url), 'utf8')
  );
  mkdirSync(directory, { recursive: true });
  for (const [name, pin] of Object.entries(pins.tools)) {
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`Native client download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyToolDownload(bytes, pin.sha256);
    writeFileSync(join(directory, pin.filename), bytes, { flag: 'wx' });
    console.log(`Verified ${name} ${pin.version} SHA-256`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  downloadNativeClientTools({ directory: process.argv[2] }).catch(() => {
    console.error('Native client download failed; no installation was attempted');
    process.exitCode = 1;
  });
