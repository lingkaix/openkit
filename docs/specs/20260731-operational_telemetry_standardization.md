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

- `docs/core/doctrine.md`
- `docs/core/architecture.md`
- `docs/core/protocol.md`
- `docs/core/evidence.md`
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
- Producer trust and Sandbox admission follow the Worker Sandbox Export Boundary below; no broader instrumentation is implied.
- Do not build a bundled observability backend, multi-collector topology, high-availability pipeline, reliable delivery spool, sampling control plane, or telemetry administration API.
- Local diagnostic files and the bounded deployment-admin Turn view are in scope. They are not a log database, durable evidence, or a public trace-query service.

### Worker Sandbox Export Boundary

The [#221 engineer ruling](../decisions/20261015-sandbox_telemetry_and_public_gateway_boundary.md) applies with the [phase-marker amendment](../decisions/20261019-worker_reported_phase_markers.md) and its narrow [resource/preflight extension](../decisions/20261019-sandbox_resource_and_preflight_diagnostics.md). The worker shim, OpenKit's own code inside the Sandbox, may report only closed marker variants through the existing authenticated worker-control channel. This is not a general telemetry relay.

Every marker has an enum phase name and timestamp. Its only additional fields follow this release-defined allowlist:

| Phase | Admitted additional fields |
| --- | --- |
| Lifecycle phase | At most one optional fixed-enum outcome or stable allowlisted error code. |
| `environment_preflight` | `harnessVersionMatch`: `match`/`mismatch` against the admitted version; `gatewayReachability`: `ok`/`dns`/`connect`/`tls`/`http_class`/`timeout`; `gatewayHttpClass`: `1xx` through `5xx`, only with `http_class`; `workAreaFreeBytes`: integer 0 through 2^53−1 for the writable work area. At most one preflight marker per Turn. |
| `native_process_exit` | An integer exit code from 0 through 255 or a release-defined signal enum, never both. |
| `shim_error` | One stable allowlisted shim error code; no error message, exception text, or stack. |

Report only actually observed preflight fields; omission means unknown. Do not include the raw harness version, URL, hostname, environment, or response body. Marker reporting grants no additional probe or egress authority. Reject unknown fields, free-form strings, invalid numeric bounds, unknown phase/outcome/signal values, and unlisted error codes. Existing channel authentication and the Core-owned Turn/step binding select the parent; a marker supplies no identity or authorization.

NanoCore validates the allowlist and per-Turn count/byte budgets before recording. Current defaults admit at most 64 marker inputs and 16 KiB of encoded marker payloads per Turn. Rejected or duplicate inputs also consume this diagnostic input budget. Exhaustion drops markers, never control messages or product work. Clamp timestamps into the Core-observed parent window, bounded by receipt time while the step is open. Drop duplicates after validation/clamping, and drop unbound or late markers after the owning step ends.

The shim uses a bounded queue below control-message priority. Drop markers on overflow; marker production and delivery must never delay control traffic. No new egress, OpenTelemetry SDK provider/exporter, OTLP endpoint/receiver, Collector, exporter credential, native agent-runtime telemetry relay, arbitrary metrics/logs, periodic sampling, or content is admitted in the Sandbox.

The execution owner records accepted markers as bounded, unverified events on the owning journal step. At journal admission, store the fixed `openkit.worker.phase` event name, clamped timestamp, admitted variant fields, `openkit.report.origin=worker`, and boolean `openkit.report.verified=false`. Exporter/view preserve these exact keys/values without aliases or trust-field rewriting. Span events, not child spans, represent these point reports: they have no verified operation duration or independent lifecycle. Keep claimed outcome/error fields separate from stage status/outcome.

Markers never change a step's status, outcome, retry, recovery, or fences, and never add histogram samples. Missing or forged markers affect diagnostics only. Journal persistence proves only that Core received an unverified report, not that the reported phase occurred.

Core/NanoHost accepted observations own native start/run/end facts; markers only add unverified detail and cannot establish receipt, completion, collection or release. Broader inside telemetry needs #221's concrete unmet need and separately accepted trust/egress/content controls. Deadline propagation stays with execution.

Host facts follow the [NanoHost resource-summary owner](20260802-nanohost_runtime_and_transport.md#host-observed-sandbox-resource-summary): existing terminal/inspect/teardown and lost-Worker inspect responses supply bounded container-lifetime counters and exit observations. Record them as trusted host/backend observations, not agent reports or outcome authority. Missing fields are unknown. Measurement stays off the teardown/fencing critical path; late data uses the journal owner's linked receiving-step rule. Native stderr/logs remain restricted-raw work content, never telemetry. This is the operative host/inside trust boundary.

## Terms

`Operational telemetry` means lossy, non-authoritative traces, metrics, and logs used to diagnose availability, latency, dependency behavior, and execution flow.

`Canonical record` means an existing Core-owned product, governance, usage, or evidence record whose owner decides product meaning independently of telemetry delivery.

`Instrumentation boundary` means an existing stable owner that knows an operation's identity and terminal result and may project those facts into telemetry.

`Collector` means an official unmodified OpenTelemetry Collector distribution configured by the operator to receive OTLP, apply bounded processing, and export to a selected backend.

`Native test artifact` means JUnit XML, JSON or JSONL, Playwright trace, screenshot, bounded stdout or stderr, HTTP summary, SSE transcript, Data Root snapshot, or another format already owned by the applicable test layer.

## Standards Contract

Use official unmodified releases and standard OpenTelemetry/OTLP contracts. Do not fork, patch or monkey-patch libraries, invent an alternate telemetry protocol, or replace standard semantic conventions. The typed journal adapter below implements the standard mapping, not an OpenKit format.

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
- Producer trust and host/Sandbox observation follow the single boundary above.

### Built-in Local Sink

NanoCore owns a dedicated sink subtree under the Data Root's server log directory, with separate signal files. Each line is one UTF-8 OTLP/JSON export request plus one newline: the Collector file exporter's uncompressed `format: json`, without custom encoding, envelope or length prefix. SDK signals use stock JSON serializers; journal spans use Typed Journal OTLP Projection below.

Current defaults cap all active/rotated files together at 256 MiB and age at seven days. Rotate at 16 MiB or one hour; a smaller total cap limits segment size. Maximum serialized request size is 1 MiB before its newline. Drop oversized requests without truncating span fields or inventing another format.

Operators may set `OPENKIT_TELEMETRY_LOCAL_MAX_BYTES` and `OPENKIT_TELEMETRY_LOCAL_MAX_AGE_SECONDS` at process start. Require positive integers and checked representable arithmetic. Invalid limits disable local capture with a safe diagnostic, not an unbounded fallback; external export stays independent. Prune expired files at startup, idle periods and before reads; no cleanup process runs while stopped.

One bounded asynchronous writer serializes all signals and enforces the combined cap, pruning expired/oldest disposable segments before growth. Pruning failure drops the batch. Writes are subordinate to the [Storage owner's reserves and in-flight accounting](20260703-storage_layout_record_ownership.md#artifact-file-payloads-and-derived-media), including free bytes and applicable inode reserves. If safe headroom is unavailable or unknown, prune disposable segments or drop the batch. Never reserve capacity ahead of product writes or add telemetry capacity state.

Only the service identity writes owner-only files. Authorize deployment-admin reads first, confine operations to the sink, reject symlink escapes, and accept no client path. Apply source-side Data Safety before local capture, not only Collector filtering.

Overflow, full disk, permission/rotation errors or deletion may lose batches; report bounded safe process diagnostics when possible without blocking product work. After partial/uncertain append, abandon that segment and use a new one. Restart always starts a new active segment. Readers ignore a truncated final fragment; no repair, replay, fsync acknowledgement or delivery ledger is added.

The sink acknowledges no product fact, drives no state/recovery, and guarantees no completeness or retention. Deletion has no product effect; racing reads report partial/unavailable detail. Canonical journal retention/backup is separate.

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
- Diagnostic Items, token deltas, SSE chunks, heartbeat samples and transport retry/poll frames do not each create spans. Actual journal step invocations, including owned retry/inspection steps, follow its mapping; aggregate events identify a material phase without new control authority.
- W3C trace propagation is accepted across OpenKit-owned HTTP clients and trusted internal NanoCore boundaries. Caller-supplied trace context is validated by the stock propagator and never supplies actor, authorization, request-id, Workspace, Turn, provider, or worker authority.

### Journal-Owned Lifecycle Mapping

The [journal-to-lifecycle mapping](20261019-durable_execution_and_control_store.md#journal-to-lifecycle-mapping) owns execution root/step identity and lifetime, stage classification, retry/sample units, immutability and late-observation placement. This projection consumes that mapping; it creates no synthetic durable root or stage. Open steps are read from the journal, not exported as ended spans or reconstructed from diagnostics.

The execution owner records safe `openkit.lifecycle.stage`, `openkit.lifecycle.status`, `openkit.reporting.owner`, `openkit.stage.reached` and `openkit.outcome.class` attributes. A known failed check supplies `openkit.failed.check.id`; otherwise retain its known stable error code, never an invented check/cause. Project these facts unchanged. Applicable `invoke_agent`, `chat` and `execute_tool` conventions are explicitly version-pinned; content attributes remain prohibited.

### Typed Journal OTLP Projection

Each ended step's stored span-model fields map losslessly to one OTLP span after its owning commit. Use a stock typed-OTLP path if pinned public packages support the complete model. Otherwise use a small pure adapter implementing the [OTLP/JSON mapping](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding) exactly. Do not recreate SDK spans, resample rows, infer types from JavaScript values, or add another telemetry format/library.

Preserve each AnyValue discriminator and exact value: `doubleValue` 1 remains a double, not an inferred int. Encode int64 and nanosecond integers as exact decimal strings where OTLP/JSON requires; never round through JavaScript Number. Trace/span IDs use hexadecimal, other bytes use base64, enum fields use integers, and special floating values follow Protobuf JSON rules. Preserve nested array/KV values and stored event/link order.

Retain dropped attribute/event/link counts, trace flags/state, timestamps, status, resource/scope descriptors and attributes, and schema URLs. Preserve optional journal semantics; never reset resource drops to zero or silently discard fields. Apply Data Safety at journal admission. Reject invalid/unsafe export input with safe diagnostics rather than mutate canonical rows or advertise a partial field projection as lossless.

SDK-originated spans/metrics/logs still use stock SDK serializers. Public inputs and the exact interop fixture are documented in Current Implementation Projection; typed journal round trips below are required before claiming interoperability.

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

This owner asks: **What are per-stage latency P50/P95 and failure share?** Stock HTTP/runtime metrics cannot separate journal lifecycle stages. The one custom metric is `openkit.turn.stage.duration`, a histogram in seconds, sampled once per ended stage-step under the journal mapping with valid nonnegative duration. Reads/exports never add samples; open/invalid durations are not guessed.

Its only point attributes are `openkit.lifecycle.stage`, `openkit.outcome.class` and `openkit.worker.kind`. Stage follows the journal mapping. Outcome is `success`, `failure`, `cancelled`, `timeout`, `rejected`, `unknown` or `degraded`. Worker kind is release-defined, or `internal`/`unknown`, never an Agent/operator label. Export non-overlapping delta histogram points; exported samples remain lossy.

The view reads ended stage-step journal rows in its stated window, grouped by **(stage, worker kind)**; the execution root is not a duration sample. Failure share is (`failure` + `timeout` + `rejected`) / all ended rows across **all outcomes** in that pair. Nine successes and one failure produce 10%, not separate 0%/100% outcome groups. Zero ended rows means no data.

P50/P95 use nearest-rank valid-duration quantiles overall in the same pair. An explicitly outcome-stratified view must label that difference. Outcome remains an exported histogram dimension, not a restriction on the overall denominator. Report sample/ended-row counts, open/invalid rows, cancelled/unknown/degraded counts, window, and partial/pagination/retention limits. Sink loss never changes journal statistics; metrics never prove usage or outcome.

## Log Contract

- Application and test logs use the OpenTelemetry Log Data Model whether they are emitted through a stock Logs SDK or collected from structured stdout and stderr by the Collector.
- The initial JavaScript implementation may retain a structured stdout bridge while the pinned OpenTelemetry JavaScript Logs API remains non-stable. It must not invent another general log record schema.
- Logs emitted inside an active span include standard trace id and span id correlation.
- Every retained error log uses a stable error code and product-safe summary. Stack traces remain restricted diagnostics and are excluded by default from external export unless an accepted security boundary explicitly admits them.
- Workspace KM notebook Tool failures expose a bounded native error code/category and emit best-effort `knowledge_notebook_tool_failed` process diagnostics with the owner operation and allowlisted exception class, excluding content and exception text.
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

A deployment administrator may request one known Turn's journal stages, diagnostic detail and stage statistics; an operating agent uses the same authorization. Worker credentials and Workspace membership alone grant no access. Authorize before opening journal/files. Reading never initiates, settles or repairs work.

Read stages/open steps from the journal; join local fine-grained spans by its trace id. Missing sink files lose detail, never a stage. Journal failure follows its owner's unavailable/quarantine semantics, not file authority. Display worker reports' exact unverified labels separately from established stage facts.

Accept only Turn id and a bounded statistics/detail window, not paths, a query language, attribute expressions or export destinations. Return safe stage/time/status/owner/check-or-error and correlation fields, with no invented end/duration on open steps. Journal statistics use the pair grouping above and are deployment samples, not Turn metric dimensions.

Current limits: 24-hour statistics/detail window, 32 MiB local scan, 1,000 diagnostic spans. Bound journal pages/work separately; do not silently exclude lifecycle/open steps because they began outside the detail window. Report continuation/partial coverage when budgets prevent completion, including across Workspace stores.

Report covered window, sample counts, truncation and missing/unavailable detail. Reject malformed required OTLP fields, ignore unselected additive fields, and expose no arbitrary attributes. Use bounded parsing and an in-memory join, no persistent index/query service/poller. Render fields as data. Journal stages/statistics remain available with capture/export disabled.

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

The locked `@opentelemetry/otlp-transformer` 0.221.0 [public exports](https://unpkg.com/@opentelemetry/otlp-transformer@0.221.0/build/src/index.d.ts) provide JSON serializers for SDK `ReadableSpan[]`, `ResourceMetrics` and `ReadableLogRecord[]`. Public trace JSON/protobuf inputs are SDK spans, not typed OTLP requests. The inspected pinned transformer/exporter-base public surfaces expose no complete typed-journal JSON path. Conversion infers int/double from JavaScript Number and resets resource dropped-attribute count; it cannot prove journal fidelity. Keep stock serializers for SDK signals and use the standard typed adapter above for journal rows, with an explicit exact dependency for direct imports.

The interop fixture is pinned to stock `otelcol-contrib` 0.163.1; its [distribution manifest](https://github.com/open-telemetry/opentelemetry-collector-releases/blob/v0.163.1/distributions/otelcol-contrib/manifest.yaml) pins `otlpjsonfilereceiver` 0.163.0. Explicitly configure `otlp_json_file.max_log_size` to the sink's 1 MiB maximum request size and verify delimiter/boundary behavior. The upstream default is also 1 MiB; larger requests cannot assume automatic growth. These are checked source/pin facts only; the adapter and live Collector round trip are not implemented/executed here.

The current explicit GenAI opt-in baseline is `@opentelemetry/semantic-conventions` 1.41.1, already resolved in the lock. Its [incubating convention surface](https://unpkg.com/@opentelemetry/semantic-conventions@1.41.1/README.md) requires an exact pin and includes the selected operation names. Opting into this experimental version does not admit content or unrelated instrumentation. No dependency is changed by this design amendment.

The local sink, local-first configuration flags, journal-backed lifecycle spans/statistics, histogram, Turn timeline, bounded shim-marker admission/projection, and host-resource summary projection are not implemented. Manual Gateway/provider/storage spans, broader log bridging, and CI telemetry also remain partial or absent. Existing evidence and retention coverage retain their owners; this document claims no complete instrumentation.

At the selected OpenShell 0.0.99 pin, an admitted TCP dial failure before CONNECT 200 can lose request correlation. The native failure event retains a shared static proxy endpoint, while a separate destination DEBUG message has no request join. NanoHost cannot reconstruct that missing association. [Issue #136](https://github.com/lingkaix/openkit/issues/136) remains open for an official upstream fix; the current slice does not add a proxy, patch OpenShell or relax identity enforcement. This limit does not establish the cause of a historical package-download failure.

## Rollout Boundary

Implement the admitted private producers, typed journal projection and bounded view through their existing owners; tests below define acceptance. Diagnostic files require no data migration, backfill, old-log import, dual format or compatibility reader. Canonical journal/data continuity remains with its owner, never disposable telemetry policy.

## Testing Strategy / Acceptance Criteria

These are required diagnostic oracles, not a claim of implemented target behavior:

- A deterministic stock exporter proves Resource identity, known opaque ids, parentage, status and stable codes without network/backend requirements.
- Lifecycle cases follow the journal mapping: validation refusal creates no native success; dispatch without accepted start does not prove receipt; native/collection/release observations remain distinct; a new Turn does not extend prior human wait. Late host data targets an eligible linked step, never an ended span.
- **Cross-owner marker oracle:** admit/store every lifecycle, preflight, native-exit and shim-error variant through the journal owner, then compare stored/exported event fields/types and displayed trust class. Exact `openkit.report.origin`/`openkit.report.verified` survive without aliases; worker stays unverified, host observations keep their distinct source class.
- Marker cases cover exact fields/enums/numbers, authentication/parent binding, atomic count/byte budget, clamping, duplicate/late/unbound drops, one-time preflight, lower-priority queues and overflow. Forged/missing input cannot change status/outcome, histogram samples, retry/recovery/fences or control progress; raw version/environment/URL/stderr and periodic samples are rejected.
- Host cases cover bounded optional fields, absent/invalid = unknown, dead/hung shim inspect, container-lifetime rather than guessed Turn counters, and no measurement wait on a ready teardown/fence. No new poller/route/metric exists.
- **Typed codec oracle:** round-trip journal spans through the pinned stock receiver/exporter and compare decoded AnyValue types/exact values, including double 1.0, int64 beyond 2^53, nested/byte values, exact timestamps, drops, flags/state, events/links, schema URLs and resource/scope metadata. SDK span recreation/Number coercion fails.
- The same fixture proves standard trace/metric/log JSONL and newline boundaries. Match receiver line size to maximum request size, test that limit and oversized drops, and require no OpenKit decoder. Source inspection alone is not Collector interoperability.
- **Capacity oracle:** with the sink below its cap, nearly exhausted free bytes/inodes or occupied in-flight capacity causes disposable pruning/drop, not consumption of canonical reserve. Unknown headroom, failed pruning and concurrent signals preserve the shared cap.
- Sink cases cover default-on/no endpoint, complete disabling, positive/invalid/overflowing overrides, combined size/age/idle pruning, owner-only/symlink/path confinement, deletion, full disk and permission/rotation failures.
- After partial/uncertain append, later batches use a new segment. Restart creates a new active segment; stock reading sees subsequent valid lines without joining them to the abandoned tail. No repair/replay/delivery state appears.
- Histogram samples follow ended steps, never recount reads, and export bounded deltas. Nine success/one failure rows yield 10% per (stage, worker kind); overall and labelled outcome-stratified quantiles differ intentionally. Invalid/open durations, empty/partial windows and cancelled/unknown/degraded counts stay explicit.
- View cases prove deployment-admin human/agent admission, Worker/member refusal, safe rendering, bounded pages/scans/results/windows, continuation and unchanged journal stages/statistics after file loss or SDK disablement.
- HTTP cases prove route templates/fixed unknown routes, status/cancellation/handoff versus completion, and no unrelated library/global-provider enrollment.
- Provider cases prove safe operation/model/streaming/terminal/duration/token fields without content/account/quota/credential/cache-key/private payloads. Internal Gateway cases retain one logical-closeout diagnostic, required `task_start`/`prefixItems` pre-transport classification, observed upstream status only, and unchanged closeout if logging throws.
- Canary credentials, headers, prompts/outputs, environment, paths, private provider data and other prohibited fields are absent before local serialization and export in SDK and typed journal paths.
- Disabled capture, Collector refusal/restart, timeout, overflow, contradictory/dropped telemetry and flush failure leave canonical facts, product/test status, cleanup and shutdown deadlines unchanged. A stock-Collector integration proves ordinary requests remain healthy while it is absent/stopped.
- Existing assertions/JUnit results and native artifacts retain acceptance authority, including stricter real-provider/security/sandbox/data-loss evidence. No backend is required for L6.
- Guards reject a second telemetry table/index/schema, reliable spool, general query API, vendor SDK, extra metric, event bus, workflow or compatibility format. Canonical journal rows and retained work owners are not telemetry storage.

## Open Questions

None for the accepted architecture boundary. The local limits are current defaults and must be checked during implementation. Collector distribution and an optional external backend remain deployment choices. Further lifecycle-record changes belong to their execution owner, not telemetry.

## Deferred / Future Work

Broader views/metrics require a demonstrated owned question. Remote Collector authentication/direct backend export, tail sampling, multiple Collectors, long-term local retention, legal hold and multi-server correlation need separate accepted deployment needs. A NanoHost local sink is not admitted in this release.

## Public Design Reference

[Claude Code public telemetry](https://code.claude.com/docs/en/monitoring-usage) is a reference, not OpenKit authority. The accepted differences are:

- Local capture defaults on; external export stays optional.
- Content opt-ins stay disabled; native work data has its retention owner.
- Trace context is not propagated into Sandbox subprocesses.

## External Standards

- [OpenTelemetry Specification](https://opentelemetry.io/docs/specs/otel/)
- [OpenTelemetry Protocol](https://opentelemetry.io/docs/specs/otlp/)
- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
