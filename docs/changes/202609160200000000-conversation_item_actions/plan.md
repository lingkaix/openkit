---
type: change-plan
status: verified
---
# Conversation Item Actions And Evidence

## Intent

The engineer's September 16 browser annotations on staging Thread ws_7/th_74 identify three problems: an approval without usable controls or explanation, a workspace-change Artifact that cannot be opened, and a denial without understandable actor, time, reason, or client/source information. Each fix must be committed separately. This work authorizes local fixes and commits, not live approval decisions, Git pushes, staging deployment, or workspace-change application.

## Owners

`docs/specs/20260531-human_attention_intervention_model.md` owns approvals and review interactions; `docs/specs/20260703-workspace_synchronization.md` owns staged workspace changes; `docs/core/audit.md` and `docs/specs/20260715-multi_user_workspace_system.md` own decision identity and evidence; `DESIGN.md` owns the Web presentation.

## Checkpoint

The live UI confirms a request followed by a system denial with no remaining response controls. `deriveApprovalStateFromItems` closes undecided requests belonging to terminal Turns at boot, attributing them to nanocore-boot-reconciliation; its timestamp is copied from Turn completion/start or request creation, not necessarily boot wall time. The Artifact row has no onOpen handler. Initial scope is frontend projection over existing authoritative records; no durable schema change is currently needed.

Approval usability is committed as 60ebbbb and Artifact inspection as 0a9931e6. Decision explanations are implemented and verified in the final dedicated commit. Source-record limitations remain explicit rather than fabricated.

## Acceptance

Closed requests explain their outcome and cannot be re-approved. Current unresolved requests retain server-governed actions with pending/error feedback and exact retry identity. Artifact references open their exact content and workspace-change review. Decision details show supported actor, timestamp provenance, reason, and source; missing historical client/reason data is explicitly unavailable.

## Approval Fix Verification

The initial three regressions failed on missing closed/ended explanations and pending feedback. Independent review additionally found a loading window and status-only actionability; delayed-dashboard and exact-Gate/live-update regressions now cover those cases. Approval fixtures use parsed Turns with the matching durable Gate. The existing empty-replay assertion was aligned with its running, non-gated Turn rather than falsely offering a stale approval. `pnpm --filter @openkit/web exec vitest run src/screens/chat/chat.test.tsx` passed 83 tests; Web build and typecheck passed with the existing large-chunk warning. Focused Biome and diff whitespace checks passed. No staging decision was submitted.

Independent reviewer review_conversation_targets found no remaining actionable findings after the loading and exact-Gate corrections; its 14 focused approval tests, Web typecheck, and whitespace check passed. The first dedicated commit closes the approval-card fix; Artifact inspection and decision explanations remain open.

## Artifact Fix Verification

The two initial regression cases failed because neither stream nor sidebar exposed View content. The shared inspection now loads only on opening, supports retry, refuses a different Artifact version, and displays recorded change paths and patch content. Three focused regressions passed; the full Chat suite passed 86 tests. Web typecheck/build, focused Biome, documentation validation (274 documents), and whitespace checks passed. An additional unchanged Artifact inventory suite failed collection because its existing Thread fixture omits required visibility; both that fixture and the Thread schema are unchanged from HEAD. Independent reviewer review_conversation_targets inspected the actual component and consumers and found no actionable findings; its focused tests, typecheck, lint and whitespace checks passed. Browser inspection of the actual source components with built styles at 831 by 803 confirmed a readable dialog, expanded full content, reachable Close, and no horizontal document overflow. No live review was decided or applied.

## Verification

The three initial decision-evidence regressions failed on missing system attribution, recovery provenance, and policy-grant explanation. All now pass; the complete Chat suite passes 89 tests. Two existing broad actor-name queries were narrowed to the same exact visible attribution because the new identifier disclosure repeats the stable actor id. Web typecheck/build passed, retaining the existing large-chunk warning; documentation validation passed for 274 documents. Browser inspection at the reported 831 by 803 viewport used actual source components and production CSS: request correlation, localized timestamp with timezone, recovery explanation, source/client facts, and expanded record identifiers were readable with no document overflow. Temporary tabs/server were closed and the viewport reset. This is local evidence, not a staging deployment. The unrelated Artifact inventory fixture collection failure remains documented above.

Independent reviewer review_conversation_targets inspected the final diff, protocol, schema and all decision producers, found no actionable findings, and independently passed Web typecheck and whitespace validation. Staged lint passed for all six final-slice files.

## Closeout Summary

The three annotated UI problems are handled in separate commits: truthful approval availability with retry, readable exact-version Artifact inspection from both entry points, and decision explanations grounded in stored actor and operation semantics. The annotated denial is a server recovery closure of a terminal task's undecided approval; its inherited timestamp cannot establish actual recovery time. Human reason and client metadata absent from the current Item contract remain explicitly unrecorded. No external approval, workspace apply, Git push, deployment, or new durable audit model was introduced.
