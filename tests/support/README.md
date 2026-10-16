# Shared Test Support

This directory contains repository-level support with current consumers in more than one app or test layer.

`demo-data.mjs` owns deterministic demo-workspace seeding used by NanoCore e2e, Web e2e, and the local deterministic Story stack. The Demo Workspace Thread it creates is current workspace-visible Thread history (`openkit.thread-visibility.v1`), not unclassified predecessor data. Its consumers test their own boundary behavior; this directory does not duplicate those assertions.

`openshell-worker-policy.json` captures the non-secret native policy produced by the former NanoCore renderer. NanoHost uses those unchanged bytes to characterize its local rendering of Core-owned typed intent and admission into the current OpenShell SDK type.

Keep support dependency-light, deterministic, and limited to demonstrated reuse. Add behavior tests at the owning consumer layer instead of creating a support-only mirror suite.

The `release-round/` kit owns Worker-only qualification collection and offline row generation. Each runtime owns one fresh Thread and its evidence directory; runtime groups run concurrently while A to D remain sequential. An uncertain mutation seals later calls and all admitted groups settle before attribution closes. New live preparations pin a published release tag and require an explicit target. Generated sixteen-case projections extend existing release notes; they create no product record or separate report service. See [the tests guide](../README.md#release-round-acceptance-instrument) for commands and evidence shapes.

Shared release retention and effect helpers are owned by `scripts/release-safety.mjs`. The qualification kit imports and pins that module; script producers do not depend on test support.

Preparation retains story-owned browser preflight under `--purpose browser-story`; Worker-only qualification omits it. Both paths retain the same source, checklist and instrument binding.

Demo seeding uses explicit canonical fixture identities. The authority helper records its fixture User through NanoCore test support and then records Workspace membership; it never imports a production default User constant.
