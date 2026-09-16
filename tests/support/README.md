# Shared Test Support

This directory contains repository-level support with current consumers in more than one app or test layer.

`demo-data.mjs` owns deterministic demo-workspace seeding used by NanoCore e2e, Web e2e, and the local deterministic Story stack. The Demo Workspace Thread it creates is current workspace-visible Thread history (`openkit.thread-visibility.v1`), not unclassified predecessor data. Its consumers test their own boundary behavior; this directory does not duplicate those assertions.

`openshell-worker-policy.json` is the canonical non-secret structured policy fixture produced by NanoCore and parsed into the current OpenShell SDK type by NanoHost.

Keep support dependency-light, deterministic, and limited to demonstrated reuse. Add behavior tests at the owning consumer layer instead of creating a support-only mirror suite.
