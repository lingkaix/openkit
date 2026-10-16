---
type: standalone-change
status: implemented
started: 2026-10-16
branch: fix/test-tmp-hygiene
---
# Test Temporary Directory Hygiene

## Intent And Authority

The coordinator requested isolation and cleanup after repeated shared `/tmp` inode exhaustion. The [test strategy](../specs/20260529-test_strategy.md#test-data-and-environment-policy) owns disposable fixtures; the [toolchain guide](../toolchain.md#test-temporary-directories) owns the execution procedure. This changes test infrastructure and fixtures only.

## Change

Every Vitest unit and NanoCore e2e configuration uses one shared global setup, including packages that previously used implicit defaults. It creates a private invocation directory before workers start, sets TMPDIR, TMP and TEMP, and removes it at normal teardown after success or failure. Worker Shim projects share the invocation directory. The setup restores prior variables and does not prune shared storage.

The reported database and Worker fixture owners close resources and remove their own roots in afterEach or afterAll. Root document-model fixtures also remove their roots. A real-worker regression exercises successful and deliberately failed single-suite and multi-project runs and checks that the parent is empty afterward. It also loads the actual configurations and requires the shared setup first. It proves containment and cleanup without a repository-wide scan or a new live leak policy.

## Evidence And Limits

The real-worker regression failed at isolation and removal with a no-op setup, then passed with the shared lifecycle. The controlled pre-correction Worker census left 160 Harness and 151 Pi adapter directories; document-model left 107 directories. The shared run teardown removed the Vitest census roots. Exact-head local gates, independent review, full CI and landing evidence are retained in the coordinator backlog under evidence/integrator and reviews.

A forcibly killed runner cannot execute JavaScript teardown; external host reclamation remains a safety net. Rust tempfile-owned fixtures and product behavior are unchanged.
