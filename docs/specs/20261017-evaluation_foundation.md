---
status: Accepted
implementation: Partial
kind: concept
aspect: work-model
---
# Evaluation Foundation

This specification owns the human judgement record and the candidate set with its attributable selection.

## Scope

- Artifact versions, Review effects, Material revisions, exact ranges, and correction effects belong to [Work Resource Interaction](20260713-work_resource_interaction_model.md).
- Worker input admission belongs to [Worker Context Package](20260703-worker_context_package.md).
- This specification adds no Evaluator, scheduler, statistics engine, A/B platform, strategy record, or universal Resource model.
- [Work Model](../core/work-model.md) defines the judgement concept this record refines.
- [Contract Evolution](../core/contract-evolution.md) owns unknown-marker refusal.

## Judgement

A judgement records one human assessment of one exact target. It retains the authenticated actor, server-recorded time, request identity, kind, choice and optional note. `JudgementRecordSchema` and `JudgementTargetSchema` in `packages/app-api-schemas/src/evaluation.ts` are the record and the target. A judgement is immutable after acceptance. A later judgement preserves the earlier assessment rather than editing it.

Material range offsets use UTF-16 code units, with an inclusive start and exclusive end. This version defines one unit, so the record has no offset-unit field. The original text and digest remain in the record. Range validation and correction effects follow the Material owner; this record does not define another locator or patch format.

An `accept` or `reject` choice is JSON `null`. It is not an absent field, an empty object, or an empty string. A `correct` choice identifies the proposed replacement. An applied correction has the full resulting Material revision tuple. A rejected correction has `resultingRevision: null`. A `select` choice identifies one exact candidate: a member of the target set, or the exact version and digest named by an Artifact-version target. A different Artifact-version choice is refused. A `rate` choice contains the numeric value and the explicit lower and upper bounds of its scale. The lower bound is strictly less than the upper bound. The value lies on that inclusive range. There is no fixed star or percentage scale. Ratings from different scales have no implied equivalence.

`JudgementRecordSchema`, `JudgementTargetSchema`, and `CandidateSetRecordSchema` in `packages/app-api-schemas/src/evaluation.ts` are the records. A public judgement add or range correction uses a strict JSON request, admits only an authenticated human actor, and returns `201` with `{ judgement }`. The caller does not choose the actor, the time, or the schema marker. Generic judgement add accepts only `accept`, `reject`, and `rate`. `select` and `correct` use their own commands. A missing target is `404 not_found`.

A selection targets a candidate set or one exact Artifact version. A correction targets an exact Material range. Other judgements can assess any target form. A note does not grant authority, alter a target or replace the typed choice.

Artifact judgements extend the existing version-keyed Review rather than creating a second Artifact decision store. Existing Review decisions retain their own effect and conflict rules. A judgement does not independently accept a proposal, change content or authorize an effect. Material correction results remain with the existing Material revision and Review owners.

## Candidate Set And Selection

A candidate set retains an ordered collection of at least two distinct exact Artifact-version references from one Workspace. Each reference includes its content digest. Duplicate identity is the pair `(artifactId, artifactVersion)`. Repeating that pair with a different digest still fails. The set also retains its creator and creation time. `candidateSetId` equals the accepted creation `requestId`. No second set id is allocated. Its identity and membership are immutable. A different membership creates a different set. A judgement request id is unique within the owning set. Every judgement targets its owning set and Workspace. A select judgement additionally chooses an exact member, including its digest.

Candidates can come from repeated runs of one configuration or from different existing Skill versions, models or prompts. Producing work and strategy references use existing outcome lineage. An AEP snapshot, Skill version or model reference is descriptive provenance; it creates neither a strategy record nor present authority.

A single-version choice is a `select` judgement on that exact version in the existing Artifact Review. Its `candidateSelections` read view derives actor, request, reason and time from those judgements; no separate selection array or column is retained or transferred. It does not assert comparison-set membership. A candidate-set choice remains only in that set's `select` judgement history. The Review and set commands each append to their existing target owner and never dual-write. The Review decision tuple remains the first-writer owner of apply and follow-up effects; descriptive judgements do not replace it.

A human selects one member through an attributable `select` judgement. The selected reference must be a member of the retained set. A later explicit selection appends a judgement; the most recently committed selection is the current projection. Earlier selections remain inspectable. A set without a selection has no selected candidate.

The next step uses the selected candidate's exact version through existing pinned inputs and Context admission. Selection alone starts no work. The user must explicitly submit the next step. A later selection or newer Artifact version never changes an already pinned input. Missing content or failed current admission blocks that input; the system does not substitute another candidate or version.

## Authority, Persistence And Failure

The Workspace owns each set and judgement. Current access must admit the target and every candidate before a read, a list, a judgement, a selection, or a replay. Set membership is not an access grant. References do not widen the audience of private source work. Historical actor, strategy and source references grant no current access.

The target's existing owner retains Artifact judgements and Material feedback. The candidate-set owner retains set membership and selection judgements. Lists and current selections are projections over those records. Verified export and restart preserve exact references and attribution within the Workspace. Ordinary portable import is absent and does not remap those references. These records contain no credentials or copies of runtime configuration.

An exact retry of an accepted request returns its recorded result without adding another judgement or set. Replay of an earlier set selection returns judgement history through that original request. It does not adopt a later choice as the original response. Reuse of a request identity with different input returns a conflict. Missing, inaccessible or digest-invalid targets produce a clear error without a new accepted judgement. A stale Material base or a conflicting correction preserves the owner's truthful result and never changes another revision.

No automatic retry, reconstruction or repair lifecycle exists. An interrupted request follows the existing command owner's receipt and unknown-result rules. Termination of a judgement or set means removal through the owning Workspace lifecycle; there is no independent cancellation or expiry state.

The retained forms have a closed core and an open extension object. Readers ignore unknown descriptive extensions. Unknown target or judgement kinds, invalid exact references and unknown authority-bearing semantics fail closed under Contract Evolution.

Retained judgement and candidate-set records use only the shared `schemaVersion: 1` marker and retained-v1 read/write helpers. Unknown or absent markers and predecessor-only `formatVersion` records are refused before family use. This pre-stable cut requires the coordinated reset; no converter, dual writer or legacy reader is supplied.

## Acceptance

- An inspected judgement identifies its human actor, exact target, time, kind, typed choice and note after restart and in the verified Workspace export.
- An Artifact judgement uses its existing Review and cannot bypass Review decision or Material apply authority.
- A candidate set preserves membership and every selection. Selection rejects a non-member and cannot disclose an inaccessible candidate.
- Explicit next-step submission uses the selected exact version through ordinary pinned-input admission, including after a newer version exists.
- Exact Material feedback retains its UTF-16 range, original text and digest; correction reports the Material owner's stale, conflict, apply or reject result.
- Unknown descriptive extensions remain readable; unknown core kinds are rejected. No background evaluation work starts from these records.

## Implementation

- `apps/nanocore/src/`
- `apps/web/src/`
- `packages/app-api-schemas/src/`

## Implementation Gaps

- A fresh browser and real-use run proves the judgement and candidate loop - On main, that qualification is not established - #343
