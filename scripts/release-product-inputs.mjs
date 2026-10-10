import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Classifies the complete release live-round exclusion policy, retaining symlinks and gitlinks as product inputs on either side. */
export function isProductInput(path, oldMode = '000000', newMode = '000000') {
  if ([oldMode, newMode].some((mode) => mode === '120000' || mode === '160000')) return true;
  return !(
    /^(?:docs|tests|\.github)\//u.test(path) ||
    (!path.includes('/') && path.endsWith('.md'))
  );
}

/** Reads original Git objects as bytes; unreadable output never proves eligibility. */
function git(args) {
  const result = spawnSync('git', args, {
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Git command failed');
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
}

/** Compares full commit identities and emits every raw change with its release classification. */
function main(args) {
  if (
    args.length !== 4 ||
    args[0] !== '--tested' ||
    args[2] !== '--publishing' ||
    ![args[1], args[3]].every((sha) => /^[a-f0-9]{40}$/u.test(sha))
  ) {
    console.error(
      'Usage: node scripts/release-product-inputs.mjs --tested <full sha> --publishing <full sha>'
    );
    return 2;
  }
  const [, tested, , publishing] = args;
  try {
    for (const sha of [tested, publishing]) {
      if (git(['rev-parse', '--verify', `${sha}^{commit}`]).trim() !== sha)
        throw new Error('Git commit identity mismatch');
    }
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', tested, publishing], {
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
    if (ancestry.error || ![0, 1].includes(ancestry.status))
      throw new Error('Git ancestry check failed');
    if (ancestry.status === 1) {
      console.error('Tested commit is not an ancestor of publishing commit');
      return 1;
    }
    const raw = git([
      'diff',
      '--raw',
      '--no-renames',
      '--no-ext-diff',
      '--no-abbrev',
      '--no-relative',
      '--ignore-submodules=none',
      '-z',
      tested,
      publishing,
    ]);
    const fields = raw.split('\0');
    if (fields.pop() !== '' || fields.length % 2 !== 0) throw new Error('Unreadable Git diff');
    const changes = [];
    for (let index = 0; index < fields.length; index += 2) {
      const header = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} ([ADMT])$/u.exec(fields[index]);
      const path = fields[index + 1];
      if (!header || !path) throw new Error('Unreadable Git diff');
      const [, oldMode, newMode, status] = header;
      changes.push({
        path,
        oldMode,
        newMode,
        status,
        product: isProductInput(path, oldMode, newMode),
      });
    }
    for (const change of changes) {
      console.log(
        `${change.product ? 'product' : 'non-product'} ${change.status} ${JSON.stringify(change.path)} (${change.oldMode} -> ${change.newMode})`
      );
    }
    const eligible = changes.every((change) => !change.product);
    console.log(
      eligible ? 'Eligible: all changes are non-product' : 'Ineligible: product inputs changed'
    );
    return eligible ? 0 : 1;
  } catch {
    console.error('Git comparison failed or output could not be read; eligibility is unproved');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
