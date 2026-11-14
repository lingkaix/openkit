#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { basename } from 'node:path';
import { WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES } from '@openkit/worker-protocol';
import { runNativeCredentialHelper } from './credential-helper-client.js';
import {
  type CredentialHelperProtocol,
  runCredentialHelper,
} from './credential-helper-protocols.js';

const aliases: Readonly<Record<string, CredentialHelperProtocol>> = {
  'git-credential-openkit': 'git',
  'docker-credential-openkit': 'docker',
  'openkit-aws-credential-process': 'aws',
  'openkit-kubernetes-exec': 'kubernetes',
  'openkit-google-executable': 'google',
};

function protocol(value: string | undefined): CredentialHelperProtocol {
  if (
    value === 'git' ||
    value === 'docker' ||
    value === 'aws' ||
    value === 'kubernetes' ||
    value === 'google'
  )
    return value;
  throw new Error('Credential unavailable.');
}

async function readStdin(): Promise<string> {
  const bytes = Buffer.allocUnsafe(WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES);
  let length = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (value.byteLength > bytes.byteLength - length) {
      process.stdin.destroy();
      throw new Error('Credential unavailable.');
    }
    bytes.set(value, length);
    length += value.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
}

let selected: CredentialHelperProtocol | undefined;
try {
  const args = process.argv.slice(2);
  selected = protocol(aliases[basename(process.argv[1] ?? '')] ?? args.shift());
  if (args.length > 1) throw new Error('Credential unavailable.');
  const operation = args[0];
  // Docker store is rejected before collecting its credential-bearing input.
  const stdin =
    selected === 'git' || (selected === 'docker' && operation !== 'store') ? await readStdin() : '';
  const reply = await runNativeCredentialHelper({
    protocol: selected,
    ...(operation !== undefined ? { operation } : {}),
    stdin,
    environment: process.env,
  });
  process.stdout.write(reply.stdout);
  process.stderr.write(reply.stderr);
  process.exitCode = reply.exitCode;
} catch {
  if (selected === 'google') {
    const reply = await runCredentialHelper({ protocol: 'google' }, () => {
      throw new Error('Credential unavailable.');
    });
    process.stdout.write(reply.stdout);
  } else {
    process.stderr.write('Credential unavailable\n');
  }
  process.exitCode = 1;
}
