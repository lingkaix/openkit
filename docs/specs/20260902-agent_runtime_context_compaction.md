---
status: Accepted
implementation: Partial
kind: mechanism
date: 2026-09-02
updated: "2026-10-17"
---
# Agent Runtime Context Management And Compaction

## Owns

This specification owns the Server-scoped active-context policy for logical models, the OpenKit automatic runtime-compaction lifecycle, the Responses-compatible `context_management` control, the OpenKit compaction item, the two internal context strategies and their shared durable summary Item format, the choice of exactly one compaction authority per Worker Turn, and the quality, observability, failure, retry, and recovery requirements shared by those paths.

## Applicability

Core Assistant and Goal/Workflow Coordinator default to [rolling context](#internal-durable-rolling-context). Knowledge Manager uses [bounded-run compaction](#knowledge-manager-compaction) under the [engineer's decision](../decisions/20261017-knowledge_manager_agent_and_compaction.md). A future Evaluator defaults to compaction only after its role is admitted. Both strategies use the existing [source-bound summary Item](#source-bound-summary-items). Worker-native compaction, physical model limits and Gateway routing retain their existing owners. The Responses control below is a Gateway wire contract. The existing context-summary Item owns canonical internal summaries; rolling context has no Gateway-compactor prerequisite.

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

Every NanoCore internal model-using role uses the shared Internal Agent Loop. Knowledge Manager starts each maintenance run with fresh bounded context and uses compaction only near its in-run budget. Assistant and Goal/Workflow Coordinator default to rolling context. Both strategies retain the same source-bound summary Item under existing Thread/Item owners. Their pinned strategy and producing model remain distinguishable for evaluation; no per-call window record is required in v0.1.0.

The remaining Gateway/Worker paths standardize one centrally authored compaction threshold and normalized control contract. A Worker with trustworthy native compaction keeps that implementation subject to its immutable setup contract; a future compatible Worker may round-trip the OpenKit Compaction Item. Each such execution selects one compaction authority so native and OpenKit compaction do not compete. These paths do not block internal-role rolling context.

## Definitions And Exclusions

`Physical Context Window` is the maximum context capacity reported for one Provider-native model by effective catalog or authored Provider metadata. It is a capability declaration, not the runtime compaction target. Every configured model must resolve this positive limit from the pinned catalog or authored Provider metadata under the Gateway owner; an adapter default cannot substitute for it.

`Compaction Threshold` is the centrally configured token count at which OpenKit requires an active context to be compacted before ordinary inference continues. It is an operational working-set boundary below the Physical Context Window, not a claim that the model has a smaller physical window.

`Active Context` is the provider-neutral, model-visible input assembled for one execution. An internal run receives its admitted rolling window or, within one bounded Knowledge Manager run, its accepted summary and later Items; a context-managed Gateway/Worker execution may apply its latest accepted compaction checkpoint. It excludes fresh trusted instructions, Tool definitions, credentials, policy facts, audit data, and product records that are not intentionally projected to the model.

`Automatic Runtime Compaction` replaces older Active Context with a bounded continuation summary while preserving authoritative source history outside the model input. Gateway/Worker continuation remains transient unless its existing owner persists it. Internal roles retain accepted summaries as existing context-summary Items under their Thread/Item owners.

`OpenKit Compaction Item` is the provider-neutral Responses item produced by the OpenKit compactor and accepted on a later OpenKit Responses request. It carries model context only and grants no authorization, capability, identity, effect authority, product truth, or proof of completion.

`Compaction Authority` is the sole component allowed to decide the cut point, produce the summary, replace the active context, and govern compaction retry for one admitted execution. Its only V1 values are `openkit` and `runtime-native` in trusted resolved projections; this discriminator is not part of the public Responses request.

This mechanism is not the initial Context Package budget used to select material for a Worker, not a product-visible Context compact used for handoff or workflow continuation, not Knowledge extraction, not provider prompt caching, and not truncation by silently dropping the oldest items. Those concerns retain their current owners.

## External Evidence And Deliberate Compatibility Boundary

The following first-party evidence was checked on 2026-09-02 against then-pinned Pi `0.80.7` and OpenCode `1.18.1`. The Pi row was re-checked on 2026-09-05 against then-current worker pin `0.85.0` at exact tag `v0.85.0` commit `107d79f11072bbc8a3a757ed7fd69596bee7d68c`, and again on 2026-09-06 against the then-current worker pin `0.85.1` at exact tag `v0.85.1` commit `d981de1229ef899957bbe968bc8dcda02a21f477`. External projects inform this design but do not own it.

| System | Trigger and control | Continuation representation | OpenKit consequence |
| --- | --- | --- | --- |
| OpenAI Responses | `context_management: [{ type: "compaction", compact_threshold }]` enables automatic server compaction, a final `compaction_trigger` input item requests Provider-side compaction, and `POST /responses/compact` is a separate explicit operation. | An opaque `{ type: "compaction", id, encrypted_content }` item is round-tripped with later Responses input. | Reuse the automatic request control shape and checkpoint ordering, reject the separate Provider-native trigger in V1, and do not claim OpenAI ciphertext compatibility. |
| Pi Coding Agent `0.85.1` | Native automatic compaction triggers from `contextWindow - reserveTokens`; manual `/compact` and an extension-supplied complete result also exist. | A plaintext summary plus retained-tail boundary is stored in Pi's native session tree. | Preserve Pi-native compaction when its adapter can project the central threshold; translating an OpenKit result requires an explicit Pi adapter. |
| OpenCode `1.18.1` | Native automatic compaction uses its configured buffer and session overflow calculation. | A synthetic compaction part, ordinary assistant summary, and `tail_start_id` rebuild the native session context. | Preserve OpenCode-native compaction when its adapter can project the central threshold; its current hook and Responses parser cannot round-trip a generic item. |

The current OpenAI documentation is [Compaction](https://developers.openai.com/api/docs/guides/compaction), [Create a model response](https://developers.openai.com/api/reference/resources/responses/methods/create), and [Compact a response](https://developers.openai.com/api/reference/resources/responses/methods/compact). The historical Pi worker pin examined above is release [`v0.85.1`](https://github.com/earendil-works/pi/tree/d981de1229ef899957bbe968bc8dcda02a21f477), and the historical OpenCode baseline is release [`v1.18.1`](https://github.com/anomalyco/opencode/tree/99f638d8293f6985726ba509da602296c4963497); deployment pins are recorded in `containers/worker-runtimes/versions.json`.

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

The logical-model resolver uses each route's required context limit and optional maximum-output limit from the Gateway-owned effective Provider model metadata. For every authored route member with resolvable metadata, including an unavailable member whose limits remain known, it requires `compactThreshold` not to exceed that window, and additionally requires `compactThreshold + maximumOutputTokens` not to exceed it when the output limit is known. Missing effective context in a configured Provider model rejects configuration under the Gateway owner. An absent Provider profile or delisted route model is instead an unavailable member under [Gateway routing](20260526-llm_gateway_responses_api.md#unavailable-members), without fabricated limits; restored supply must pass threshold validation before selection. Missing output metadata remains unknown and does not prevent admission; the configuration does not claim its threshold is proven to fit an unknown output reserve. Adapter operating defaults do not become verified physical limits. A non-positive threshold, duplicate context-management entries, an unknown entry type, or a known route limit that cannot honor the threshold rejects the snapshot before the logical model becomes eligible. An actual upstream context-overflow error remains explicit and follows the existing failure path rather than silently substituting a model or inventing a physical limit.

There are no Server-global numeric fallback, Provider-route override, Agent override, internal-role override, Workspace override, User override, percentage mode, summary-model selection, retained-tail knob, or prompt override in V1. Models have different physical limits, so the policy belongs to each logical model; every Gateway/Worker execution using compaction for that logical model receives the same value. The Knowledge Manager uses this compaction threshold. Assistant and Goal/Workflow Coordinator use the rolling-window budget rather than this threshold by default.

A successful configuration reload applies a changed threshold only to newly admitted compaction-managed Gateway requests and newly resolved Worker packages. An active managed execution remains pinned to its accepted policy, and an active Worker Turn remains pinned to its immutable package. Rollback selects the prior value for later executions and never rewrites completed history or a native session checkpoint.

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

The Knowledge Manager selects `openkit`. Rolling internal roles do not use this Gateway/Worker compaction-authority projection. A Worker uses `runtime-native` only when its pinned adapter proves that it can apply the exact central threshold, retain a valid native continuation checkpoint, emit normalized outcome evidence, and disable the OpenKit automatic path for that Turn. A Worker uses `openkit` only when its adapter proves that it can preserve, return, and later submit the OpenKit Compaction Item without loss. Once an immutable Worker package carries `llm.contextManagement`, setup fails visibly if neither capability is proven rather than running two compactors or silently ignoring the policy. Until that coordinated AEP version is admitted, a Worker continues with its runtime-native local defaults, receives no OpenKit `context_management` injection, and makes no central-policy conformance claim.

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

OpenKit requires every effective compaction entry to contain `compact_threshold` even though the current OpenAI schema documents it as optional. A caller may omit the complete `context_management` field, in which case the trusted Gateway injects the pinned entry. If a caller supplies the field, a missing or mismatched threshold, additional entry, unknown field, unknown type, or request for OpenKit compaction under a `runtime-native` execution fails before Provider dispatch. The effective value MUST equal the policy pinned to the authenticated compaction-managed Worker Turn or current Gateway request. Trusted Knowledge Manager calls use OpenKit compaction under the selected model policy. Rolling internal-role calls bypass this control and use their admitted rolling window.

V1 rejects a caller-supplied Responses input item whose type is `compaction_trigger`, or any other Provider-native compaction control, before Provider dispatch. OpenKit never forwards a second compaction trigger into an execution whose sole authority was already selected.

The OpenKit-owned output and later input item is:

```ts
interface OpenKitCompactionItem {
  type: "compaction";
  id: string;
  summary: string;
}
```

`id` and a non-empty `summary` are required, and the item carries no status, Provider identity, physical route, source payload, credential, policy decision, or executable instruction field. Summary generation uses the selected adapter's bounded output budget, limited by the model's maximum output when known. If physical output metadata is absent, the adapter's existing operational output bound applies without becoming a claimed physical limit. Admission additionally requires the reconstructed Active Context to remain below `compactThreshold`. The Gateway emits the completed item before the ordinary output items generated from the compacted context. For a streaming response it emits no partial summary or summary delta: the complete compaction item appears through the existing Responses output-item transport before any ordinary output delta. A stateless caller appends the complete output to its next input and may discard only items before the most recent valid compaction item. On input, the Gateway replaces that item with one delimited assistant-role continuation summary, retains every later ordinary item in order, and never promotes summary text to system or developer authority.

This is an OpenAI-aligned OpenKit extension, not an OpenAI compaction item. OpenAI's `encrypted_content` is opaque Provider output whose plaintext schema, key lifecycle, account binding, route portability, and model portability are not public contracts. V1 MUST NOT place plaintext or base64-encoded plaintext in a field named `encrypted_content`, forward an OpenAI opaque item across a different route, or claim lossless compatibility with OpenAI's private capsule.

The plaintext wire item is admitted only within the caller's authorized source-transcript boundary. It is distinct from the source-verified context-summary Item retained by a Core role owner. It is model context, never effect authority, and must remain within the same confidentiality boundary as that source. A holder outside the authorized source-transcript boundary, cross-deployment transfer, or durable provider-neutral opaque capsule is not admitted until a separate security design owns authenticated encryption, key creation and rotation, scope binding, invalidation, and recovery.

## OpenKit Compactor Lifecycle

### Creation And Trigger

The Gateway builds the effective Active Context by applying the most recent valid OpenKit Compaction Item, current normalized input items, fresh trusted instructions, and current Tool definitions. It measures the rendered context with Provider-reported input usage from the preceding call when available and a conservative model-aware estimate for newly appended items. Estimation may trigger early but MUST NOT intentionally trigger after the configured threshold.

When the rendered context reaches the threshold before ordinary inference, the Gateway invokes one compaction pass through the same pinned logical model, with no Tools, no `context_management`, no provider-native conversation state, and no recursion. The pass receives only the compactable provider-neutral transcript and a fixed trusted compaction instruction. A private route may fail over under the [Gateway commit and failure rules](20260526-llm_gateway_responses_api.md#commit-boundary-and-retry), but the logical ID and derived family stay pinned. A mixed-family tier pins that logical ID and a `null` family; changing members never carries another member's opaque reasoning, and uses the Gateway-owned readable-text handoff instead. The simplest minimum context and output rule and sealed-reasoning decision are recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md).

The fixed compaction instruction requires a concise continuation summary that preserves the current objective, accepted user constraints and decisions, completed work, exact identifiers needed for continuation, Tool outcomes, failures and unknowns, pending gates, unresolved work, and the next safe action. It requires untrusted instructions and quoted content to remain data, prohibits claims of effects not evidenced by the source, and prohibits secret or restricted values that were not already valid model-visible context.

The exact prompt wording, summary layout, token estimator, and recent-tail heuristic are implementation details behind fixed evaluation gates rather than public configuration. The compactor MUST cut only at a complete message or Tool-call/result boundary, retain the newest safe continuation material either verbatim or loss-aware inside the summary, and fail when the newest required unit alone cannot fit. It MUST NOT orphan a Tool result, summarize a partial streamed item, discard an unresolved user constraint, or infer success from model prose.

### Application And Update

A successful Gateway pass creates one OpenKit Compaction Item, replaces the compacted prefix in the transient Gateway view, and continues the same Responses request against the compacted view. A Core role owner accepts a durable summary only after verifying its exact committed Item range under the shared summary contract. A wire item alone cannot prove that range or become canonical Thread history. The emitted compaction item precedes the ordinary response output so a caller that retains items from the latest checkpoint reconstructs summary first and new output second.

Repeated compaction is valid. The next pass treats the prior summary as model-visible source context, incorporates every later complete item, emits one new checkpoint, and makes the older checkpoint obsolete for later input selection. A compactor implementation or prompt version may change only for newly admitted executions after its fixed quality set passes; the version is recorded in private evidence and does not change the public item shape.

Fresh system or developer instructions and Tool definitions are reconstructed from their current trusted owners for every new internal run and are pinned within that run. They are not summarized into the OpenKit Compaction Item. A compaction summary cannot add a Tool, widen its schema, alter authorization, change the selected model, replace policy, or carry an accepted product result.

### Termination

Compaction terminates as `completed`, `failed`, or `aborted` in normalized private evidence. `completed` means the compacted context is below the threshold and the same ordinary inference request may proceed. `failed` means no compacted context was admitted. `aborted` means the caller or execution deadline ended the pass; it never becomes a partial checkpoint.

An internal loop terminates through its existing `failed` or `aborted` exit when a required compaction cannot complete. A Worker maps the outcome through its native adapter, AgentSession, Turn, and worker-control owners. No compaction outcome proves product completion, Tool success, external-effect settlement, or workflow progress.

### Retry, Overflow Recovery, And Unknown Result

A known pre-commit Provider failure in the compaction pass may use the logical model's [bounded retry and failover rules](20260526-llm_gateway_responses_api.md#commit-boundary-and-retry), including its automatic-failover setting. Once the compaction call commits under the Gateway owner, another route is not tried. Private generation alone is not public commit and does not establish replay safety; the Gateway's uncertain-effect rule still applies. A malformed, empty, over-budget, or unsafe summary fails validation and is not retried automatically with a changed prompt or model.

If ordinary inference returns a confirmed context-overflow error before any output, the OpenKit authority may perform one compaction pass and retry that exact model request once. This is recovery from estimator error, not a second autonomous retry policy. Another overflow, a source that cannot fit the compaction call, or a compaction result that remains at or above the threshold terminates with `context_compaction_unavailable` and no ordinary Provider success.

This specification authors the context-management failure conditions and stable codes under the Gateway's existing public error envelope and transport owner. Invalid, mismatched, malformed, or forbidden context-management control or input uses HTTP `400`, type `invalid_request_error`, code `invalid_context_management`, and fixed message `Invalid context management request.` A required compaction that cannot complete before ordinary output uses HTTP `503`, type `provider_error`, code `context_compaction_unavailable`, and fixed message `Context compaction is unavailable.` Caller cancellation and a failure after streaming begins retain the Gateway's existing cancellation and terminal-SSE transport rules; raw Provider or summary content never enters the public error.

The trusted Codex adapter carries its already validated native request kind as optional ephemeral `requestKind` (`turn`, `prewarm`, or `compaction`) in the existing inference hint. The Gateway consumes it before Provider dispatch. Only a confirmed `compaction` request that fails before output receives the required-compaction envelope above. Absence of this phase evidence, an ordinary request, cancellation, and failure after output retain their existing categories. A subagent label or prompt content alone does not prove the compaction phase. This [approved phase seam](../decisions/20261016-native_compaction_phase_hint.md) adds neither durable state nor a compactor.

If the compaction Provider outcome is unknown after output may have begun, the Gateway admits no item and performs no automatic repeat. The owning internal execution fails and a later request reconstructs from Core-owned source history; a Worker follows its AgentSession and adapter interruption contract. An uncertain compaction never authorizes replay of an earlier Tool call or external effect.

### Missing, Invalid, Stale, And Restarted State

A missing item simply means the caller supplies uncompacted context. A malformed item, empty summary, duplicate identifier within the request, item placed where it would split a Tool-call/result unit, or item that exceeds input bounds fails before Provider contact with a stable redacted context-management error.

A summary can contain stale product facts because it is context, not authority. Every consequential Tool call and publication revalidates current state through its existing owner. A stale summary may cause bounded model correction or a new compaction, but it cannot bypass authorization or overwrite source history.

NanoCore process restart abandons every in-memory run and transient Gateway compaction item. Internal reconstruction verifies the latest accepted summary and later canonical Items within the admitted continuity boundary. For Knowledge Manager, that boundary is one bounded run; a new maintenance Turn assembles fresh notebook/run inputs and selected needed records, not a previous Turn's summary. Failed runs are never resumed or replayed. A new run uses current Core-owned sources and configuration, not hidden Provider state. A runtime-native Worker checkpoint restarts only under its adapter and AgentSession contract. The Gateway stores no conversation, compaction item, or replay cursor. The reasoning-item-to-member association is new process-local Gateway state, not existing per-conversation state, a transcript, or durable authority. Codex turn-state remains a caller-held `x-codex-turn-state` header that Gateway forwards and returns; it is not a Gateway conversation store. The association is abandoned on restart, so every earlier reasoning capsule becomes unattributed and receives readable-text handoff even when the producing member is selected again. The restart consequence is recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md).

Entries are created only when the Gateway returns a reasoning item from a known member. Each entry holds only the reasoning item id and the producing member’s key, never ciphertext or other payload bytes. The association has a fixed entry ceiling with least-recently-used eviction; the ceiling’s value is an implementation constant. The item ID is the lookup key, and only an unambiguous attribution to that same member permits opaque forwarding. A missing, evicted, external, stale, conflicting, or restarted entry proves no producer and uses readable-text handoff rather than relabeling the item. Eviction removes attribution without an error. The association has no independent durable authority, write, retry, termination, or recovery operation. Provider failure does not authorize reconstruction or a new public identity field. After restart or association loss, the caller's retained readable history remains usable while opaque reasoning continuity is lost.

## Source Traceability, Confidentiality, And Visibility

The compaction source is the exact ordered provider-neutral Active Context admitted for the pass. Where the caller has Core lineage, private evidence records the Workspace, Thread, Turn, internal role or AgentSession, logical model, compaction item ID, source-item boundary or ordered source references, canonical source digest, threshold, estimated tokens before and after, compactor version, route-attempt lineage through its existing private owner, usage, start time, and terminal outcome.

The concrete record projection and producer obligations remain with `docs/specs/20260703-audit_usage_evidence_records.md`. Before this requirement is implemented, that owner must accept the normalized compaction fields and the Gateway or adapter producer boundary through its ordinary record-evolution rules; this specification creates no `CompactionRecord`, transcript table, or second usage ledger. Provider-native summaries and OpenKit summaries MUST NOT be copied into ordinary logs, public diagnostics, audit payloads, or usage rows. Internal summary text belongs only in its authorized context-summary Item; summary content does not become an audit or usage payload. A process-local unscoped Gateway request may retain only redacted diagnostics and usage because it has no invented Core lineage.

Gateway/Worker runtime compaction is not rendered as a user or assistant Thread message. Its product surfaces may show a safe compaction indication, completed-pass count and terminal failure, without exposing raw summaries or private Provider/runtime data. Internal roles instead retain the existing context-summary Item and its authorized source-range display under the contract below; it is not an ordinary user or assistant message.

If a workflow deliberately needs a visible, durable Context compact for handoff, retry, recovery, or a later bounded step, its existing workflow owner creates a traceable product record under `docs/core/agent-workflow.md`. Automatic runtime compaction does not create that record by implication and does not replace its source Items, Artifacts, Evidence, Knowledge, decisions, or checkpoints. If a summary contains reusable learning, it enters Knowledge only through the existing proposal and acceptance path.

## Knowledge Manager Compaction

The notebook scope's maintenance Thread is nonresident. It records bounded runs, exact inputs, outcomes and required approvals. Each explicit or scheduled run starts fresh from the admitted notebook overview, run inputs and needed authorized Thread records. Cross-run memory is the notebook and commit history, not a continuing model conversation. Query runs remain independently bound to the asker's context and audience.

Only within one bounded run, near the selected model's threshold, OpenKit compacts the current admitted context. It retains the accepted summary as the existing `context-summary` Item with strategy `compaction`, exact covered Item range and producing model. Latest valid summary plus later canonical Items reconstruct that run's admitted context. A later maintenance Turn does not resume the previous Turn's summary; needed prior records are selected inputs. Exact history remains available through the existing history Tool.

The shared source-bound summary contract below preserves source digests, retrieval evidence, role environment, authority, audience, Tool pairing and typed failure behavior. Only canonical committed Items before the summary are eligible, including a complete prefix of the producing Turn. Transient model output is not source proof. Summary text remains untrusted context and grants no authority or publication evidence.

A context-summary Item is an existing durable Item, not a new store, Item kind, transcript or checkpoint owner. Restart abandons the model run and virtual editing filesystem. A new bounded run reconstructs current notebook/run inputs and needed authorized records without replaying inference or Tool effects. A failed or invalid summary accepts no replacement and returns the existing explicit failure; it never silently truncates history.

Acceptance requires bounded fresh-context admission, compaction only inside a run, exact summary-range reconstruction, retained history and decisions, and no cross-run model resumption. Parallel queries preserve audience isolation. [Knowledge Manager](20260704-knowledge_manager_internal_agent_runtime.md#query-and-maintenance-execution) owns maintenance and query admission, daily enablement, learning inputs and visible outcomes.

## Internal Durable Rolling Context

Core Assistant, including its bounded management entry, and Goal/Workflow Coordinator default to the shared durable rolling-context mechanism. A deterministic Workflow Coordinator performs no model call. Knowledge Manager uses bounded-run compaction above. Strategy changes context assembly, not the shared Internal Agent Loop or durable summary format. The [rolling-context decision](../decisions/20261015-private_assistant_timeline_and_rolling_context.md) and [Knowledge Manager decision](../decisions/20261017-knowledge_manager_agent_and_compaction.md) record these defaults.

The context belongs to its existing role/conversation owner. Its window continues across bounded runs and process restart. It is not a per-user process, a Worker AgentSession, reusable Memory, or a second canonical conversation log. Canonical Thread Items, accepted commands, source revisions, and effect records remain authoritative. The shared Internal Agent Loop receives the owner's admitted ordered messages and retains no independent durable truth.

Creation derives the first window from authorized durable inputs. Updates retain a bounded continuation of the same context with source attribution and Tool call/result pairing. A bounded run's termination does not erase continuity. Retry reconstructs from current durable owners and never repeats a Tool effect merely to rebuild context. Archive, deletion, and retention follow the containing record's existing owner.

Before model use, trusted assembly checks current source authority, output audience, source revision, role configuration, and physical model bounds. A stale or incompatible window is reconstructed from eligible durable inputs. Missing or contradictory required evidence fails closed; dependency failure and context overflow remain explicit failures. Provider state, caches, summaries, and a previous read cannot restore revoked authority or substitute for missing canonical history.

Migration to the shared loop preserves existing timeout, cancellation, usage, redaction, and product-result behavior through their owning contracts. The rolling context must preserve required constraints, decisions, exact continuation references, failures, pending work, untrusted-data boundaries, and complete Tool call/result pairing when the window advances.

Acceptance requires distinct internal roles to use the same mechanism, continuity across restart, bounded model input, private/shared audience isolation, and reconstruction after a correction or source revocation. Losing Provider state must not lose authoritative work. No rolling-context execution calls the Gateway compactor or waits for it to exist. Neither context policy silently discards required constraints or unresolved Tool effects.

### Window Boundary And Persistence

The exact private loop input is [InternalAgentLoopInput](20260813-internal_agent_runtime.md#runtime-input-and-ownership-boundary). Its `messages` field carries the assembled window as the existing ordered `AgentMessage` union. The former `contextManagement` field is removed without a replacement compaction field. Actor, source range, durable identity, and audience remain server-bound facts of the existing role owner, not model arguments or new loop fields.

At admission to each bounded run, that owner reconstructs one window through an exact committed input boundary. It selects a bounded recent range plus required constraints, decisions, pending work, and admitted source context. It may use an existing source-attributed summary only while its canonical range and authority remain valid. Window selection preserves order, complete Tool call/result pairing, and untrusted-source boundaries. If required material cannot fit, admission fails explicitly rather than silently dropping it.

The budget comes from the selected logical model's current physical context and known output reserve through the existing Gateway metadata/fitting owner. Count the fixed prompt, Tool definitions, and message content together. This adds no authored threshold, retained-tail option, fourth fuse, or per-role compactor. Each later Provider dispatch still satisfies that same physical bound. If appended observations cannot fit, the run returns `failed` with a safe context-boundary code; it neither silently truncates nor continues through the Gateway compactor.

The durable role owner accepts initiating input through its existing Turn/command boundary before dispatch. It persists accepted output and Tool effect evidence only through their existing owners. A transient loop result cannot commit work by itself. There is no separately persisted loop transcript or checkpoint store. Both strategies retain accepted summaries as existing context-summary Items, within their own admitted continuity boundary. The next admitted run reconstructs and replaces its window from those committed records; it never makes a failed or cancelled transient response canonical merely to retain context.

Reconstruction, each source read, and publication use current permission and output-audience checks. Cached context cannot restore revoked authority. A source change, deletion, audience change, or incompatible role configuration invalidates affected retained material before reuse. Restart reconstructs through the same exact committed boundary. Missing or contradictory input/effect evidence returns its existing typed failure or `recovery_required`; it never replays a Tool to discover whether it committed. Provider-owned continuation state is not required.

Acceptance covers reconstruction by two distinct durable role owners into the same private input shape, exact committed boundaries, complete Tool pairing, budget failure before dispatch, and a new window after committed input advances. Crash before canonical acceptance retains no invented output; crash after acceptance reconstructs it without another effect. Revocation between runs or before a later read/publication withholds affected material.

### Source-Bound Summary Items

Both internal strategies use the existing `context-summary` Item under the Thread and Item owners. The Item has completed status, bounded untrusted continuation text, an environment digest, strategy `rolling | compaction`, the producing logical model and one exact source range. The range records its first and last Item references, count, ordered canonical source digest, and dependent retrieval-evidence digest. It is derived context, not Memory, an authorization decision, executable Tool output, a second transcript, or a Provider checkpoint. No new Item kind or checkpoint store is introduced. Unknown Item kinds remain invalid; readers ignore descriptive additive fields without changing these required semantics.

The summary Item uses the shared Item UUIDv5 generator with the exact JCS name `{ "kind": "internal-context-summary", "turnId": admittedTurnId, "environmentDigest": environmentDigest, "sourceRange": sourceRange }`. These values are the exact canonical producing Turn and accepted proof fields; no text, clock or random input changes retry identity. This identity grants no summary validity or source authority.

The existing role owner creates a summary only under an admitted Turn and current source and output-audience authority. Its range is an ordered prefix of eligible committed Items before the summary, including complete Items from the producing Turn. Rolling may cover admitted continuity history; compaction covers only the current bounded run. It excludes hidden reasoning, credentials, previous summaries and unaccepted transient output. Exact Items stay retained under their original owners. The model sees the covered range and can read exact source Items on demand through the existing history Tool. Web and CLI Item projections show the covered range and continuation text.

For rolling context, admission uses complete eligible history when it fits. Under physical capacity pressure, it combines a verified prior summary with the largest whole canonical source prefix that fits an ordinary summary request. Required fresh input, fixed instructions, fixed Tool definitions and output reserve must fit too. Large retained history may require consecutive prefix batches. Each successful batch must advance the exact source boundary and reduce pending raw context. Rolling has no authored pressure threshold, retained-tail setting or summary model. Compaction instead triggers near the model threshold within its current bounded run, under the same source and budget checks.

Summary production uses the ordinary selected Provider path, capture, usage, audit and failure accounting. Rolling preserves the Turn's pinned System Prompt and Tool definitions and adds the bounded summary task as untrusted user context. Compaction uses its pinned model and fixed compaction instruction without Tools. Reject any summary response that requests Tools before a closure executes. Neither strategy executes model-requested Tools during summary production. The summary and answer share the existing model-turn, Tool-call and absolute deadline budget; reserve an ordinary answer call. A summary must preserve constraints, decisions, unresolved work, exact continuation references, failures and untrusted-data boundaries. An incomplete response or one that cannot reduce the window fails explicitly.

Before accepting or reusing a summary, assembly verifies its full source range, current canonical source digests, current dependent retrieval evidence, role environment and audience. The environment binds the admitted strategy, model and applicable policy. Within that admitted history, reconstruction uses the latest valid summary and later canonical Items in order. A missing, changed, revoked or contradictory source invalidates it. An invalid summary cannot justify truncation; if complete current eligible history cannot fit, return the safe capacity failure. A failed producer accepts no new summary and exposes its typed cause through the existing Turn failure path. Previously accepted batches remain canonical; do not claim cross-call rollback. Restart derives the last valid window from Items and source evidence without replaying any Tool or inference effect.

Existing execution records pin strategy `rolling | compaction` beside role, logical model and applicable threshold. Summary Items retain their producing model and strategy so evaluation can distinguish the methods despite their shared storage shape. V0.1.0 adds no per-call window record or strategy registry.

Acceptance includes both strategies using this same Item shape, exact range display, model/strategy attribution, bounded reconstruction within the proper continuity boundary, exact history retrieval, complete source validation, revocation, failed production without boundary advancement, shared budget exhaustion and reuse by distinct role owners. No new store, runner or checkpoint owner is introduced.

## Worker Runtime Policy

Worker native implementations remain valuable because they understand their own session tree, reasoning state, Tool representation, overflow recovery, and retained-tail semantics. OpenKit therefore does not translate Pi summaries into OpenCode checkpoints, feed a Codex opaque Provider item to another route, or require every Harness to use the OpenKit summarization prompt.

The central threshold and normalized evidence remain mandatory. For `runtime-native`, the adapter translates the resolved `compactThreshold` into the pinned runtime's supported settings and proves the observed trigger boundary with a focused test. It disables the OpenKit automatic path for that Turn and maps native start, completion, failure, tokens-before, tokens-after when available, and checkpoint identity into product-safe evidence without copying the summary.

For `openkit`, the adapter preserves the exact OpenKit Compaction Item in its private active context and submits it on the next Gateway request. It disables native automatic compaction for the same execution. An adapter that cannot preserve the item losslessly cannot claim this authority.

The historical Pi and OpenCode pins examined under External Evidence And Deliberate Compatibility Boundary had usable native compaction but no first-class generic Responses compaction-item path. Pi's full-result extension makes a future translation adapter feasible; OpenCode requires a new native adapter or protocol path. The internal-loop slice runs inside NanoCore and does not depend on whether a worker runtime is resident, so neither the Pi nor the OpenCode worker adapter is an implementation blocker for that slice.

The historical Codex `0.153.4` fixture evidence proves only a native `compaction` request classification, not a configurable exact threshold. OpenKit does not yet project the central threshold or normalized compaction evidence. Its first conformance task must verify from the pinned runtime whether the exact threshold can be controlled: retain Codex as `runtime-native` only if that proof passes, otherwise implement and prove the OpenKit-item path before admitting a context-managed Worker package.

## Large Source Projection

Before content enters any active window, apply the [bounded source projection contract](20260703-worker_context_package.md#bounded-model-projection). File size, raw model output, context tokens, and transport bytes remain separate accounting domains. Native compaction and rolling context do not authorize full-body reinsertion or override current source/audience checks. Byte limits cannot replace model-specific token admission, including instructions, history, Tool schemas, media cost, and output reserve. A missing source or failed retrieval stays a bounded unavailable descriptor; context reconstruction never replays an effect to recover its bytes.

## Quality Control And Optimization

One fixed, versioned evaluation set governs the OpenKit compactor and every adapter's threshold projection before default rollout. The set contains long conversations, Tool-heavy loops, repeated compactions, large user messages, multilingual content, prompt-injection text, negative findings, failed attempts, exact file and resource identifiers, accepted constraints and decisions, pending gates, unresolved questions, and context-overflow recovery. Before any candidate compactor output is observed, each fixture enumerates its required continuation facts, forbidden authority promotions, Tool-call/result pairings, and bounded acceptance tolerances, making those assertions a prior and bounded deciding oracle. Any model-graded or holistic quality score is informing-only and cannot accept a rollout or optimization.

The deciding checks prove that the compacted continuation answers or acts consistently with the source on required facts, preserves Tool-call/result integrity and current user intent, does not promote untrusted instructions, does not claim unproved effects, remains below the configured threshold, and reduces context materially enough for another ordinary response. Token reduction alone is not a sufficient oracle.

Normalized measurements compare pinned internal strategy where applicable, compaction authority, runtime family, logical model, threshold, tokens before and after, compaction latency, compaction-model usage, repeated-pass count, correction rate, terminal failure, the prior fixture-assertion result, and any separately labeled informing quality score. Summary text remains excluded. These measurements permit native implementations to be compared without making their internal formats interchangeable.

The OpenKit prompt, tail policy, or implementation may be optimized behind the stable request and item contracts only after the fixed evaluation set shows no regression. A separate cheaper summary model, role-specific prompt, dynamic percentage threshold, user knob, or learned optimizer requires current evidence and a later accepted design; none exists in V1.

## Current Implementation Projection

The pending implementation requires `packages/config-schema/src/gateway.ts` to admit one authored logical-model `contextManagement` entry and `apps/nanocore/src/llm/logical-models.ts` to validate its threshold against each route's effective context limit and known output reserve, and project the resolved policy without changing model identity. Missing policy must reject the configuration snapshot; shipped configuration must supply the required field. Existing deployments must update their configuration before that snapshot becomes eligible, under the existing last-known-good configuration owner.

The Gateway exposes `POST /v1/responses`, but the pinned pi-ai Responses abstraction does not admit `context_management` or parse a compaction output item. The Codex worker hint carries the validated native request kind for the pre-output failure mapping above; a `compact` subagent classification alone is not phase evidence. This classification does not implement central compaction policy.

Internal roles use the shared loop and existing rolling-context summary Items. Unified compaction summary storage, producing-model/strategy metadata and bounded scheduled Knowledge Manager runs remain implementation work. The Gateway Responses item remains a separate wire projection; it is not the canonical Thread summary. Rolling roles do not acquire a Gateway-compactor dependency.

The current AEP version 4 has no resolved context-management field, and the Codex, Pi, and OpenCode adapters do not consume one central threshold. Existing Harness-native defaults therefore remain implementation fact, not conformance with this design.

## Implementation Order

1. Add and validate the required logical-model `contextManagement` policy, derive physical limits from the shared effective Provider metadata resolver, and expose the resolved policy without changing model identity.
2. Add the OpenKit compactor and strict Responses control and item mapping behind the existing `POST /v1/responses`; do not add a standalone route.
3. Reuse the existing context-summary Item for both internal strategies, retain producing model and strategy, and pin strategy beside role/model/threshold in existing execution records. Add bounded Knowledge Manager in-run compaction through the shared loop; preserve rolling defaults and canonical history owners.
4. Update `docs/specs/20260703-audit_usage_evidence_records.md` and its existing record producers with the normalized audit, usage, and failure projection, add the fixed evaluation evidence, then roll out the threshold only for newly admitted Gateway/Worker executions.
5. Version the AEP and add one adapter at a time, beginning by verifying whether pinned Codex exposes an exact native threshold control; do not admit that policy into a Worker package or mark a runtime conformant until its focused proof passes.

## Alternatives Considered

### Force One Summary Algorithm Into Every Harness

Rejected because the current runtimes have materially different session trees, retained-tail rules, replay behavior, extension boundaries, and failure handling. An adapter that discards those strengths would add conversion risk without improving central control.

### Keep Every Harness Policy Independent

Rejected because the same logical model could then consume different working sets depending on role or runtime, configuration changes would require editing several unrelated files, and operators could not explain or compare behavior from one Server policy.

### Copy OpenAI `encrypted_content` With Plaintext Data

Rejected because the name would assert confidentiality that does not exist. Actual authenticated encryption requires a key, scope, rotation, invalidation, and recovery design; no current consumer needs that machinery.

### Add `POST /v1/responses/compact` Immediately

Rejected for the remaining Gateway/Worker path because automatic `context_management` supports that adapter contract. Knowledge Manager uses bounded-run compaction and the common internal summary Item; rolling roles do not require this wire operation. A standalone operation becomes justified only when a real caller needs manual compaction or a canonical compacted-output array independent of ordinary inference.

### Store Gateway Conversations Or Compaction Records

Rejected because the caller, Internal Agent Loop, workflow owner, or AgentSession already owns the relevant continuity. Stateless input and output items provide the required channel without a second transcript authority.

### Pretend The Physical Model Window Is The Desired Working Set

Rejected because rewriting a one-million-token model as 400,000 tokens corrupts capability facts and can break routing, output headroom, and native Harness behavior. The configured threshold is a separate policy.

## Acceptance Predicates

- Every logical model has one validated Server-authored compaction threshold distinct from physical context and output limits; each configured model requires a known positive context limit from catalog inheritance or authored Provider metadata while output limits remain optional. Every authored route's known physical window bounds the threshold, including the output reserve when known; known unavailable-sibling limits still constrain it. An absent profile or delisted model stays unavailable, and restored supply must pass validation before selection.
- A one-million-token model configured with `compactThreshold: 400000` remains physically identified as one million tokens while all new executions resolving that logical model receive the 400,000-token policy.
- `POST /v1/responses` accepts or injects exactly one `{ type: "compaction", compact_threshold }` control for OpenKit authority and rejects a mismatch before Provider dispatch.
- The OpenKit compactor emits `{ type: "compaction", id, summary }`, applies it as low-authority continuation context, and never labels plaintext as `encrypted_content`.
- The Gateway stores no conversation or compaction record, and a stateless caller can continue by retaining the latest compaction item and later output.
- Each Worker Turn selects exactly one of `openkit` or `runtime-native`, and a focused check proves that the unselected path performs zero compaction work.
- Every model-using internal role uses the shared loop. Assistant and Goal/Workflow Coordinator default to rolling context; Knowledge Manager uses bounded-run compaction. A future Evaluator uses compaction only after admission. No separate Provider loop or rolling-role Gateway-compactor dependency is introduced.
- Both internal strategies store the existing context-summary Item with exact committed source range, strategy and producing model. Existing execution records pin strategy beside role/model/threshold for evaluation; no per-call window record, Item kind or checkpoint store is added.
- Reconstruction validates the latest summary and later canonical Items. Rolling may span admitted continuity history; compaction stays inside the current bounded run. A new Knowledge Manager Turn starts fresh, and restart never resumes or replays a failed run.
- A compaction pass preserves required constraints, decisions, Tool pairing, failures, exact continuation identifiers, pending work, and untrusted-data boundaries under the fixed evaluation set.
- Missing, invalid, stale, oversized, aborted, failed, unknown, overflow, repeated-compaction, configuration-reload, and process-restart cases produce the exact bounded behavior defined above without silent truncation or duplicate effects.
- Mixed-tier failover preserves the logical ID and pinned null family. Same-member attribution preserves opaque reasoning; another member, missing or conflicting attribution, eviction, external history, and restart use readable-text handoff without forwarding foreign capsules or adding a response field. The payload-free association stays within its fixed entry ceiling under sustained traffic, and eviction produces readable-text handoff rather than an error.
- Private evidence preserves source traceability, threshold, token, version, usage, and terminal outcome without copying summary text or Provider-private data into public or durable diagnostic surfaces.
- Codex, Pi, and OpenCode retain their native algorithms until an accepted adapter proves central threshold projection or exact OpenKit-item translation; no native checkpoint is treated as portable across runtimes.

## Deferred Work

- A public or internal `POST /v1/responses/compact` route.
- Provider-native `compaction_trigger` input and any delegation of compaction authority to a Provider-native Responses mechanism.
- Authenticated encryption and an `encrypted_content`-style opaque OpenKit capsule.
- Cross-deployment, cross-account, cross-logical-model, or cross-runtime compaction-item portability.
- Per-role, per-Agent, per-Workspace, per-User, per-request, percentage, adaptive, or cost-based threshold overrides.
- A separate compaction model, configurable compaction prompt, configurable retained-tail target, strategy registry, plugin hook, or learned optimizer.
- Manual editing of canonical summary Items or raw Gateway/Worker summary inspection beyond existing authorized Item projections.

## Open Questions

None.
