---
type: change-plan
status: in-progress
---
# Develop And Maintain OpenKit Through OpenKit

## Intent Epoch 1

Source: the engineer's 2026-09-16 request after redeploying the latest code on SSH host a2 at https://ai.simonxu.net. Exercise every page and its useful operations using OrcaRouter / DeepSeek Flash Free, fix observed problems and make justified improvements, commit each completed correction, and continue until OpenKit development and maintenance can move into Workspace ws_7. Changes beyond Web presentation must also reach the public OpenKit Skill and be exercised there. The engineer authorizes live product testing and Skill installation. Existing human approval gates, credential protections, and unrelated work remain intact.

## Owners

- `docs/core/work-model.md` owns the user-facing work backbone and execution narratives.
- `docs/specs/20260628-web_product_surface_projection.md` and `DESIGN.md` own Web projections.
- `docs/specs/20260713-openkit_agent_skill_interface.md` owns the public Skill and operation parity.
- `docs/specs/20260704-task_mode_worker_delegation.md` and the applicable Goal, repository, approval, and workspace-sync specifications own execution and delivery.
- `docs/specs/20260909-persistent_deployment_acceptance.md` and `docs/cookbooks/persistent-live-acceptance.md` own live-use attribution and repair boundaries.

## Method And Acceptance

Start with the deployed UI and public Skill, preserve concrete failures, and reduce deterministic defects into focused regressions. Prioritize the development loop: submit a bounded task with the requested model, observe execution, inspect exact changes, handle required human decisions, and locate durable results through both interfaces. Inspect every published page and safe meaningful controls; do not exercise destructive administration merely for coverage. Preserve existing data and services. Local fixes are committed individually; deployed and locally verified behavior are distinguished. Broad migration success requires a real completed development loop and an identified supported maintenance path, not only passing UI tests.

## Checkpoint

Local baseline is clean at e44c78f0. The browser visibly shows the earlier message-identity, navigation, composer, and icon corrections. Source Skill doctor against https://ai.simonxu.net succeeded using the existing protected endpoint credential; NanoCore reports ready and protocol 0.5.0. This establishes connection only. The composer offers OrcaRouter as a logical model; its physical model is not yet verified. Existing task history displays Task input as raw JSON, a usability finding awaiting an owning-path trace. New-conversation Recent ordering differs from the activity-ordered sidebar, also awaiting a focused check.

Next action: inspect the deployed provider/model mapping and capability access, complete a bounded live conversation, inventory published pages, and fix the first proved workflow blocker. Keep page observations and attempt identifiers here as evidence accumulates.

## First Live Observations

The fixed deployed App is container openkit-staging, image tag openkit/app:staging-bdd94349e96fb0e6017a5b0f8d086c2e60fa6367, image ID sha256:f034d9f996d424a12c6e1122ee8bcc6baeaa9ee7a1b15cfcb470b3fa867c3e69, started 2026-09-16T04:51:13.371942156Z. This is earlier than local e44c78f0; do not claim the last local icon correction is deployed. Non-secret Docker identity was read through authorized SSH a2 with sudo. No service was changed.

The installed complete Skill at /Users/m5pro/.codex/skills/openkit passes doctor and workspace.list with the existing protected endpoint credential. Web uses the signed-in editor while the stored Skill credential has a different effective scope; parity observations must preserve that difference. AI interface displays OrcaRouter model deepseek/deepseek-v4-flash-free. A bounded Web Chat produced three relevant Chinese acceptance-evidence bullets in ws_7/th_81. This proves Chat only, not Worker execution.

Overview displays seven Workspace Review attention rows with no Open controls. The existing openHrefForRow omitted workspace_review and workspace_recovery, which have no Thread. Both now route to the existing selected-Workspace changes surface with an accurate accessible label; decisions remain there. Two focused regressions failed before the correction; 152 Workspace and Workspace Sync tests passed afterward. Web build passed with the existing chunk-size warning. Evidence: /tmp/openkit-overview-red.log, /tmp/openkit-overview-green.log, /tmp/openkit-overview-build.log. This is a Web projection correction; existing public sync review operations are already discoverable through the installed Skill.

Independent Consultant check_self_hosted_route returned Continue: prioritize the real development loop over page polish, reuse public Skill operations and existing App update receipts, and retain exact model/build/result attribution. Obtain the next direction observation after the first real development loop, before committing to a further batch of cross-backend changes.

Pages observed so far: existing Task history, Chat starter and successful Chat, Overview, Agents (empty even though Worker targets exist elsewhere; Refresh health exercised), Knowledge, Artifacts (internal reviews correctly excluded), Account, AI interface, Workspace changes, and Repositories. Repository loading fails after Retry; cross-interface diagnosis is next. Workspace changes exposes exact patches but foregrounds long internal IDs and duplicates operational inventories; retain as a usability finding rather than pretending it is a user-ready review experience.
