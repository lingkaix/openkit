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

Independent tests preceded implementation and reached assertion failures on unchanged production. Configuration and type checks are not runtime acceptance. Thirty independent regressions pass using explicit finite-accounting fixtures and real file I/O. The original real-filesystem positive assumption was corrected by the independent test owner; unreported inode accounting still fails closed and can make local capture unavailable on that filesystem. No platform exception is introduced. Whole-cut review, exact-head gates and landing remain pending.

## Next Action

Complete the local sink against independent tests, inspect the actual diff with a separate reviewer, and run the applicable gates. Only then land this cut before the current-path lifecycle instrumentation.
