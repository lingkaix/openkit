---
status: Draft
implementation: Not Started
kind: boundary
date: "2026-10-20"
updated: "2026-10-21"
---
# Compute Neutrality Target

This Draft records the proposed placement and carriage mapping, migration order, retained-meaning dispositions and validation limits. It approves no implementation.

The [neutrality decision](../decisions/20261020-compute_and_harness_neutrality.md), [Architecture](../core/architecture.md#compute-and-harness-neutrality) and [Product Vision](../product-vision.md) own the principles. Existing specifications retain execution, continuity, evidence and transport authority. This Draft introduces no protocol, retained format or lifecycle state.

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

## Migration Order

1. Before v0.1.0, settle the retained meanings below and complete the proposed validation. External adapters and carriage changes remain outside this documentation work.
2. After v0.1.0, implement E2B placement and migrate NanoHost to the same placement contract together, including outbound Worker carriage. Preserve NanoHost's stronger evidence.
3. Then add the Agents API harness through the same execution port, including separate executor placement and provider-owned continuation.
4. Then add Cloudflare Container placement and Pi Durable harness integration as separate realizations.

Use bounded Turns and collected data across allocation limits. Pause/resume waits for the existing [snapshot boundary](../core/sandbox.md#deferred-backend-snapshot-boundary); it adds no pre-freeze suspended state.

A north-bound Agents-compatible API, universal wire compatibility and live process migration remain deferred. This target needs no new provider registry, execution ledger or reconciler.

## Pre-Freeze Dispositions

R1–R4 identify the retained-meaning questions reviewed before the freeze; resolution does not qualify an external adapter.

| Question | Disposition and owner |
| --- | --- |
| R1 — resolved launch package | Resolved: [Agent Environment Package](20260616-agent_environment_package.md#definition-and-exclusions) confines current v4 image, command, Shim and local-route meanings to NanoHost. External forms remain additive. |
| R2 — native continuation | Resolved: [AgentSession Continuity](20260704-agent_session_continuity.md#persistent-data-is-separate-from-native-continuity) separates the native owner from executor placement and preserves current locator/digest meanings. |
| R3 — receipt and release evidence | Open: the [durable-execution increment](20261019-durable_execution_and_control_store.md#physical-receipt-consumption) owns qualification of receipt retention, retry capability and effect-domain proof. This Draft does not amend its receiver requirement. |
| R4 — harness identity and provenance | Resolved: [Work Data Retention](20260921-work_data_retention_format.md) identifies retained NanoHost image grouping separately from external harness identity and preserves explicit provenance and capture gaps. |

For R3, the proposed qualification distinguishes actual receiver receipts, scoped provider observations and unknown outcomes through existing evidence references. An empty list, kill acknowledgement or disconnected client supplies no complete-domain absence proof. Unknown preserves conflicting-writer exclusion; later inspection cannot rewrite the original outcome.

## Validation Status

Only the paper mechanism-by-platform matrix has been completed. It examined retention, mediation, execution lifetime, storage, Gateway, telemetry, Knowledge and product workflows. Its conclusions are design evidence, not provider qualification.

The following fake-backend cases are proposed and have not been executed as neutrality validation:

- Lose a submit reply, return an empty list, acknowledge kill and allow a late create. Expect unknown/closing, no replay or conflicting reattachment, and healthy sibling progress.
- Preserve an external session across executor replacement. Expect exact native-owner identity and fresh authority, without transcript reconstruction.
- Withhold native transcript or measured harness identity. Expect explicit unavailable coverage; missing required data must not appear complete.
- Send a stale tool call after a new Turn. Expect current Turn and operation checks to refuse it.
- Retry a provider mutation. Expect receiver-owned deduplication or proved non-execution before replay.

On branch `q171/cases` before landing, all five cases were executed against the existing fake backend fixtures in `execution-backend-port.test.ts`, `worker-governance-turn-executor.test.ts`, `worker-transcript.test.ts`, and `nanohost-harness-records.test.ts`; each new case passed locally. No open PROD-SUSPECT or NOT EXPRESSIBLE items were recorded for this slice.

Use the existing owner tests and fake backend; add no test harness. Real-platform validation remains separately authorized and requires accounts and reachable ingress. No external run or runtime acceptance is claimed here.
