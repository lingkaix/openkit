import {
  type CandidateSetRecord,
  CandidateSetRecordReaderSchema,
  type EvaluationCandidate,
  type JudgementRecord,
  JudgementRecordReaderSchema,
  type WorkspaceMaterialRevisionView,
} from '@openkit/app-api-schemas';
import type { ArtifactVersionRecord } from '@openkit/protocol';

/** Existing import maps and exact target records; no judgement or candidate state is allocated here. */
export interface EvaluationImportContext {
  readonly sourceWorkspaceId: string;
  readonly targetWorkspaceId: string;
  readonly artifactIds: ReadonlyMap<string, string>;
  readonly materialIds: ReadonlyMap<string, string>;
  readonly materialRevisionId: (materialId: string, revisionId: string) => string;
  readonly requestId: (requestId: string) => string;
  readonly artifactVersions: readonly ArtifactVersionRecord[];
  readonly materialRevisions: readonly (WorkspaceMaterialRevisionView & {
    readonly createdByRequestId: string;
  })[];
}

/** A judgement stays with the exact existing Review, Material revision or candidate set that owns it. */
type JudgementOwner =
  | ({ readonly kind: 'artifact-version' } & EvaluationCandidate)
  | {
      readonly kind: 'material-range';
      readonly materialId: string;
      readonly revisionId: string;
      readonly contentDigest: string;
    }
  | { readonly kind: 'candidate-set'; readonly candidateSetId: string };

/** Validates closed retained semantics while keeping the original descriptive objects for remapping. */
export function readPortableJudgements(value: unknown): JudgementRecord[] {
  const records = JudgementRecordReaderSchema.array().parse(value);
  if (new Set(records.map((record) => record.requestId)).size !== records.length)
    throw new Error('Portable judgement history has duplicate request identities.');
  return value as JudgementRecord[];
}

/** Remaps one exact Artifact reference and proves the retained version and digest in the target graph. */
function remintCandidate(candidate: EvaluationCandidate, context: EvaluationImportContext) {
  const artifactId = context.artifactIds.get(candidate.artifactId);
  if (
    !artifactId ||
    !context.artifactVersions.some(
      (record) =>
        record.artifact.id === artifactId &&
        record.artifact.workspaceId === context.targetWorkspaceId &&
        record.artifact.version === candidate.artifactVersion &&
        record.artifact.contentDigest === candidate.contentDigest
    )
  ) {
    throw new Error('Portable evaluation reference lacks its exact Artifact version and digest.');
  }
  return { ...candidate, artifactId };
}

/** Remaps only owned references; attribution, ranges, choices and unknown descriptive additions stay intact. */
export function remintPortableJudgements(
  value: unknown,
  owner: JudgementOwner,
  context: EvaluationImportContext
): JudgementRecord[] {
  const rawRecords = readPortableJudgements(value);
  return rawRecords.map((raw) => {
    const record = JudgementRecordReaderSchema.parse(raw);
    const source = record.target;
    if (
      record.workspaceId !== context.sourceWorkspaceId ||
      source.kind !== owner.kind ||
      (source.kind === 'artifact-version' &&
        owner.kind === 'artifact-version' &&
        (source.artifactId !== owner.artifactId ||
          source.artifactVersion !== owner.artifactVersion ||
          source.contentDigest !== owner.contentDigest ||
          !['accept', 'reject', 'rate'].includes(record.kind))) ||
      (source.kind === 'material-range' &&
        owner.kind === 'material-range' &&
        (source.materialId !== owner.materialId ||
          source.revisionId !== owner.revisionId ||
          source.contentDigest !== owner.contentDigest)) ||
      (source.kind === 'candidate-set' &&
        owner.kind === 'candidate-set' &&
        source.candidateSetId !== owner.candidateSetId)
    ) {
      throw new Error('Portable judgement contradicts its existing target owner.');
    }
    let target: JudgementRecord['target'];
    let choice: JudgementRecord['choice'] = raw.choice;
    switch (source.kind) {
      case 'artifact-version':
        target = { ...raw.target, ...remintCandidate(source, context) };
        break;
      case 'candidate-set':
        target = {
          ...raw.target,
          kind: source.kind,
          candidateSetId: context.requestId(source.candidateSetId),
        };
        if (record.kind === 'select') {
          choice = { ...raw.choice, ...remintCandidate(record.choice, context) };
        }
        break;
      case 'material-range': {
        const materialId = context.materialIds.get(source.materialId);
        const revisionId = context.materialRevisionId(source.materialId, source.revisionId);
        const revision = context.materialRevisions.find(
          (candidate) => candidate.materialId === materialId && candidate.revisionId === revisionId
        );
        const splitsPair = (offset: number) =>
          revision !== undefined &&
          offset > 0 &&
          offset < revision.content.length &&
          /[\uD800-\uDBFF]/.test(revision.content[offset - 1]!) &&
          /[\uDC00-\uDFFF]/.test(revision.content[offset]!);
        if (
          !materialId ||
          !revision ||
          revision.workspaceId !== context.targetWorkspaceId ||
          revision.contentDigest !== source.contentDigest ||
          source.end > revision.content.length ||
          splitsPair(source.start) ||
          splitsPair(source.end) ||
          revision.content.slice(source.start, source.end) !== source.originalText
        ) {
          throw new Error(
            'Portable judgement contradicts its exact original UTF-16 Material range.'
          );
        }
        target = { ...raw.target, ...source, materialId, revisionId };
        if (record.kind === 'correct' && record.choice.outcome === 'apply') {
          const result = record.choice.resultingRevision;
          const resultMaterialId = context.materialIds.get(result.materialId);
          const resultRevisionId = context.materialRevisionId(result.materialId, result.revisionId);
          const applied = context.materialRevisions.find(
            (candidate) =>
              candidate.materialId === resultMaterialId && candidate.revisionId === resultRevisionId
          );
          if (
            !applied ||
            resultMaterialId !== materialId ||
            applied.parentRevisionId !== revisionId ||
            applied.contentDigest !== result.contentDigest ||
            applied.content !==
              revision.content.slice(0, source.start) +
                record.choice.replacementText +
                revision.content.slice(source.end) ||
            applied.createdByRequestId !== context.requestId(record.requestId) ||
            applied.authorId !== record.actor.id ||
            applied.createdAt !== record.recordedAt
          ) {
            throw new Error(
              'Portable correction contradicts its actual resulting Material revision.'
            );
          }
          const rawChoice = raw.choice as Extract<
            Extract<JudgementRecord, { kind: 'correct' }>['choice'],
            { outcome: 'apply' }
          >;
          choice = {
            ...rawChoice,
            outcome: 'apply',
            resultingRevision: {
              ...rawChoice.resultingRevision,
              materialId,
              revisionId: resultRevisionId,
            },
          };
        }
        break;
      }
    }
    const imported = {
      ...raw,
      workspaceId: context.targetWorkspaceId,
      requestId: context.requestId(record.requestId),
      target,
      choice,
    };
    JudgementRecordReaderSchema.parse(imported);
    return imported as JudgementRecord;
  });
}

/** Carries raw ordered membership and its target-owned assessments through the existing request-lineage map. */
export function remintPortableCandidateSets(
  values: readonly unknown[],
  context: EvaluationImportContext
): CandidateSetRecord[] {
  const ids = new Set<string>();
  return values.map((value) => {
    const record = CandidateSetRecordReaderSchema.parse(value);
    if (record.workspaceId !== context.sourceWorkspaceId || ids.has(record.candidateSetId))
      throw new Error(
        'Portable candidate set has contradictory Workspace ownership or duplicate identity.'
      );
    ids.add(record.candidateSetId);
    const raw = value as CandidateSetRecord;
    const imported = {
      ...raw,
      workspaceId: context.targetWorkspaceId,
      candidateSetId: context.requestId(record.candidateSetId),
      candidates: raw.candidates.map((candidate) => remintCandidate(candidate, context)),
      judgements: remintPortableJudgements(
        raw.judgements,
        { kind: 'candidate-set', candidateSetId: record.candidateSetId },
        context
      ),
    };
    CandidateSetRecordReaderSchema.parse(imported);
    return imported;
  });
}
