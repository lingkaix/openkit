# Worker Agent Adapter Boundary Change Plan

Type: change-plan
Status: in-progress
Date: 2026-07-16

## Intent

OpenKit will use Codex, OpenCode, and Pi to prove one small Worker Agent integration boundary.

> The real outcome is not three adapters. A fourth bounded runtime must add one authored AgentManifest, one worker-side adapter module plus its static registry entry, and one governed image definition plus its existing catalog entry without adding runtime-specific behavior to NanoCore, canonical protocols, governance, or the shared worker harness.

This change removes native-runtime assumptions from the generic launch path, reuses the existing worker supervisor, and keeps stock OpenShell as the only current governance backend.

## Inherited Audit Responsibility

This plan is WP-2 of the [OpenKit Execution Program](./202607172152230001-openkit_execution_program.md) and absorbs G03 from the [alignment audit](./202607111941330001-core_spec_implementation_alignment_audit.md). The Execution Program convergence rules bind this package.

## G03 Audit Preamble — 2026-07-18

- Scope: C04, C05, C13, C16, S20-S38, S64-S66, their current NanoCore, schema, worker-shim, OpenShell, image, and test projections, and only the adapter/AEP/image/security work frozen below; this checkpoint is review-only and authorizes no implementation.
- Authored authority: C13 and S22 own one top-level `AgentManifest` with nested behavior profiles; NanoCore resolves it through the existing `ResolvedAgentSetup` into the immutable S20 AEP, so a second runtime-oriented `AgentProfile`, hard-coded `RuntimeAgent`, global image selector, or inferred runtime is forbidden.
- Execution authority: S25 and `packages/worker-shim` own the shared supervisor and static adapter registry; S64-S66 own native command and result translation; S37 owns the only worker-control plane; the backend owns outer sandbox lifecycle; NanoCore alone validates candidate worker records and commits product truth.
- Containment authority: C16, S26-S32, and the AEP own explicit sandbox, network, credential, image, binary, lease, and cleanup facts; stock OpenShell `0.0.80` remains unmodified; S36/S38 capability and executable MCP routes remain disabled.
- Security findings: `SECURITY-GAP` hidden Codex/DeepWiki network defaults and the arbitrary public terminal-command `argv`/`cwd` issuer are frozen for deletion-first correction before adapter work; no policy framework or replacement command service is authorized.
- In-scope findings: `OWNERSHIP-CONFLICT` (C13/S20/S22/S25) covers duplicate manifest, runtime, and capability authority; `DESIGN-DEFECT` (S20/S25/S28/S64-S66) covers generic-shim handoff, the two-operation adapter, candidate records, and output bounds; `IMPLEMENTATION-DEFECT` (S20/S22/S27/S28) covers Codex-specific NanoCore command, provider, policy, credential and global-image ownership plus the mixed shim and missing images/adapters; `DOC-DRIFT` (S20/S25/S28/S64-S66) covers profile terminology, runtime-specific shims, session metadata, canonical-output wording, and false capability/MCP claims; `TEST-GAP` (S20/S25/S28/S64-S66) covers shared conformance, image, and fourth-runtime proof; `REAL-USE-GAP` (S28/S65/S66) covers unproved OpenCode and Pi images.
- Provenance disposition: S33 retains independent Codex-native verification as an explicitly separate optional security extension; the base fourth-runtime criterion does not require provenance, and WP-2 must not weaken verification or make native provenance part of the shared adapter contract.
- Out-of-scope findings: broad session snapshot/reuse deletion, the S29/S30 consolidation, and a bespoke GitHub credential helper enter the Execution Program Backlog for later review; WP-2 does not absorb them. The terminal-result replay finding was extinguished when the security blocker deleted that complete command/result surface.
- Consolidation: S21 is superseded because C13/S20/S22/S23/S25 now own every continuing setup and supply contract; S25 and S29 remain active because their shared harness and current deployment/timing contracts have no complete replacement; S30 remains unchanged in WP-2.
- Exit: declared-to-resolved-to-materialized execution, one control plane, unchanged exact lease/recovery behavior, bounded scheduler ownership, stock OpenShell enforcement, adapter isolation, truthful disabled capabilities, three landed adapters, and the fourth-runtime criterion must all hold without a replacement runtime, recovery workflow, plugin system, or test platform.

## Primary Acceptance Criterion

A hypothetical fourth bounded runtime passes architectural review when its production diff contains only:

- one authored `AgentManifest`
- one worker-side adapter module and one entry in the existing static registry
- one governed worker image definition and one entry in `containers/images.json`

The diff may include adapter-local tests, image smoke evidence, and a runtime-specific specification. It must not add a runtime enum member, native command builder, event parser, provider special case, image selector, product-state branch, governance branch, or shared-harness behavior to NanoCore or canonical protocols.

Static registry and image-catalog entries are explicit accepted bookkeeping. Dynamic loading would violate the no-plugin-framework rule and is not required to satisfy the criterion.

## Authority And Handoff

```text
AgentManifest plus selected nested profile
  -> NanoCore ResolvedAgentSetup
  -> immutable Agent Environment Package
  -> WorkerGovernanceBackend launches the governed image and generic shim
  -> shared worker supervisor selects one opaque adapter id
  -> adapter prepares one native process and collects one bounded result
  -> shared supervisor emits schema-conformant candidate records
  -> NanoCore validates and commits canonical product state
```

The AEP is the only NanoCore-to-worker launch contract. `runtime.command.argv` launches `openkit-worker-shim`; it never contains Codex, OpenCode, or Pi argv. `control.adapter.kind` identifies the generic shim and `control.adapter.targetRuntime` is the sole opaque adapter selector. `agent.runtimeKind` is descriptive and must not select code.

The shared supervisor retains AEP loading, direct worker-control readiness, heartbeat and polling, child process supervision and process-group termination, transcript sequencing, redaction, workspace capture, and terminal reporting. It must not understand native event types or own product state.

## Exact Declarative Inputs

S22 owns these authored `runtime` fields: opaque `kind`, opaque `adapter`, optional pinned `version`, governed `image.ref` with pull policy, and a non-empty list of runtime binary ids and absolute worker-local paths used for supply and policy. Nested `profiles` remain behavior selections and are not runtime records.

The authored sandbox section may declare exact network grants, credential declarations, and backend requirements. Every network binary path must match a declared runtime binary. NanoCore resolves those declarations into the AEP; a backend environment variable or built-in endpoint must not expand the effective allowlist.

The AEP carries the selected image, generic shim command, opaque adapter id, declared runtime binaries, provider/model selection, exact network and credential policy, and the existing private `extensions.openkit.turnInput`. No runtime-native argv, native event schema, or hidden endpoint belongs in NanoCore.

Launch-time capabilities come from the authored manifest intersected with adapter/image proof. Missing required support blocks launch; optional unproven support remains unadvertised. The adapter does not publish a second capability authority.

## Minimal Adapter Contract

The worker-side internal adapter has only two operations:

```text
prepare(resolved adapter input) -> native launch plan
collect(native exit and bounded output) -> normalized adapter result
```

`prepare` returns argv, safe child environment additions, and output-capture requirements. `collect` returns the final assistant content and a bounded product-safe failure classification. Shared process-group termination owns interrupt behavior for all three current runtimes.

Native stdout capture is bounded to 16 MiB and ordinary stdout/stderr diagnostic prefixes remain bounded to 16 KiB each. Overflow fails closed. OpenCode and Pi session identifiers are not retained because native continuation is outside the accepted bounded-turn contract.

Codex provenance remains adapter-local capture plus the separately owned S33 NanoCore verifier. It is not a generic adapter operation and creates no obligation for OpenCode, Pi, or a fourth runtime.

## Runtime Decisions

| Runtime | Native bounded surface | Result source | Current control |
| --- | --- | --- | --- |
| Codex | `codex exec --json --output-last-message ...` | bounded final-message file; JSONL only for optional S33 provenance | shared process-group termination |
| OpenCode | `opencode run --format json ...` | bounded JSONL final assistant extraction | shared process-group termination |
| Pi | `pi --mode json` with explicit provider/model, no session, no ambient project trust, resources, updates, or telemetry | bounded JSONL final assistant extraction | shared process-group termination |

Native server, RPC, live steering, follow-up, approvals, questions, live token projection, and session continuation are not implemented or advertised.

## Frozen Scope

In scope:

- delete hidden network expansion and the complete arbitrary terminal-command production surface before adapter work
- make authored setup and `ResolvedAgentSetup` the only adapter, image, binary, and sandbox declaration source
- replace the closed runtime type, hard-coded NanoCore agent defaults, global image selector, Codex command/provider/policy defaults, and runtime-name inference on the affected launch path
- rename the existing shim in place, preserve its shared supervisor, and extract only Codex, OpenCode, and Pi native `prepare`/`collect` logic
- add three authored manifests, three governed images, one static adapter registry, focused conformance and image tests, and one fourth-runtime fixture proof
- keep executable MCP/capability routes disabled and preserve S33 independent provenance verification

Out of scope:

- interactive or reusable native sessions, server/RPC modes, steering, follow-up, native approval UI, and live token Items
- dynamic adapter discovery, an adapter SDK, class hierarchy, dependency-injection framework, new base image, or universal runtime configuration model
- scheduler redesign, session snapshot/reuse cleanup, settlement or recovery workflows, capability/MCP execution, provider onboarding, or broad Agent catalog/Web work
- any OpenShell fork, patch, custom binary, or compatibility alias

## Execution

1. Correct the owning documents and record this preamble without production changes.
2. Add the smallest failing tests for hidden network defaults and every arbitrary terminal-command production surface, then delete the public request schema and route, gateway command shape, persistence and rebuild path, and shim executor.
3. Add focused failing contracts for opaque runtime ids, manifest-driven AEP image/binaries, the generic shim command, the two-operation adapters, bounded output, and the fourth-runtime fixture.
4. Reuse the existing supervisor, implement the static registry and three adapters, and delete Codex-specific duplicate ownership from NanoCore and the shared path.
5. Add the three manifests and three image definitions, build and smoke on A1 when local image execution is unavailable, and use no new runner.
6. Run affected-package gates during slices and the existing full repository gate only at WP-2 exit; close this plan, G03, and the Execution Program checkpoint with exact evidence.

## Verification

- Config-schema and NanoCore tests prove one manifest resolves adapter, image, binaries, network policy, and provider/model inputs into one AEP without a supported-runtime switch.
- Worker-shim tests run shared supervisor invariants once and native command/result fixtures only in each adapter.
- Security tests prove no backend-added endpoint remains and no App API schema or route, gateway method, durable command shape, rebuild path, or worker shim accepts or executes arbitrary worker commands.
- Image catalog and smoke tests prove one native runtime, the generic shim, non-root execution, pinned versions, and bounded machine-readable mode for each image.
- The fourth-runtime fixture changes no NanoCore, canonical protocol, governance, or shared-supervisor behavior.
- Existing worker-control, exact reconnect, whole-Cell recycle, workspace capture, and Codex provenance suites remain green without expanded matrices.

## Stop Rules

Stop if implementation requires a new durable record, runtime state machine, recovery owner, control plane, runner, harness package, plugin loader, adapter SDK, runtime-native schema in NanoCore/protocol, or product-state mutation from an adapter.

When a native runtime cannot satisfy the bounded contract, report it unsupported or defer it. Do not broaden the system to accommodate it.

## Progress

- 2026-07-16: The change plan and three adapter specifications were accepted under a docs-only decision.
- 2026-07-18: The bounded G03 preamble completed. S21 was superseded into C13/S20/S22/S23/S25; two security gaps and the frozen adapter/AEP/image defects are in scope; unrelated scheduler, continuity, and credential-helper findings were dispatched rather than absorbed.
- 2026-07-18: The focused adapter contract was narrowed before implementation: current adapters return no generated files, exactly one NanoCore-resolved LLM route reaches each launch, and the pinned Pi result is accepted only after its final settled lifecycle correlation. No config-artifact envelope, route selector, or fallback enters the shared harness.

### 2026-07-18: Security Blocker Closeout

- Scope: the two frozen pre-adapter security blockers only; commits `5e3e234` through `bc678d1`.
- Result: OpenShell base network policy is exactly AEP-derived; backend defaults and environment expansion are deleted; non-transient provider effects fail closed before provider, sandbox, or restore effects until the AEP can prove exact Providers v2 policy.
- Control: the public arbitrary command/result surface is deleted from schemas, routes, persistence, rebuild, Core Client, Skill, Web, gateway, and shim; `interrupt` is the sole command, and retired durable rows plus acknowledged interrupts remain inert.
- Verification: focused App API, Core Client, Skill, worker-shim, NanoCore, OpenAPI, rebuild, network, provider, typecheck, lint, build, and remnant scans passed; the final provider slice passed 131 focused tests.
- Remaining: focused manifest/AEP, generic shim, adapter, fourth-runtime, image, stock OpenShell, and A1 work in Steps 3-6.

## Implementation Summary

In progress. The G03 preamble, both deletion-first security blockers, and focused adapter-contract precision are complete; test-first manifest/AEP and generic-shim implementation is next. Adapter, image, fourth-runtime, stock OpenShell, and A1 exit evidence remain open.

## Final Verification

Pending.
