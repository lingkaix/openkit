---
status: Accepted
date: "2026-10-19"
decider: Engineer
---
# Work Data Retention Completeness

## Decision

OpenKit retains valuable observed work data as completely as possible without predicting later extraction, comparison, improvement, scoring, evaluation, audit, fine-tuning, or post-training. Anonymization and use-specific filtering happen at use time, not capture. This is not a data-use permission model; no consent, training-permission, or purpose flags are introduced.

Capture Coverage defaults on, with the existing server -> Workspace -> task resolution and explicit lower settings recorded historically. Gateway-observed model exchanges retain native upstream JSON-semantic content and the Worker-facing exchange when translated. Streaming retains the provider-native event sequence as bounded immutable chunks, plus Gateway-observed first-token/completion times. A normalized final message is derived, not a second stored copy.

Message/part references and structurally shared sequences deduplicate conversation history. Prompts and tool definitions are retained once by digest. Workspace-attributed data uses that Workspace's existing immutable Storage content; unattributed calls use existing server Storage/control roots with explicit server-scope coverage. No Workspace/Turn identity or global capture owner is invented.

Native transcripts remain in the harness format by default. Native stderr/log output is restricted-raw content, bounded per Turn with an explicit truncation record, never telemetry. Context and judgment provenance reference existing owners; lifecycle facts stay with the execution journal. OpenKit designs only envelope/index records and references, not a normalized content truth or dataset storage product.

OpenKit-held/injected credentials and secret material are never captured. Other admitted content is retained verbatim under restricted-raw access, current authorization and audited reads. User/legal/operator deletion and legal holds remain binding. Restricted-raw is an access class, not a demonstrated-need retention gate.

This decision replaces the default-off disposition of the earlier [full model I/O decision](20260921-full_model_io_switch_default_off.md) and the Storage model's demonstrated-need gate for restricted raw work data. Scope resolution, mandatory metadata, historical binding, and truthful absence remain. There is no partial-supersession metadata form; the earlier record remains unchanged, and current owners state the new default and completeness contract.

## Reason

Source: the engineer's 2026-10-19 direction to the coordinator, translated from Chinese. Future uses cannot be known at capture. Missing native inputs, outputs, context or judgments cannot later be recreated from summaries, metadata or current configuration. Content addressing and shared sequence manifests address storage growth without discarding that information. The coordinator confirmed native streaming sequence retention and server-scoped capture for unattributed Gateway calls.

## Rejected Alternatives

- Default-off or demonstrated-use-only retention permanently loses data before its value can be assessed.
- Filtered semantic messages or normalized final responses discard native fields, streaming order and partial failures; derive these views at use time instead.
- Serializing every conversation prefix repeats content quadratically; immutable message references and shared manifests preserve history without that duplication.
- A new store, dataset product, export pipeline, anonymization engine or query service duplicates owners and is not needed for completeness.
- Consent, training-permission or purpose flags turn a capture-completeness decision into a new data-use permission model.

## Revisit When

Revisit if measured capture/storage cost cannot be bounded through existing Storage, deduplication and operator policy, or an existing legal/secret obligation conflicts with a concrete capture boundary. Preserve explicit gaps and retained-data continuity; no missing data may be backfilled as observed history.

## Affected Owners

- [Work Data Retention Format](../specs/20260921-work_data_retention_format.md)
- [Storage Model](../core/storage.md)
