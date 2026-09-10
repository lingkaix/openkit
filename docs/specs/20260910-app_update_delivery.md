---
status: Draft
implementation: Not Started
date: "2026-09-10"
---
# App Update Delivery

## Owns

This specification owns explicitly administrator-directed NanoCore and Web replacement on one configured deployment: the bounded public update command, process-independent host handoff, immutable source selection, maintenance and concurrency checks, host receipt, and observable failure/recovery behavior.

## Does Not Own

It does not own release publication, Git review/merge, NanoHost lifecycle, Worker containment, backup format, configuration reload, Task completion, human approval or a new deployment scheduler. It creates no fleet, second required instance, co-deployed Agent, general host command API, customer autonomous maintenance service, new Core database or cross-domain transaction. `20260829-release_management.md`, `20260909-persistent_deployment_acceptance.md`, `20260910-agent_operator_skill.md` and the existing storage, work, permissions and NanoHost owners retain their concerns.

## Core References

- `docs/core/architecture.md`
- `docs/core/permissions.md`
- `docs/core/work-model.md`
- `docs/core/audit.md`
- `docs/core/sandbox.md`

## Decision

Web and the public Skill may invoke the same administrator-only App update capability. NanoCore validates the request and sends one closed command to an installed host helper through a separately configured restricted SSH identity. The helper owns a short-lived supervised job outside the App process being replaced. The operations Skill can invoke and inspect that same helper through authorized host tools while NanoCore is unavailable. One persistent deployment is sufficient; optional staging does not change this contract.

NanoCore remains trusted to enforce current server-admin authority and user approvals. This feature does not introduce another signing authority or protect against an already malicious NanoCore binary. It does prevent a Workspace Worker or arbitrary caller from acquiring host command capability, changing the deployment target or selecting an untrusted source by request data. Host execution remains a separate effect domain whose result cannot be inferred from a Core request record.

## Authorization And Configuration

The capability is disabled when deployment configuration is absent. Configuration identifies one host, SSH user/port, one exact private identity file and pinned known-hosts file. The fixed helper command and target deployment are installed by an explicitly authorized operator; request data cannot choose a host, command, repository, Docker socket, mount, environment value or path. The SSH key is outside Data Root, images and Workspace/export trees, mounted only into the requesting App as a protected deployment secret. Enforce ordinary host-key verification, BatchMode, IdentitiesOnly, no agent forwarding and no port forwarding. Host-side `authorized_keys` restricts this identity to the fixed command, with no PTY or forwarding; its privileges cover only the configured App update procedure.

Both public reads and mutations require current deployment-admin/session or server-admin token authorization under existing owners. A direct authorized user's start request is consent for that exact source and expected current image. An Agent-mediated request must carry the existing valid user approval binding for that operation; the Agent cannot approve its own update or replace an exact approval with general task intent. Until the internal capability adapter can honor that binding, it reports unsupported and the Web administrator action remains usable. No update operation, key or host transport is included in AEPs or Workspace Worker tools. Public discovery does not grant access.

## Source And Request Contract

The public surface offers start and status operations. Start carries a caller request ID, a full source commit object ID, the expected currently running App image ID and explicit consent to the selected maintenance interruption. The approval unit is the source commit and expected current image; a locally built candidate digest is a later observed receipt field. Resolve a selected release to its exact source commit before start; do not execute a mutable `latest` selector. Status carries only the request ID. The host helper independently validates a closed JSON request from stdin with a maximum byte count and finite read deadline, rejecting unknown fields, paths, shell fragments and arbitrary verbs. It does not evaluate `SSH_ORIGINAL_COMMAND` as shell code. The App-key entry admits start/status only; stage requires the separately authorized operator entry. NanoCore validates the same public inputs before transport. The initial repository uses 40 lowercase hexadecimal Git commit IDs; image IDs retain their Docker `sha256:` identity.

Host-owned configuration fixes the source repository and authorized branch. A requested commit must be reachable from that branch after a bounded fetch, or already present as a verified source archive staged by a separately authorized operator. Staging verifies the archive's full Git commit identity and content digest before atomic placement in a private immutable candidate directory. Staging is not exposed through the App's restricted key. A local unpushed commit may therefore be staged without publishing a branch. A request cannot supply a new remote, tree, Dockerfile path or build command. Selecting an older commit is an explicit update request subject to the same data-compatibility checks, never implicit rollback permission.

## Host Lifecycle And Records

The host helper validates the closed request and current target, then creates or finds one receipt under its private update directory outside Data Root. The request ID binds immutable request parameters. An exact repeat returns the same observation without another job; a reused ID with different parameters is a conflict. A host lock held by the executing transient job admits at most one active update for the configured target; it is released by process termination, not kept alive by a receipt or abandoned SSH session. A different request during an update reports busy rather than stacking replacements.

NanoCore writes its authorized request Audit observation before sending start. The helper durably writes the accepted host receipt before launching one named transient service through existing host supervision, then returns its job identity. The caller supplies and retains the request ID before submission; an HTTP response or SSH connection can still be lost, and neither delivery nor a Core Audit handoff is assumed atomic with the host job. Re-read that request ID after an uncertain handoff instead of sending a new start. The job has a finite deadline, survives the caller's SSH disconnect and target App restart, and writes its receipt atomically as it advances. Preparation, application, verification and terminal success/failure are observations of this host job, not a second product Task lifecycle. A host restart or missing final receipt remains interrupted/unknown unless the supervisor and installed target prove a later result; the helper does not resume or retry an interrupted update automatically. If a pre-launch receipt has no corresponding live job after the bounded launch window, status records a terminal unknown observation and leaves no target lock behind. A fresh request requires inspection of the current target; it is not an automatic replay. No observer calls a missing job proof that an external effect never began.

Receipts retain the request/source identity, previous and candidate image IDs, old/new boot observations, stage, times, outcome, bounded redacted error, and whether the previous App was restored. They exclude secrets, raw logs, private environment values and product transcripts. The status response projects that receipt; absence or inability to read it is unavailable evidence, never success. Existing Core Audit records record authorization and the handoff observation. Existing Tasks or Artifacts may reference the request ID and later attach a retrieved receipt through ordinary public writes. The helper never writes Core storage, and a receipt does not accept an Artifact or complete an interrupted Turn.

## Apply And Verification

Prepare and smoke the exact candidate image before the maintenance window. Inspect active work and coordinate interruption under the persistent-acceptance owner. Immediately before replacement, re-check the expected current image and target identity under the host lock. A mismatch refuses the update. Do not flip a boot-readiness flag into a fabricated maintenance state or invent a second scheduler. The administrator's explicit maintenance consent permits interruption of the inspected work. An idle retained binding is not active execution and must not permanently block an update. Graceful App shutdown uses the existing shutdown and interrupted-work behavior; race-admitted work is recorded by those owners rather than claimed drained without a real admission barrier.

Preserve the deployment's Data Root, external Vault key, protected environment, NanoHost transport sink, network/port bindings, restart policy and log retention. Stop and retain the previous App, then start the candidate with the same owned settings. Never run two Apps on the same writable Data Root. If Web assets are external, switch the matching staged assets in that same stopped-App window. Do not rebuild, restart, reenroll or modify NanoHost, unrelated services or the host reverse proxy as an App update side effect.

Before the first candidate boot, establish whether the current data/configuration is compatible with a return to the previous image. Existing schema migration/version evidence and an explicit compatible candidate assessment decide this; absence is not proof. Configuration edits required by a new parser are staged and applied while the App is stopped. Retain protected copies for inspection; do not infer that reverting image or configuration reverses a data migration.

Success requires the candidate's actual image/source and Web asset identity, a new observed boot, `acceptingProductWork`, no blocking readiness reasons, an authenticated read of retained product data, the unchanged NanoHost identity/generation returning to readiness when it was connected before the update, and a successful read-only helper-status request through the new App so the update capability has not silently removed itself. Only explicitly admitted nonblocking readiness reasons, initially `storage.index-rebuilt`, may be tolerated. Record every predicate separately. These predicates establish App update operability, not all roadmap or L6 acceptance.

On preparation failure, leave the running App unchanged. If candidate verification fails and the previous image is proved compatible with current data/configuration, the same host job must attempt to restore the previous App and its matching Web assets; record the update as failed with recovery observed. Otherwise stop to explicit host recovery and preserve both evidence and data. Never restore a data backup automatically, restart NanoHost to force a pass, or repeat the host effect after an uncertain response. The operations Skill provides the offline inspection path.

## Current Implementation Projection

Existing deployment procedures already build and replace exact App/Web snapshots while retaining NanoHost. There is no first-party Web update capability or installed restricted helper yet. The first implementation targets the existing Linux/systemd/Docker deployment; other supported deployment shapes retain their normal operator procedures until a concrete equivalent is implemented. This is not a new hard qualification requirement for all NanoCore installations.

## Rollout And Acceptance

Install the helper and restricted key only for an explicitly selected deployment after the design is accepted. Keep the feature absent elsewhere. The first real proof uses a migration-free update and may update A2 with unchanged NanoHost; a1 staging is optional and uses its own data, ports and credentials when admitted. A migration-bearing update requires a verified available operator host-recovery path before start. Public Skill/Core Client and Web project the same operations and errors; the operations Skill documents offline status/recovery from the same helper.

Lowest sufficient checks prove authorization, strict command input, source/current-image guards, duplicate identity/conflict, absence of Worker supply, secret redaction and honest unknown results. A host-domain test proves that the job survives the caller and replaced process, rejects concurrent/stale requests, and does not touch unrelated services. A real selected-host update records actual before/after identities and post-boot product reads. A failed candidate test observes bounded restoration or explicit maintenance without assuming database rollback. No test may claim full success from a mocked receipt or `docker ps` alone.
