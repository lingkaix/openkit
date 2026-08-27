---
status: Draft
implementation: Not Started
date: "2026-07-31"
---
# Operational Telemetry Standardization

## Owns

- The non-authoritative operational telemetry projection for OpenKit runtime and repository-test execution.
- Adoption of stock OpenTelemetry signals, OTLP transport, W3C Trace Context, applicable OpenTelemetry Semantic Conventions, and JUnit-compatible test-result interchange.
- Correlation from existing OpenKit execution identities into traces and logs without creating another product record.
- Telemetry topology, enablement, redaction, bounded buffering, exporter failure, shutdown, and test-environment behavior.

## Does Not Own

- Which product, runtime, provider, storage, or test boundary must produce evidence; those obligations remain with their existing Core and specification owners.
- `AuditEvent`, `CapabilityCall`, `UsageRecord`, `PermissionDecision`, `VaultUse`, `EvidenceBundle`, `RuntimeEvidence`, Thread, Turn, Item, Artifact, or any other canonical record semantics.
- Product analytics, user-behavior tracking, billing, compliance reporting, SLO policy, alert policy, or a user-facing observability product.
- An observability storage backend, dashboard vendor, hosted service, or bundled Grafana, Prometheus, Loki, Tempo, Jaeger, or equivalent stack.
- A universal `Run`, event ledger, event bus, workflow, recovery mechanism, log database, test harness, or public telemetry API.
- Raw worker, provider, sandbox, or test artifact formats and their existing evidence retention.

## Core References

- `docs/core/foundation.md`
- `docs/core/architecture.md`
- `docs/core/protocol.md`
- `docs/core/audit.md`
- `docs/core/metering.md`
- `docs/core/storage.md`
- `docs/core/vault.md`
- `docs/core/contract-evolution.md`

## Related Docs

- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260721-provider_subscription_accounts.md`

## Summary

OpenKit will use OpenTelemetry as its vendor-neutral operational telemetry standard. Traces, metrics, and correlated logs are diagnostic projections over existing product and evidence owners; they are not durable product truth, acceptance authority, or a replacement for Audit, Usage, Evidence, and work history.

The initial topology is deliberately small: NanoCore emits stock OpenTelemetry signals through OTLP to an optional operator-provided Collector on the same deployment boundary. The Collector may batch, filter, retry, and export to an operator-selected backend. NanoCore remains fully functional when telemetry is disabled, the Collector is absent, or export fails.

Repository tests use the same system-under-test instrumentation and correlation semantics. Test pass or failure remains with the existing test runner and JUnit-compatible result output; large diagnostic artifacts remain in their native formats and are referenced rather than embedded in telemetry.

## Goals / Non-goals

### Goals

- Reuse an established standard for signal shape, context propagation, transport, resource identity, HTTP instrumentation, runtime measurements, and CI/CD correlation.
- Make one production or test execution queryable across process, HTTP, Gateway, provider, scheduler, and worker boundaries when those boundaries already expose the required facts.
- Preserve exact links to existing OpenKit ids without duplicating their authority.
- Keep instrumentation optional, bounded, product-safe, backend-neutral, and failure-independent from product execution.
- Use the same signal and correlation rules in local, container, test, and server deployment modes.

### Non-goals

- Do not make complete telemetry delivery a product-success predicate.
- Do not convert canonical SQLite or file records into OTLP storage.
- Do not write a second OpenKit event schema over OpenTelemetry.
- Do not record prompt text, response text, tool content, arbitrary attributes, request or response bodies, headers, credentials, private provider data, or unrestricted paths.
- Do not instrument every internal function, Item, state transition, assertion, or worker-native event.
- Do not inject an OpenTelemetry SDK into user workers, agent runtimes, or governed sandboxes in the initial implementation.
- Do not build a bundled observability backend, multi-collector topology, high-availability pipeline, disk spool, sampling control plane, or telemetry administration API.

## Terms

`Operational telemetry` means lossy, non-authoritative traces, metrics, and logs used to diagnose availability, latency, dependency behavior, and execution flow.

`Canonical record` means an existing Core-owned product, governance, usage, or evidence record whose owner decides product meaning independently of telemetry delivery.

`Instrumentation boundary` means an existing stable owner that knows an operation's identity and terminal result and may project those facts into telemetry.

`Collector` means an official unmodified OpenTelemetry Collector distribution configured by the operator to receive OTLP, apply bounded processing, and export to a selected backend.

`Native test artifact` means JUnit XML, JSON or JSONL, Playwright trace, screenshot, bounded stdout or stderr, HTTP summary, SSE transcript, Data Root snapshot, or another format already owned by the applicable test layer.

## Standards Contract

The implementation uses official unmodified releases and does not fork, patch, monkey-patch, or reimplement OpenTelemetry protocols or semantic conventions.

The standards surface is:

- OpenTelemetry Specification for trace, metric, log, resource, context, SDK, and error behavior.
- OpenTelemetry Protocol for telemetry export.
- W3C Trace Context for HTTP trace propagation where propagation is admitted by the owning trust boundary.
- OpenTelemetry Semantic Conventions for stable HTTP, process, runtime, exception, resource, and applicable CI/CD fields.
- OpenTelemetry GenAI Semantic Conventions only through an explicitly pinned opt-in version and only for product-safe provider, operation, model, streaming, terminal, and token-count fields. Content-bearing GenAI attributes are prohibited.
- JUnit-compatible XML from the existing test framework reporter for suite, case, duration, skip, and failure-result interchange.

The exact SDK, Collector, OTLP, and Semantic Convention releases are pinned in the implementation dependency lock and deployment assets for one OpenKit release. Experimental or Release Candidate conventions must be explicitly opted into at the pinned version and must not become durable product contracts. Operational telemetry is release-coupled and may change with one coordinated OpenKit release; no compatibility reader or migration is required.

## Authority And Projection Boundary

- Canonical owners commit product state without waiting for telemetry export.
- Instrumentation reads only facts already available at the producing boundary and must not query another store to infer success.
- A span, log, metric, trace id, Collector queue, or backend document never proves a product mutation, permission decision, provider call, usage quantity, cleanup, or test result.
- Existing AuditEvent, CapabilityCall, UsageRecord, EvidenceBundle, RuntimeEvidence, Turn, and test records remain authoritative even when telemetry is absent or contradictory.
- A contradiction between telemetry and a canonical record is a diagnostics defect. It must not be resolved by rewriting canonical state from telemetry.
- OpenTelemetry trace and span ids are operational correlation values and are not persisted as new authority-bearing fields in canonical records in the initial implementation.

## Deployment Topology

The accepted initial topology is:

```text
NanoCore and test processes
  -> stock OpenTelemetry SDK or stdout log bridge
  -> OTLP
  -> optional operator-provided local Collector
  -> operator-selected observability backend
```

- NanoCore depends on no vendor-specific observability SDK or exporter.
- The configured OTLP destination is a same-deployment Collector. Remote backend credentials and vendor exporters remain outside NanoCore and belong to Collector configuration.
- The Collector is optional and is not part of NanoCore readiness, product admission, backup, restore, or availability authority.
- OpenKit does not bundle an analysis backend in this specification. A later cookbook may project one operator-selected backend without changing the telemetry contract.
- Local development and deterministic tests may use an in-memory or stdout exporter supplied by the stock SDK. Production code must not branch on backend vendor.
- The initial worker boundary is instrumented from NanoCore's scheduler, worker-control, transcript, and teardown owners. No SDK, exporter credential, or Collector authority is injected into the worker or sandbox.

## Resource And Correlation Contract

Every emitted signal uses standard OpenTelemetry Resource attributes when the value exists:

- `service.name` identifies the emitting OpenKit service or test process.
- `service.version` identifies the current OpenKit release or build.
- `service.instance.id` is the NanoCore `bootId` for a NanoCore process instance and a generated process instance id for another emitter.
- `deployment.environment.name` distinguishes local, test, and server deployment posture without encoding a hostname or Data Root path.

Trace and log correlation uses standard trace id and span id fields. Existing OpenKit ids may be added as attributes only when already known at that boundary:

- `openkit.request.id`
- `openkit.workspace.id`
- `openkit.thread.id`
- `openkit.turn.id`
- `openkit.agent.session.id`
- `openkit.package.snapshot.id`
- `openkit.capability.call.id`
- `openkit.permission.decision.id`
- `openkit.evidence.bundle.id`
- `openkit.error.code`

These attributes are a projection of existing ids, not a new identity vocabulary. They must not be generated merely to populate telemetry, and they must not be copied into metric dimensions. Raw provider account ids, credential references, account-slot labels, backend session ids, process keys, host paths, and runtime-native child ids are excluded.

## Trace Contract

- A trace root represents one bounded ingress request, command, accepted Turn, scheduled trigger, or repository-test task. A trace must not span the whole NanoCore process lifetime.
- NanoCore process lifetime is grouped by `service.instance.id`; boot, readiness, and shutdown may emit bounded spans or logs linked by that resource identity.
- Stable HTTP server and client Semantic Conventions are used for admitted inbound and outbound HTTP boundaries. Route templates are used instead of cardinality-bearing raw paths where the standard allows them.
- Manual spans are added only for boundaries that automatic HTTP, process, and runtime instrumentation cannot express: provider resolution and dispatch, LLM inference, scheduler admission, worker lifecycle, transcript collection, Workspace publication, cleanup, and governed storage operations.
- One owner emits one terminal span status. Nested helpers must not emit parallel success claims for the same operation.
- Cancellation, timeout, typed degraded capability, upstream rejection, product failure, and cleanup failure remain distinct product-safe classifications.
- Internal Items, token deltas, SSE chunks, heartbeat samples, retry iterations, and worker-native frames do not each create spans. Aggregated events may be attached to the owning span only when they materially identify a terminal or last-completed phase.
- W3C trace propagation is accepted across OpenKit-owned HTTP clients and trusted internal NanoCore boundaries. Caller-supplied trace context is validated by the stock propagator and never supplies actor, authorization, request-id, Workspace, Turn, provider, or worker authority.

## Metric Contract

- The first implementation uses stock OpenTelemetry HTTP, process, runtime, SDK, and Collector metrics where supported by the pinned stable conventions.
- Metrics describe aggregate availability, latency, counts, resource use, and exporter health. They do not reproduce AuditEvent, UsageRecord, CapabilityCall, or test-result rows.
- Workspace, Thread, Turn, request, user, account, CapabilityCall, test-case, raw route, URL, error message, and evidence ids are prohibited metric dimensions.
- A custom `openkit.*` metric may be added only when an existing owning specification names a current operational question that stock metrics cannot answer and fixes a bounded low-cardinality attribute set. This Draft introduces no custom metric catalog.
- UsageRecord remains measurement authority for attributable product consumption. An OTel token or cost metric is an operational aggregate and must not be treated as billing, quota, or audit truth.

## Log Contract

- Application and test logs use the OpenTelemetry Log Data Model whether they are emitted through a stock Logs SDK or collected from structured stdout and stderr by the Collector.
- The initial JavaScript implementation may retain a structured stdout bridge while the pinned OpenTelemetry JavaScript Logs API remains non-stable. It must not invent another general log record schema.
- Logs emitted inside an active span include standard trace id and span id correlation.
- Every retained error log uses a stable error code and product-safe summary. Stack traces remain restricted diagnostics and are excluded by default from external export unless an accepted security boundary explicitly admits them.
- Console output without a retained container, process-manager, or Collector sink is transient and must not be claimed as surviving evidence.
- The presence or absence of a log line never decides a product or test outcome.

## Test And CI Contract

- The system under test emits the same production telemetry with `deployment.environment.name=test`; tests do not maintain a second instrumentation implementation.
- The existing test framework emits JUnit-compatible XML for suite, case, duration, skip, and terminal failure interchange where a machine-readable test result is required.
- CI pipeline and task execution may use the pinned OpenTelemetry CI/CD Semantic Conventions. Because those conventions are not yet Stable, their exact release is opt-in and release-coupled.
- Native test artifacts remain in their existing formats and stores. Telemetry may reference only their product-safe logical name, media type, bounded size, sensitivity class, retention class, and digest; it must not embed their raw content.
- Test runners may add test run, suite, case, and run-index correlation to test-controller telemetry. Those fields do not enter production product records or high-cardinality metrics.
- Telemetry is supplemental diagnostics, not a test oracle. A test passes or fails from its existing assertions, terminal runner result, and required native evidence even when telemetry export fails.
- A real-provider, credential, security, sandbox, data-loss, or irreversible-effect test must retain the stricter evidence required by its owning Test Strategy boundary. OTel export cannot weaken that contract.

## Data Safety

Redaction occurs before data reaches an OpenTelemetry API, SDK queue, stdout bridge, Collector, exporter, or backend. Collector-side filtering is defense in depth and never the only redaction boundary.

Telemetry must not contain:

- credentials, cookies, authorization headers, bootstrap tokens, Vault material, secret refs that reveal a storage location, or auth-source paths;
- prompt text, response text, tool content, arbitrary Item or Artifact content, source material, unrestricted transcript content, or request and response bodies;
- raw provider account ids, quota payloads, provider-private errors, prompt-cache keys, backend handles, worker process keys, runtime-native session ids, or sub-agent transcript ids;
- full URLs with query or user-info components, arbitrary HTTP headers, unrestricted environment variables, hostnames when unnecessary, or full filesystem paths;
- arbitrary exception objects, recursive payload serialization, or dynamic attribute names derived from untrusted input.

Stable route templates, provider family, model id, operation, streaming flag, HTTP status, token counts, duration, bounded outcome, stable error code, and existing opaque OpenKit ids are permitted only at the owning boundary. The implementation must configure automatic instrumentation to suppress or sanitize fields that violate this contract.

## Lifecycle, Failure, And Recovery

- Telemetry enablement is operator configuration and is resolved at process start. Dynamic telemetry reconfiguration, remote control, and a product administration surface are out of scope.
- Disabled telemetry installs a no-op provider or equivalent stock behavior. Product code must not branch around its core operation merely because telemetry is disabled.
- SDK queues are bounded in memory. Queue overflow drops telemetry, increments stock exporter or SDK failure diagnostics when available, and does not block or fail product work.
- NanoCore performs no telemetry disk spooling and writes no second telemetry ledger under Data Root.
- Collector batching, retry, filtering, and backend export are Collector responsibilities. NanoCore neither observes nor repairs Collector delivery.
- Orderly shutdown makes one bounded best-effort flush inside the existing shutdown deadline. Flush timeout or exporter failure is reported through product-safe process diagnostics when possible and must not extend the deadline, prevent lock release, or rewrite the canonical shutdown result.
- Crash, forced kill, OOM, host loss, and Collector failure may lose in-flight telemetry. Container or process supervision remains the source of exit evidence for failures that prevent in-process completion.
- Restart creates a new `service.instance.id`. It does not resume, settle, or reconstruct an earlier trace from canonical records.

## Retention, Export, And Analysis

- The operator-selected telemetry backend owns operational telemetry retention and deletion. OpenKit workspace retention, backup, export, import, and legal hold do not implicitly include external OTel data.
- Data Root backup and Workspace export do not copy Collector state, backend indexes, traces, metrics, or logs.
- Canonical records may be queried by their existing ids, and telemetry may be queried by projected copies of those ids. No correctness path depends on joining the two stores.
- The minimum analysis target is one query from a known `bootId`, request id, Turn id, CapabilityCall id, or test run to its available correlated spans and logs, with native evidence references when present.
- Dashboards, alert thresholds, SLOs, and a bundled backend remain separate future operator choices.

## Current Implementation Projection

OpenKit currently has no direct application-owned OpenTelemetry SDK, OTLP exporter, Collector configuration, trace middleware, or telemetry backend contract. `@opentelemetry/api` appears only through transitive dependencies and is not OpenKit instrumentation.

NanoCore already provides much of the source information this projection will consume: durable boot start, outcome, and orderly-shutdown rows; general server and Workspace AuditEvent recorders; CapabilityCall and UsageRecord producers; PermissionDecision and VaultUse linkage; process-local Gateway usage summaries; worker checkpoints; EvidenceBundle and RuntimeEvidence indexes; bounded runtime transcript and provenance evidence; and stable request, Workspace, Thread, Turn, AgentSession, package snapshot, and CapabilityCall identities.

NanoCore creates server and Workspace log directories, but ordinary process output currently goes mainly to stdout and stderr and has no complete application-owned retention path. Existing evidence producers and retention coverage remain partial as documented by their owning specifications. This Draft authorizes no implementation until accepted and paired with an execution plan.

## Alternatives Considered

**Create an OpenKit-wide event table and project every subsystem into it.** Rejected because it would duplicate Audit, CapabilityCall, Usage, Evidence, Turn, runtime, and test authority while creating a second lifecycle and retention owner.

**Use OpenTelemetry as durable audit or acceptance evidence.** Rejected because OTel delivery is intentionally lossy, backend retention is external, and exporter failure must not change product behavior.

**Adopt one observability vendor SDK and backend.** Rejected because OTLP and the Collector provide the required vendor-neutral boundary without placing backend credentials or release cadence inside NanoCore.

**Write a custom JSON event and logging specification.** Rejected because the OpenTelemetry data model, OTLP, W3C Trace Context, Semantic Conventions, and JUnit-compatible reporters already cover transport and general interpretation. OpenKit adds only projections of existing domain ids and stable error codes.

**Instrument every worker and agent runtime with OTel.** Rejected for the initial implementation because it would add dependencies and outbound authority inside governed sandboxes while duplicating the existing worker-control, transcript, provenance, and RuntimeEvidence boundaries.

**Bundle a complete local observability stack.** Rejected because the current single-server deployment needs a standard export seam, not another product, storage system, or supported cluster.

## Rollout / Migration Plan

1. Accept the evidence-completeness obligations in their existing owning specifications before relying on telemetry to project them.
2. Pin official stock OpenTelemetry SDK, OTLP, and Semantic Convention releases through the normal dependency procedure.
3. Add process Resource identity, no-op disabled behavior, redaction guards, stable HTTP instrumentation, and bounded export to a local Collector.
4. Add only the manual spans needed at already accepted Gateway, provider, scheduler, worker, storage, and cleanup boundaries.
5. Correlate structured stdout or stderr with active spans and add the existing framework's JUnit-compatible reporter plus pinned CI/CD telemetry where used.
6. Add one optional Collector deployment or cookbook projection only after an operator-selected backend is named; do not bundle an analysis backend.

There is no compatibility requirement. No product data migration, telemetry backfill, old log import, dual telemetry format, or legacy reader is permitted.

## Testing Strategy / Acceptance Criteria

- A deterministic test exporter proves Resource identity, trace parentage, terminal status, stable error code, and existing OpenKit id projection without a network service.
- HTTP tests prove stable route-template instrumentation, status and cancellation behavior, and absence of body, header, query, credential, and unrestricted path attributes.
- Gateway and provider tests prove product-safe provider, model, operation, streaming, terminal, duration, and usage projection without prompt, response, quota payload, account, credential, cache-key, or provider-private data.
- Worker tests prove that NanoCore-owned scheduler, worker, transcript, publication, and teardown boundaries correlate without injecting an SDK or exporter into the worker.
- Metrics tests reject high-cardinality OpenKit ids and dynamic route, URL, error-message, user, account, Workspace, Thread, Turn, request, and test-case dimensions.
- Failure tests prove disabled telemetry, Collector refusal, exporter timeout, queue overflow, and shutdown flush failure do not alter product status, canonical records, cleanup, or process deadline behavior.
- Redaction tests inject canary credentials, authorization headers, prompts, outputs, provider errors, paths, environment values, account ids, and cache keys and prove absence from spans, metrics, logs, and exported OTLP payloads.
- Test integration proves one existing deterministic test emits JUnit-compatible results and correlated system telemetry while retaining native artifacts separately.
- One container integration proves NanoCore can export to a stock local Collector and that Collector absence or termination leaves product health and request behavior unchanged.
- Repository guards prove no telemetry storage table, Data Root spool, public telemetry route, vendor SDK, worker SDK injection, compatibility format, or second event schema was added.

Acceptance requires all of the following:

- Operational telemetry uses stock OpenTelemetry and OTLP contracts rather than an OpenKit event or transport schema.
- Canonical OpenKit records remain the sole product, governance, usage, evidence, and test authorities.
- A known process, request, Turn, CapabilityCall, or test execution can locate its available correlated traces and logs through existing ids.
- Product and test outcomes are unchanged when telemetry is disabled, dropped, unavailable, delayed, or contradictory.
- Sensitive and unrestricted content is absent before export.
- Metrics remain bounded by low-cardinality dimensions.
- No SDK or exporter authority enters the governed worker or sandbox in the initial implementation.
- No bundled backend, persistent spool, new runner, event bus, public API, or recovery workflow exists.

## Risks & Mitigations

- Risk: Automatic instrumentation captures URLs, headers, exceptions, or GenAI content that violates OpenKit boundaries. Mitigation: source-side allowlisting and sanitizer tests precede exporter activation; Collector filtering is defense in depth only.
- Risk: High-cardinality ids make metrics expensive. Mitigation: keep execution ids in traces and logs and mechanically reject them from metric dimensions.
- Risk: Operators mistake OTel data for durable proof. Mitigation: mark the entire projection non-authoritative and keep existing product and test queries as the only acceptance owners.
- Risk: Exporter backpressure affects NanoCore latency or shutdown. Mitigation: bounded asynchronous queues, no disk spool, best-effort flush inside the existing deadline, and product-independent failure tests.
- Risk: Experimental GenAI or CI/CD conventions drift. Mitigation: explicit opt-in, exact release pinning, same-release coordinated upgrades, and no durable dependency on their fields.
- Risk: A bundled observability stack becomes a second product. Mitigation: ship only the OTLP seam and, when needed, one optional operator cookbook without backend ownership.

## Open Questions

None for the architecture boundary. Exact package versions, Collector distribution, and the first operator-selected backend are implementation and deployment-plan choices constrained by this specification and the normal dependency procedure.

## Deferred / Future Work

- Product-visible diagnostic views or links after repeated operator use proves a need beyond backend queries.
- Custom low-cardinality OpenKit metrics after an owning specification states one measured operational question not answered by stock metrics.
- OpenTelemetry inside trusted worker components after the current NanoCore-owned boundary proves insufficient and an accepted trust design authorizes it.
- Remote Collector authentication or direct OTLP export after a deployment model requires it; the initial same-deployment Collector keeps vendor credentials outside NanoCore.
- Tail sampling, multi-collector routing, long-term local storage, telemetry legal hold, and multi-server correlation after the deployment baseline changes.

## External Standards

- [OpenTelemetry Specification](https://opentelemetry.io/docs/specs/otel/)
- [OpenTelemetry Protocol](https://opentelemetry.io/docs/specs/otlp/)
- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
