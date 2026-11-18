# Shared Test Support

This directory contains repository-level support with current consumers in more than one app or test layer.

`demo-data.mjs` owns deterministic demo-workspace seeding used by NanoCore e2e, Web e2e, and the local deterministic Story stack. The Demo Workspace Thread it creates is current workspace-visible Thread history (`openkit.thread-visibility.v1`), not unclassified predecessor data. Its consumers test their own boundary behavior; this directory does not duplicate those assertions.

`openshell-worker-policy.json` captures the non-secret native policy produced by the former NanoCore renderer. NanoHost uses those unchanged bytes to characterize its local rendering of Core-owned typed intent and admission into the current OpenShell SDK type.

Keep support dependency-light, deterministic, and limited to demonstrated reuse. Add behavior tests at the owning consumer layer instead of creating a support-only mirror suite.

The `release-round/` kit owns Worker-only qualification collection and offline row generation. Codex, Pi and OpenCode V2 each own one fresh Thread and its evidence directory; those three runtime groups run concurrently while A to D remain sequential. DeepSeek owns one pre-effect refusal on an admitted existing Thread, creates no Thread, and does not run A to D. An uncertain mutation seals later calls and all admitted groups settle before attribution closes. New live preparations pin a published release tag and require an explicit target. Generated thirteen-row projections extend existing release notes; they create no product record or separate report service. See [the tests guide](../README.md#release-round-acceptance-instrument) for commands and evidence shapes.

Shared release retention and effect helpers are owned by `scripts/release-safety.mjs`. The qualification kit imports and pins that module; script producers do not depend on test support.

Preparation retains story-owned browser preflight under `--purpose browser-story`; Worker-only qualification omits it. Both paths retain the same source, checklist and instrument binding.

Demo seeding uses explicit canonical fixture identities. The authority helper records its fixture User through NanoCore test support and then records Workspace membership; it never imports a production default User constant.

The authority helper initializes each fresh demo Notebook through the native Git initializer under its explicit fixture User. It uses the current governed page serializer and initializes the service's personal Notebook with an empty index. It never writes or converts a predecessor knowledge/pages tree.

The fresh demo Workspace records use the current retained marker. Each fixture scope retains a distinct canonical Knowledge Base ID in its configuration before the initial Notebook publication, and publication validation uses that exact page scope. Seed retries retain those IDs and Git publications without repairing invalid retained records.

The demo Thread fixture carries the canonical explicit Workspace owner. Its existing envelope lineage stays an address, and its digest covers the same admitted Thread payload as the native reader. No retired record shape is emitted.

Qualification public-record checks require an explicit Workspace owner on each attributed Turn. Plan and operation Workspace selectors remain addressing inputs. Synthetic Turn and Item fixtures use the same current owner shape.

`golden-path.mjs` is the hosted-only fixed procedure for `.github/workflows/golden-path.yml`. It reuses release packaging, the installer and `scripts/release-safety.mjs`; the live release-round kit requires a retained remote published deployment and does not fit this fresh-install subject. The model endpoint scripts native file write/read tool calls, checks their actual results, and supplies exact assistant text. Public records prove completion, exact public Artifact bytes and retained association identity. Private attempt SQL is diagnostic only and selects no credentials or preparation payloads. Run the workflow to exercise the real stack; never run this helper or NanoHost on a development installation.

The helper's `self-check` mode uses fixed HTTP stand-ins and no host or product process. It must reach success and reject a failed Turn, a wrong assistant reply, wrong file bytes and an observation timeout. The workflow runs this admission before building artifacts. Its output is instrument evidence only.

The fixed order creates W1 before Worker image activation and W2 after activation. W1 runs first; a failed W1 stops the procedure. W2 must then complete before the restart and the retained-file Turn on W1. This covers both initial configuration loading and immediate use of a new Workspace without an extra reload.
