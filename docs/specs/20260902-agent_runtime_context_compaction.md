---
status: Accepted
implementation: Not Started
date: 2026-09-02
---
# Agent Runtime Context Management And Compaction

## Owns

This specification owns the Server-scoped active-context policy for logical models, the OpenKit automatic runtime-compaction lifecycle, the Responses-compatible `context_management` control, the OpenKit compaction item, the choice of exactly one compaction authority per internal run or Worker Turn, and the quality, observability, failure, retry, and recovery requirements shared by those paths.

## Does Not Own

- `docs/core/agent-workflow.md` owns the canonical Context Compaction workflow mechanism and its traceability requirement.
- `docs/core/work-model.md` owns the distinction between a product-visible Context compact, reusable Knowledge, and runtime continuity.
- `docs/core/agent-session.md` owns Worker AgentSession identity, native conversation continuity, replacement, and restart behavior.
- `docs/specs/20260813-internal_agent_runtime.md` owns the role-agnostic Internal Agent Loop, its transient transcript, Tools, fuses, and typed exits.
- `docs/specs/20260526-llm_gateway_responses_api.md` owns Gateway authentication, logical-model routing, endpoint compatibility, fallback, streaming, and public error transport.
- `docs/specs/20260616-agent_environment_package.md` owns the strict immutable Worker package envelope and any future Worker projection of the resolved context policy.
- Runtime-specific Worker adapter specifications own translation into Codex, Pi, OpenCode, or another Harness's native configuration, checkpoint, and continuation representation.
- This specification does not create a Gateway conversation store, durable provider transcript, second Thread history, new AgentSession for internal roles, Knowledge mutation, Context Package replacement, public compaction registry, pluggable strategy framework, or per-role and per-user threshold override matrix.

## Core References

- `docs/core/agent-workflow.md`
- `docs/core/work-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-capability.md`
- `docs/core/foundation.md`
- `docs/core/audit.md`
- `docs/core/metering.md`

## Related Docs

- `docs/specs/20260813-internal_agent_runtime.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260709-quick_chat_workspace.md`
- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260716-codex_worker_adapter.md`
- `docs/specs/20260716-pi_worker_adapter.md`
- `docs/specs/20260716-opencode_worker_adapter.md`
- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`

## Summary

OpenKit standardizes one centrally authored compaction threshold and one normalized control contract, not one universal summarization algorithm. Every NanoCore-internal model-using role runs through the shared Internal Agent Loop, including Quick Chat, and the loop uses the OpenKit Gateway compactor when its resolved logical model reaches the configured threshold. A Worker runtime that already owns trustworthy native compaction keeps that implementation but receives the same resolved threshold through its immutable setup; a future compatible Worker may instead round-trip the OpenKit compaction item through the Gateway. One execution selects exactly one authority, so native and OpenKit compaction never compete inside the same active context.

The immediate blocker is the missing OpenKit compaction path for internal roles. The current Quick Chat direct provider function is implementation lag against the accepted shared-loop design, not a product exception and not a second runtime to preserve.

## Definitions And Exclusions

`Physical Context Window` is the maximum context capacity derived for one Provider-native model from the pinned model catalog. It is a capability fact, not an authored runtime target.

`Compaction Threshold` is the centrally configured token count at which OpenKit requires an active context to be compacted before ordinary inference continues. It is an operational working-set boundary below the Physical Context Window, not a claim that the model has a smaller physical window.

`Active Context` is the provider-neutral, model-visible input currently assembled for one internal run or Worker-native conversation after applying the latest accepted compaction checkpoint. It excludes fresh trusted instructions, Tool definitions, credentials, policy facts, audit data, and product records that are not intentionally projected to the model.

`Automatic Runtime Compaction` replaces older Active Context with a bounded continuation summary while preserving authoritative source history outside the model input. It is transient runtime continuity unless an existing workflow or AgentSession owner separately persists its native checkpoint.

`OpenKit Compaction Item` is the provider-neutral Responses item produced by the OpenKit compactor and accepted on a later OpenKit Responses request. It carries model context only and grants no authorization, capability, identity, effect authority, product truth, or proof of completion.

`Compaction Authority` is the sole component allowed to decide the cut point, produce the summary, replace the active context, and govern compaction retry for one admitted execution. Its only V1 values are `openkit` and `runtime-native` in trusted resolved projections; this discriminator is not part of the public Responses request.

This mechanism is not the initial Context Package budget used to select material for a Worker, not a product-visible Context compact used for handoff or workflow continuation, not Knowledge extraction, not provider prompt caching, and not truncation by silently dropping the oldest items. Those concerns retain their current owners.

## External Evidence And Deliberate Compatibility Boundary

The following first-party evidence was checked on 2026-09-02 against then-pinned Pi `0.80.7` and OpenCode `1.18.1`. The Pi row was re-checked on 2026-09-05 against the current worker pin `0.85.0` at exact tag `v0.85.0` commit `107d79f11072bbc8a3a757ed7fd69596bee7d68c`. External projects inform this design but do not own it.

| System | Trigger and control | Continuation representation | OpenKit consequence |
| --- | --- | --- | --- |
| OpenAI Responses | `context_management: [{ type: "compaction", compact_threshold }]` enables automatic server compaction, a final `compaction_trigger` input item requests Provider-side compaction, and `POST /responses/compact` is a separate explicit operation. | An opaque `{ type: "compaction", id, encrypted_content }` item is round-tripped with later Responses input. | Reuse the automatic request control shape and checkpoint ordering, reject the separate Provider-native trigger in V1, and do not claim OpenAI ciphertext compatibility. |
| Pi Coding Agent `0.85.0` | Native automatic compaction triggers from `contextWindow - reserveTokens`; manual `/compact` and an extension-supplied complete result also exist. | A plaintext summary plus retained-tail boundary is stored in Pi's native session tree. | Preserve Pi-native compaction when its adapter can project the central threshold; translating an OpenKit result requires an explicit Pi adapter. |
| OpenCode `1.18.1` | Native automatic compaction uses its configured buffer and session overflow calculation. | A synthetic compaction part, ordinary assistant summary, and `tail_start_id` rebuild the native session context. | Preserve OpenCode-native compaction when its adapter can project the central threshold; its current hook and Responses parser cannot round-trip a generic item. |

The current OpenAI documentation is [Compaction](https://developers.openai.com/api/docs/guides/compaction), [Create a model response](https://developers.openai.com/api/reference/resources/responses/methods/create), and [Compact a response](https://developers.openai.com/api/reference/resources/responses/methods/compact). The current Pi worker pin is release [`v0.85.0`](https://github.com/earendil-works/pi/tree/107d79f11072bbc8a3a757ed7fd69596bee7d68c), and the OpenCode baseline is release [`v1.18.1`](https://github.com/anomalyco/opencode/tree/99f638d8293f6985726ba509da602296c4963497).

The shared denominator is a threshold, a summary, a retained continuation boundary, and one owner that replaces context. There is no evidenced cross-runtime checkpoint format. OpenKit therefore normalizes policy, lifecycle outcomes, and measurements while allowing each selected authority to retain its native representation and algorithm.

## Central Logical-Model Policy

`DATA_ROOT/config/gateway.jsonc` is the sole authored source of the compaction threshold. Every logical model contains exactly one context-management entry in the accepted target shape:

```json
{
  "id": "reasoning-large",
  "displayName": "Reasoning Large",
  "contextManagement": [
    {
      "type": "compaction",
      "compactThreshold": 400000
    }
  ],
  "routes": [
    {
      "id": "primary",
      "providerProfileId": "anthropic-primary",
      "providerModel": "anthropic/claude-opus-4-6"
    }
  ]
}
```

Configuration uses repository-standard camel case, while the HTTP request uses OpenAI-compatible snake case. The array shape is retained because it matches Responses and permits a later separately accepted context-management entry type without replacing the field, but V1 requires exactly one entry and accepts only `type: "compaction"` with a positive integer `compactThreshold`.

The example keeps the catalog-derived Physical Context Window at 1,000,000 tokens and sets the managed Compaction Threshold to 400,000 tokens. OpenKit MUST NOT rewrite `model_context_window`, model catalog data, or Provider metadata to pretend that the physical model is a 400,000-token model.

The logical-model resolver derives every route member's context and maximum-output limits from the pinned model catalog. It rejects a configured threshold unless `compactThreshold + maximumOutputTokens` is less than or equal to every eligible route member's Physical Context Window. Missing physical or output limits, a non-positive threshold, duplicate context-management entries, an unknown entry type, or a logical model whose route set cannot honor the same threshold rejects the snapshot before the logical model becomes eligible.

There are no Server-global numeric fallback, Provider-route override, Agent override, internal-role override, Workspace override, User override, percentage mode, summary-model selection, retained-tail knob, or prompt override in V1. Models have different physical limits, so the policy belongs to each logical model; every internal role and Worker that resolves that logical model receives the same value.

A successful configuration reload applies a changed threshold only to newly admitted internal runs and newly resolved Worker packages. An active internal run remains pinned to its accepted policy, and an active Worker Turn remains pinned to its immutable package. Rollback selects the prior value for later executions and never rewrites completed history or a native session checkpoint.

## Resolved Execution Projection

The trusted resolved policy is:

```ts
interface ResolvedContextManagement {
  type: "compaction";
  compactThreshold: number;
  authority: "openkit" | "runtime-native";
}
```

`authority` is selected before the execution begins from the runtime kind and an adapter capability proven by its accepted specification and focused tests. It is never selected by the model, caller metadata, public request body, Provider response, or an unregistered runtime string.

Every NanoCore-internal run uses `authority: "openkit"`. A Worker uses `runtime-native` only when its pinned adapter proves that it can apply the exact central threshold, retain a valid native continuation checkpoint, emit normalized outcome evidence, and disable the OpenKit automatic path for that Turn. A Worker uses `openkit` only when its adapter proves that it can preserve, return, and later submit the OpenKit Compaction Item without loss. Once an immutable Worker package carries `llm.contextManagement`, setup fails visibly if neither capability is proven rather than running two compactors or silently ignoring the policy. Until that coordinated AEP version is admitted, a Worker continues with its runtime-native local defaults, receives no OpenKit `context_management` injection, and makes no central-policy conformance claim.

The future Worker projection belongs at `llm.contextManagement` in the immutable Agent Environment Package and carries exactly the resolved object above. The current strict version 4 package has no such field, so Worker policy projection requires the next coordinated AEP schema and adapter implementation; an `extensions` workaround, ambient Harness configuration, or mutable post-launch file is forbidden.

## Responses Control And Item Contract

The OpenKit Gateway accepts or injects this exact V1 control on `POST /v1/responses` for an execution whose authority is `openkit`:

```json
{
  "context_management": [
    {
      "type": "compaction",
      "compact_threshold": 400000
    }
  ]
}
```

OpenKit requires every effective compaction entry to contain `compact_threshold` even though the current OpenAI schema documents it as optional. A caller may omit the complete `context_management` field, in which case the trusted Gateway injects the pinned entry. If a caller supplies the field, a missing or mismatched threshold, additional entry, unknown field, unknown type, or request for OpenKit compaction under a `runtime-native` execution fails before Provider dispatch. The effective value MUST equal the policy pinned to the authenticated internal run, Worker Turn, or current unscoped Gateway request.

V1 rejects a caller-supplied Responses input item whose type is `compaction_trigger`, or any other Provider-native compaction control, before Provider dispatch. OpenKit never forwards a second compaction trigger into an execution whose sole authority was already selected.

The OpenKit-owned output and later input item is:

```ts
interface OpenKitCompactionItem {
  type: "compaction";
  id: string;
  summary: string;
}
```

`id` and a non-empty `summary` are required, and the item carries no status, Provider identity, physical route, source payload, credential, policy decision, or executable instruction field. Summary generation is bounded by the selected logical model's declared maximum output, and admission additionally requires the reconstructed Active Context to remain below `compactThreshold`. The Gateway emits the completed item before the ordinary output items generated from the compacted context. For a streaming response it emits no partial summary or summary delta: the complete compaction item appears through the existing Responses output-item transport before any ordinary output delta. A stateless caller appends the complete output to its next input and may discard only items before the most recent valid compaction item. On input, the Gateway replaces that item with one delimited assistant-role continuation summary, retains every later ordinary item in order, and never promotes summary text to system or developer authority.

This is an OpenAI-aligned OpenKit extension, not an OpenAI compaction item. OpenAI's `encrypted_content` is opaque Provider output whose plaintext schema, key lifecycle, account binding, route portability, and model portability are not public contracts. V1 MUST NOT place plaintext or base64-encoded plaintext in a field named `encrypted_content`, forward an OpenAI opaque item across a different route, or claim lossless compatibility with OpenAI's private capsule.

The plaintext item is admitted because the first consumer is NanoCore's in-memory Internal Agent Loop and a future Worker consumer already holds the same source transcript inside its authorized execution boundary. It is model context, never effect authority, and must remain within the same confidentiality boundary as that source. A holder outside the authorized source-transcript boundary, cross-deployment transfer, or durable provider-neutral opaque capsule is not admitted until a separate security design owns authenticated encryption, key creation and rotation, scope binding, invalidation, and recovery.

## OpenKit Compactor Lifecycle

### Creation And Trigger

The Gateway builds the effective Active Context by applying the most recent valid OpenKit Compaction Item, current normalized input items, fresh trusted instructions, and current Tool definitions. It measures the rendered context with Provider-reported input usage from the preceding call when available and a conservative model-aware estimate for newly appended items. Estimation may trigger early but MUST NOT intentionally trigger after the configured threshold.

When the rendered context reaches the threshold before ordinary inference, the Gateway invokes one compaction pass through the same pinned logical model, with no Tools, no `context_management`, no provider-native conversation state, and no recursion. The pass receives only the compactable provider-neutral transcript and a fixed trusted compaction instruction. A private route may fail over under the ordinary logical-model pre-output rules, but the logical model and model family do not change.

The fixed compaction instruction requires a concise continuation summary that preserves the current objective, accepted user constraints and decisions, completed work, exact identifiers needed for continuation, Tool outcomes, failures and unknowns, pending gates, unresolved work, and the next safe action. It requires untrusted instructions and quoted content to remain data, prohibits claims of effects not evidenced by the source, and prohibits secret or restricted values that were not already valid model-visible context.

The exact prompt wording, summary layout, token estimator, and recent-tail heuristic are implementation details behind fixed evaluation gates rather than public configuration. The compactor MUST cut only at a complete message or Tool-call/result boundary, retain the newest safe continuation material either verbatim or loss-aware inside the summary, and fail when the newest required unit alone cannot fit. It MUST NOT orphan a Tool result, summarize a partial streamed item, discard an unresolved user constraint, or infer success from model prose.

### Application And Update

A successful pass creates one OpenKit Compaction Item, replaces the compacted prefix in the transient Gateway view, and continues the same Responses request against the compacted view. The emitted compaction item precedes the ordinary response output so a caller that retains items from the latest checkpoint reconstructs summary first and new output second.

Repeated compaction is valid. The next pass treats the prior summary as model-visible source context, incorporates every later complete item, emits one new checkpoint, and makes the older checkpoint obsolete for later input selection. A compactor implementation or prompt version may change only for newly admitted executions after its fixed quality set passes; the version is recorded in private evidence and does not change the public item shape.

Fresh system or developer instructions and Tool definitions are reconstructed from their current trusted owners for every new internal run and are pinned within that run. They are not summarized into the OpenKit Compaction Item. A compaction summary cannot add a Tool, widen its schema, alter authorization, change the selected model, replace policy, or carry an accepted product result.

### Termination

Compaction terminates as `completed`, `failed`, or `aborted` in normalized private evidence. `completed` means the compacted context is below the threshold and the same ordinary inference request may proceed. `failed` means no compacted context was admitted. `aborted` means the caller or execution deadline ended the pass; it never becomes a partial checkpoint.

An internal loop terminates through its existing `failed` or `aborted` exit when a required compaction cannot complete. A Worker maps the outcome through its native adapter, AgentSession, Turn, and worker-control owners. No compaction outcome proves product completion, Tool success, external-effect settlement, or workflow progress.

### Retry, Overflow Recovery, And Unknown Result

A known pre-output Provider failure in the compaction pass may use the logical model's ordinary bounded route fallback. Once any compaction output begins, another route is not tried. A malformed, empty, over-budget, or unsafe summary fails validation and is not retried automatically with a changed prompt or model.

If ordinary inference returns a confirmed context-overflow error before any output, the OpenKit authority may perform one compaction pass and retry that exact model request once. This is recovery from estimator error, not a second autonomous retry policy. Another overflow, a source that cannot fit the compaction call, or a compaction result that remains at or above the threshold terminates with `context_compaction_unavailable` and no ordinary Provider success.

This specification authors the context-management failure conditions and stable codes under the Gateway's existing public error envelope and transport owner. Invalid, mismatched, malformed, or forbidden context-management control or input uses HTTP `400`, type `invalid_request_error`, code `invalid_context_management`, and fixed message `Invalid context management request.` A required compaction that cannot complete before ordinary output uses HTTP `503`, type `provider_error`, code `context_compaction_unavailable`, and fixed message `Context compaction is unavailable.` Caller cancellation and a failure after streaming begins retain the Gateway's existing cancellation and terminal-SSE transport rules; raw Provider or summary content never enters the public error.

If the compaction Provider outcome is unknown after output may have begun, the Gateway admits no item and performs no automatic repeat. The owning internal execution fails and a later request reconstructs from Core-owned source history; a Worker follows its AgentSession and adapter interruption contract. An uncertain compaction never authorizes replay of an earlier Tool call or external effect.

### Missing, Invalid, Stale, And Restarted State

A missing item simply means the caller supplies uncompacted context. A malformed item, empty summary, duplicate identifier within the request, item placed where it would split a Tool-call/result unit, or item that exceeds input bounds fails before Provider contact with a stable redacted context-management error.

A summary can contain stale product facts because it is context, not authority. Every consequential Tool call and publication revalidates current state through its existing owner. A stale summary may cause bounded model correction or a new compaction, but it cannot bypass authorization or overwrite source history.

NanoCore process restart abandons every in-memory internal run and its transient compaction item. A new run rebuilds from current Core-owned Thread, Item, Knowledge, workflow, and configuration sources; it does not resume hidden Provider state. A runtime-native Worker checkpoint restarts only under its adapter and AgentSession contract. The Gateway stores no conversation, compaction item, or replay cursor.

## Source Traceability, Confidentiality, And Visibility

The compaction source is the exact ordered provider-neutral Active Context admitted for the pass. Where the caller has Core lineage, private evidence records the Workspace, Thread, Turn, internal role or AgentSession, logical model, compaction item ID, source-item boundary or ordered source references, canonical source digest, threshold, estimated tokens before and after, compactor version, route-attempt lineage through its existing private owner, usage, start time, and terminal outcome.

The concrete record projection and producer obligations remain with `docs/specs/20260703-audit_usage_evidence_records.md`. Before this requirement is implemented, that owner must accept the normalized compaction fields and the Gateway or adapter producer boundary through its ordinary record-evolution rules; this specification creates no `CompactionRecord`, transcript table, or second usage ledger. Provider-native summaries and OpenKit summaries MUST NOT be copied into ordinary logs, public diagnostics, audit payloads, or usage rows. A process-local unscoped Gateway request may retain only redacted diagnostics and usage because it has no invented Core lineage.

Automatic runtime compaction is not rendered as a user or assistant Thread message. Product surfaces may show a product-safe indication that context was compacted, the number of completed passes, and a terminal context-management failure when useful, but they do not expose the raw summary, Provider payload, native session entry, source digest, route identity, or private token estimate.

If a workflow deliberately needs a visible, durable Context compact for handoff, retry, recovery, or a later bounded step, its existing workflow owner creates a traceable product record under `docs/core/agent-workflow.md`. Automatic runtime compaction does not create that record by implication and does not replace its source Items, Artifacts, Evidence, Knowledge, decisions, or checkpoints. If a summary contains reusable learning, it enters Knowledge only through the existing proposal and acceptance path.

## Internal Agent Loop And Quick Chat

The Internal Agent Loop receives the resolved logical-model context policy with its immutable input. Before each Gateway call it supplies or permits injection of the exact Responses control, recognizes an OpenKit Compaction Item in completed output, replaces its transient older messages with the summary checkpoint, then processes later assistant and Tool-call items in order. A compaction subcall counts toward metering and the run deadline but is not an ordinary model turn and does not create another loop fuse.

Every NanoCore-internal model-using role uses this one loop. Role-specific callers assemble prompts, Tools, messages, and product mappings, but they do not implement their own transcript loop or compactor. Short calls normally remain below threshold and pay no compaction call.

Quick Chat follows the same rule. Its lightweight Workspace capability boundary, absence of worker execution, and likely short conversations do not justify a direct Provider runtime. The current `callQuickChatProvider` path and tests that forbid the Internal Agent Runner are implementation divergence; implementation must replace that path with the shared Internal Agent Loop and preserve Quick Chat's existing timeout, cancellation, usage, redaction, and product-result behavior through the loop's owners.

## Worker Runtime Policy

Worker native implementations remain valuable because they understand their own session tree, reasoning state, Tool representation, overflow recovery, and retained-tail semantics. OpenKit therefore does not translate Pi summaries into OpenCode checkpoints, feed a Codex opaque Provider item to another route, or require every Harness to use the OpenKit summarization prompt.

The central threshold and normalized evidence remain mandatory. For `runtime-native`, the adapter translates the resolved `compactThreshold` into the pinned runtime's supported settings and proves the observed trigger boundary with a focused test. It disables the OpenKit automatic path for that Turn and maps native start, completion, failure, tokens-before, tokens-after when available, and checkpoint identity into product-safe evidence without copying the summary.

For `openkit`, the adapter preserves the exact OpenKit Compaction Item in its private active context and submits it on the next Gateway request. It disables native automatic compaction for the same execution. An adapter that cannot preserve the item losslessly cannot claim this authority.

Pi Coding Agent `0.85.0` and OpenCode `1.18.1` currently have usable native compaction but no first-class generic Responses compaction-item path. Pi's full-result extension makes a future translation adapter feasible; OpenCode requires a new native adapter or protocol path. The current Pi Worker is also unavailable on the accepted Gateway route, and both Pi and OpenCode adapters remain bounded-turn implementations, so neither is an immediate implementation blocker for the internal-loop slice.

Codex `0.153.4` is the only current session-continuity Worker adapter, and current repository evidence proves only a native `compaction` request classification, not a configurable exact threshold. OpenKit does not yet project the central threshold or normalized compaction evidence. Its first conformance task must verify from the pinned runtime whether the exact threshold can be controlled: retain Codex as `runtime-native` only if that proof passes, otherwise implement and prove the OpenKit-item path before admitting a context-managed Worker package.

## Quality Control And Optimization

One fixed, versioned evaluation set governs the OpenKit compactor and every adapter's threshold projection before default rollout. The set contains long conversations, Tool-heavy loops, repeated compactions, large user messages, multilingual content, prompt-injection text, negative findings, failed attempts, exact file and resource identifiers, accepted constraints and decisions, pending gates, unresolved questions, and context-overflow recovery. Before any candidate compactor output is observed, each fixture enumerates its required continuation facts, forbidden authority promotions, Tool-call/result pairings, and bounded acceptance tolerances, making those assertions a prior and bounded deciding oracle. Any model-graded or holistic quality score is informing-only and cannot accept a rollout or optimization.

The deciding checks prove that the compacted continuation answers or acts consistently with the source on required facts, preserves Tool-call/result integrity and current user intent, does not promote untrusted instructions, does not claim unproved effects, remains below the configured threshold, and reduces context materially enough for another ordinary response. Token reduction alone is not a sufficient oracle.

Normalized measurements compare compaction authority, runtime family, logical model, threshold, tokens before and after, compaction latency, compaction-model usage, repeated-pass count, correction rate, terminal failure, the prior fixture-assertion result, and any separately labeled informing quality score. Summary text remains excluded. These measurements permit native implementations to be compared without making their internal formats interchangeable.

The OpenKit prompt, tail policy, or implementation may be optimized behind the stable request and item contracts only after the fixed evaluation set shows no regression. A separate cheaper summary model, role-specific prompt, dynamic percentage threshold, user knob, or learned optimizer requires current evidence and a later accepted design; none exists in V1.

## Current Implementation Projection

The target is not implemented. `packages/config-schema/src/gateway.ts` currently gives logical models only `id`, `displayName`, and `routes`, and `apps/nanocore/src/llm/logical-models.ts` derives capabilities and `modelFamilyId` but does not project catalog context limits or a compaction policy.

The Gateway exposes `POST /v1/responses`, but the pinned pi-ai Responses abstraction does not admit `context_management` or parse a compaction output item. The current Codex worker hint recognizes `request_kind: "compaction"` and a `compact` subagent classification only as ephemeral native provenance; those hints do not implement this contract.

The accepted Internal Agent Runtime exists as a specification and partial profile implementation, while Quick Chat still performs one direct Chat Completions call in `apps/nanocore/src/mode-entry-routes.ts`. The current Quick Chat tests explicitly protect that old direct path. Those tests must be replaced by shared-loop coverage when implementation begins.

The current AEP version 4 has no resolved context-management field, and the Codex, Pi, and OpenCode adapters do not consume one central threshold. Existing Harness-native defaults therefore remain implementation fact, not conformance with this design.

## Implementation Order

1. Add and validate the required logical-model `contextManagement` policy, derive physical limits from the pinned catalog, and expose the resolved policy without changing model identity.
2. Add the OpenKit compactor and strict Responses control and item mapping behind the existing `POST /v1/responses`; do not add a standalone route.
3. Extend the shared Internal Agent Loop with the transient compaction checkpoint, route every model-using internal role through it, and delete the Quick Chat direct-provider exception and its inverse tests.
4. Update `docs/specs/20260703-audit_usage_evidence_records.md` and its existing record producers with the normalized audit, usage, and failure projection, add the fixed evaluation evidence, then roll out the threshold only for new internal runs.
5. Version the AEP and add one adapter at a time, beginning by verifying whether pinned Codex exposes an exact native threshold control; do not admit that policy into a Worker package or mark a runtime conformant until its focused proof passes.

## Alternatives Considered

### Force One Summary Algorithm Into Every Harness

Rejected because the current runtimes have materially different session trees, retained-tail rules, replay behavior, extension boundaries, and failure handling. An adapter that discards those strengths would add conversion risk without improving central control.

### Keep Every Harness Policy Independent

Rejected because the same logical model could then consume different working sets depending on role or runtime, configuration changes would require editing several unrelated files, and operators could not explain or compare behavior from one Server policy.

### Copy OpenAI `encrypted_content` With Plaintext Data

Rejected because the name would assert confidentiality that does not exist. Actual authenticated encryption requires a key, scope, rotation, invalidation, and recovery design; no current consumer needs that machinery.

### Add `POST /v1/responses/compact` Immediately

Rejected because automatic `context_management` closes the present Internal Agent blocker and supports the future adapter path. A standalone operation becomes justified only when a real caller needs manual compaction or a canonical compacted-output array independent of ordinary inference.

### Store Gateway Conversations Or Compaction Records

Rejected because the caller, Internal Agent Loop, workflow owner, or AgentSession already owns the relevant continuity. Stateless input and output items provide the required channel without a second transcript authority.

### Pretend The Physical Model Window Is The Desired Working Set

Rejected because rewriting a one-million-token model as 400,000 tokens corrupts capability facts and can break routing, output headroom, and native Harness behavior. The configured threshold is a separate policy.

## Acceptance Predicates

- Every logical model has one validated Server-authored compaction threshold distinct from its catalog-derived physical context and output limits.
- A one-million-token model configured with `compactThreshold: 400000` remains physically identified as one million tokens while all new executions resolving that logical model receive the 400,000-token policy.
- `POST /v1/responses` accepts or injects exactly one `{ type: "compaction", compact_threshold }` control for OpenKit authority and rejects a mismatch before Provider dispatch.
- The OpenKit compactor emits `{ type: "compaction", id, summary }`, applies it as low-authority continuation context, and never labels plaintext as `encrypted_content`.
- The Gateway stores no conversation or compaction record, and a stateless caller can continue by retaining the latest compaction item and later output.
- Each internal run and Worker Turn selects exactly one of `openkit` or `runtime-native`, and a focused check proves that the unselected path performs zero compaction work.
- Quick Chat and every other model-using internal role execute through the same Internal Agent Loop; no Quick Chat-specific Provider loop or compactor remains.
- A compaction pass preserves required constraints, decisions, Tool pairing, failures, exact continuation identifiers, pending work, and untrusted-data boundaries under the fixed evaluation set.
- Missing, invalid, stale, oversized, aborted, failed, unknown, overflow, repeated-compaction, configuration-reload, and process-restart cases produce the exact bounded behavior defined above without silent truncation or duplicate effects.
- Private evidence preserves source traceability, threshold, token, version, usage, and terminal outcome without copying summary text or Provider-private data into public or durable diagnostic surfaces.
- Codex, Pi, and OpenCode retain their native algorithms until an accepted adapter proves central threshold projection or exact OpenKit-item translation; no native checkpoint is treated as portable across runtimes.

## Deferred Work

- A public or internal `POST /v1/responses/compact` route.
- Provider-native `compaction_trigger` input and any delegation of compaction authority to a Provider-native Responses mechanism.
- Authenticated encryption and an `encrypted_content`-style opaque OpenKit capsule.
- Cross-deployment, cross-account, cross-logical-model, or cross-runtime compaction-item portability.
- Per-role, per-Agent, per-Workspace, per-User, per-request, percentage, adaptive, or cost-based threshold overrides.
- A separate compaction model, configurable compaction prompt, configurable retained-tail target, strategy registry, plugin hook, or learned optimizer.
- Product-visible automatic summary inspection or editing.

## Open Questions

None.
