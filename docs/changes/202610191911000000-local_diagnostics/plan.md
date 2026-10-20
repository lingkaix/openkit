---
type: change-plan
status: in-progress
date: 2026-10-19
---
# Built-In Local Diagnostics

## Intent Revisions

1. Implement the accepted local diagnostics target on existing execution paths without a data reset: default-on disposable OTLP/JSONL, optional external export, then observed lifecycle spans and one histogram. Telemetry never contains work content or determines product outcome. Journal, timeline, native retention and storage-layout work remain separate.
2. The accepted implementation cut limits capacity admission to direct filesystem checks against existing reserve values, without shared reservation composition. Use the existing server logs directory and lock-matched stock SDK serializers; stock Collector qualification is later work. Retention sharing and its default flip wait for the content primitives; the current capture default and canonical file publication remain unchanged.

## Authority

[Operational Telemetry](../../specs/20260731-operational_telemetry_standardization.md) owns signals and loss policy. [Storage](../../core/storage.md) owns canonical records and retained content. [Work Data Retention](../../specs/20260921-work_data_retention_format.md) remains separate from diagnostic loss.

## Working Checkpoint

The first cut replaces endpoint-required capture with an independent local destination. The stock SDK serializes requests; one bounded asynchronous writer rotates and prunes only its own segments. A new process or uncertain append creates a fresh segment, never repair or replay. Explicit SDK disablement disables all destinations; external and local failures cannot alter product work. No general log framework, persistent telemetry index, receipt or new reserve is introduced.

Independent tests preceded implementation and reached assertion failures on unchanged production. Configuration and type checks are not runtime acceptance. The first candidate passed 30 independent regressions and the repository, lint, typecheck and 55-case local gate. Independent review then reproduced an idle-cleanup symlink escape, so that green result did not authorize landing. Two independent boundary regressions failed on the exact defective candidate before correction. Every file inventory now validates its directory chain, including idle cleanup after startup refusal; 32 focused cases pass with the external bytes preserved. Exact-head re-review and the 57-case gate passed, and the first increment landed. The main suite then found an existing disabled-case test that used an empty environment; the explicit SDK-disabled fixture was corrected on main and its CI passed. Default and shared-semantics changes now require the full NanoCore suite or full branch CI, not only targeted files. Finite-accounting fixtures retain real file I/O; unreported inode accounting still fails closed, without a platform exception.

The second increment adds a small observer at existing awaited preparation, validation, materialization, session open/inspect, start delivery, native final-status, collection and cleanup boundaries. No new admission or human-wait lifetime, durable journal, execution owner or control is introduced. Returned validation refusals and native statuses are classified separately from fulfilled transport calls. One stock delta histogram uses seconds and only stage/outcome/release-defined Worker-kind dimensions; both signals share the existing bounded writer but never a signal segment. Metric readers drain before the trace provider closes that writer, under the existing bounded shutdown. Known ids remain span-only, unknown facts remain unknown, and the original operation Promise, result and error remain unchanged.

Independent current-runtime tests reached three intended assertion failures before implementation on the merged green main. They now pass with the 32 first-increment regressions: 37 cases across four files. This evidence covers actual awaited validation, returned refusal, nine successful validations plus one failure, privacy, disablement and no-effect cleanup. It does not establish full native lifecycle fault coverage, journal statistics or Collector interoperability.

## Next Action

Inspect the complete second-increment diff with a fresh reviewer, run the full NanoCore suite and exact-head gates, then report ready to land. Retained body sharing/default changes and later native collectors remain outside this increment.
