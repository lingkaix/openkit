import { matchPath, useLocation } from 'react-router-dom';
import { SURFACES } from './surfaces';

/**
 * Reads identifiers from a registered surface without decoding literal percent escapes twice.
 *
 * React Router decodes the pathname before replacing `%2F` in route captures, so `useParams` conflates a literal `%2F` with `/`.
 * Match the encoded pathname and decode each capture once instead.
 * The route identity regressions must remain when the router is upgraded or this extraction is changed.
 */
export function useSurfaceParams(surfaceId: string): Record<string, string | undefined> {
  const { pathname } = useLocation();
  const surface = SURFACES.find((candidate) => candidate.id === surfaceId);
  if (!surface) throw new Error(`Unknown surface: ${surfaceId}`);
  const match = matchPath(surface.path, pathname);
  if (!match) throw new Error(`The current path does not match surface: ${surfaceId}`);
  return Object.fromEntries(
    Object.entries(match.params).map(([key, value]) => [
      key,
      value === undefined ? undefined : decodeURIComponent(value),
    ])
  );
}
