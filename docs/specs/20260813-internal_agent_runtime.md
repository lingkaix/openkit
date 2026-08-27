---
status: Accepted
implementation: Not Started
date: 2026-08-13
---
# Internal Agent Runtime

## Owns

This specification owns the role-agnostic bounded runtime used by NanoCore-internal model-using roles: its assembled input, transient loop algorithm, emergency fuses, typed exits, Tool execution boundary, transport-only streaming projection, prompt assembly contract, restart posture, and internal-role execution profile.

## Does Not Own

- `docs/core/agent-capability.md` owns canonical Tool identity, capability projection, exact Tool admission, per-call authorization, and final publication admission.
- `docs/core/architecture.md` owns the definitions and stable responsibilities of Core Assistant, Workflow Coordinator, Knowledge Manager, and other internal Core roles.
- `docs/core/agent-workflow.md` owns durable workflow progression, bounded worker steps, gates, decisions, evidence, retry, and closeout.
- The loop does not own or know product records, role selection, durable state, scheduling, recovery, provider configuration, capability catalogs, authorization policy, budgets, credentials, output audiences, or external-effect settlement.
- This specification does not redefine Worker Agent execution, Worker runtime continuity, Harnesses, Sandboxes, or worker capability supply.

## Core References

- `docs/core/architecture.md`
- `docs/core/agent-capability.md`
- `docs/core/agent-workflow.md`
- `docs/core/foundation.md`
- `docs/core/permissions.md`

## Summary

NanoCore uses one small bounded loop for internal roles instead of separate role runtimes. The caller assembles all role and product meaning before invocation, and the loop only performs model calls, validates and executes supplied Tools, appends bounded feedback, observes cancellation and emergency fuses, and returns one typed runtime outcome.

The loop is expressible without importing or understanding Thread, Turn, Goal, Workspace, Worker, AgentSession, or any other product concept. Internal roles remain Core-local assemblies over this mechanism, and every durable or consequential result remains controlled by its existing owner.

## Runtime Input And Ownership Boundary

The runtime consumes one immutable input for a bounded run:

```ts
interface InternalAgentLoopInput {
  systemPrompt: string;
  messages: readonly AgentMessage[];
  tools: readonly AgentTool[];
  model: ModelRef;
  limits: {
    maxModelTurns: number;
    maxToolCalls: number;
    deadline: string;
  };
  signal: AbortSignal;
  onTextIncrement?: (text: string) => void;
}
```

`systemPrompt`, `messages`, `tools`, `model`, `limits`, and `signal` MUST be fully assembled by trusted callers before the loop begins. The optional text-increment observer is a transport projection defined below and is not loop state or product input.

`maxModelTurns` counts provider round trips, `maxToolCalls` counts environment touches through supplied Tool closures, and `deadline` bounds wall-clock duration. These three values are the complete in-loop fuse vector.

The loop owns only its transient prompt, transcript, provider responses, Tool calls and observations, counters, abort observation, and terminal runtime outcome. Creation begins when the caller invokes the loop with an accepted input; updates are append-only within that in-memory run; termination returns exactly one typed exit; retry and recovery always occur outside the loop as a new run reconstructed by the caller.

Missing or invalid required input fails before the first provider call. Stale product facts, conflicting authority, unavailable dependencies, and authorization changes are not resolved by the loop; trusted assembly or the bound Tool owner rejects them, and the loop returns or relays the resulting bounded failure without inventing replacement state.

Acceptance requires the same loop implementation to execute different internal roles by changing only its assembled input, with no product-domain import or conditional branch.

## Emergency Fuses

The three fuses cover the three local runaway axes: provider round trips, environment touches, and wall clock. Each MUST be enforceable from loop-local state without a tokenizer, pricing table, usage ledger, durable history, or product-state inspection.

Output-token limits belong to the model request. Monetary and usage budgets belong to their existing budget and deployment owners and remain enforced at consequential calls. Repeated-work or no-progress detection belongs to the durable workflow owner that can compare separate runs. These limits MUST NOT become additional loop fuses.

Fuses are deliberately large emergency stops for ghost loops, runaway Tool use, and provider failure. They are not normal capacity targets, completion conditions, or evidence that any product operation succeeded.

Initial conversational objectives are configuration values in the internal-role execution profile: first visible text within 2 seconds at p95 for a run with no Tool call, settled output within 10 seconds at p95 with no Tool call and within 30 seconds at p95 with at most two Tool calls, and ordinary Assistant model spend roughly one order of magnitude below the smallest per-Goal budget unit. The deadline fuse MUST be at least four times the applicable settled-answer objective.

Objectives and fuse values are created or changed through the accepted execution-profile configuration rollout, never by branching runtime code or revising this design. A missed objective reports degraded performance, while a reached fuse terminates with `limit_reached`; restart selects the current accepted profile and does not inherit an exhausted counter.

Acceptance requires each fuse to terminate independently with its exact limit discriminator, while changing an objective or fuse value requires only a configuration selection change through the rollout and rollback path.

## Typed Exits

The runtime returns exactly one of four outcomes:

```ts
type InternalAgentLoopExit =
  | { kind: "quiescent"; messages: readonly AgentMessage[] }
  | {
      kind: "limit_reached";
      messages: readonly AgentMessage[];
      limit: "model_turns" | "tool_calls" | "deadline";
    }
  | { kind: "aborted"; messages: readonly AgentMessage[] }
  | { kind: "failed"; messages: readonly AgentMessage[]; code: string };
```

`quiescent` means no runnable Tool call remains after the latest model response. `limit_reached` names the fuse that ended the run. `aborted` means the caller's signal ended it. `failed` carries a stable sanitized code for provider or implementation failure.

There is no fifth `stopped` exit. Model text cannot create a runtime exit or authoritative stop flag, and an internal role that must end its owning product execution early MUST cancel through the abort signal and receive `aborted`.

Every exit terminates only the bounded runtime run. No exit proves workflow completion, command acceptance, durable mutation, publication, or external-effect settlement, and callers MUST map it through the applicable product owner.

Retry after `failed`, `aborted`, or `limit_reached` is a newly admitted run from current trusted inputs. Recovery MUST NOT reinterpret one of those exits as `quiescent` or resume hidden provider reasoning.

Acceptance requires all termination paths to produce one of these four outcomes and makes any additional exit kind or success-shaped product inference non-conformant.

## Loop Algorithm

The loop MUST perform these steps in order:

1. Initialize an in-memory transcript from the accepted messages and check abort, deadline, and positive fuse capacity.
2. Call the selected model with the assembled system prompt, transcript, and provider-visible Tool definitions, then append the complete assistant response.
3. If the provider response failed or cancellation occurred, terminate with the exact typed outcome.
4. If a truncated provider response contains any Tool call, execute none of its Tool calls; when another model round trip remains admissible, append bounded safe error results for correction, and otherwise terminate with the applicable fuse or failure.
5. For each complete Tool call in provider order, resolve the exact supplied Tool, validate its arguments against the input schema, invoke its server-bound closure, sanitize its result or error, and append the model-visible feedback.
6. Call the model again only when at least one complete runnable Tool call was processed; otherwise return `quiescent`.

The loop MUST NOT guess missing Tool arguments, execute a partial batch containing a truncated call, treat model prose as authorization, or treat a model-generated stop flag as authoritative.

Tool calls execute sequentially in the first implementation. Parallel Tool batches, in-loop asynchronous input injection, dynamic model changes, hook pipelines, provider-controlled termination hints, and exact in-progress replay are excluded until a separately accepted need owns them.

A dependency failure before an environment touch produces bounded feedback when correction is possible and a provider round trip remains; otherwise it returns `failed`. A Tool owner may return a typed denial, stale, conflict, unknown, or recovery-required result, but the loop only feeds that bounded result back and never repairs or reclassifies it.

Acceptance requires deterministic Tool-call order, zero execution for truncated or incomplete calls, schema validation before every closure invocation, and no provider call after an exit condition is observed.

## Minimal Tool Contract

The runtime Tool contract is deliberately small:

```ts
type JsonSchema = Record<string, unknown>;

interface AgentTool<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: TInput, context: ToolExecutionContext): Promise<AgentToolResult>;
}

interface ToolExecutionContext {
  callId: string;
  signal: AbortSignal;
}

interface AgentToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details?: unknown;
  isError?: boolean;
}
```

Only `name`, `description`, and `inputSchema` are eligible for provider projection. The `execute` closure, internal result `details`, authoritative command identity, actor and role bindings, credentials, policy facts, and audit data remain server-side.

`callId` provides correlation only and MUST NOT become effect authority. Model-visible `content` is a bounded observation; `details` MAY support product UI, audit, usage, or evidence through their existing owners and MUST NOT enter provider context automatically.

The generic Tool interface MUST NOT duplicate role, owner, effect class, budget class, visibility, confirmation, credential, scope, audience, or autonomy metadata already owned by Core contracts. Tool identity and admission are owned by `docs/core/agent-capability.md` rather than this runtime shape.

Tool creation and update occur in trusted server code, and a run receives a temporary immutable array. Tool termination is the end of that array's run; replacement occurs on a later safe provider request or new run. Missing Tools fail exact lookup, stale or unauthorized operations fail through their current owner, and restart reconstructs the array rather than reviving it.

Acceptance requires provider serialization to contain no field beyond the three eligible fields and requires every execution to use the supplied server closure rather than a model-selected implementation path.

## Model-Visible Results And Errors

The loop MUST turn expected invalid arguments, denials, stale state, missing accessible resources, budget boundaries, and implementation failures into concise model-visible observations when bounded correction is useful. Every observation MUST be accurate enough to choose a safe next action without claiming product success.

Model-visible results and errors MUST NOT reveal secret values, the existence of restricted resources, raw exception or stack text, host paths, provider payloads, private identifiers, policy internals, credentials, or unrestricted structured details. When explaining the exact reason would cross that boundary, the loop returns a stable sanitized code and a generic safe description.

Sanitization occurs for every Tool result before it is appended to the transcript and again at final publication through the capability owner. A sanitizer failure terminates `failed`; it MUST NOT fall back to raw content.

Acceptance requires adversarial error inputs containing every prohibited category to leave none of those values in provider-visible messages or published output, while retaining a bounded correction reason when safe.

## Streaming Transport Projection

This specification owns the boundary that streaming cannot change runtime or product semantics; the channel transport owns delivery. The loop's return value remains the final messages and one typed exit regardless of whether any increment was observed.

The optional observer receives provider text increments only. It cannot influence loop control, cannot be inspected by the model, carries no product status or progress meaning, and MAY be ignored without changing the result.

Increments are ephemeral transport state. Only finalized content is eligible to become a durable Item through its owning product boundary, while role progress uses existing Item and status projections rather than the increment observer.

Disconnect loses increments but does not cancel or settle the server-side run. Reconnection reconstructs visible state from durable history, not an increment replay; interruption finalization remains with the product lifecycle owner rather than this loop.

Acceptance requires identical final messages and exit with the observer present, absent, or disconnected, and requires no increment to become durable independently.

## Prompt Contract

Every internal-role base prompt contains exactly four semantic parts:

1. A concise role, current responsibility, and expected response form.
2. A concise authority and truthfulness boundary stating what may be relied on and what must not be claimed or decided.
3. A concise rule for Tool use, waiting, escalation, and the role-specific meaning of ending the current product execution.
4. Only stable behavioral facts that cannot be expressed more accurately by messages, Tool descriptions and schemas, or executable Core policy.

The parts need not be separate paragraphs. Tool descriptions and schemas are the primary model-facing operational documentation, and the prompt MUST NOT duplicate complete schemas, lifecycle rules, authorization policy, budget tables, recovery algorithms, or NanoCore architecture.

Trusted assembly proceeds conceptually in this deterministic order: role core, current facts from their exact owners, active Tool definitions, optional bounded cross-Tool guidance, optional progressively disclosed Skill index, bounded conversation or work messages, and provider serialization. The order does not require every layer to be concatenated into the system string, and optional layers MAY be absent.

The caller rebuilds the effective prompt and Tool definitions from current trusted inputs for every new run. An in-progress provider request remains pinned to its admitted prompt, messages, Tool definitions, model, context policy, and limits; a later safe provider request or new run receives changes.

Warm provider state is a disposable cache and never authority. Ordinary users, retrieved content, files, Skills, MCPs, plugins, and model output MUST NOT replace the internal-role prompt or widen Tool set, scope, audience, authority, budget, or autonomy.

By default the assembler excludes ambient files, repository summaries, working directory, source catalogs, Knowledge bodies, work overview, diagnostics, Worker transcripts, raw external content, global Tool or Skill catalogs, deployment topology, private runtime identities, duplicated schemas or policies, programming-specific instructions for general roles, hidden-reasoning requests, and instructions to run forever or declare success without an authoritative result.

Prompt creation and update belong to trusted role assembly and configuration. A missing or invalid required role core fails before dispatch; stale facts are refreshed from their owner for a new run; conflicting untrusted instructions remain delimited data; restart rebuilds and repins the request.

Acceptance requires stable role behavior to reconstruct without hidden provider memory, selected resource context to remain absent until an admitted Tool reads it, and prompt injection to fail to replace the role or executable policy.

## Persistence And Restart

No durable toolset snapshot, provider transcript, loop state record, or duplicate Agent harness is created. Existing owners MAY record canonical Tool IDs and implementation or schema versions or digests when explanation requires them.

After process or provider failure, NanoCore abandons the in-memory run. Recovery admits a new product execution, assembles current trusted state, and invokes a new loop run under the existing idempotent command identity and recovery contracts so accepted effects are not duplicated.

The runtime does not resume an exact hidden token stream, partial reasoning trace, or historical Tool implementation. An uncertain external effect remains unknown until its owner inspects or reconciles it; the loop MUST NOT replay it automatically.

Acceptance requires restart reconstruction without a durable loop or toolset record and no duplicate accepted effect when a prior Tool call already settled.

## Internal Role Execution Profile

Before provider dispatch, the caller resolves one configuration-owned profile containing the internal role, risk or independence requirement, provider and model, required provider capabilities, security and policy compatibility, prompt version or digest, exact Tool schema versions or digests, context cap and reserved headroom, the three fuses, conversational objectives, and an ordered compatible fallback set when fallback is permitted.

One product execution is pinned to its resolved provider, model, prompt, Tool definitions, context policy, and limits. No model, Tool schema, role instruction, or safety limit changes after dispatch begins.

Fallback is permitted only before dispatch and only to an already-approved candidate satisfying every capability, security, data-location, budget, context, role, and independence constraint. Failure after dispatch terminates with its exact typed outcome; retry or fallback is a newly admitted execution reconstructed from current durable truth.

Every material role prompt, Tool schema, model policy, or default-model change MUST pass a fixed role-relevant evaluation set before becoming the default. The set covers normal behavior, denied authority, malformed Tool input, prompt injection, result redaction, budget and context boundaries, provider failure, restart reconstruction, and duplicate-effect prevention, plus role-specific success and false-completion cases.

Release begins with the current configured default and the smallest bounded canary or internal validation population able to expose regressions. Promotion changes the configuration selection only for new executions; rollback restores the prior accepted selection for new executions and does not rewrite completed durable history.

If no compatible fallback exists, the caller exposes an honest unavailable or failed result. Independence requirements MUST NOT degrade to a disallowed provider or model family, and an incompatible warm provider context MUST be discarded.

Acceptance requires recorded profile identity sufficient for explanation, no mid-dispatch substitution, evaluation evidence before a default change, bounded rollout, and configuration-only rollback.

## Explicit Rejections And Deferred Mechanisms

The first internal Agent runtime explicitly excludes:

- a new durable activation, run, toolset, prompt, provider-transcript, or Agent-harness product entity;
- a generic `maxSteps`, token, cost, no-progress, consecutive-Tool-failure, or Goal-lifetime loop fuse;
- a fifth `stopped` exit or model-controlled authoritative stop flag;
- partial or guessed execution of truncated or incomplete Tool calls;
- parallel Tool execution, in-loop asynchronous injection, dynamic model changes, generic hooks, extension pipelines, or exact replay;
- a broad model-visible Tool catalog, opaque universal environment Tool, wildcard capability hierarchy, or generic duplicated authority taxonomy;
- arbitrary user, model, Skill, MCP, or plugin registration of internal Tools;
- automatic ambient context injection, a mandatory routing Agent, or per-message Tool admission;
- raw exceptions, unrestricted details, secrets, restricted-resource existence, provider payloads, host paths, private identifiers, or policy internals in model context;
- Worker Agents, subagents, Sandboxes, Harnesses, Worker AgentSessions, workflow progression, or product lifecycle transitions as loop primitives;
- an increment event bus, durable increment history, or control flow that depends on observed streaming increments;
- decode-time masking, logit bias, provider Tool choice, provider aliases, or Tool presence as an authorization boundary;
- provider memory, hidden reasoning, runtime-native state, or loop state as durable product truth;
- model marketplace, self-modifying prompt, automatic prompt optimizer, persistent shadow Agent, generic experimentation platform, or fallback workflow.

These exclusions have no creation, update, termination, retry, or recovery lifecycle because the excluded mechanisms do not exist. Any future admission requires a separately accepted owner and externally observable predicate; implementation convenience, catalog size guesses, or replay aspirations are insufficient.

## Acceptance Predicates

- One role-agnostic loop runs distinct internal roles from assembled inputs without importing or branching on product concepts.
- Exactly three fuses and four typed exits cover every local termination path, and none becomes product success.
- Truncated or incomplete Tool calls execute zero environment operations, while complete calls execute sequentially after schema validation.
- Provider projection contains only Tool name, description, and input schema, and bound execution and internal details stay server-side.
- Model-visible errors support bounded correction without exposing any prohibited value category.
- Streaming observation changes no final messages, exit, persistence, recovery, or product behavior.
- Prompt assembly follows the four-part contract, deterministic owner order, refresh and pinning rules, and default exclusions.
- Restart reconstructs a new run from current trusted owners without durable loop or toolset state and without duplicate accepted effects.
- One execution remains pinned to its resolved profile, uses fallback only before dispatch, and changes defaults only after evaluation through bounded rollout and configuration rollback.

## Related Docs

- `docs/specs/20260529-test_strategy.md`
