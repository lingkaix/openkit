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

Independent tests preceded implementation and reached assertion failures on unchanged production. Configuration and type checks are not runtime acceptance. The first candidate passed 30 independent regressions and the repository, lint, typecheck and 55-case local gate. Independent review then reproduced an idle-cleanup symlink escape, so that green result did not authorize landing. Two independent boundary regressions failed on the exact defective candidate before correction. Every file inventory now validates its directory chain, including idle cleanup after startup refusal; 32 focused cases pass with the external bytes preserved. Exact-head re-review, renewed gates and landing remain pending. Finite-accounting fixtures retain real file I/O; unreported inode accounting still fails closed, without a platform exception.

## Next Action

Complete the local sink against independent tests, inspect the actual diff with a separate reviewer, and run the applicable gates. Only then land this cut before the current-path lifecycle instrumentation.
