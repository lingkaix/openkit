---
status: Accepted
implementation: Partial
date: "2026-09-09"
---
# Persistent Deployment Acceptance

## Owns

This specification owns ordinary functional acceptance on a persistent internal OpenKit deployment: the composition of in-product work and external Skill-driven use, attempt attribution and isolation, reusable execution support, evidence collection, benchmark reports as ordinary files or Artifacts, diagnosis-to-repair handoff, and the initial observable completion predicates.

## Does Not Own

It does not create a test service, evaluation database, Agent runtime, scheduler, durable attempt record, automatic repair loop, or release gate. Existing work, Artifact, Evidence, Audit, Usage, authorization, deployment and release owners retain their semantics. Cold-start, installation, interruption, destructive recovery and NanoHost containment qualification retain their own fixtures and strict proofs. Customer autonomous maintenance and a co-deployed coding Agent are excluded.

## Core References

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/audit.md`
- `docs/core/permissions.md`
- `docs/core/storage.md`

## Related Docs

- `docs/specs/20260529-l6_story_acceptance.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260731-operational_telemetry_standardization.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260829-release_management.md`
- `docs/specs/20260909-deployment_host_requirements.md`
- `docs/verification-instruments.md`

## Summary

Reuse one authorized deployed product for real Task execution and external Skill-driven acceptance, with independent result evidence and separate operator diagnosis.

## Decision

Ordinary functional acceptance reuses an explicitly authorized persistent internal deployment. A new change plan does not require a new host, Data Root, login, Provider account or product installation. Upgrade the deployment through its existing deployment procedure when the target product changes; keep the product build fixed during an attempt. New scenario state is normally a dedicated Workspace or Thread, not a new deployment. Do not certify unexecuted work or close another plan merely because it shares the tested build.

Two complementary paths are admitted. In-product execution submits actual tasks or benchmark workloads to normal Task or Goal Mode and observes the resulting Items, Artifacts, Usage and Evidence. External execution uses a Skill-capable desktop Agent through the same public NanoCore contracts, with separately authorized browser or SSH tools for the user's chosen surface and operator diagnosis. Both use the same installed product and record owners. Internal execution does not require a new evaluation role or a Worker with administrative access to NanoCore.

The engineer's operating premise is that Agent implementation is fast while environment preparation, evidence acquisition and trustworthy adjudication dominate recent acceptance effort. The intended improvement is less repeated preparation and reconstructive scripting, not less reliable proof. A persistent deployment is neither a clean-install proof nor a safe place for every destructive test.

## Environment And Authority

The operator selects the deployment and grants access through existing authentication and host tooling. No repository default names a private host, credential path, token or SSH trust override. An SSH alias is supplied explicitly; normal host-key checking remains enabled. Deployments serving unrelated users are not implicitly admitted by this contract.

The selected deployment may retain its current protected access credentials, Provider subscriptions and test data across attempts. Check current authority and availability before use; historical evidence is never a credential source. Attempt-created tokens, fixtures and temporary files remain owned by that attempt and are removed when no longer required. Durable deployment credentials are not removed as test cleanup. No secret value enters prompts, transcripts, reports or retained evidence; secure stores and existing credential-mediated public operations remain the delivery mechanisms.

The existing deployment resource owner remains responsible for concurrent work. An attempt records a fixed build and relevant configuration observations; upgrades or relevant operator repairs terminate its attribution window. A materially changed environment requires a fresh attempt, not continuation under the old label. The stage manager coordinates a maintenance window for deployment changes and checks active work before restart. Shared-instance permission does not authorize changes to unrelated services, networks or containers.

Cold or destructive proofs explicitly select their own isolated fixture. Reusing a persistent instance cannot prove fresh-install behavior, interruption recovery or absence of interference on a host it did not observe. Those tests continue under their owning specifications; ordinary live acceptance does not invoke their teardown.

## Test Scope And Default Placement

These modes primarily host L6 Stories and Agent task/benchmark suites representing real user goals and full product flows. They are the default for ordinary L6 execution, not a new home for all L1-L5 checks and not a requirement that the Actor run inside the product. A story selects a dedicated environment only for an explicit condition the persistent deployment cannot witness. The existing L6 admission and repeated-run rules remain applicable; one successful Task proves that execution seam, not automatic admission of a new story.

## Execution And Evidence

An attempt is an execution observation, not a new product entity. It has no durable product authority, table or dedicated lifecycle record; its report follows the existing Artifact or evidence owner. Reuse the existing story document for L6, ordinary Task/Goal inputs for workloads, and Artifact or change-record evidence for the resulting report. An external attempt retains local evidence even if NanoCore becomes unavailable. Record the target build or deployed artifact digest, start/end times, entry surface, relevant non-secret configuration identity, input/story revision, Workspace/Thread/Turn identifiers, and observed outcome. A configured version string alone is not an exact-build proof: obtain the deployed artifact identity through the release/deployment owner, or report it unavailable.

Collect user-visible responses and the minimum named product records that decide the expected outcomes. Use existing public read operations for Thread/Turn/Item state, Artifact, EvidenceBundle, Audit and Usage; preserve returned pagination or incomplete coverage rather than treating a partial read as complete. Fetch sensitive content only under the requesting user's current source authority. Server-admin diagnostics do not bypass private conversation visibility. Correlation values select records and never grant access.

Operational telemetry supplements those records with process and request diagnostics; it never supplies missing product truth. Its absence is reported separately. No complete raw database export, full transcript, blanket environment dump or private host filesystem scan is required by default. SSH can establish an authorized diagnostic fact but cannot become a hidden product success oracle; a recurring missing product observation returns to its owning interface.

Reusable setup, public-client invocation, evidence collection and deterministic comparison helpers may be maintained in existing support locations when repeated use demonstrates the need. They do not prescribe an L6 Actor's trajectory, create private authentication or transport, or manage a second workflow. The L6 owner controls Actor/Judge isolation and product classifications. Infrastructure support exposes errors and partial evidence; it must not discard a deciding exception into a bare FAIL.

If an attempt fails, retain sufficient redacted evidence to diagnose or re-adjudicate it. Fixing a collector or judge over the same retained complete observations may permit a new adjudication without repeating product work. If required observations are absent, the result remains inconclusive; do not synthesize them or infer a pass. Product mutation or operator repair requires a new execution before claiming the repaired behavior works. Cleanup failure is a separate observation.

## Benchmark Composition

A benchmark is a selected set of ordinary authorized workloads with predeclared outcome checks. It runs through the existing Task/Goal and Worker substrate; no EvalTask, suite service, Judge runner or separate queue is introduced. Its dataset and report are ordinary files/Artifacts under their existing owners. Held-back answers never enter candidate context. External side effects and Provider consumption require the same current grants as ordinary work.

Reports distinguish functional outcome, output quality, elapsed time, attributable Usage and interaction friction. Preserve model/Provider configuration, dataset/check revision, product build, budget and sample count before comparing results. Missing or incomparable observations remain unavailable; a single faster nondeterministic run is not proof of improvement. A benchmark score neither changes an L6 verdict nor automatically promotes a Skill, merges code or authorizes deployment.

## Diagnosis And Repair

An Agent may inspect admitted records, classify product, environment, tool or evidence failures, and create an ordinary repair Task. Reuse existing tasks to associate repeated occurrences when known; no per-log repair dispatch, polling Agent daemon or autonomous PR merge is introduced. A Worker changes code only in its authorized repository environment. Confirmed deterministic defects receive the lowest sufficient regression; the appropriate user-intent attempt is rerun after deployment when its integration risk remains.

The desktop Agent's SSH authority is separate from the OpenKit Skill. Host tools may inspect or change only the engineer-authorized deployment scope. During the Actor's product flow they cannot seed hidden success, edit product databases, bypass approvals or repair the system and retain the original pass claim. Installation and diagnosis commands stay in the deployment cookbook; the Skill remains a public product client.

PR publication, merge and deployment use their existing owners and explicit task authorization. Unknown external outcomes require inspection; retries cannot blindly repeat an external effect. Normal service supervision handles process liveness. No internal role is responsible for repairing a NanoCore process that cannot execute that role.

## Initial Acceptance

- One exact updated build runs on the authorized persistent host using its existing protected Provider subscription configuration.
- One real Task or small benchmark workload executes inside OpenKit; its actual terminal product state and meaningful output are observed through public records. Merely receiving a submitted Turn is insufficient.
- An independent external Agent loads the packaged Skill and completes an admitted user intent on that same deployment without a prescribed call sequence or private database mutation.
- Another authorized reader can locate the named records and explain both results; a negative/absent outcome is not converted into success by optional telemetry or a producer report.
- Both attempts retain attribution and survive as evidence without rebuilding or deleting the deployment between them. Attempt fixtures can be identified independently of pre-existing data.
- Process/request diagnostics can be inspected without content or credential disclosure; optional telemetry failure does not change product outcomes.
- A later engineer can repeat the procedure from the maintained cookbook and packaged Skill, supplying the deployment access and goal, without reconstructing authentication, transport or deployment scripts.

## Implementation Status

Existing public operations, Task/Goal execution and evidence producers remain the substrate. The focused implementation adds the NanoHost runtime-target Skill/Core Client read, refreshed packaged Skill guidance, process diagnostics and optional HTTP telemetry. Local contract checks pass. The final deployed build has completed an independently judged external Skill run and a Collector outage/recovery observation without product interruption; the unchanged Skill story also retains its three-run admission evidence. NanoHost is publicly ready after initial restoration. The complete composition remains partial: Provider authentication and real model inference are now verified, but a real Worker Task with meaningful output on the current persistent deployment still needs its own completion evidence. Other roadmap plans retain their individual acceptance obligations.
