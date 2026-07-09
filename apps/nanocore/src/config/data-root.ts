import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Environment shape used by data-root resolution.
 */
export interface DataRootEnv {
  /** Optional data-root override. */
  OPENKIT_DATA_ROOT?: string;
}

/**
 * Resolves the NanoCore data root to an absolute path.
 *
 * @param env Environment variables to inspect.
 * @returns Absolute data-root path. Defaults to the system temp directory.
 */
export function resolveDataRoot(env: DataRootEnv): string {
  return env.OPENKIT_DATA_ROOT
    ? resolve(process.cwd(), env.OPENKIT_DATA_ROOT)
    : resolve(tmpdir(), 'openkit-nanocore-data');
}
