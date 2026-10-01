import { access, cp, lstat, mkdir, readdir, realpath, rename } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Retained Pi configuration directory, separate from disposable control material. */
export function piAgentDirectory(stateRoot: string): string {
  return join(resolve(stateRoot), 'agent');
}

/** Tests lexical or canonical containment without confusing path-prefix siblings. */
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  );
}

/** Observes dangling links too; only absence is a fresh-home observation. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}

/** Validates every source entry before copying; links are dereferenced only within the source. */
async function validateNativeSource(source: string, path = source): Promise<void> {
  const target = await realpath(path);
  if (!within(source, target)) throw new Error('Pi image source escapes its root.');
  const entry = await lstat(target);
  await access(target, entry.isDirectory() ? 5 : 4);
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) await validateNativeSource(source, join(path, name));
  } else if (!entry.isFile()) {
    throw new Error('Pi image source contains an unreadable native entry.');
  }
}

/** Seeds only a genuinely absent child home; the Thread lease already supplies the sole writer. */
export async function initializePiNativeHome(stateRoot: string): Promise<void> {
  const home = piAgentDirectory(stateRoot);
  const root = await realpath(stateRoot);
  if (await pathExists(home)) {
    if (!(await lstat(home)).isDirectory() || !within(root, await realpath(home))) {
      throw new Error('Pi native home escapes its retained root.');
    }
    return;
  }
  const staging = `${home}.initializing`;
  if (await pathExists(staging)) throw new Error('Pi native home initialization is incomplete.');
  // Input.environment.HOME is launch supply, not the shim image user's default source.
  const source = process.env.HOME ? resolve(process.env.HOME, '.pi', 'agent') : null;
  if (!source || within(resolve(stateRoot), source) || !(await pathExists(source))) {
    await mkdir(home, { mode: 0o700 });
    return;
  }
  const canonicalSource = await realpath(source);
  if (within(root, canonicalSource)) {
    await mkdir(home, { mode: 0o700 });
    return;
  }
  if (!(await lstat(canonicalSource)).isDirectory())
    throw new Error('Pi image default source is not a native directory.');
  await validateNativeSource(canonicalSource);
  await cp(canonicalSource, staging, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  });
  if (await pathExists(home)) throw new Error('Pi native home was created during initialization.');
  await rename(staging, home);
}
