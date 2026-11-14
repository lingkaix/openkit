import { mkdirSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Expose the real built CLI only in the existing invocation-private test directory. */
export function prepareNativeCredentialHelper({ root, cli }) {
  const helperBin = join(root, 'bin');
  mkdirSync(helperBin);
  symlinkSync(cli, join(helperBin, 'docker-credential-openkit'));
  process.env.PATH = `${helperBin}${delimiter}${process.env.PATH ?? ''}`;
}
