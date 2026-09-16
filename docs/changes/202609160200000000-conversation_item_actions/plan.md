---
type: change-plan
status: in-progress
---
# Conversation Item Actions And Evidence

## Intent

The engineer's September 16 browser annotations on staging Thread ws_7/th_74 identify three problems: an approval without usable controls or explanation, a workspace-change Artifact that cannot be opened, and a denial without understandable actor, time, reason, or client/source information. Each fix must be committed separately. This work authorizes local fixes and commits, not live approval decisions, Git pushes, staging deployment, or workspace-change application.

## Owners

`docs/specs/20260531-human_attention_intervention_model.md` owns approvals and review interactions; `docs/specs/20260703-workspace_synchronization.md` owns staged workspace changes; `docs/core/audit.md` and `docs/specs/20260715-multi_user_workspace_system.md` own decision identity and evidence; `DESIGN.md` owns the Web presentation.

## Checkpoint

The live UI confirms a request followed by a system denial with no remaining response controls. `deriveApprovalStateFromItems` closes undecided requests belonging to terminal Turns at boot, attributing them to nanocore-boot-reconciliation; its timestamp is copied from Turn completion/start or request creation, not necessarily boot wall time. The Artifact row has no onOpen handler. Initial scope is frontend projection over existing authoritative records; no durable schema change is currently needed.

Next action: first restore approval usability through clear closed/unavailable states and pending/error/retry feedback, verify and commit; then connect Artifact inspection and finally decision explanations. Source-record limitations must remain explicit rather than fabricated.

## Acceptance

Closed requests explain their outcome and cannot be re-approved. Current unresolved requests retain server-governed actions with pending/error feedback and exact retry identity. Artifact references open their exact content and workspace-change review. Decision details show supported actor, timestamp provenance, reason, and source; missing historical client/reason data is explicitly unavailable.

## Approval Fix Verification

The initial three regressions failed on missing closed/ended explanations and pending feedback. Independent review additionally found a loading window and status-only actionability; delayed-dashboard and exact-Gate/live-update regressions now cover those cases. Approval fixtures use parsed Turns with the matching durable Gate. The existing empty-replay assertion was aligned with its running, non-gated Turn rather than falsely offering a stale approval. `pnpm --filter @openkit/web exec vitest run src/screens/chat/chat.test.tsx` passed 83 tests; Web build and typecheck passed with the existing large-chunk warning. Focused Biome and diff whitespace checks passed. No staging decision was submitted.

Independent reviewer review_conversation_targets found no remaining actionable findings after the loading and exact-Gate corrections; its 14 focused approval tests, Web typecheck, and whitespace check passed. The first dedicated commit closes the approval-card fix; Artifact inspection and decision explanations remain open.
