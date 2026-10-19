---
status: Accepted
implementation: In Progress
kind: concept
date: "2026-10-17"
---
# Evaluation Foundation

## Summary

Human judgement on exact outputs and candidate selection provide the v0.1.0 foundation for improvement through ordinary work.

## Owns

This specification owns the judgement record and the candidate set with its attributable selection.

## Does Not Own

Artifact versions and Review decisions remain with [Work Resource Interaction](20260713-work_resource_interaction_model.md). That owner also defines Material revisions, exact ranges and correction effects. [Worker Context Package](20260703-worker_context_package.md) owns worker input admission. This specification adds no Evaluator, scheduler, statistics engine, A/B platform, strategy record or universal Resource model.

## Core References

- [Work Model](../core/work-model.md)
- [Knowledge](../core/knowledge.md)
- [Permissions](../core/permissions.md)
- [Storage](../core/storage.md)
- [Contract Evolution](../core/contract-evolution.md)

## Judgement

A judgement records one human assessment of one exact target. It retains the authenticated actor, server-recorded time, request identity, kind, choice and optional note. The closed kinds are `accept`, `reject`, `correct`, `select` and `rate`. A judgement is immutable after acceptance. A later judgement preserves the earlier assessment rather than editing it.

The target has exactly one of these closed forms:

| Target | Required retained reference |
| --- | --- |
| Artifact version | Workspace, Artifact identity, version and content digest |
| Material range | Workspace, Material identity, revision identity, content digest, range start, range end and original text |
| Candidate set | Workspace and immutable candidate-set identity |

Material range offsets use UTF-16 code units, with an inclusive start and exclusive end. This version defines one unit, so the record has no offset-unit field. The original text and digest remain in the record. Range validation and correction effects follow the Material owner; this record does not define another locator or patch format.

An `accept` or `reject` choice is empty. A `correct` choice identifies the proposed replacement and, when applied, the resulting exact Material revision. A `select` choice identifies one candidate in the target set. A `rate` choice contains the numeric value and the explicit lower and upper bounds of its scale. The value must lie within those bounds. Ratings from different scales have no implied equivalence.

A selection targets a candidate set. A correction targets an exact Material range. Other judgements can assess any target form. A note does not grant authority, alter a target or replace the typed choice.

Artifact judgements extend the existing version-keyed Review rather than creating a second Artifact decision store. Existing Review decisions retain their own effect and conflict rules. A judgement does not independently accept a proposal, change content or authorize an effect. Material correction results remain with the existing Material revision and Review owners.

## Candidate Set And Selection

A candidate set retains an ordered collection of at least two distinct exact Artifact-version references from one Workspace. Each reference includes its content digest. The set also retains its creator and creation time. The accepted creation request is the scoped set identity; no second creation request field is retained. Its identity and membership are immutable. A different membership creates a different set.

Candidates can come from repeated runs of one configuration or from different existing Skill versions, models or prompts. Producing work and strategy references use existing outcome lineage. An AEP snapshot, Skill version or model reference is descriptive provenance; it creates neither a strategy record nor present authority.

`ArtifactReview.candidateSelections` records the existing independent choice of one exact Artifact version for a later input; it does not assert membership in a comparison set. A candidate-set selection records a choice among that set's immutable members only in its `select` judgement history. The candidate-set command does not append a Review candidate selection, and the Review command does not append a candidate-set judgement. One human choice is never written to both owners.

A human selects one member through an attributable `select` judgement. The selected reference must be a member of the retained set. A later explicit selection appends a judgement; the most recently committed selection is the current projection. Earlier selections remain inspectable. A set without a selection has no selected candidate.

The next step uses the selected candidate's exact version through existing pinned inputs and Context admission. Selection alone starts no work. The user must explicitly submit the next step. A later selection or newer Artifact version never changes an already pinned input. Missing content or failed current admission blocks that input; the system does not substitute another candidate or version.

## Authority, Persistence And Failure

The Workspace owns each set and judgement. Current access must admit the target and every candidate before a read, judgement or selection. References do not widen the audience of private source work. Historical actor, strategy and source references grant no current access.

The target's existing owner retains Artifact judgements and Material feedback. The candidate-set owner retains set membership and selection judgements. Lists and current selections are projections over those records. Export, import and restart preserve exact references and attribution within the Workspace's existing portability boundary. These records contain no credentials or copies of runtime configuration.

An exact retry of an accepted request returns its recorded result without adding another judgement or set. Reuse of a request identity with different input returns a conflict. Missing, inaccessible or digest-invalid targets produce a clear error without a new accepted judgement. A stale Material base or a conflicting correction preserves the owner's truthful result and never changes another revision.

No automatic retry, reconstruction or repair lifecycle exists. An interrupted request follows the existing command owner's receipt and unknown-result rules. Termination of a judgement or set means removal through the owning Workspace lifecycle; there is no independent cancellation or expiry state.

The retained forms have a closed core and an open extension object. Readers ignore unknown descriptive extensions. Unknown target or judgement kinds, invalid exact references and unknown authority-bearing semantics fail closed under Contract Evolution.

Retained judgement and candidate-set records use only the shared `schemaVersion: 1` marker and retained-v1 read/write helpers. Unknown or absent markers and predecessor-only `formatVersion` records are refused before family use. This pre-stable cut requires the coordinated reset; no converter, dual writer or legacy reader is supplied.

## Acceptance

- An inspected judgement identifies its human actor, exact target, time, kind, typed choice and note after restart and Workspace round trip.
- An Artifact judgement uses its existing Review and cannot bypass Review decision or Material apply authority.
- A candidate set preserves membership and every selection. Selection rejects a non-member and cannot disclose an inaccessible candidate.
- Explicit next-step submission uses the selected exact version through ordinary pinned-input admission, including after a newer version exists.
- Exact Material feedback retains its UTF-16 range, original text and digest; correction reports the Material owner's stale, conflict, apply or reject result.
- Unknown descriptive extensions remain readable; unknown core kinds are rejected. No background evaluation work starts from these records.

## Related Docs

- [Work Resource Interaction](20260713-work_resource_interaction_model.md)
- [Evaluation Harness Design](20260711-evaluation_harness_design.md)
- [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md)
