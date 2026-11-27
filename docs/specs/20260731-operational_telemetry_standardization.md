---
status: Accepted
implementation: Partial
kind: mechanism
aspect: evidence
---
# Operational Telemetry Standardization

This specification is the single owner of the non-authoritative operational telemetry projection for OpenKit runtime and repository-test execution, the built-in local OTLP JSONL sink and optional Collector export, Worker Sandbox phase-marker admission, the closed emitted lifecycle stage strings and `openkit.turn.stage.duration` histogram, the deployment-admin Turn timeline view, and the App Diagnostics operational process and release-identity sample.

## Scope

Owns:
- The non-authoritative operational telemetry projection (traces, metrics, and correlated logs), adoption of stock OpenTelemetry signals, OTLP transport, W3C Trace Context, applicable OpenTelemetry Semantic Conventions, and JUnit-compatible test-result interchange.
- Correlation of existing OpenKit execution identities into traces and logs, telemetry topology, built-in local OTLP JSONL capture, enablement, redaction, bounded buffering, exporter failure, shutdown, and test-environment behavior.
- The Worker Sandbox phase-marker boundary, closed emitted `openkit.lifecycle.stage` strings, `openkit.turn.stage.duration` histogram, deployment-admin Turn timeline read projection, and the `process` and `build` sample on App Diagnostics.

Does not own:
- Which product, runtime, provider, storage, or test boundary must produce durable evidence, or the semantics of `AuditEvent`, `CapabilityCall`, `UsageRecord`, `PermissionDecision`, `VaultUse`, `EvidenceBundle`, `RuntimeEvidence`, Thread, Turn, Item, or Artifact ([Audit, Usage, And Evidence Records](20260703-audit_usage_evidence_records.md), [Storage Layout And Record Ownership](20260703-storage_layout_record_ownership.md)).
- Execution-journal step state machines and step-kind definitions ([Durable Execution And Control Store](20261019-durable_execution_and_control_store.md)) or boot readiness ([NanoCore Bootstrap Readiness](20260704-nanocore_bootstrap_readiness.md)).
- Product analytics, user-behavior tracking, billing, compliance reporting, SLO/alert policy, a bundled observability backend (Grafana, Prometheus, Loki, Tempo, Jaeger), a multi-collector or high-availability pipeline, a reliable delivery spool, a sampling control plane, a telemetry administration API, or raw worker/provider/sandbox/test artifact formats.

Core: [Doctrine](../core/doctrine.md), [Architecture](../core/architecture.md), [Protocol](../core/protocol.md), [Evidence](../core/evidence.md), [Storage](../core/storage.md), [Vault](../core/vault.md), [Contract Evolution](../core/contract-evolution.md).

## Worker Sandbox Export Boundary

The worker shim inside the Sandbox may report only closed marker variants through the authenticated worker-control channel. It is not a general telemetry relay, and trace context is never propagated into Sandbox subprocesses.

Every marker carries a closed enum phase name and timestamp. Its only permitted additional fields follow this allowlist:

| Phase | Admitted additional fields |
| --- | --- |
| Lifecycle phase | At most one optional fixed-enum outcome or stable allowlisted error code. |
| `environment_preflight` | `harnessVersionMatch`: `match` \| `mismatch` against the admitted version; `gatewayReachability`: `ok` \| `dns` \| `connect` \| `tls` \| `http_class` \| `timeout`; `gatewayHttpClass`: `1xx`..`5xx` (admitted only with `http_class`); `workAreaFreeBytes`: integer `0`..`2^53 - 1` (`9,007,199,254,740,991`) for the writable work area. At most `1` preflight marker per Turn. |
| `native_process_exit` | Integer exit code `0`..`255` or a release-defined signal enum, never both. |
| `shim_error` | One stable allowlisted shim error code; no error message, exception text, or stack. |

Producers report only actually observed preflight fields (omission means unknown) and MUST NOT include raw harness versions, URLs, hostnames, environment variables, or response bodies. Marker reporting grants no probe or egress authority. NanoCore rejects unknown fields, free-form strings, invalid numeric bounds, unknown phase/outcome/signal values, and unlisted error codes. Channel authentication and the Core-owned Turn/step binding select the parent; a marker supplies no identity or authorization.

NanoCore enforces per-Turn input budgets before recording: at most `64` marker inputs and `16 KiB` (`16,384` bytes) of encoded marker payloads per Turn (`current defaults`), counting rejected and duplicate inputs toward that budget. Budget exhaustion drops markers and never delays or drops control messages or product work. Timestamps are clamped into the Core-observed parent step window bounded by receipt time while the step is open; duplicates after validation/clamping and unbound or late markers after step end are dropped. The shim uses a bounded queue below control-message priority and drops markers on overflow, with no Sandbox OpenTelemetry SDK, OTLP endpoint/exporter, Collector, exporter credential, native-runtime relay, periodic sampling, or content capture.

The execution owner records accepted markers as bounded unverified span events (never child spans) on the owning journal step with event name `openkit.worker.phase`, clamped timestamp, admitted variant fields, `openkit.report.origin = 'worker'`, and boolean `openkit.report.verified = false`. Exporters and views preserve these exact keys and values without aliases. Markers never alter step status, outcome, retry, recovery, fences, or histogram samples.

Host-observed Sandbox resource and exit facts follow [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md#host-observed-sandbox-resource-summary): terminal/inspect/teardown and lost-Worker inspect responses supply bounded container-lifetime counters and exit observations as trusted host/backend observations (never agent reports or outcome authority; missing fields stay unknown, measurement stays off the teardown/fencing critical path, late data uses the journal's linked receiving-step rule, and native `stderr`/logs remain `restricted-raw` work content).

## Standards Contract

OpenKit uses official unmodified OpenTelemetry and OTLP releases without forking, monkey-patching, or inventing an alternate telemetry protocol:
- `Operational telemetry`: lossy, non-authoritative traces, metrics, and correlated logs used to diagnose availability, latency, dependency behavior, and execution flow.
- `Canonical record`: a Core-owned product, governance, usage, or evidence record whose owner decides product meaning independently of telemetry delivery.
- `Instrumentation boundary`: a stable owner that knows an operation's identity and terminal result and projects those facts into telemetry.
- `Collector`: an official unmodified OpenTelemetry Collector distribution configured by the operator to receive OTLP, apply bounded processing, and export to a selected backend.
- `Native test artifact`: JUnit XML, JSON/JSONL, Playwright trace, screenshot, bounded `stdout`/`stderr`, HTTP summary, SSE transcript, Data Root snapshot, or another format owned by the applicable test layer.

The standards surface comprises the OpenTelemetry Specification (trace, metric, log, resource, context, SDK, and error behavior), OTLP export, W3C Trace Context for admitted HTTP boundaries, OpenTelemetry Semantic Conventions for stable HTTP/process/runtime/exception/resource and opt-in CI/CD fields, OpenTelemetry GenAI Semantic Conventions only at an explicitly pinned opt-in version for product-safe provider/operation/model/streaming/terminal/token-count fields (content-bearing GenAI attributes are prohibited and disabled), and JUnit-compatible XML from the test runner. Direct NanoCore dependency pins (`apps/nanocore/package.json` and `pnpm-lock.yaml`, `current dependency pins`) use `@opentelemetry/otlp-transformer` and OTLP exporters `0.301.0`, `@opentelemetry/sdk-node` `3.1.x`, `@opentelemetry/api` `1.10.x`, and resolved `@opentelemetry/semantic-conventions` `1.45.0`. Operational telemetry is release-coupled and requires no data migration, backfill, old-log import, dual format, or compatibility reader; canonical execution-journal rows follow their execution owner's retained-data continuity rules.

## Authority And Projection Boundary

- Canonical owners commit product state without waiting for telemetry export; complete telemetry delivery is never a product-success predicate.
- Instrumentation reads only facts already available at the producing boundary and MUST NOT query another store to infer success.
- An exported or local diagnostic span, log, metric, trace ID, Collector queue, or backend document never proves a product mutation, permission decision, provider call, usage quantity, cleanup, or test result.
- `AuditEvent`, `CapabilityCall`, `UsageRecord`, `EvidenceBundle`, `RuntimeEvidence`, Turn, and test records remain authoritative when telemetry is absent or contradictory; contradictions are never resolved by rewriting canonical state from telemetry.
- OpenTelemetry `traceId` and `spanId` values are correlation identifiers, never authorization or outcome authority. The durable execution journal (`control_executions` and `control_execution_steps`) is the sole canonical persistence exception (`1` trace ID per execution and `1` span ID per step); no other canonical record gains trace or span fields.

## Deployment Topology

NanoCore emits stock OpenTelemetry signals to a bounded local OTLP JSONL file sink by default without requiring an OTLP endpoint, and optionally exports to a same-deployment Collector (`OTEL_EXPORTER_OTLP_ENDPOINT`) and operator-selected backend; NanoHost and test processes retain their optional stock OTLP export. `OTEL_SDK_DISABLED=true` disables both local capture and external export. NanoCore depends on no vendor-specific SDK or exporter, remote backend credentials stay in Collector configuration, the Collector is not part of NanoCore readiness, admission, backup, or restore, and product code MUST NOT branch on backend vendor.

### Built-in Local Sink

NanoCore writes separate signal files under the Data Root's server log directory (`apps/nanocore/src/telemetry-local-exporter.ts` and `packages/storage/src/local.ts`), where each line is one uncompressed UTF-8 OTLP/JSON export request plus `\n` (`format: json`, with stock JSON serializers for SDK traces and `DELTA`-temporality metrics, and Typed Journal OTLP Projection below for journal spans).

Current defaults cap all active and rotated files combined at `256 MiB` (`268,435,456` bytes) and `7` days (`604,800` seconds), rotate segments at `16 MiB` (`16,777,216` bytes) or `1` hour (`3,600,000 ms`, lowered when total cap is smaller), and bound each serialized request to `1 MiB` (`1,048,576` bytes) before `\n` (dropping oversized requests without truncating fields). Operators may override `OPENKIT_TELEMETRY_LOCAL_MAX_BYTES` and `OPENKIT_TELEMETRY_LOCAL_MAX_AGE_SECONDS` at process start with positive safe integers; invalid values disable local capture with a safe diagnostic rather than falling back to unbounded writes, while leaving external export independent. Expired files are pruned at startup, during idle periods (`<= 60 s` interval, `current default`), and before reads.

One bounded asynchronous writer (`512` queued items and `16 MiB` queued-byte ceiling, `current defaults`) serializes local writes and prunes expired or oldest disposable segments before growth, subordinate to the Storage owner's configured byte reserve and free-inode checks (`packages/storage/src/local.ts`). If safe headroom is unavailable or pruning fails, the writer drops the batch without consuming canonical reserves. Only the service identity writes owner-only directories (`0700`) and exclusive non-symlink segment files (`0600`, `O_EXCL`/`O_NOFOLLOW` with inode revalidation; unexpected non-regular directory entries fail segment inventory). Deployment-admin reads are authorized before access, accept no client path, and apply source-side Data Safety before local capture. After any partial or uncertain append or process restart, the writer abandons the prior segment and opens a new active segment; readers ignore a truncated final fragment without repair or replay.

## Resource And Correlation Contract

Every emitted signal carries standard OpenTelemetry `Resource` attributes when present: `service.name`, `service.version`, `service.instance.id` (NanoCore `bootId` or a generated process instance ID), and `deployment.environment.name` (`local`, `test`, or `server`, without encoding a hostname or `DATA_ROOT` path).

Trace and log correlation projects existing known OpenKit IDs as span/log attributes only (`openkit.request.id`, `openkit.workspace.id`, `openkit.thread.id`, `openkit.turn.id`, `openkit.agent.session.id`, `openkit.package.snapshot.id`, `openkit.capability.call.id`, `openkit.permission.decision.id`, `openkit.evidence.bundle.id`, `openkit.error.code`), never minting IDs for telemetry, copying high-cardinality IDs into metric dimensions, or emitting raw provider account IDs, credential refs, account-slot labels, backend session IDs, process keys, host paths, or runtime-native child IDs.

## Trace Contract

- A trace root represents one bounded ingress request, command, accepted Turn, scheduled trigger, or repository-test task, never the whole NanoCore process lifetime (which is grouped by `service.instance.id`).
- Admitted HTTP boundaries use stable HTTP Semantic Conventions with route templates (or a fixed unknown-route label for unmatched paths) rather than raw paths, distinguishing response handoff from stream completion.
- Manual spans cover only boundaries automatic instrumentation cannot express (provider resolution/dispatch, LLM inference, scheduler admission, worker lifecycle, transcript collection, Workspace publication, cleanup, and governed storage operations); one owner emits one terminal span status, keeping cancellation, timeout, typed degraded capability, upstream rejection, product failure, and cleanup failure distinct, and never creating spans per Item, token delta, SSE chunk, heartbeat sample, or transport retry/poll frame.
- W3C Trace Context propagation is accepted across OpenKit HTTP clients and trusted internal NanoCore boundaries, validated by the stock propagator without granting actor, authorization, request, Workspace, Turn, provider, or worker authority.

### Journal-Owned Lifecycle Mapping

This specification owns the closed eight-value `openkit.lifecycle.stage` string set emitted by NanoCore (`apps/nanocore/src/telemetry.ts`):

```text
preparation
validation
materialization
session.open.inspect
turn.start.delivery
native.run
collection
cleanup.release
```

[Durable Execution And Control Store](20261019-durable_execution_and_control_store.md#journal-to-lifecycle-mapping) maps its execution-journal step kinds (including `deliver-steer`) to these eight stages and owns execution root/step identity and lifetime. Open steps remain in the journal and are never exported as ended spans. Ended steps project safe `openkit.lifecycle.stage`, `openkit.lifecycle.status`, `openkit.reporting.owner`, `openkit.stage.reached`, `openkit.outcome.class`, and known `openkit.failed.check.id` or stable error codes alongside pinned `invoke_agent`, `chat`, and `execute_tool` conventions without content attributes.

### Typed Journal OTLP Projection

Each ended journal step's stored span-model fields map losslessly to one OTLP/JSON span after its owning commit without recreating SDK spans, coercing `int64` or `doubleValue` `1.0` through JavaScript `Number`, resetting resource dropped-attribute counts, or dropping nested array/kvlist values, event/link order, trace flags/state, or schema URLs. Invalid or unsafe export input is rejected with a safe diagnostic rather than mutating canonical rows.

### NanoHost Correlation

NanoHost uses the optional stock Rust SDK and OTLP exporter (`apps/nanohost/src/telemetry.rs`). Without a Collector, NanoHost's own fine-grained spans are absent from the local sink and the Turn timeline view in this release; the Core execution journal still records Core-observed timing for every NanoHost call, and a NanoHost local sink is not admitted. Native command responses and result requests carry optional W3C `traceparent` and `tracestate` headers ([NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md)); the initiating command context supplies effect parentage (never an unrelated poll), local execution spans end at the observed local result, startup and member start/exit are bounded observations (where local startup never establishes Core readiness), and a Turn-caused NanoHost effect span may carry one span link to the completed Epoch startup context. At the pinned OpenShell `0.0.99` release (`#136`), an admitted TCP dial failure before `CONNECT 200` can lose request correlation because the native failure event carries only a shared static proxy endpoint and a separate destination `DEBUG` log lacks a request join; operators and diagnostics MUST report that cause as unproved rather than inferring correlation or retaining full URLs, headers, bodies, or raw exceptions.

## Metric Contract

Metrics use stock OpenTelemetry HTTP, process, runtime, SDK, and Collector metrics where supported, forbidding high-cardinality identifiers (`workspaceId`, `threadId`, `turnId`, `requestId`, `userId`, `accountId`, `capabilityCallId`, test-case ID, raw route/URL, error message, or evidence ID) as dimensions. `UsageRecord` remains sole authority for attributable consumption.

### Stage-Duration Histogram

The single admitted custom `openkit.*` metric is `openkit.turn.stage.duration` (histogram in seconds, `DELTA` temporality), sampled once per ended stage-step with valid nonnegative duration and carrying only the three point attributes `openkit.lifecycle.stage` (from the closed eight-stage set above), `openkit.outcome.class` (`success`, `failure`, `cancelled`, `timeout`, `rejected`, `unknown`, `degraded`), and `openkit.worker.kind` (release-defined Worker adapter kind, `internal`, or `unknown`).

In the Turn timeline view, stage statistics read ended journal stage-step rows in the requested window grouped by `(openkit.lifecycle.stage, openkit.worker.kind)` (excluding the execution root): failure share is `(failure + timeout + rejected) / all ended rows across all outcomes` in that pair (`9` successes and `1` failure yield `10%`, and `0` ended rows report no data), and `P50`/`P95` use nearest-rank valid-duration quantiles across all ended rows in that pair unless explicitly labeled outcome-stratified.

## Log Contract

Application and test logs follow the OpenTelemetry Log Data Model (via stock Logs SDK or structured `stdout`/`stderr` bridge) with active `traceId`/`spanId` correlation, stable error codes, and product-safe summaries (excluding stack traces from external export by default). Workspace Knowledge Manager notebook Tool failures emit best-effort `knowledge_notebook_tool_failed` diagnostics with owner operation and allowlisted exception class only. Console output without a retained sink is transient, and log presence or absence never decides a product or test outcome.

### Control Store Pressure Sample

Sample the Core database and WAL bytes, age since complete checkpoint, queued and open live-set counts, and commit p99. Use the control-store qualification thresholds for checkpoint at 8 MiB or 1 s and WAL pressure at 32 MiB or 5 s (current defaults). Evaluate commit p99 against the [accepted writer load profile](20261019-durable_execution_and_control_store.md#acceptance). Use bounded diagnostic log samples. Attribute database, WAL and body growth and cutoff rates through the existing scope correlation attributes for logs. Keep samples in the existing telemetry retention. The native writer emits at most one sample per active owner every 5 seconds and keeps at most 128 successful COMMIT timings per owner between samples. The cutoff sample counts typed truncation responses in its window, including exact replays. These counts and the window duration support rate calculation. An alarm supplies diagnostic evidence only. Physical admission and terminal headroom remain with the existing [control-store and filesystem owners](20261019-durable_execution_and_control_store.md#write-and-space-budget).

### Failed Internal Gateway Logical Calls

When an internal-role Gateway logical call fails, closeout emits one best-effort diagnostic (`internal_gateway_call_failed`, `apps/nanocore/src/internal-agents/gateway-provider.ts`) per logical call rather than per retry or route member. It carries a fixed safe summary, closed failure phase (`pre-transport` for local selection/admission/request-construction rejections including `prefixItems` constrained-sampling rejection, `transport` when handed to the adapter without local rejection or provider response, `provider-response` for observed upstream HTTP rejections, or `output-projection` for response-to-message conversion failures), closed Gateway failure kind, observed upstream HTTP status when present (omitting local error-envelope statuses), and known correlation IDs (`requestId`, `workspaceId`, `threadId`, `turnId`, `capabilityCallId`, logical-dispatch correlation, and attempt index when a member was reached). Missing correlation values are omitted without minting IDs or querying storage for enrichment; raw exception text, stack traces, provider-private codes, schemas, Tool arguments, prompts, outputs, and credentials are prohibited. The diagnostic creates no durable descriptive cause on `CapabilityCall` and no additional product record, failed or absent logging leaves closeout and the public `provider_call_failed` / `internal_inference_failed` projection unchanged, and it has no recovery or restart lifecycle beyond the optional log sink.

### Worker Provider Rejection Detail

The `worker_inference_failed` diagnostic (`apps/nanocore/src/llm/gateway-routes.ts`) may attach an optional request-local `providerError` read only from a bounded clone of an actual rejected stock HTTP response (`apps/nanocore/src/llm/pi-ai-client.ts`), carrying only upstream `type`, `code`, `param`, and `message` strings (sanitizing `message`—including removing the selected request credential—before truncating each string to at most `200` characters, clearing the detail at attempt start so closeout describes only the final attempt, and omitting headers, full bodies, prompts, and outputs). Malformed, unreadable, or oversized detail leaves the observed HTTP status available, and these fields are diagnostic evidence only that never alter routing, retries, failure classification, public error envelopes, or durable records.

## Test And CI Contract

The system under test uses the same production telemetry with `deployment.environment.name = 'test'`, JUnit-compatible XML for machine-readable test results, and opt-in pinned CI/CD Semantic Conventions. Native test artifacts remain in their existing formats and stores; telemetry may reference only their product-safe logical name, media type, bounded size, sensitivity class, retention class, and digest, and MUST NOT embed their raw content. Test-runner suite/case/run-index attributes never enter production records or metric dimensions, and test pass/fail verdicts and stricter real-provider/security/sandbox/data-loss evidence requirements never depend on telemetry export.

## Data Safety

Redaction runs at the source before data reaches any OpenTelemetry API, SDK queue, `stdout` bridge, local sink, Collector, or exporter. Telemetry MUST NOT contain credentials, cookies, authorization headers, bootstrap tokens, Vault material, secret-revealing refs, or auth-source paths; prompt text, response text, tool content, arbitrary Item/Artifact/source/transcript content, or request/response bodies; raw provider account IDs, quota payloads, provider-private errors, prompt-cache keys, backend handles, worker process keys, runtime-native session IDs, or sub-agent transcript IDs; full URLs with query or user-info components, arbitrary HTTP headers, unrestricted environment variables, unnecessary hostnames, or full filesystem paths; or raw exception objects, recursive payload dumps, or untrusted dynamic attribute names.

## Lifecycle, Failure, And Recovery

Capture, retention, and export settings resolve at process start. Disabled telemetry installs a no-op/non-recording provider without disabling the canonical execution journal or its read projection. In-memory SDK queues (`512` items, `current default`) drop on overflow without blocking product work. Orderly shutdown runs one concurrent best-effort flush (`1,000 ms` timeout, `current default`) that never delays listener closure or lock release or alters the shutdown result. Restart generates a new `service.instance.id` without reconstructing lost HTTP/provider spans.

## Retention, Export, And Analysis

Data Root backup and Workspace export exclude disposable local OTLP files, Collector state, and backend telemetry (while canonical execution-journal rows follow their storage owner's backup and retention rules). Correctness paths never join canonical records with telemetry; the analysis target is querying correlated spans and logs from a known `bootId`, `requestId`, `turnId`, `capabilityCallId`, or test run.

## Turn Timeline Read Projection

A deployment administrator (human or operating agent; Worker credentials and Workspace membership alone are refused) may request one known Turn's journal stages, diagnostic detail, and stage statistics, accepting only `turnId` and a bounded statistics/detail window (`24 h` window, `32 MiB` local scan, and `1,000` diagnostic spans, `current defaults`)—never file paths, a query language, attribute expressions, or export destinations. The view reads stages and open steps from the execution journal and joins local fine-grained spans by `traceId` in memory: missing sink files lose detail only, never a stage; journal failure follows the journal owner's unavailable/quarantine semantics rather than file authority; and journal stages and statistics remain available when telemetry capture or export is disabled. The view returns safe stage/time/status/owner/check-or-error and correlation fields with no invented end or duration on open steps, bounds journal pages/work separately without excluding lifecycle or open steps merely because they began outside the detail window, reports continuation/partial coverage when budgets prevent completion (including across Workspace stores), displays worker phase markers with their exact `openkit.report.origin = 'worker'` and `openkit.report.verified = false` labels separately from established stage facts, reports covered window, sample/open/invalid/cancelled/unknown/degraded counts, and truncation/missing detail, rejects malformed required OTLP fields while ignoring unselected additive fields, renders fields as data, exposes no arbitrary attributes, and uses bounded parsing and an in-memory join with no persistent index, query service, or poller.

## Persistent-Deployment Instrumentation

Persistent-deployment acceptance ([Persistent Deployment Acceptance](20260909-persistent_deployment_acceptance.md)) and [L6 Story Acceptance](20260529-l6_story_acceptance.md) require no telemetry backend. External export uses `OTEL_EXPORTER_OTLP_ENDPOINT` for a same-deployment Collector; malformed endpoints or nonempty exporter-header environment variables (`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, etc.) disable external export with a safe diagnostic naming the variable without its value and without mutating `process.env` or disabling local capture. NanoCore uses a private stock provider so third-party libraries (such as Better Auth session reads) never enroll spans into the pipeline.

### App Diagnostics Operational Sample

The deployment-admin App Diagnostics response (`DiagnosticsProcessSampleSchema` and `DiagnosticsReleaseIdentitySchema` in `packages/app-api-schemas/src/diagnostics.ts`) includes:
- A live `process` sample (`observedAt`, `nodeVersion`, nonnegative `uptimeSeconds`, `memory` with nonnegative integer `rssBytes`/`heapUsedBytes`/`heapTotalBytes`, and `telemetry` with booleans `enabled` and `exportConfigured`). `enabled` is `true` unless `OTEL_SDK_DISABLED` is `true` (case-insensitive); `exportConfigured` is `true` iff the configured endpoint is an absolute `http(s)` URL with host and no credentials, query, or fragment (yielding `(true, false)` without an endpoint and `(false, true)` when disabled with a valid endpoint).
- A strict `build` projection (`releaseTag` and 40-lowercase-hex `sourceCommit` from [Container Image Packaging](20260708-container_image_packaging.md)): both are `null` when no build-identity file is injected; an untagged source build sets `sourceCommit` with `releaseTag: null`; a release build sets both; and a present malformed identity file (or a `releaseTag` without `sourceCommit`) fails NanoCore boot configuration with `invalid_release_identity`.

## Acceptance

- **Typed journal OTLP codec and Collector round-trip fixture**: round-trip journal spans through the pinned `otelcol-contrib` `0.163.1` / `otlpjsonfilereceiver` `0.163.0` fixture with `otlp_json_file.max_log_size` set to `1 MiB`, proving exact `double` `1.0`, `int64 > 2^53`, byte/nested `AnyValue` types, timestamps, dropped counts, events/links, and `1 MiB` oversized-request drop behavior, and proving that after partial append or restart a new segment opens and stock readers parse subsequent lines cleanly.
- **Fault-injected capacity, Collector outage, and redaction proof**: verify under fault-injected free-byte and free-inode exhaustion, Collector stop/restart, third-party library calls, and canary-secret injection that the local sink prunes or drops disposable segments without consuming canonical storage reserves, ordinary requests and boot readiness remain healthy during Collector failure, private-provider isolation excludes third-party spans, and source-side redaction strips canary secrets, prompts, headers, and paths before serialization.

## Implementation

- `apps/nanocore/src/telemetry.ts`
- `apps/nanocore/src/telemetry-local-exporter.ts`
- `apps/nanocore/src/storage/control-store-pressure-telemetry.ts`
- `apps/nanocore/src/runtime/`
- `apps/nanocore/src/internal-agents/gateway-provider.ts`
- `packages/app-api-schemas/src/diagnostics.ts`
- `packages/storage/src/local.ts`

## Implementation Gaps

- Stage-duration histogram journal-step sampling - `openkit.turn.stage.duration` samples process-local `withLifecycleStageTelemetry` wrappers rather than ended execution-journal stage-step rows - #742
- Worker-kind metric dimension vocabulary - `openkit.worker.kind` in `apps/nanocore/src/telemetry.ts` omits the `deepseek` adapter and retains `claude-code`, which has no adapter - #727
- Worker shim phase-marker transport, journal projection, and NanoHost resource-summary projection - Bounded shim phase markers (`openkit.worker.phase` with `verified: false`) and NanoHost container-lifetime resource summaries are not projected into execution-journal events - #221, #818
- Typed journal-to-OTLP span adapter, deployment-admin Turn timeline view, and Collector round-trip fixture - Lossless typed journal-row OTLP/JSON export, the bounded deployment-admin Turn timeline view (`24 h` / `32 MiB` / `1,000` spans) with `(stage, worker.kind)` journal statistics, and the live `otelcol-contrib` file-receiver round-trip fixture are not implemented - #219, #353, #818
- Manual Gateway/provider/storage spans, structured log bridge, and CI telemetry artifact references - Manual spans across provider/storage boundaries, full OTel log bridging, and CI test-runner telemetry references are partial or absent - #207, #818
- OpenShell pre-`CONNECT 200` TCP dial failure request correlation - At the pinned OpenShell `0.0.99` release, a TCP dial failure before `CONNECT 200` emits a shared proxy endpoint without request correlation - #136

## Decisions

- [App Image Release Identity](../decisions/20261013-app_image_release_identity.md)
- [Sandbox Telemetry And Public Gateway Boundary](../decisions/20261015-sandbox_telemetry_and_public_gateway_boundary.md)
- [NanoHost Trace Headers And Startup Link](../decisions/20261016-nanohost_trace_headers_and_startup_link.md)
- [Sandbox Resource And Preflight Diagnostics](../decisions/20261019-sandbox_resource_and_preflight_diagnostics.md)
- [Telemetry As Internal Logs](../decisions/20261019-telemetry_as_internal_logs.md)
- [Worker-Reported Phase Markers](../decisions/20261019-worker_reported_phase_markers.md)
