/** Release SBOM attachment names, shared so library importers never load the release-sbom CLI entry. */
import { readFileSync } from 'node:fs';

export const platformPattern = /^linux\/(?:amd64|arm64)$/u;
export function releaseImages() {
  return JSON.parse(
    readFileSync(new URL('../containers/images.json', import.meta.url), 'utf8')
  ).images.filter((image) => image.release === true);
}
export function sbomName(id, platform, tag) {
  if (
    !/^[a-z0-9-]+$/u.test(id) ||
    !platformPattern.test(platform) ||
    !/^v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u.test(tag)
  )
    throw Error('SBOM filename identity refused');
  return `openkit-sbom-${id}-${platform.replace('/', '-')}-${tag}.cdx.json`;
}
/** Existing catalog/platform subjects plus the two existing NanoHost archive targets. */
export function sbomAssetNames(tag) {
  return [
    ...releaseImages().flatMap((image) =>
      image.platforms.map((platform) => sbomName(image.id, platform, tag))
    ),
    ...['linux/amd64', 'linux/arm64'].map((platform) => sbomName('nanohost', platform, tag)),
  ].sort();
}
