---
status: Draft
implementation: Partial
kind: boundary
aspect: architecture
---
# Compute Neutrality Target

This document records the proposed placement mapping and the accepted v0.2.0 backend qualification and scoped release contract.

The [neutrality decision](../decisions/20261020-compute_and_harness_neutrality.md), [Architecture](../core/architecture.md#compute-and-harness-neutrality) and [Product Vision](../product-vision.md) own the principles. Existing specifications retain execution, continuity, evidence and transport authority. This Draft introduces no protocol, retained format or lifecycle state.

## Scope

Owns placement and carriage mapping, backend capability qualification, and the scoped evidence required for release.

Does not own execution. [Worker Runtime Communication](20260629-worker_runtime_communication_model.md) owns the execution port.

Does not own native continuation. [AgentSession Continuity](20260704-agent_session_continuity.md) owns it.

Does not own retained provenance. [Work Data Retention](20260921-work_data_retention_format.md) owns it.

Core: [Architecture](../core/architecture.md).

## Placement And Carriage Mapping

Both an OpenKit Worker on admitted compute and an external harness map onto the existing [Execution Backend Port](20260629-worker_runtime_communication_model.md#execution-backend-port). The scheduler retains one attempt when the harness and its executor occupy different platforms. Their native identities remain distinct.

| Existing operation | OpenKit Worker on a placement | External harness API |
| --- | --- | --- |
| `submit` | Prepare or connect compute, deliver admitted supply, authenticate the Worker and start the admitted Turn. | Create or reuse the exact provider session, attach an executor when required and submit correlated input. |
| `inspect` | Observe the original allocation and Worker receipts separately. | Retrieve the original session, operation and available Items after stream loss. |
| `cancel` | Revoke authority, stop or fence the exact work and settle preparation races. | Revoke authority and request cancellation; retain pending or unknown when physical stop is unproved. |
| `release` | Collect required data, close routes and report proved quiescence or absence, pending or unknown. | Collect required data and settle harness and executor cleanup separately; session deletion alone is insufficient. |

Preparation stays inside the adapter. Inspection never creates, resumes or renews work, and never resends unknown input. A connect operation that extends provider lifetime is effectful.

The proposed placement vocabulary covers create, connect, metadata listing, timeout and kill. Each adapter declares its supported subset and evidence. Optional pause/resume supplies no generic process-continuity guarantee.

| Realization | Proposed mapping |
| --- | --- |
| NanoHost | Preserve existing resource control, image identity, storage attachment, exact receipts, fencing and complete-domain absence evidence. Keep inference/MCP relay where required by the deployment. |
| E2B | Map the supported placement operations and declared persistence to its API. Keep allocation evidence separate from Worker receipts. |
| Cloudflare Container | Use the deployed Worker/Durable Object endpoint for allocation and inspection. Reconcile exact known identities; do not assume global metadata listing. |
| Agents API | Use its session/Turn API for an external harness, with a hosted or separately placed executor where required. |
| Cloudflare Pi Durable | Treat the durable harness and any Container tool executor as separate native bindings under one attempt. |

The proposed Worker carriage is outbound authenticated control, inference and capability traffic to Core, including for NanoHost placement. Remote admission requires reachable authenticated Core ingress and the existing Workspace, AgentSession, attempt and Turn bindings.

Desktop Core remains loopback-only. Endpoint and authentication changes belong to the [control owner](20260703-worker_control_protocol.md#authentication) and [identity owner](20260628-nanocore_config_identity_contract.md#current-contract). External harnesses use their native APIs; callbacks still require the actual admitted Turn and operation.

## Backend Qualification And Scoped Release

Use one kernel admission, attempt, input receipt, deadline and scoped hold across NanoHost, the OpenAI Agents API and E2B mock. Retain only common deciding facts in the kernel. Adapter code or configuration declares actual capabilities. The adapter retains native handles and raw inspection evidence. Revoke every grant issued for the original attempt, including hosted Turns that need no Worker token. Match evidence to its original operation and scope.

Before kernel freeze, probe actual Agents API behavior in development. Record the pinned interface and exact native session, Turn and input observations with a withheld input acknowledgement. Distinguish intake from processing read-back. Check which Turn a cancellation targets and which writers its evidence can fence. Model lost create before ID, paused or late allocation and command versus input acknowledgement through disposable E2B mocks without an account or live calls. Map each case to the common contract. An unsupported guarantee is unknown and prevents enabling that capability. If no honest representation exists, resolve the kernel shape before freeze.

At reinstall, NanoHost alone serves execution. Its exact-build golden path returns a verified nonce file and transcript, reads them back after restart or lost ACK, and proves revocation and release. Before external adapter enablement, qualify lost create/input/final acknowledgements, exact original Turn and saved Items, equal-text separate steers, native state loss, input racing session-current cancel, verified file/transcript return and cleanup. E2B remains mock-only. Other platforms and a north-bound Agents-compatible API retain their separate admission owners.

Definite nonacceptance without outstanding effects permits eligible requeue. Otherwise enter closing, revoke scoped credentials and inspect the original operation. Preserve the first cause. Successful release needs terminal handoff, required output and evidence, outside-Workspace collection, integration drain, route revocation and a fence covering applicable publishers, volumes, native sessions, Tools, delayed starts and paid resources. A lifetime bound applies only to its documented writer domain after the last possible start including renewal or resume. Hold affected dispatch if that bound is unproved. Kill ACK, list miss, clock jump or reconnect cannot prove termination. An authorized administrator may waive enumerated handoffs only for fenced scopes. Keep surviving exclusions on the original execution and enforce them at claim and placement. Independent work can proceed on a proved-disjoint destination after predecessor publishers are fenced. Track remaining remote cleanup independently.

## Pre-Freeze Dispositions

R1–R4 identify the retained-meaning questions reviewed before the freeze; resolution does not qualify an external adapter.

| Question | Disposition and owner |
| --- | --- |
| R1 — resolved launch package | Resolved: [Agent Environment Package](20260616-agent_environment_package.md#definition-and-exclusions) confines NanoHost image, command, Shim and local-route meanings to NanoHost. External forms remain additive. |
| R2 — native continuation | Resolved: [AgentSession Continuity](20260704-agent_session_continuity.md#persistent-data-is-separate-from-native-continuity) separates the native owner from executor placement and preserves current locator/digest meanings. |
| R3 — receipt and release evidence | Use the [qualification and scoped release contract](#backend-qualification-and-scoped-release) and its [durable step carriage](20261019-durable_execution_and_control_store.md#retained-kernel-step-carriage). Qualification is per capability. |
| R4 — harness identity and provenance | Resolved: [Work Data Retention](20260921-work_data_retention_format.md) identifies retained NanoHost image grouping separately from external harness identity and preserves explicit provenance and capture gaps. |

For R3, the proposed qualification distinguishes actual receiver receipts, scoped provider observations and unknown outcomes through existing evidence references. An empty list, kill acknowledgement or disconnected client supplies no complete-domain absence proof. Unknown preserves conflicting-writer exclusion; later inspection cannot rewrite the original outcome.

## Validation Status

The paper mechanism-by-platform matrix remains design evidence, not Provider qualification. Main has executed receipts for all five adopted fake cases in the existing Worker-governance owner tests. Lost-submit inspection returns null, not an empty list. Provider-mutation retry proves receiver-owned image settlement, not permission to replay an arbitrary mutation. The stale-Tool-call case also passes on main.

In the withheld-native-transcript case, the fake backend withholds a manifest-declared native stream while immutable capture is on. The real collection owner retains failed transcript-collection evidence and a quarantined raw bundle, publishes no normalized index or withheld-body reference, and fails the Turn. This does not resolve the earlier measured-identity probe.

In the executor-replacement case, two disposable fake executors share one backend-owned native conversation. Successor preparation, native storage binding and admission commit carry its exact locator and digest into a fresh Turn, package, attempt, deadline and route tokens. A predecessor token cannot authenticate the successor lineage. Transcript collection never reconstructs the native session. This component proof extends the existing fake without adding an executor-replacement capability, harness or retained format. Neither case qualifies a real external adapter.

The five adopted cases are:

- Lose a submit reply, return null inspection, acknowledge kill, and allow a late create. Expect unknown or closing, no replay of the original submission, and healthy work on another Thread.
- Preserve an external native session across executor replacement. Expect the preserved locator and digest, fresh authority, and no transcript reconstruction.
- Withhold the native transcript. Expect incomplete collection, a quarantined raw bundle, and no complete success. This is not a measured-identity probe.
- Send a stale Tool call after a new Turn. Expect the current Turn to refuse it before a deeper operation check. The refusal does not undo an external effect.
- Retry a provider mutation. Expect the receiver to return the prior result for the same input and to conflict on a changed digest.

Use the existing owner tests and fake backend. Add no test harness. Real remote list, kill, and late-create qualification remains with the durable-execution owner. Real-platform validation remains separately authorized.

## Implementation

- `apps/nanocore/src/runtime/`

## Implementation Gaps

- Cross-backend proof and scoped fencing - Real development Agents API shape probes, E2B mock qualification, and the exact storage candidate NanoHost run remain to be proved - #156, #947

## Decisions

- [Control Kernel And Service Storage](../decisions/20261120-control_kernel_and_service_storage.md)

- [Compute and harness neutrality](../decisions/20261020-compute_and_harness_neutrality.md)
