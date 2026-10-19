---
status: Accepted
implementation: Partial
kind: mechanism
date: "2026-07-31"
---
# Operational Telemetry Standardization

## Owns

- The non-authoritative operational telemetry projection for OpenKit runtime and repository-test execution.
- Adoption of stock OpenTelemetry signals, OTLP transport, W3C Trace Context, applicable OpenTelemetry Semantic Conventions, and JUnit-compatible test-result interchange.
- Correlation from existing OpenKit execution identities into traces and logs without creating another product record.
- Telemetry topology, built-in local capture, enablement, redaction, bounded buffering, exporter failure, shutdown, and test-environment behavior.
- The process sample and bounded Turn timeline on the deployment-admin diagnostics read projection; shared schemas remain in App API schemas and boot readiness stays with its owner.
- Lifecycle stage spans and one stage-duration histogram, projected from existing execution owners rather than a second execution history.

## Does Not Own

- Which product, runtime, provider, storage, or test boundary must produce evidence; those obligations remain with their existing Core and specification owners.
- `AuditEvent`, `CapabilityCall`, `UsageRecord`, `PermissionDecision`, `VaultUse`, `EvidenceBundle`, `RuntimeEvidence`, Thread, Turn, Item, Artifact, or any other canonical record semantics.
- Product analytics, user-behavior tracking, billing, compliance reporting, SLO policy, alert policy, or a user-facing observability product.
- An observability storage backend, dashboard vendor, hosted service, or bundled Grafana, Prometheus, Loki, Tempo, Jaeger, or equivalent stack.
- A universal `Run`, event ledger, event bus, workflow, recovery mechanism, log database, test harness, or public trace/log query API.
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

OpenTelemetry is the one format and toolchain for internal diagnostics, built into the product under the [engineer decision](../decisions/20261019-telemetry_as_internal_logs.md). NanoCore captures signals in a bounded local OTLP file sink by default. An operator may also export to a same-deployment Collector and an operator-selected backend. NanoHost retains its existing optional OTLP export. Product work remains functional when capture is disabled, local files are deleted, the Collector is absent, or export fails.

Repository tests use the same system-under-test instrumentation and correlation semantics. Test pass or failure remains with the existing test runner and JUnit-compatible result output; large diagnostic artifacts remain in their native formats and are referenced rather than embedded in telemetry.

## Goals / Non-goals

### Goals

- Reuse an established standard for signal shape, context propagation, transport, resource identity, HTTP instrumentation, runtime measurements, and CI/CD correlation.
- Make one production or test execution queryable across process, HTTP, Gateway, provider, scheduler, and worker boundaries when those boundaries already expose the required facts.
- Preserve exact links to existing OpenKit ids without duplicating their authority.
- Provide internal diagnostics without requiring a Collector or backend installation; keep capture bounded, product-safe, backend-neutral, disableable, and independent of product success.
- Use the same signal and correlation rules in local, container, test, and server deployment modes.

### Non-goals

- Do not make complete telemetry delivery a product-success predicate.
- Do not replace canonical SQLite or file records with lossy OTLP file storage. The execution journal's span data model remains canonical under its execution owner.
- Do not write a second OpenKit event schema over OpenTelemetry.
- Do not record prompt text, response text, tool content, arbitrary attributes, request or response bodies, headers, credentials, private provider data, or unrestricted paths.
- Do not instrument every internal function, Item, state transition, assertion, or worker-native event.
- Do not inject an OpenTelemetry SDK into user workers, agent runtimes, or governed sandboxes; #221 governs this boundary.
- Do not build a bundled observability backend, multi-collector topology, high-availability pipeline, reliable delivery spool, sampling control plane, or telemetry administration API.
- Local diagnostic files and the bounded deployment-admin Turn view are in scope. They are not a log database, durable evidence, or a public trace-query service.

### Worker Sandbox Export Boundary

The [#221 engineer ruling](../decisions/20261015-sandbox_telemetry_and_public_gateway_boundary.md) applies with the narrow [worker phase-marker amendment](../decisions/20261019-worker_reported_phase_markers.md). The worker shim, OpenKit's own code inside the Sandbox, may report only allowlisted lifecycle phase markers through the existing authenticated worker-control channel. This is not a general telemetry relay.

A marker contains exactly an enum phase name, a timestamp, and at most one optional fixed-enum outcome or stable error code. Reject unknown fields, free-form strings, unknown phase/outcome values, and error codes outside the release-defined allowlist. Existing channel authentication and the Core-owned Turn/step binding select the parent; a marker supplies no identity or authorization.

NanoCore validates the allowlist and per-Turn count/byte budgets before recording. Current defaults admit at most 64 marker inputs and 16 KiB of encoded marker payloads per Turn. Rejected or duplicate inputs also consume this diagnostic input budget. Exhaustion drops markers, never control messages or product work. Clamp timestamps into the Core-observed parent window, bounded by receipt time while the step is open. Drop duplicates after validation/clamping, and drop unbound or late markers after the owning step ends.

The shim uses a bounded queue below control-message priority. Drop markers on overflow; marker production and delivery must never delay control traffic. No new egress, OpenTelemetry SDK provider/exporter, OTLP endpoint/receiver, Collector, exporter credential, native agent-runtime telemetry relay, or content is admitted in the Sandbox.

The execution owner records accepted markers as bounded, unverified events on the owning journal step. This specification defines their projection as OpenTelemetry span events, not child spans: a point observation has no verified operation duration or independent lifecycle. Use the fixed event name `openkit.worker.phase`, the clamped timestamp, an allowlisted phase, and any admitted outcome/error code. NanoCore adds `openkit.report.origin=worker` and `openkit.report.verified=false`. Keep marker outcome/error attributes separate from the owning stage's outcome/status attributes.

Markers never change a step's status, outcome, retry, recovery, or fences, and never add histogram samples. Missing or forged markers affect diagnostics only. Journal persistence proves only that Core received an unverified report, not that the reported phase occurred.

NanoCore emits native start, run, and end stage spans from facts it already accepts: worker-control observations, the accepted start result, and final status. Unverified markers can add detail but cannot establish receipt, native start, completion, collection, or release. Further Sandbox telemetry requires #221's concrete unmet need and separately accepted egress/untrusted-content controls. Missing spans authorize no bypass. Deadline propagation remains with the execution owner; this specification adds none.

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

The exact SDK, Collector, OTLP, and Semantic Convention releases are pinned in the implementation dependency lock and deployment assets for one OpenKit release. Experimental or Release Candidate conventions must be explicitly opted into at the pinned version and must not become durable product contracts. Operational telemetry is release-coupled and may change with one coordinated OpenKit release; no compatibility reader or migration is required. This disposal rule does not apply to canonical execution-journal rows, whose owner preserves retained-data continuity.

## Authority And Projection Boundary

- Canonical owners commit product state without waiting for telemetry export.
- Instrumentation reads only facts already available at the producing boundary and must not query another store to infer success.
- An exported or local diagnostic span, log, metric, trace id, Collector queue, or backend document never proves a product mutation, permission decision, provider call, usage quantity, cleanup, or test result. A canonical journal row has authority only under its execution owner, not because it uses the span data model.
- Existing AuditEvent, CapabilityCall, UsageRecord, EvidenceBundle, RuntimeEvidence, Turn, and test records remain authoritative even when telemetry is absent or contradictory.
- A contradiction between telemetry and a canonical record is a diagnostics defect. It must not be resolved by rewriting canonical state from telemetry.
- OpenTelemetry trace and span ids are correlation values, never authorization or outcome authority. The durable execution journal is the one persistence exception: its SQLite rows retain one trace id per execution and one span id per step. No other canonical record gains trace/span fields under this specification.

## Deployment Topology

The accepted topology is:

```text
NanoCore -> stock OpenTelemetry signals -> bounded local OTLP JSONL files
                                       -> optional same-deployment Collector -> operator backend
NanoHost and test processes -> existing optional stock OTLP export -> Collector
Deployment-admin Turn view <- durable journal stages/statistics + local diagnostic spans
```

Local capture is on by default without an OTLP endpoint. `OTEL_SDK_DISABLED=true` disables local capture and external export. The endpoint controls external export only; it is not required for local capture.

- NanoCore depends on no vendor-specific observability SDK or exporter.
- The configured OTLP destination is a same-deployment Collector. Remote backend credentials and vendor exporters remain outside NanoCore and belong to Collector configuration.
- The Collector is optional and is not part of NanoCore readiness, product admission, backup, restore, or availability authority.
- OpenKit does not bundle an analysis backend in this specification. A later cookbook may project one operator-selected backend without changing the telemetry contract.
- Local development and deterministic tests may use an in-memory or stdout exporter supplied by the stock SDK. Production code must not branch on backend vendor.
- Core/NanoHost observations own worker stage spans; only bounded unverified shim markers may add span events under the Worker Sandbox Export Boundary above.

### Built-in Local Sink

NanoCore owns the sink under the server-scoped log directory in the Data Root. Each signal has separate files. Each line is one UTF-8 OTLP/JSON export request followed by a newline, without an OpenKit envelope. Use the Collector file exporter's uncompressed `format: json` shape, without custom encoding or length prefixes. The stock `otlpjsonfile` receiver must read the files unchanged.

Use stock OTLP JSON serialization rather than handwritten encoding or an OpenKit logging library. Append and rotation are bounded file operations, not a new telemetry protocol. Source-side Data Safety rules apply before serialization, local capture, and export.

Current defaults limit all active and rotated signal files together to 256 MiB and set a maximum age of seven days. These limits protect deployment disk capacity, not canonical data retention.

Rotate a segment at 16 MiB or one hour, whichever comes first; a smaller total cap also limits segment size. Remove expired or oldest segments before admitting a write that would exceed the total cap. Oversized batches are dropped, not partially written as a different format.

Operators may change the total cap and maximum age at process start with `OPENKIT_TELEMETRY_LOCAL_MAX_BYTES` and `OPENKIT_TELEMETRY_LOCAL_MAX_AGE_SECONDS`. Each value must be a positive integer. An invalid value disables local capture with a safe diagnostic, not an unbounded fallback; external export remains independent.

Prune expired segments at startup, during idle periods, and before reads. No cleanup process runs while NanoCore is stopped; expired files are never admitted to the view after restart. These are operational retention defaults, not product-data guarantees.

Only the NanoCore service identity may write the directory. Files use owner-only access; read projections apply deployment-admin authorization before opening them. Restrict operations to this directory and reject symbolic-link escapes. No client may supply a filesystem path.

Writes use a bounded asynchronous queue and never block product work on disk delivery. Queue overflow, full disk, permission errors, rotation failure, or deletion can lose telemetry.

Drop affected batches, report bounded safe process diagnostics when possible, and continue product work. No fsync acknowledgement, repair queue, write-ahead delivery state, or replay is required.

The sink is not a second ledger: it acknowledges no product fact, drives no state or recovery, and guarantees neither completeness nor retention. Operators may delete it at any time without product effect.

A read racing deletion or rotation reports partial or unavailable diagnostics. A truncated final line is ignored; it never changes canonical state.

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

### Turn Lifecycle Stages

Each accepted Turn's execution has one trace, using the execution journal's trace id, with one Turn root and lifecycle step spans. Request traces remain separate; link an initiating request when its context is available. The execution owner supplies the root and step identities; telemetry does not mint a competing lifecycle. The root covers execution through cleanup/release closeout, not only HTTP handoff or command dispatch.

| Stage | Observation emitted by the existing owner |
| --- | --- |
| Admission/queue | Accepted Turn admission and its queue wait; no root for a refused, unaccepted Turn. |
| Preparation | Resolve the current execution setup for the admitted attempt. |
| Validation | Check environment, storage, Skills, context, continuity, and capacity. |
| Materialization | Observe input publication and Sandbox/environment preparation. |
| Session open/inspect | Observe the exact session binding and accepted baseline. |
| turn.start delivery | Observe queued command delivery through accepted start result; dispatch alone does not prove receipt or start. |
| Native run | Observe accepted native start through final status or the owning failure/unknown closeout. |
| Pending request wait | Observe only the wait owned by this Turn; later resolution or a new Turn does not extend it. |
| Collection | Observe terminal evidence collection and reconciliation separately from execution. |
| Cleanup/release | Observe cleanup, fencing, and capacity release separately from product terminal status. |

Spans carry `openkit.lifecycle.stage`, `openkit.lifecycle.status`, `openkit.reporting.owner`, `openkit.stage.reached`, and `openkit.outcome.class`. A failed check adds its existing stable `openkit.failed.check.id` when known. Otherwise use the owner's known stable error code; do not invent a check or infer a cause.

Values come from release-defined allowlists, except existing opaque ids. This satisfies the obligation to name the failure and reporting owner without exception text or content. Set OpenTelemetry span status from the observed result; pending or unknown must not be marked successful.

The durable-execution owner stores its step journal as SQLite rows using the OpenTelemetry span data model: trace id, span id, parent, name, kind, start/end, status, semantic attributes, events, and links. Open steps have no end or terminal result. The execution owner defines their durable lifecycle; this specification defines only their diagnostic projection.

Every ended step's span-shaped data projects losslessly to one OTLP span. Lossless mapping is not guaranteed delivery. Emit from the owning accepted journal boundary, without another timeline schema, telemetry journal, or inferred success. Keep content outside this span-shaped data under the work-data retention owner. A lost exported span loses no canonical stage fact.

Collection failure, native failure, and release failure keep their separate observations. Telemetry never decides an outcome or triggers a retry.

Do not hold a stage open beyond its owner's closeout or manufacture stages that were not reached.

Restart preserves journal-owned execution and step correlation. The view reads those rows, including open steps; it does not reconstruct them from telemetry. Lost process-local context can leave gaps only in fine-grained diagnostic spans. Do not invent another execution root, backfill unobserved work, or create durable telemetry recovery state.

Use the explicitly opted-in GenAI conventions for `invoke_agent`, `chat`, and `execute_tool` only where the owning boundary observes those operations. Do not label queueing or cleanup as inference. Provider, model, operation, streaming, terminal, and token-count fields remain content-free; no content opt-in is admitted. The current opt-in pin is recorded in Current Implementation Projection.

### NanoHost Correlation

NanoHost uses the same optional stock SDK and OTLP export contract. Existing native command responses and result requests carry only optional W3C `traceparent` and `tracestate` headers, as specified by [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md#transport-envelope-and-worker-control-liveness). The initiating command context supplies effect parentage; an unrelated polling request does not. Local execution spans end at the observed local result, independently of result delivery or Core acceptance. Startup and member start are bounded observations; member exit is a bounded observation rather than the end of a process-lifetime span. The observed local startup result does not establish Core readiness.

A Turn-caused NanoHost effect span may carry one span link to the completed Epoch startup context. Startup normally precedes that Turn and is not its child. A known Turn can locate its caused effect spans and their available startup link; startup need not share the Turn trace id. Missing context leaves correlation unavailable and requires no reconstruction. This [accepted interpretation](../decisions/20261016-nanohost_trace_headers_and_startup_link.md) adds no durable state, body field, Sandbox telemetry or delivery authority. Existing content exclusions, bounded export and disabled-export behavior apply unchanged.

Without a Collector, NanoHost's own fine-grained spans are absent from the local sink and Turn view in this release; the Core journal still records Core-observed timing for every NanoHost call, and a NanoHost local sink remains a later option, not admitted now.

## Metric Contract

- The first implementation uses stock OpenTelemetry HTTP, process, runtime, SDK, and Collector metrics where supported by the pinned stable conventions.
- Metrics describe aggregate availability, latency, counts, resource use, and exporter health. They do not reproduce AuditEvent, UsageRecord, CapabilityCall, or test-result rows.
- Workspace, Thread, Turn, request, user, account, CapabilityCall, test-case, raw route, URL, error message, and evidence ids are prohibited metric dimensions.
- A custom `openkit.*` metric requires an owning specification to name a current operational question stock metrics cannot answer and fix bounded attributes. This owner admits exactly one below.
- UsageRecord remains measurement authority for attributable product consumption. An OTel token or cost metric is an operational aggregate and must not be treated as billing, quota, or audit truth.

### Stage-Duration Histogram

This specification owns the operational question: **What are per-stage latency P50/P95 and failure share?** Stock HTTP and runtime metrics do not separate the Turn lifecycle stages above.

The one custom metric is `openkit.turn.stage.duration`, a histogram in seconds. Record one nonnegative duration at the owning journal boundary for each ended stage with valid start/end values. Do not record a guessed duration for missing timestamps or an open stage. A repeated journal read or export must not record another sample.

Its only data-point attributes are `openkit.lifecycle.stage`, `openkit.outcome.class`, and `openkit.worker.kind`. Stage uses the table above. Outcome is `success`, `failure`, `cancelled`, `timeout`, `rejected`, `unknown`, or `degraded`. Worker kind is a release-defined Worker Harness kind, or `internal`/`unknown`; never an Agent name or operator-defined label.

Export delta histogram points for non-overlapping collection intervals. An external backend may estimate P50/P95 from compatible buckets. Exported metrics remain lossy; do not treat missing samples as complete journal coverage.

The Turn view instead computes stage P50/P95 and failure share directly from ended journal rows, not local metric files. Select rows whose end falls in the stated window; group by the same bounded attributes. Use nearest-rank quantiles of valid durations. Failure share is the combined `failure`, `timeout`, and `rejected` count divided by all ended rows in each group. Report open steps and invalid/missing durations separately, without adding them to latency samples.

Show cancellation, unknown, and degraded counts separately. An empty denominator means no data, not zero failure. State the journal window, duration sample count, ended-row count, and any pagination or retention limits. Sink loss changes neither the journal statistics nor lifecycle coverage. Exported metric counts never prove execution, usage, or success.

## Log Contract

- Application and test logs use the OpenTelemetry Log Data Model whether they are emitted through a stock Logs SDK or collected from structured stdout and stderr by the Collector.
- The initial JavaScript implementation may retain a structured stdout bridge while the pinned OpenTelemetry JavaScript Logs API remains non-stable. It must not invent another general log record schema.
- Logs emitted inside an active span include standard trace id and span id correlation.
- Every retained error log uses a stable error code and product-safe summary. Stack traces remain restricted diagnostics and are excluded by default from external export unless an accepted security boundary explicitly admits them.
- Console output without a retained container, process-manager, or Collector sink is transient and must not be claimed as surviving evidence.
- The presence or absence of a log line never decides a product or test outcome.

### Failed Internal Gateway Logical Calls

The existing internal-role Gateway logical-call closeout emits one best-effort product-safe diagnostic when the logical call fails, rather than one log per retry or route member. Its stable code is `internal_gateway_call_failed`. It carries only a fixed safe summary, a failure phase, the existing closed Gateway failure kind, an actually observed upstream HTTP status when available, and existing correlation ids already known by closeout. It creates no durable descriptive cause on CapabilityCall and no additional product record.

The failure phase is allowlisted to `pre-transport`, `transport`, `provider-response`, or `output-projection`. Local selection, admission and request-construction rejection are `pre-transport`; in particular, rejection of a Tool's `prefixItems` schema under required constrained sampling belongs to that phase even when the stock adapter was entered. An attempt handed to the adapter without affirmative local rejection or provider-response evidence is `transport`; this phase does not prove delivery. An observed upstream HTTP rejection is `provider-response`. Failure converting a returned response to the internal Agent message is `output-projection`. Local error-envelope HTTP values are not observed upstream status and must be omitted.

Correlation includes known request, Workspace, Thread, Turn and CapabilityCall ids, plus the existing logical-dispatch correlation and attempt index when a member was reached. Missing values are omitted; no id is minted or storage queried for this log. Raw exception text, stack traces, provider-private codes, schemas, Tool arguments, prompts, outputs and credentials are prohibited. Failed or absent logging leaves closeout and the existing public `provider_call_failed` / `internal_inference_failed` projection unchanged. These diagnostics have no recovery or restart lifecycle beyond the existing optional log sink.

### Worker Provider Rejection Detail

The existing `worker_inference_failed` diagnostic may include an optional request-local `providerError` with only the upstream error `type`, `code`, `param` and message. Each string is bounded to 200 characters; the message is sanitized before truncation, including removal of the selected request credential. Read only a bounded clone of an actual rejected stock HTTP response; malformed, unreadable or oversized detail leaves the observed status available. Do not retain headers, full bodies, prompts or outputs. Attempt-start clears this detail, so closeout describes only the final attempt. These fields are diagnostic evidence only and do not change routing, retries, failure classification, public error envelopes or durable records.

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

- Capture, retention settings, and optional export configuration are resolved at process start. Dynamic reconfiguration, remote control, and a telemetry configuration API are out of scope.
- Disabled telemetry installs a no-op provider or equivalent stock behavior. It disables local capture and export, not the canonical journal or its read projection. Product code must not branch around its core operation merely because telemetry is disabled.
- SDK queues are bounded in memory. Queue overflow drops telemetry, increments stock exporter or SDK failure diagnostics when available, and does not block or fail product work.
- The local sink retains only bounded disposable OTLP files. It is not an export retry spool and does not create durable product or recovery state.
- Collector batching, retry, filtering, and backend export are Collector responsibilities. NanoCore neither observes nor repairs Collector delivery.
- Orderly shutdown makes one bounded best-effort flush inside the existing shutdown deadline. Flush timeout or exporter failure is reported through product-safe process diagnostics when possible and must not extend the deadline, prevent lock release, or rewrite the canonical shutdown result.
- Crash, forced kill, OOM, host loss, and Collector failure may lose in-flight telemetry. Container or process supervision remains the source of exit evidence for failures that prevent in-process completion.
- Restart creates a new `service.instance.id`. Telemetry does not resume or settle work. The execution owner preserves its journal trace/step correlation; diagnostic exporters do not reconstruct lost HTTP/provider spans or introduce recovery state.

## Retention, Export, And Analysis

- NanoCore bounds local diagnostic retention; the operator-selected backend owns its external retention and deletion. Workspace retention, import, and legal hold do not implicitly include telemetry.
- Data Root backup and Workspace export exclude disposable local OTLP files, Collector state, and backend telemetry. Restore does not require them. Canonical journal rows remain subject to their execution/storage owner's backup, export, and continuity rules; their span shape does not make them disposable telemetry.
- Canonical records may be queried by their existing ids, and telemetry may be queried by projected copies of those ids. No correctness path depends on joining the two stores.
- The minimum analysis target is one query from a known `bootId`, request id, Turn id, CapabilityCall id, or test run to its available correlated spans and logs, with native evidence references when present.
- Dashboards, alert thresholds, SLOs, and a bundled backend remain separate future operator choices.

## Turn Timeline Read Projection

A deployment administrator may request one known Turn's lifecycle stages, diagnostic spans, and stage statistics through deployment diagnostics. An agent operating the deployment uses the same authorization; Worker credentials and ordinary Workspace membership do not grant this access. The view is read-only. Its stage facts come from canonical journal rows; diagnostic details never override them.

After authorization, read lifecycle stages from the durable journal, including open steps. Join available fine-grained HTTP/provider and other diagnostic spans from the local sink by the journal's trace id. The journal gives the complete recorded lifecycle even if every local file is lost. An open step remains open, not a guessed success or failure. Missing or unavailable journal data follows its owner's explicit failure semantics, never a fallback to the sink as authority.

Accept the Turn id and a bounded statistics/detail time window, not a query language, path, attribute expression, or export destination. Return allowlisted stage names, start/end values, status, reporting owner, failed-check id or stable error code, and trace/span correlation. Keep open steps visible without an invented end or completed duration. Show shim marker events separately as worker-reported and unverified; never present them as established lifecycle facts.

Stage aggregates come from journal queries defined above over the stated window; they are deployment stage statistics, not Turn-specific metric dimensions. The histogram remains an exported OpenTelemetry metric and is not the view's statistical source.

Current defaults limit statistics/detail windows to 24 hours, local file scans to 32 MiB, and returned diagnostic spans to 1,000 per request. Journal reads and aggregates also use bounded pages/work budgets. Page lifecycle rows through the existing read boundary without silently dropping stages or excluding open steps because they began outside the detail window. If a budget prevents completion, report explicit continuation or partial coverage, not a complete result.

Reject invalid windows and stop at scan/result limits. Report the covered journal window, sample counts, diagnostic truncation, and missing/unavailable detail. Missing files, malformed OTLP records, or lost process-local context can remove diagnostic detail, never a journal stage. Reject malformed required OTLP fields and ignore unselected additive attributes. Never expose arbitrary unknown attributes.

Use bounded parsing and an in-memory join over the existing journal read boundary. No second persistent index, query service, polling process, or analysis backend is required. Render safe fields as data, not executable markup. Reading does not initiate work, change product state, or repair execution. Journal stages and statistics remain available when capture/export is disabled.

## Persistent-Deployment Instrumentation

Existing public work, Audit, Usage, and Evidence queries remain the default acceptance evidence path. The [persistent-deployment acceptance owner](20260909-persistent_deployment_acceptance.md) and [L6 story owner](20260529-l6_story_acceptance.md) do not acquire a telemetry dependency. L6 may retain its separate run-scoped Collector file; this sink changes neither that topology nor its verdict authority.

External export uses the standard `OTEL_EXPORTER_OTLP_ENDPOINT` for a same-deployment Collector. No secret headers, arbitrary attributes, payload capture, or vendor exporter is admitted. Malformed endpoints disable export with a safe diagnostic, not product boot or valid local capture. Nonempty exporter-header environment configuration for an emitted signal disables external export, not sanitized local capture. For traces this includes `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS`. Name the unsupported variable without its value. Do not mutate process environment or depend on private SDK evaluation timing to suppress headers. Stock TLS trust and client-certificate settings remain operator transport configuration; their values and paths are never telemetry.

HTTP spans include method, matched route template, status, duration, and known request identity. Unmatched paths use a fixed unknown-route label. No body, query, header, user text, raw exception, or host path is emitted. A completed HTTP span proves only its observed boundary. Distinguish response handoff from stream completion; neither proves later asynchronous work completed.

Use a private stock provider for explicitly admitted instrumentation. Enabling capture must not enroll unrelated library instrumentation. Disabled or stopped instrumentation uses non-recording spans, not a foreign process-global exporter. Library exception and context fields cannot enter merely because a dependency uses the OpenTelemetry API.

Use bounded stock SDK queues and flush inside the existing shutdown deadline. A stock in-memory exporter proves positive and negative instrumentation paths without a network service. No backend installation is required for L6 admission.

### App Diagnostics Operational Sample

The accepted target adds to the existing deployment-admin App Diagnostics response a strict `process` projection with `observedAt` (UTC timestamp), `nodeVersion`, nonnegative `uptimeSeconds`, and `memory` containing nonnegative integer `rssBytes`, `heapUsedBytes` and `heapTotalBytes`. These values are sampled from the current NanoCore process after authorization, are not persisted, and are not host-wide capacity or Worker health claims. They reset/change with process lifetime and collection time. The existing boot id correlates the sample with a process instance. The same response includes a strict `build` projection with `releaseTag` and `sourceCommit`. Both are null when the process has no injected build identity file. An untagged source build sets the full 40-lowercase-hex `sourceCommit` with a null `releaseTag`. A release build sets that commit and the v-prefixed SemVer release tag. A tag without its commit is rejected. [Container Image Packaging](20260708-container_image_packaging.md) owns build-time injection and the missing-input boundary. The server emits a closed `build` and rejects unknown keys, under [Storage Strictness Versus Live Projection Strictness](../core/contract-evolution.md#storage-strictness-versus-live-projection-strictness). A reader drops unknown additive keys under [Closed Core, Open Extension](../core/contract-evolution.md#closed-core-open-extension) and still rejects a malformed tag, a malformed commit, or a tag without its commit. This projection tells an administrator which build is running. Exact deployed build identity for update attribution remains the release/deployment owner's evidence. The process projection includes `process.telemetry` with booleans `enabled` and `exportConfigured`, describing configuration, not delivery or file availability. `enabled` is true unless `OTEL_SDK_DISABLED` is `true` (case-insensitive). `exportConfigured` is true exactly when an explicit endpoint is an absolute HTTP(S) URL with a host and no embedded credentials, query, or fragment. Without an endpoint the target is `(true, false)`; a valid endpoint with the SDK disabled yields `(false, true)`. Local retention errors and unsupported exporter headers do not change these configuration meanings. Optional telemetry failure cannot change readiness or a product outcome. The bounded Turn view above adds no polling service, public filesystem access, configuration API, or arbitrary runtime inspection.

## Current Implementation Projection

NanoCore implements the HTTP/process subset with a private stock OpenTelemetry provider, bounded OTLP/HTTP trace export, existing boot identity, safe HTTP response-handoff spans and correlated stdout diagnostics. Its bounded Turn-dispatch initiation context follows the existing pending NanoHost command in optional native headers; the result produces a short acceptance observation. NanoHost uses the stock Rust SDK and OTLP exporter for bounded startup, member and local effect observations, with one available startup link per effect. The authorized App Diagnostics projection includes the process sample, nested telemetry configuration, and the running release identity. A missing identity file reports both `build` fields null. A present malformed identity file fails NanoCore boot configuration with `invalid_release_identity` and is not reported as a release identity. Unsupported exporter-header environment configuration disables telemetry without mutating the process environment. The operator may run a stock local Collector; no analysis backend is bundled. Shutdown starts a concurrent best-effort flush; normal process exit may cut it short, and it cannot delay listener closure or decide the product shutdown result. Live observation verifies owned HTTP-only export, successful ordinary public reads while the Collector is stopped, and resumed export after Collector restart without changing the App boot. A Better Auth session read does not add library spans to this pipeline.

NanoCore already provides much of the source information this projection will consume: durable boot start, outcome, and orderly-shutdown rows; general server and Workspace AuditEvent recorders; CapabilityCall and UsageRecord producers; PermissionDecision and VaultUse linkage; process-local Gateway usage summaries; worker checkpoints; EvidenceBundle and RuntimeEvidence indexes; bounded runtime transcript and provenance evidence; and stable request, Workspace, Thread, Turn, AgentSession, package snapshot, and CapabilityCall identities.

NanoCore creates server and Workspace log directories, but ordinary process output currently goes mainly to stdout and stderr without complete application-owned retention. The current `apps/nanocore/src/telemetry.ts` still requires an admitted endpoint to enable its provider. Its current `enabled` flag also becomes false for unsupported exporter headers. Those are implementation gaps against the local-first target above, not the target defaults.

The lock resolves `@opentelemetry/otlp-transformer` 0.221.0 through the trace exporter. Its [published public entry point](https://unpkg.com/@opentelemetry/otlp-transformer@0.221.0/build/src/index.d.ts) exposes `JsonTraceSerializer`, `JsonMetricsSerializer`, and `JsonLogsSerializer`. Their `serializeRequest` implementations produce OTLP JSON bytes; append one newline per request. Prefer these stock serializers, with an explicit exact dependency when implementation imports them directly. The [stock file exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/fileexporter) and [OTLP JSON file receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/otlpjsonfilereceiver) document this uncompressed newline-delimited shape. This verifies serializer availability and framing, not an implemented local exporter.

The current explicit GenAI opt-in baseline is `@opentelemetry/semantic-conventions` 1.41.1, already resolved in the lock. Its [incubating convention surface](https://unpkg.com/@opentelemetry/semantic-conventions@1.41.1/README.md) requires an exact pin and includes the selected operation names. Opting into this experimental version does not admit content or unrelated instrumentation. No dependency is changed by this design amendment.

The local sink, local-first configuration flags, journal-backed lifecycle spans/statistics, histogram, Turn timeline, and bounded shim-marker admission/projection are not implemented. Manual Gateway/provider/storage spans, broader log bridging, and CI telemetry also remain partial or absent. Existing evidence and retention coverage retain their owners; this document claims no complete instrumentation.

At the selected OpenShell 0.0.99 pin, an admitted TCP dial failure before CONNECT 200 can lose request correlation. The native failure event retains a shared static proxy endpoint, while a separate destination DEBUG message has no request join. NanoHost cannot reconstruct that missing association. [Issue #136](https://github.com/lingkaix/openkit/issues/136) remains open for an official upstream fix; the current slice does not add a proxy, patch OpenShell or relax identity enforcement. This limit does not establish the cause of a historical package-download failure.

## Alternatives Considered

**Create an OpenKit-wide event table and project every subsystem into it.** Rejected because it would duplicate Audit, CapabilityCall, Usage, Evidence, Turn, runtime, and test authority while creating a second lifecycle and retention owner.

**Use OpenTelemetry as durable audit or acceptance evidence.** Rejected because OTel delivery is intentionally lossy, backend retention is external, and exporter failure must not change product behavior.

**Adopt one observability vendor SDK and backend.** Rejected because OTLP and the Collector provide the required vendor-neutral boundary without placing backend credentials or release cadence inside NanoCore.

**Write a custom JSON event and logging specification.** Rejected because the OpenTelemetry data model, OTLP, W3C Trace Context, Semantic Conventions, and JUnit-compatible reporters already cover transport and general interpretation. OpenKit adds only projections of existing domain ids and stable error codes.

**Instrument every worker and agent runtime with OTel.** Rejected under #221 as narrowly amended. Allowlisted shim phase markers are not native runtime telemetry or an OTLP relay. Core owns span construction; no Sandbox SDK provider/exporter or new egress is admitted.

**Require an operator Collector for all internal diagnostics.** Rejected by the internal-logs decision because a single-server deployment needs usable bounded diagnostics without installing a backend.

**Bundle a complete local observability stack.** Rejected because bounded stock OTLP files and a narrow read projection meet this need without another backend or supported cluster.

## Rollout / Migration Plan

1. Accept the evidence-completeness obligations in their existing owning specifications before relying on telemetry to project them.
2. Pin official stock OpenTelemetry SDK, OTLP, and Semantic Convention releases through the normal dependency procedure.
3. Preserve Resource identity, private providers, no-op disabled behavior, redaction guards, and optional external export; add default-on bounded local capture.
4. Add journal-backed lifecycle spans/statistics, the histogram, and the bounded Turn view. Admit only the defined unverified shim markers, not a Sandbox SDK or native runtime telemetry producer.
5. Correlate admitted logs with active spans and keep JUnit-compatible results and native test artifacts separate. Add other manual spans or pinned CI/CD telemetry only at accepted boundaries.
6. Verify stock Collector file interoperability, rotation, bounded reads, and product independence before relying on the view for diagnosis. Do not bundle an analysis backend.

Diagnostic files have no compatibility requirement. No telemetry backfill, old log import, dual telemetry format, or legacy reader is permitted. This does not authorize deletion or incompatible changes to the canonical execution journal; its owner decides data continuity and migrations.

## Testing Strategy / Acceptance Criteria

The deciding oracles remain canonical records and existing assertions. Telemetry tests decide only whether the diagnostic projection obeys this specification. The following examples constrain that projection:

| Observed situation | Required diagnostic result |
| --- | --- |
| Validation fails before materialization | Name the validation owner and known failed check; do not claim a native run occurred. |
| turn.start was dispatched but no accepted start result arrived | Show delivery timeout or unknown under its owner, not native-start success. |
| Native work finishes but collection or release fails | Preserve the distinct native, collection, and release observations; do not rewrite the product result. |
| A Pending Request ends its raising Turn | End only that Turn's observed wait; later authorized work has its own root. |
| NanoCore restarts or diagnostic files disappear | Preserve journal stages, open steps, correlation, and statistics; show lost detail without replaying work or inferring success. |

- A deterministic test exporter proves Resource identity, trace parentage, terminal status, stable error code, and existing OpenKit id projection without a network service.
- HTTP tests prove stable route-template instrumentation, status and cancellation behavior, and absence of body, header, query, credential, and unrestricted path attributes.
- Gateway and provider tests prove product-safe provider, model, operation, streaming, terminal, duration, and usage projection without prompt, response, quota payload, account, credential, cache-key, or provider-private data.
- Internal Gateway regressions prove one logical-closeout diagnostic, the pre-transport classification of required constrained-sampling rejection of `task_start`'s `prefixItems` schema, observed-status-only projection, prohibited-content absence, and unchanged failure closeout when the log sink throws.
- Worker tests prove Core-owned start/run/end spans use accepted observations and distinguish dispatch from accepted start. Only allowed shim markers become unverified journal/span events; no SDK provider/exporter, OTLP/native-runtime relay, endpoint, credential, or new egress enters the Sandbox.
- Marker tests cover exact fields/enums, authentication/binding, count/byte limits, timestamp clamping, duplicate and late-input drops, lower-priority bounded queues, and overflow. Missing/forged markers never change step status, outcomes, histogram samples, retries, recovery, fences, or control-traffic progress.
- Lifecycle tests prove every ended journal step maps losslessly to one OTLP span and retains journal-owned correlation. Cover every reached/open stage, failed-check attribution, distinct collection/release outcomes, and pending-request closeout without telemetry-driven recovery.
- Metrics tests reject high-cardinality OpenKit ids and dynamic route, URL, error-message, user, account, Workspace, Thread, Turn, request, and test-case dimensions.
- Failure tests prove disabled telemetry, Collector refusal, exporter timeout, queue overflow, and shutdown flush failure do not alter product status, canonical records, cleanup, or process deadline behavior.
- Redaction tests inject canary credentials, authorization headers, prompts, outputs, provider errors, paths, environment values, account ids, and cache keys and prove absence from spans, metrics, logs, and exported OTLP payloads.
- Test integration proves one existing deterministic test emits JUnit-compatible results and correlated system telemetry while retaining native artifacts separately.
- One container integration proves NanoCore can export to a stock local Collector and that Collector absence or termination leaves product health and request behavior unchanged.
- Stock serializers and a stock Collector `otlpjsonfile` receiver prove trace, metric, and log file interoperability without an OpenKit decoder or envelope.
- Sink tests prove default-on capture without an endpoint, complete disabling, valid/invalid retention overrides, combined size/age bounds, idle pruning, rotation, truncated writes, deletion, full disk, permission errors, and independent external export.
- Histogram tests prove one sample per ended stage, bounded attributes, delta intervals, no recount on journal reads, and independent best-effort export.
- View tests prove exact journal-based quantiles/failure share, empty/partial data, complete/open lifecycle rows, and unchanged stage statistics when sink files are removed or capture is disabled.
- View tests also prove deployment-admin authorization for humans and agents, refusal of Worker/member access, safe rendering, bounded queries/scans/results/windows, explicit continuation, and missing-detail handling without product-state changes.
- Repository guards prove no telemetry storage table, reliable retry spool, general public telemetry-query route, vendor SDK, Sandbox SDK/OTLP/native-runtime relay, compatibility format, or independent event/timeline format was added.

Acceptance requires all of the following:

- Operational telemetry uses stock OpenTelemetry and OTLP contracts rather than an OpenKit event or transport schema.
- Canonical OpenKit records remain the sole product, governance, usage, evidence, and test authorities.
- A known process, request, Turn, CapabilityCall, or test execution can locate its available correlated traces and logs through existing ids.
- Product and test outcomes are unchanged when telemetry is disabled, dropped, unavailable, delayed, or contradictory.
- Sensitive and unrestricted content is absent before export.
- Metrics remain bounded by low-cardinality dimensions.
- The only Sandbox reports are bounded allowlisted shim markers, retained/projected as unverified events under #221's narrow amendment. The optional NanoHost trace-header/startup-link contract remains unchanged.
- Local OTLP files remain disposable and excluded from backup/export; canonical journal continuity is unchanged. Stage facts/statistics come from the journal, with optional sink detail, without a Collector.
- No bundled backend, reliable spool, new runner, event bus, general query API, or telemetry recovery workflow exists.

## Risks & Mitigations

- Risk: Automatic instrumentation captures URLs, headers, exceptions, or GenAI content that violates OpenKit boundaries. Mitigation: source-side allowlisting and sanitizer tests precede exporter activation; Collector filtering is defense in depth only.
- Risk: A forged shim report looks like a verified phase. Mitigation: closed payloads, count/byte bounds, clamped timestamps, explicit unverified labels, and no effect on stage status, metrics, recovery, or fences.
- Risk: High-cardinality ids make metrics expensive. Mitigation: keep execution ids in traces and logs and mechanically reject them from metric dimensions.
- Risk: Operators mistake OTel data for durable proof. Mitigation: mark the entire projection non-authoritative and keep existing product and test queries as the only acceptance owners.
- Risk: Local writes or exporter backpressure affect NanoCore latency or shutdown. Mitigation: bounded asynchronous queues, disposable files rather than delivery spooling, deadline-bounded flush, and product-independent failure tests.
- Risk: Diagnostic samples suggest complete history or unbiased statistics. Mitigation: use the journal for lifecycle coverage and view statistics; expose diagnostic gaps, covered windows, sample counts, and truncation.
- Risk: Experimental GenAI or CI/CD conventions drift. Mitigation: explicit opt-in, exact release pinning, same-release coordinated upgrades, and no durable dependency on their fields.
- Risk: Internal diagnostics become a second product. Mitigation: stock OTLP files, one bounded read projection, no query language or persistent index, and no backend ownership.

## Open Questions

None for the accepted architecture boundary. The local limits are current defaults and must be checked during implementation. Collector distribution and an optional external backend remain deployment choices. Further lifecycle-record changes belong to their execution owner, not telemetry.

## Deferred / Future Work

- Broader diagnostic views or additional custom metrics require a separate demonstrated need and an owning operational question.
- Sandbox telemetry beyond the admitted unverified shim markers must satisfy #221's revisit condition; no native-runtime or OTLP relay is authorized.
- A NanoHost local sink requires a later accepted need; this release admits no such sink.
- Remote Collector authentication or direct OTLP export after a deployment model requires it; the initial same-deployment Collector keeps vendor credentials outside NanoCore.
- Tail sampling, multi-collector routing, long-term local storage, telemetry legal hold, and multi-server correlation after the deployment baseline changes.

## Public Design Reference

[Claude Code's public telemetry design](https://code.claude.com/docs/en/monitoring-usage) provides a useful reference, not OpenKit authority:

- Telemetry is off by default and uses standard `OTEL_*` configuration, metrics, events-as-logs, and opt-in traces.
- Its span hierarchy is interaction -> llm_request/tool -> blocked_on_user/execution. Trace context reaches subprocesses and direct model requests.
- Content is redacted by default with explicit capture opt-ins. Metric switches control cardinality.

OpenKit adopts standard signals/configuration, bounded operation/wait spans, safe correlation, and explicit cardinality control. Local capture differs: it is on by default, while external export remains optional. Shim markers are only bounded unverified control-channel reports, not runtime telemetry. Do not copy trace propagation into Sandbox subprocesses or broaden provider-request propagation beyond an accepted trust boundary. The NanoHost header contract remains unchanged.

OpenKit rejects content opt-ins and high-cardinality metric switches, including session/user ids and arbitrary resource attributes. Content belongs to canonical records under [Work Data Retention Format](20260921-work_data_retention_format.md), never the telemetry sink. OpenKit also rejects a separate event/timeline schema or logging library.

## External Standards

- [OpenTelemetry Specification](https://opentelemetry.io/docs/specs/otel/)
- [OpenTelemetry Protocol](https://opentelemetry.io/docs/specs/otlp/)
- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
