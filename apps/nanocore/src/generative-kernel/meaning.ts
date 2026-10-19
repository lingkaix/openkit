import { isUtf8 } from 'node:buffer';
import type { LightAppMeaningResolution } from '@openkit/app-api-schemas';
import { parseReferenceScope, parseReferenceUri } from '@openkit/protocol';
import { readWorkspaceSkillContent } from '../catalog/skill-inspection.js';
import { resolveKnowledgeMeaningReference } from '../knowledge/knowledge-meaning-reference.js';
import type { KnowledgeRetrievalAccess } from '../retrieval-knowledge-adapter.js';

/** Resolves one admitted pin through its existing owner without selecting a current default. */
export function resolveLightAppMeaning(input: {
  readonly workspaceId: string;
  readonly reference: string;
  readonly access: KnowledgeRetrievalAccess;
}): LightAppMeaningResolution {
  const unavailable = { reference: input.reference, status: 'unavailable' as const };
  const parsed = parseReferenceUri(input.reference);
  const scope = parsed && parseReferenceScope(parsed.reference.scopeId);
  if (!parsed?.contentDigest || !scope) return unavailable;
  if (scope.family === 'page' || scope.family === 'raw') {
    const result = resolveKnowledgeMeaningReference(input);
    return result.status === 'available'
      ? { reference: input.reference, status: 'available', content: result.content }
      : unavailable;
  }
  if (
    scope.family !== 'skill' ||
    scope.kind !== 'workspace' ||
    scope.workspaceId !== input.workspaceId
  )
    return unavailable;
  const dataRoot = input.access.store.getDataRoot();
  if (!dataRoot) return unavailable;
  try {
    const result = readWorkspaceSkillContent({
      dataRoot,
      workspaceId: input.workspaceId,
      entryId: parsed.reference.objectId,
      digest: parsed.contentDigest,
      path: 'SKILL.md',
    });
    const bytes = Buffer.from(result.contentBase64, 'base64');
    if (!isUtf8(bytes)) return unavailable;
    return { reference: input.reference, status: 'available', content: bytes.toString('utf8') };
  } catch {
    // Missing, purged or changed trees disclose no partial content or internal storage details.
    return unavailable;
  }
}
