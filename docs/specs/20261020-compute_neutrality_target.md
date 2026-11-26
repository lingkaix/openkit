---
status: Draft
implementation: Partial
kind: boundary
aspect: architecture
---
# Compute Neutrality Target

This document records the proposed placement mapping and the accepted v0.2.0 backend qualification and scoped release contract.

This specification also owns the execution backend port and environment provider contract. [Architecture](../core/architecture.md#compute-and-harness-neutrality) owns the neutrality principles.

## Scope

Owns the kernel-facing attempt operations, the environment provider operations and their proof, backend capability qualification, and the scoped evidence required for release.

[Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md) owns the Worker Shim and transport. [AgentSession Continuity](20260704-agent_session_continuity.md) owns native continuation. [Work Data Retention](20260921-work_data_retention_format.md) owns retained provenance.

Core: [Architecture](../core/architecture.md) and [Runtime Model](../core/runtime-model.md#environment-provider-and-worker-shim).

## Execution Backend Port

The backend uses the original attempt, backend, binding, input and operation correlation. Core owns admission, authority, product settlement and eligibility for release. The backend owns its native operation evidence and maps the original attempt to its execution mechanism.

| Operation | Contract |
| --- | --- |
| `submit` | Use the original grant, finalized input, absolute deadline and applicable credential bindings. Return correlated acceptance, refusal or unknown, with applicable credential receipts. Transport acknowledgement or launch alone leaves input acceptance unproved. |
| `inspect` | Read the original operation and report the retained disposition, progress and any outcome or fence evidence. A missing result stays held pending proof of non-commit. Inspection leaves execution and provider lifetime unchanged and never resends input. |
| `cancel` | After the durable Core fence, target the original attempt and report stop or interrupt progress or unknown. A cancellation acknowledgement leaves physical release pending proof. |
| `release` | Use the original correlation and required terminal, output, evidence, outside-Workspace collection, integration drain and route-revocation handoffs. Return pending, released or unknown with any applicable scoped fence evidence. Core checks which claims the proof covers. |

Preparation stays in the backend. A connection that extends provider lifetime is an effect. Existing capacity refusal remains a side-effect-free admission check, Login support a capability lookup, and credential replacement and revocation Vault and edge operations.

A provider-native agent loop implements this port directly. If the harness and its executor occupy different platforms, keep one scheduler attempt and distinct native identities. Correlate native callbacks to the admitted Turn and original operation. The backend accounts for harness and executor cleanup separately. Worker identity, shim reconnect and Sandbox drain apply where the environment uses those contracts. A bare-metal environment may have no outside stop unit if it lacks out-of-band control. In that case exclusion stays held pending proof.

## Environment Provider Contract

The environment provider acts outside the Sandbox. The NanoHost backend supplies Core's full desired set to the provider on the current Host session. The provider refuses superseded desired sets from that session and sets from an old session. Core decides placement and keeps its claims. Bind readiness to the enrolled Host, the deployment and the current connection generation. Stamp the originating Host epoch on the claim and settle it only by evidence that covers that predecessor. The provider owns its runtime calls and physical read-back.

| Operation | Contract |
| --- | --- |
| Keep present | Converge on the ordered Sandbox incarnation for the current desired set. Use its template, envelope and Volume writer generation. Readiness reports the actual incarnation and Host epoch, realized attachment and envelope, and incarnation-bound shim session carrier. Refusal or unknown leaves readiness unproved. |
| Keep absent | Use the same incarnation in the current desired set after Core fences it. Close the carrier as part of keeping it absent. Return pending, unknown or authoritative absence with proof kind and scope. |
| Report inventory | Report the full observed incarnation set and readiness for the current epoch and connection, with qualified absence or fresh-empty evidence when available. An incomplete inventory leaves absence unproved. Core can use current inventory as a placement hint. |

The provider declares absence proof as exact inside the epoch or by epoch renewal only. Same-epoch absence requires closed ingress, joined accepted work and observation by the owner of the stop unit. A missing list entry counts only when observations qualify for that proof. After renewal, fresh-empty readiness proves release only after the predecessor domain has ended. [Fault Tolerance](../core/fault-tolerance.md#release-by-proof) owns the release rule. [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) owns the NanoHost evidence.

Sleep leaves the stable Sandbox and its Volume after keep absent. Wake uses keep present with a fresh incarnation and fresh authority. [Sandbox](../core/sandbox.md#sleep-and-wake) owns continuity. For a version refusal, follow the [peer-specific exit](../core/fault-tolerance.md#exit-of-every-hold).

## Placement And Carriage Mapping

| Realization | Mapping |
| --- | --- |
| NanoHost | The container provider owns OpenShell operations, the edge, Volume attachment, and the Host relay. The Worker Shim pulls over the authenticated Host relay. |
| E2B | Proposed. Map the supported placement operations and declared persistence to its API. Keep allocation evidence separate from Worker receipts. |
| Cloudflare Container | Proposed. Use the deployed Worker/Durable Object endpoint for allocation and inspection. Reconcile exact known identities. |
| Agents API | Proposed. Use its session and Turn API for an external harness, with a hosted or separately placed executor where required. |
| Cloudflare Pi Durable | Proposed. Treat the durable harness and any Container tool executor as separate native bindings under one attempt. |

The shim pulls over one authenticated session. A future VM or bare-metal placement may carry it over a direct outbound connection to reachable authenticated Core ingress. Desktop Core remains loopback-only. Endpoint and authentication changes belong to the [control owner](20260703-worker_control_protocol.md#authentication) and [identity owner](20260628-nanocore_config_identity_contract.md#current-contract).

## Backend Qualification And Scoped Release

Use one kernel admission, attempt, input receipt, deadline and scoped hold across NanoHost, the OpenAI Agents API and E2B mock. Retain only common deciding facts in the kernel. Use the existing capability declarations and include the provider absence proof where the backend uses that contract. The adapter retains native handles and raw inspection evidence. Revoke every grant issued for the original attempt, including hosted Turns that need no Worker token. Match evidence to its original operation and scope.

Before kernel freeze, probe actual Agents API behavior in development. Record the pinned interface and exact native session, Turn and input observations with a withheld input acknowledgement. Distinguish intake from processing read-back. Check which Turn a cancellation targets and which writers its evidence can fence. Model lost create before ID, paused or late allocation and command versus input acknowledgement through disposable E2B mocks without an account or live calls. Map each case to the common contract. An unsupported guarantee is unknown and prevents enabling that capability. If no honest representation exists, resolve the kernel shape before freeze.

At reinstall, NanoHost alone serves execution. Its exact-build golden path returns a verified nonce file and transcript, reads them back after restart or lost ACK, and proves revocation and release. Before external adapter enablement, qualify lost create/input/final acknowledgements, exact original Turn and saved Items, equal-text separate steers, native state loss, input racing session-current cancel, verified file/transcript return and cleanup. E2B remains mock-only. Other platforms and a north-bound Agents-compatible API retain their separate admission owners.

Definite nonacceptance without outstanding effects permits eligible requeue. Otherwise enter closing, revoke scoped credentials and inspect the original operation. Preserve the first cause. Successful release needs terminal handoff, required output and evidence, outside-Workspace collection, integration drain, route revocation and a fence covering applicable publishers, volumes, native sessions, Tools, delayed starts and paid resources. A lifetime bound applies only to its documented writer domain after the last possible start including renewal or resume. Hold affected dispatch if that bound is unproved. A kill acknowledgement, an unqualified list miss, a clock jump or a reconnect leaves termination unproved. An authorized administrator may waive enumerated handoffs only for fenced scopes. Keep surviving exclusions on the original execution and enforce them at claim and placement. Independent work can proceed on a proved-disjoint destination after predecessor publishers are fenced. Track remaining remote cleanup independently.

## Pre-Freeze Dispositions

R1–R4 identify the retained-meaning questions reviewed before the freeze; resolution does not qualify an external adapter.

| Question | Disposition and owner |
| --- | --- |
| R1 — resolved launch package | Resolved: [Agent Environment Package](20260616-agent_environment_package.md#definition-and-exclusions) confines NanoHost image, command, Shim and local-route meanings to NanoHost. External forms remain additive. |
| R2 — native continuation | Resolved: [AgentSession Continuity](20260704-agent_session_continuity.md#persistent-data-is-separate-from-native-continuity) separates the native owner from executor placement and preserves current locator/digest meanings. |
| R3 — receipt and release evidence | Use the [qualification and scoped release contract](#backend-qualification-and-scoped-release) and its [durable step carriage](20261019-durable_execution_and_control_store.md#retained-kernel-step-carriage). Qualification is per capability. |
| R4 — harness identity and provenance | Resolved: [Work Data Retention](20260921-work_data_retention_format.md) identifies retained NanoHost image grouping separately from external harness identity and preserves explicit provenance and capture gaps. |

For R3, the proposed qualification distinguishes actual receiver receipts, scoped provider observations and unknown outcomes through existing evidence references. A list miss supplies absence evidence only under the [provider proof rule](#environment-provider-contract). A kill acknowledgement or disconnected client leaves absence unproved. Unknown preserves conflicting-writer exclusion; later inspection cannot rewrite the original outcome.

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

- Environment provider contract - Incarnation-based desired state, full epoch inventory and the provider absence proof remain to qualify - #951
- Cross-backend proof and scoped fencing - Real development Agents API shape probes, E2B mock qualification, and the exact storage candidate NanoHost run remain to be proved - #156, #947

## Decisions

- [Long-Running Sandbox And Worker Layer](../decisions/20261126-long_running_sandbox_and_worker_layer.md)

- [Control Kernel And Service Storage](../decisions/20261120-control_kernel_and_service_storage.md)

- [Compute and harness neutrality](../decisions/20261020-compute_and_harness_neutrality.md)
