---
type: change-plan
status: in-progress
date: "2026-09-10"
---
# Persistent Worker Environments

## Intent Epoch 1

The engineer requests that Worker sandboxes behave as long-lived lightweight VM-like working resources, while NanoCore remains the backend-independent orchestration center. Persist and remount useful working storage through compatible image replacement and planned or accidental container/epoch restart. NanoCore/Web updates must not routinely restart NanoHost. Desktop and internal Operations Agents must prepare and activate a changed environment through owned operations, including adding software during a long-running task with truthful interruption/continuity semantics. Primary writes Core/key specs personally, consults independent Claude Code, obtains independent review and audit, commits documentation first, then creates a new plan and completely implements the design. Product Vision remains untouched. Source: engineer messages in this thread on 2026-09-10.

## Intent Epoch 2

The engineer clarifies that ignored temp/, native runtime conversations, memory, configuration and similar files are examples, not a complete inventory. Preserve and reuse entire volumes generically; no file-kind allowlist or per-runtime data migration registry. Inherited base-image storage layout should support ordinary derived images adding tools or upgrading software. Mount compatibility does not assert native-format rollback or process-memory continuity. Source: subsequent engineer corrections in this thread.

## Intent Epoch 3

The engineer makes Workspace and work relatedness central to reuse: isolate Workspaces, prefer reusing suitable idle Workers and volumes for related Tasks/Goals within one Workspace, but let Operator/Orchestrator Agents choose dynamically rather than a mechanical similarity algorithm. The settled interpretation permits explicit selection of an idle retained association for new related work after its old Sandbox is gone, with cumulative source-audience admission, contributor/independent-review isolation, compatible layout and fenced writers. No-input admission creates fresh retained storage; a Goal may explicitly select reuse for child work with current eligibility rechecked. Source: latest engineer steering in this thread.

## Owners

- [Persistent Worker Volumes](../../specs/20260910-persistent_worker_volumes.md) owns generic storage, admission, replacement and acceptance.
- [Storage](../../core/storage.md), [Runtime](../../core/runtime-model.md) and [Sandbox](../../core/sandbox.md) own durable boundaries.
- [NanoHost](../../specs/20260802-nanohost_runtime_and_transport.md) owns fixed transport, host effects and epoch fencing.
- [Materialization](../../specs/20260704-session_static_workspace_materialization.md) and the native adapter specifications own retained data versus disposable control.
- [Environment Images](../../specs/20260721-worker_execution_environment_images.md) owns inherited image supply.
- [Thread entry and visibility](../../specs/20260909-thread_visibility_and_sharing.md) owns immutable private administration routing and its record cutover.
- [Internal administration](../../specs/20260704-chat_mode_assistant.md) and [Operator Skill](../../specs/20260910-agent_operator_skill.md) own the two operation entries.

## Decisions And Evidence

Independent Claude session 61f72bec-5abd-48fe-8956-b1f8c22044ca challenged Workspace/user-derived sharing, per-file retention, host UID allocation and an unnecessary combined environment-inspect operation. Settled opaque per-admitted-group storageRef with current cumulative audience checks, explicit Agent selection, transactional attachment CAS, whole volumes, host-owned 0700 parents, inherited OCI Volumes and numeric User, generic seed-once per target, fresh control, bounded image.inspect/storage.inspect/storage.purge on existing carriage, and no new journal. Current read requests do not inherit effect recovery; partial purge fences only its ref. The readonly bootstrap candidate was refuted by the pinned OpenShell actual write probe and corrected to writable ephemeral /tmp/openkit-bootstrap; immutable base Python supply moves under /opt. Pinned upstream source is OpenShell 0.0.99 at 8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032. Temporary source, consultations and independent doc findings are under temp/persistent-worker-environment/.

## Checkpoint

Documentation commit `02daa009` precedes this implementation plan; independent reviewer and auditor accepted its actual diff with no outstanding design findings, and document checks plus 16 root/spec tests passed. Production implementation is in progress across image/policy, host storage, shim retention, Core attachment admission, public operations and the shared internal loop. Baseline destructive paths are the deciding regressions; intermediate builder output is not acceptance. No mounted-volume or live continuity PASS exists for this change.

Next action: implement image/policy prerequisite, host storage effects, shim retention and Core association/admission in disjoint owned paths, then connect the existing Web/internal and Desktop Skill operations. Expected observations are focused regressions that fail against current destructive behavior and pass only with whole-volume preservation, scope/writer rejection, safe initial seeding and truthful failure. The real pinned-runtime path must prove a compatible derived image adds a usable tool while reusing unknown bytes, then survive a real epoch restart. A containment/mount obstacle or inability to prove predecessor fencing stops dependent integration for correction.

Verification uses the lowest sufficient checks, then an expressly named isolated real-host fixture for destructive restart/replacement. Before host effects record exact target, prerequisites, cleanup and retained evidence; do not routinely restart A2 NanoHost or tear down unrelated services. Local Docker and authorized A1 test-host resources are available. Evidence belongs under the matching temp/changes/ bundle. Core-only backup cannot certify host data coverage; data persistence cannot certify process survival, native resume or all-roadmap completion.

Independent Claude performed the fresh direction observation after primary compaction, reading Intent Epoch 5, the current plan and actual owner diffs. Verdict: Continue with the broad catalog wording narrowed to technical effects and current result settlement separated from new dispatch/apply authorization. Evidence: `temp/changes/202609101342020001-persistent_worker_environments/consultant-admin-direction.txt`. Existing local-mode implicit administration remains with the identity owner; this team/server-mode clarification does not replace local authentication. Candidate preparation reuses immutable authored/resolved Artifacts, private administration Items and payload-bound human command confirmation/receipts; no Worker lease, proposal registry or operation journal is added. Independent reviewer and auditor accepted these authority amendments after correcting the local/server wording, fixed Tool count, ordinary Skill-selection boundary and candidate-build alternative. Document-model validation (255 documents), lifecycle/index checks and 16 root/spec tests passed. Production and live-environment acceptance remain pending.

A subsequent direct code probe refuted two implementation shortcuts: expiring conversation receipts or prose/ID markers cannot own durable administration entry, and create-only Artifact v1 plus MCP-specific Approval resumption cannot implement generic candidate revision and pause/resume without unnecessary expansion. Claude endorsed one immutable server-authored Thread.entryPath and separate authored/resolved v1 Artifacts, with the existing payload-bound human command confirmation/receipt path. Build identity comes from the pre-dispatch authored Artifact. Evidence: `temp/changes/202609101342020001-persistent_worker_environments/consultant-candidate-command.txt`. This reframes the over-specific ApprovalRequest implementation wording, not the user's required human approval, current authority or private audience. Independent reviewer and auditor accepted the corrected authority bytes, including private administration provenance, exact confirmation/receipt semantics and the record feature registry. Lifecycle, documentation-model, generated-index and diff checks passed.

## Current Integration Dependency

Direct inspection of mode-entry-routes.ts and the Assistant specification's implementation projection confirms that the shared Internal Agent Loop and private administration entry remain unimplemented; the current fallback calls callQuickChatProvider directly. Independent Claude recommends delivering storage and real public Web/Skill operations here, with Desktop Agents making actual reuse choices, and tracking internal Operator integration under its runtime/privacy owner rather than inventing a bespoke Assistant runtime. The engineer chose to include those prerequisites, as preserved in Intent Epoch 4. A dedicated builder now implements the minimal accepted shared loop and private administration entry; image, host, shim, Core and public operation work continue independently. No internal Operator readiness claim is made before that path is implemented and exercised.

## Intent Epoch 4

The engineer explicitly chooses to implement the internal Agent prerequisites in this change after being informed that the shared Internal Agent Loop and private administration entry are missing. Source: user reply "Implement the internal Agent prerequisites in this change as well" on 2026-09-10. Deliver the minimal shared loop and private administration entry needed for the same environment operations and Agent reuse proposals, under their existing accepted runtime/Assistant/privacy owners. Do not replace the internal runtime with a Worker harness or silently enable unrelated external tools. This supersedes the pending dependency-scope question above; internal Operator integration is required for this plan's completion.

## Intent Epoch 5

The engineer explicitly states that Assistant/Operator system operations depend on the requesting user's valid administrator token. Technical staff or engineers administer the team deployment and decide system changes, including technical configuration affecting system behavior; ordinary users such as lawyers, doctors, marketers or designers ask that administrator rather than authorizing such changes themselves. Workspace membership and ordinary human confirmation do not grant system-management authority. The model never receives the token secret or acts through an independent privileged service identity. Routine work using already admitted resources remains distinct from technical configuration changes. Source: engineer clarification during implementation on 2026-09-10.
