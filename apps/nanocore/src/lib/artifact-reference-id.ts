import { deriveEntityId } from '@openkit/protocol';

/**
 * Derives the stable Item identity for one Artifact and communicating Turn.
 * @param artifactId Artifact communicated by the Item.
 * @param turnId Turn that owns the Item.
 * @returns Stable non-secret Item id.
 */
export function artifactReferenceItemId(artifactId: string, turnId: string): string {
  return deriveEntityId('it', [artifactId, turnId]);
}
