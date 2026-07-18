# Knowledge Work

Load this reference for knowledge sources, observations, claims, conflicts, retrieval, context packages, proposals, repair, or knowledge health.

## Read before writing

Identify the workspace and thread context, then search the operation catalog with the user's intent, such as `knowledge source`, `retrieve`, `claim`, `conflict`, `context package`, `proposal`, `repair`, or `health`. Describe the selected operation before invoking it.

Read current knowledge state before recording a new observation, claim, decision, or proposal. Preserve the source, scope, provenance, and revision information required by the described schema; do not infer missing provenance or present a projection as its durable owner.

## Apply governed changes

Perform one knowledge mutation at a time and re-read its durable result. Treat conflicts, stale revisions, reviews, and promotion requirements as governed outcomes rather than local merge prompts.

Present knowledge proposals and conflicts to the user with their evidence and scope. Resolve or promote them only through an exposed operation and explicit user direction when that decision changes shared knowledge.

Use retrieval and context-package operations to obtain bounded task context. Do not bulk-load the knowledge store when a scoped query is sufficient, and do not treat retrieved context as authorization to mutate another record or external system.

Use repair or health operations only for the condition they describe. Re-read the affected durable records after repair and report any remaining conflict, missing dependency, or typed failure.

## Protect sensitive and derived material

Never store credentials, one-time secret material, raw private runtime state, or unredacted diagnostic output as knowledge. Preserve required citations and provenance when deriving a claim from an artifact, evidence record, source, or observation.

Do not duplicate an artifact into knowledge merely to make it discoverable. Record the supported reference or derived claim when the described public contract provides one.
