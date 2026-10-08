---
status: Accepted
date: "2026-10-08"
decider: "Engineer, on a Consultant-reviewed proposal"
---
# Historical Tool Pairs And Release Hold

## Decision

The engineer chose these two options verbatim on 2026-10-08, as preserved in the writer dispatch:

1. Route: 「(a) 把完整的历史调用/结果对当作不可调用的上下文放行，按顾问给的规范文本修改两份 owner」.
2. Release: 「等：修复落地并重新跑完干净轮次后再发布」.

The English translation of ruling 1 is: “Admit complete historical call/result pairs as non-callable context, using the consultant's specification text to amend both owning documents.” The English translation of ruling 2 is: “Wait: publish after the fix lands and the clean rounds are rerun.” The quotations remain the source wording.

The route ruling is limited to complete historical local function or custom-tool call/result pairs on same-protocol native Responses. [Pi AI Unified LLM Backend, Codex Turn-State Continuity](../specs/20260708-pi_ai_unified_llm_backend.md#codex-turn-state-continuity) owns pairing, exclusions, current callable authority and new-output validation. [LLM Gateway Responses API, POST /v1/responses](../specs/20260526-llm_gateway_responses_api.md#post-v1responses) owns admission and preservation on the public route; its [Bridge Compatibility](../specs/20260526-llm_gateway_responses_api.md#bridge-compatibility) keeps undeclared-history refusal on cross-protocol mappings. Compaction prompts and runtime provenance hints supply no admission authority. The existing native envelope remains attempt-local; no durable record or migration is introduced.

The backend amendment replaces exactly: “A missing declaration, invalid search result, conflicting definition, or unmatched call/result fails the request before provider access; malformed provider output fails that response without executing a tool or repairing history.” The Gateway Bridge Compatibility amendment replaces exactly: “Mapping collisions, conflicting default-namespace aliases and undeclared or unmatched history fail before provider access; undeclared Provider output fails instead of inventing a callable identity.” The Gateway route amendment adds a paragraph immediately after the first paragraph of POST /v1/responses; it replaces no sentence. Surrounding projection, lifecycle, search-activation and acceptance requirements remain binding.

The release ruling holds `v0.1.0-rc.1` until the correction lands and the corrected candidate completes the clean rounds under [Release Management](../specs/20260829-release_management.md#release-exit-criterion). A changed candidate restarts the count under that owner. Local checks do not satisfy persistent-deployment rounds, qualify upstream acceptance, establish release readiness or authorize publication. This record does not authorize deployment, Provider access or publication.

## Reason

The Consultant's main reason is that a transcript records what happened, while current declarations describe what may be requested now. Requiring a historical tool to remain callable confuses context with execution authority. Strict pairing and item-schema admission can preserve the transcript while every new call still requires current callable authority. The engineer selected that bounded amendment and the release hold; no separate engineer rationale was recorded.

Source material is the 2026-10-08 writer dispatch at `temp/interface-unification/build/write-spec-compact.md` and the independent Consultant report at `temp/reports/consult-compact/consult.md`, held in the repository's temporary work area. The Consultant's Exact proposed owner changes supplies the approved text, and Lowest-sufficient regressions and failure category, items 1 to 3, supplies its admission, validation and output predicates. These temporary sources are evidence rather than governing authority; the linked owners state the rules.

Acceptance of complete undeclared historical pairs by the actual `openai-codex` Responses service remains unproved. A native client request, stock-adapter payload capture, synthetic transport success or permissive SDK type does not establish remote service acceptance. The amendment removes an OpenKit-local refusal without claiming Provider or end-to-end success. The existing [external-provider behavior decision](20261002-external_provider_behavior_accepted.md) does not justify that local refusal and does not authorize a private adapter patch or silent fallback.

## Rejected Alternatives

- Route (b), projecting pairs into readable text: changes structured item identities, roles and lineage, with reasoning-continuity and summary-quality consequences. It needs a separately accepted projection if the preserved native form proves unusable.
- Route (c), making native Codex send declarations: no supported mechanism preserving summary-only behavior was established; reconstructing callable definitions from history would promote context to authority.
- Route (d), implementing OpenKit compaction items and disabling native compaction: valid strategic work under the accepted compaction owner, but a larger coordinated change than this bounded admission correction.
- Route (e), leaving the refusal and shipping with disclosure: retains the known failure of long tool-using Codex work. The engineer selected a fix and renewed clean rounds before release.
- Provider detection, a private pi-ai patch, another transport, or silent text conversion after rejection: outside the selected route and existing transport and semantic-preservation boundaries.

## Revisit When

Direct rejection evidence from the `openai-codex` service for the preserved native form is the trigger to reconsider route (b), an explicitly accepted readable-text projection, versus route (d), OpenKit-owned compaction with proved native disablement, before further investment. Local admission or synthetic continuation success does not resolve that uncertainty. A pairing or output-validation finding returns to the existing owners rather than weakening current callable authority. Changing the release hold requires a new engineer ruling; the existing release process still governs clean-round evidence and publication authorization.

## Affected Owners

- [Pi AI Unified LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md#codex-turn-state-continuity)
- [LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md#post-v1responses)
- [Agent Runtime Context Management And Compaction](../specs/20260902-agent_runtime_context_compaction.md)
- [Codex Worker Adapter](../specs/20260716-codex_worker_adapter.md)
- [Release Management](../specs/20260829-release_management.md#release-exit-criterion)
