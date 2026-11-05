import { readFileSync } from 'node:fs';
import { PresentReleaseIdentitySchema, type ReleaseBuildIdentity } from '@openkit/app-api-schemas';
import { BootConfigError } from '../config/mode.js';

/**
 * Image path of the App release identity file.
 *
 * The identity is a file, not an image ENV. The App-update helper replays every
 * old container Config.Env entry as --env, so an ENV identity from the previous
 * image would override the new image after every update.
 * https://github.com/lingkaix/openkit/issues/239 records that replay.
 */
export const RELEASE_IDENTITY_PATH = '/usr/local/lib/openkit/release-identity.json';

/**
 * Reads the release identity file admitted at boot.
 *
 * A missing image file may use the source build's adjacent generated identity file. Missing
 * identities still report both fields null; an invalid image file never falls back. A present
 * file requires an exact 40-lowercase-hex commit. Its tag is null for an untagged
 * source build or a v-prefixed SemVer tag. Invalid JSON or core values fail boot configuration.
 * Unknown additive keys are ignored and are not returned.
 *
 * @param path Identity file path. Production uses the image path.
 * @param sourceBuildPath Optional source-build fallback used only when the first file is absent.
 * @returns Closed release identity, or both nulls when the file is absent.
 * @throws BootConfigError with code invalid_release_identity when a present file is malformed.
 */
export function readReleaseIdentity(
  path: string | URL = RELEASE_IDENTITY_PATH,
  sourceBuildPath?: string | URL
): ReleaseBuildIdentity {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      const fallback =
        sourceBuildPath ??
        (path === RELEASE_IDENTITY_PATH
          ? new URL('../source-build-identity.json', import.meta.url)
          : undefined);
      return fallback ? readReleaseIdentity(fallback) : { releaseTag: null, sourceCommit: null };
    }
    throw new BootConfigError(
      'invalid_release_identity',
      'Release identity file could not be read.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BootConfigError(
      'invalid_release_identity',
      'Release identity file is not valid JSON.'
    );
  }

  const admitted = PresentReleaseIdentitySchema.safeParse(parsed);
  if (!admitted.success) {
    throw new BootConfigError(
      'invalid_release_identity',
      'Release identity file has an unknown core shape or a value outside the closed release identity.'
    );
  }
  return admitted.data;
}
