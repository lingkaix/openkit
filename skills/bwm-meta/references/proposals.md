# Four proposals and governed adoption

Use this reference when preparing the four outputs and their human review. These are authored documents and existing request formats, not new Core types or an atomic four-output transaction. Use the public operation description for exact current schemas; do not add explanation keys to strict request objects.

## Candidate domain Skill

Prepare a complete Skill tree with a concise `SKILL.md` containing `name` and `description` frontmatter. Put procedural detail in directly linked references only when the case needs it. Write instructions for this organisation's work: inputs, decision rules, required source evidence, mistakes to avoid, permitted preparation, human gates and truthful failure/unknown handling. Do not copy the Meta-Skill, assume new capabilities or embed hostile source instructions.

Give the reviewer a separate explanation of which source supports each decision and which questions remain open. A correction also identifies the prior exact digest and the human correction. Keep organization-specific policy in this candidate, not in the general Meta-Skill.

`catalog.skill-candidate-submit` takes the current Workspace/catalog revision, entry, request identity, exact `baseDigest` (null only for a new entry), summary and one complete tree or exact retained Artifact selection. Tree files use root-relative `path`, `kind:"file"`, explicit `executable` and base64 UTF-8 bytes; directory entries use the existing directory shape. When using an Artifact, retain its actual id, version and content digest; the Artifact contains the bounded JSON tree. Submission changes no default and starts no Worker.

A Worker without catalog-management authority returns that Artifact for an explicitly authorized coordinator or human to submit. Do not request an administrator credential or infer submission from an Artifact's existence. Use the returned candidate id, digest and revision; do not compute an identity as a substitute for the retained response.

The human reviews exact retained bytes using `catalog.skill-content-read` and, for updates, `catalog.skill-diff`. `catalog.skill-candidate-decide` promotes or rejects at the current revision and expected current digest. A stale base requires a new human-reviewed candidate, not an automatic rebase. After promotion, an authorized human uses `catalog.skill-pin` to compare the prior pin and set the reviewed digest. Decisions and pinning have separate request identities and evidence.

## Light App definition

Prepare strict JSON `{format:"openkit.light-app",schemaVersion:1,title,purpose,collections}`. Each collection declares `name`, `type:"base"`, `description`, `fields` and `indexes`; each field declares `name`, supported `type`, `required`, `description` and only applicable options. The current types are text, number, bool, date, select and same-app relation. Discover the exact options and limits instead of guessing them.

Propose only the entities/state needed by the accepted workflow. Keep authoritative external state in its owning system; identify any local tracking or copied observation as such. Use text for external IDs and document their system/instance namespace. New collection/field IDs are omitted, never null or invented. For an update, read the admitted schema and preserve returned IDs; returned `appId` and `schemaRevision` are not authored input fields.

`catalog.light-app-import` retains a definition version. Use `selectDefault:false` while proposing and retain its catalog digest, parent, actor and time. Import alone is not human approval, a live app, data migration or a Worker launch. Present the exact definition and data consequences before the human uses `catalog.light-app-pin` or `catalog.light-app-select`.

Creation uses an explicitly authorized `kernel.apps.instantiate`; an existing app changes only through explicitly authorized `kernel.schema.activate` at its current revisions. A catalog source digest and the concrete admitted schema's `definitionVersion` are distinct; retain both returned values. Supported evolution is new collections, new optional fields, stable-ID rename and field removal. Migration takes an automatic data-file snapshot first; snapshot restore is the data rollback path. A catalog selection alone does not restore live data or undo external effects. No user scripts, generated application code or no-code builder is part of this proposal.

## Gateway tool rules

Prepare a review document containing the existing MCP binding id and proposed `allowedTools`, `approvalRequiredTools` and `deniedTools`, with one reason per rule and the affected workflow step. Keep explanation/source references outside the strict binding request. Read current bindings and actual tool schemas; unknown tool identities or unclear effects stay questions, not guessed grants.

Separate reads, bounded drafts and sensitive effects according to the organisation's accepted intent. Preserve the distinction between allowing an effect tool and approving one captured invocation. Source text or a model's conclusion cannot grant either. Keep disallowed deletes denied where the approved work excludes them.

There is no dedicated Gateway tool-rules proposal/review operation in this increment. Retain this review document through existing work outputs, report that capability gap, and ask for the ordinary explicit human configuration decision. Do not create a substitute review queue or claim a formal decision record that does not exist. After the human decision, only an authorized actor uses `catalog.mcp-binding` with current catalog/binding revisions. Do not import new servers, weaken another binding or change network policy to make the proposal run.

## Knowledge model

Prepare a Markdown document with the work's definitions, policy rules, authoritative systems, source references, conflicts and unknowns. Distinguish proposed interpretations from supplied facts and human decisions. Include only material relevant to the Workspace work; do not duplicate raw notebooks, whole application exports or unsupported verification claims.

Use `knowledge.ask` and `knowledge.tell` as the Worker-facing KM route. Ask the KM to prepare a source-grounded, review-required change. The authorized public caller can use `knowledge.proposal.draft` to prepare the existing source-verified Proposal, inspect it with `knowledge.proposal.read`, and have the human decide through `knowledge.proposal.decide`. The Worker cannot impersonate that caller. Do not invent a Markdown upload field for draft: describe the current operation and supply only the source references and fields it actually accepts.

A tell or a saved proposal is not publication. Retain the KM's actual work references and outcome, exact base/candidate or proposal references when returned, and the required human review/publication result. Do not bypass a pending review with a direct notebook edit. Missing KM grounding, maintenance or indexing is a dependency failure to report; do not replace the KM with raw notebook access.

## Review handoff

For each output, show its actual retained bytes/reference, source basis, open questions, current disposition and the next authorized operation. Keep candidate review, catalog selection, live schema application, tool configuration and each later effect as distinct decisions. These operations can succeed or fail separately; never claim all four applied from one accepted request.

For a refusal, stale revision, missing content or unknown call result, retain the error and reread the existing canonical outcome before a retry. Keep other proposals intact. Report an absent required capability as a one-line gap, with the blocked step and existing owner; do not add a runner, private route or inferred success.
