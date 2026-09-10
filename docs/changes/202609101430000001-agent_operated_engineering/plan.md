---
type: change-plan
status: in-progress
date: "2026-09-10"
---
# Agent-Operated Engineering

## Intent Epoch 1

On 2026-09-10 the engineer clarifies the operating goal: use OpenKit itself for its ongoing development and maintenance, principally through Web-directed Agents, with repository engineering principles, independent verification, tests and acceptance usable through that platform. Desktop Agents use the OpenKit Skill and separately authorized SSH for exceptional work. NanoCore and Web are the routine release-or-exact-commit build/update targets; NanoHost maintenance is explicitly separate and must not become part of ordinary App updates. Agent-usable installation, configuration, upgrade, diagnosis and recovery guidance should be independently distributable as a Skill rather than parallel user manuals. Provider model parameters must be optionally authorable using the models.dev declaration format, including limits, modalities and pricing. The engineer authorizes implementing settled feasible parts now through Cursor Agents and permits the primary and independent Claude Consultant to settle implementation details; unresolved user choices remain discussion topics. Primary personally writes canonical Markdown, retains Product Vision unchanged and uses independent review/audit for consequential artifacts.

## Intent Epoch 2

The engineer confirms that dual-instance operation is optional, not a prerequisite. Existing A2 Web and Desktop Agent plus Skill paths should carry most scenarios. SSH alias `a1` is available only if a task genuinely needs an additional machine; no mandatory staging deployment or NanoHost maintenance is implied. Preserve separately owned services and data, and verify actual host identities before treating aliases as isolated environments.

## Intent Epoch 3

The engineer requires one model parameter: a maximum context length so context compression can use a known bound. Prices, reasoning-intensity options, modalities and other metadata remain optional. A positive context limit inherited from the pinned catalog satisfies that requirement; an uncatalogued model without one must declare it explicitly. This supersedes the earlier admission of a model with no known context limit, not exact native-ID support. Adapter operating defaults are not sourced physical limits.

## Intent Epoch 4

The engineer offers another server for optional staging in response to the earlier placement question. Its SSH identity is not yet supplied or equated with the previously authorized `a1`; confirm the named destination before any effect. This offer does not make dual-instance operation a prerequisite or replace the A2 Web and Desktop Skill paths.

## Intent Epoch 5

The engineer identifies the offered optional staging server as SSH alias `a1`. Read-only qualification may now use that alias; compare its destination with A2 before treating it as an independent machine. The existing two main paths remain the immediate delivery target.

## Intent Epoch 6

The engineer states that SSH a1 was a test/development server, all of its data may be deleted or overwritten, and requests complete cleanup of its accumulated temporary files. This authorizes identifying and removing A1 legacy test deployments, temporary artifacts and build caches after exact host/path identification. It does not authorize changing A2 or destroying the operating system and SSH access. Cursor `live-deployment` owns the bounded host cleanup; source/document writers remain unchanged.

## Owners

Existing [persistent-deployment acceptance](../../specs/20260909-persistent_deployment_acceptance.md), [test strategy](../../specs/20260529-test_strategy.md)/L6, workflow, policy, Artifact/Evidence/Audit/Usage and [repository execution](../../change-execution.md) contracts retain authority. Gateway, Provider configuration and pi-ai backend owners define the model-parameter extension. A bounded update-delivery and operations-Skill owner must be accepted before new deployment behavior or a second distributable Skill is implemented. Release management retains publication and distribution identity; it does not own deployment effects.

## Checkpoint

Current A2 App/Web is exact source `26abdc124c0085a3f8cfd5e0ca51deddf5ce3f0a`, with Codex authenticated, all three requested logical models completing inference, and OrcaRouter the default. NanoHost generation 7 is ready and fresh-empty. These are Provider/setup facts, not a completed Web engineering or Worker Artifact acceptance. The older persistent plan remains open at that frontier. The Telemetry implementation exports explicit HTTP response-handoff spans and process diagnostics; product records provide additional evidence but do not automatically create a self-maintenance loop.

Primary owns all Markdown. Cursor `live-builder` investigates and will implement the isolated model-metadata slice after owner review; `live-deployment` inspects host/update primitives; `live-tester` inspects real Worker/Web acceptance and tooling. These contexts own separate `temp/` areas until precise production write ownership is dispatched. Independent Claude `live-resume-direction` examines the scheme, actual owners and current code. No second instance, host update, NanoHost effect, new daemon or evaluation database is authorized by this checkpoint alone. The user authorizes the dedicated A2 engineering fixture; `live-tester` may provision only that Workspace through public APIs and prepare protected browser access under its temporary path. The expected observation is an exact fetchable source revision and an authenticated Web entry, not a completed Worker story; missing Git transport or browser capability reframes that fixture step without changing NanoHost.

The immediate model proposal adds optional Provider-native `modelMetadata` using models.dev fields, one shared effective resolver, explicit false/zero precedence, and actual adapter use. Bare IDs with a known catalog context remain valid; otherwise an authored context is required. The next observable is a lowest-sufficient failing check for the new declaration, followed by the narrow implementation and focused passing checks. A displayed-but-unused parameter, altered credential/endpoint authority, fabricated price or unknown limit is a finding, not acceptable completion.

The engineering delivery frontier is a repeatable Web-started change with independent evidence and a bounded NanoCore/Web update that survives target process replacement, plus Desktop/Skill diagnosis and recovery. Reuse existing records and host supervision. Determine the smallest missing public/tool integration from actual attempts rather than coding this repository's whole governance procedure into Core.

## Acceptance

- Provider declarations preserve models.dev naming/units and exact native-ID admission with a known context limit, drive existing capability/adapter consumers, validate invalid inputs and retain explicit zero/false values without changing auth or public identity redaction.
- Independently distributable operations guidance and executable support cover actual supported install, configuration, update and recovery paths without a running NanoCore prerequisite or a second independently maintained manual corpus.
- A user can direct a real bounded engineering task through the deployed Web, inspect exact output and independent verification, and give any required human decision through existing product records.
- Normal tests run in the owning Worker environment; full real-use acceptance uses the existing persistent paths. Container-owning or destructive work uses a separately authorized effect domain without weakening sandbox containment.
- A release/exact-commit App/Web update has reviewable target identity, bounded authorization, preserved data/credentials, a process-independent execution path, observed post-update health/identity and inspectable failure. No automatic NanoHost restart or assumed database rollback is introduced.
- Desktop Agent plus packaged Skill can operate the same product and use separate authorized host tools for recovery. Optional second-host support is not a prerequisite or an HA/state-replication claim.

## Evidence

Prior Provider deployment and independent configuration evidence remain in `temp/live-deployment/deploy-26abdc12-evidence.json` and `temp/live-review/a2-config-26abdc12.md`. Model research is in `temp/live-builder-model-metadata/`; its corrections supersede the first proposal's pi-ai cache-field spelling and unverified pricing assumptions. New raw evidence stays under task-owned `temp/` paths. No acceptance is inferred from documentation, a tool inventory, a submitted Task or an Agent's self-report.

The independent audit rejected making optional incomplete prices an inference prerequisite. The narrowed backend contract preserves inference and token accounting while withholding an unsupported USD estimate. Complete known rates still use stock pi-ai calculation. After primary compaction, Claude session `2027a8ec-5859-46fc-981c-e1b8acbf9be9` is inspecting source Intent, current Git and retained deployment evidence before new update-delivery commitment.

Fresh Claude direction check (`2027a8ec-5859-46fc-981c-e1b8acbf9be9`) returns Continue for the required-context model slice, real Worker proof and operations Skill. It recommends `openkit-ops` to distinguish the Skill from the existing stopped-server `openkit-operator` executable. New host authority remains held for the concrete restricted design; there is no mandatory second instance or measured desktop-hop prerequisite. Independent model owner review reports no material objections after mandatory context and optional-price corrections; `git diff --check` passes.

Model owner review, document-model validation (250 documents), lifecycle validation and generated-index check pass. The operations Skill remains a committed Draft proposal for independent review; it grants no host effect.

Next host action is A1 cleanup under Intent Epoch 6: enumerate exact test/temp paths and services against the observed A1 identity, inspect the proposed deletions, then remove only that selected scope. Expected observable is reclaimed storage and absence of those legacy artifacts with SSH usable; a host-identity or mount-scope mismatch stops deletion. A2 operation and pending implementation continue independently.

The exact Orca free-model context is absent from both public and authenticated Provider model discovery (HTTP 200, selected row present; `temp/live-review/model-context/authenticated-orca-v1-models.json`). The engineer has been asked for its required declared ceiling; A2 model activation waits for that number rather than inventing one. OpenRouter publishes 200000 for its exact free-router ID and the pinned catalog agrees. Code, Skill migration, Worker preparation and A1 cleanup proceed independently.

Independent `ops_delivery_owner_review` reports no owner-level blocker for the operations Skill and manual migration. Claude agrees with its boundary and naming. The owner is Accepted; package/projection code will follow that committed contract. App-update remains Draft while correcting released-artifact identity and receipt-loss admission. These do not gate the separate Skill packaging or model slice.
