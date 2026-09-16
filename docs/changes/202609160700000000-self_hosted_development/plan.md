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

Local baseline was clean at e44c78f0. The deployed browser shows the earlier message-identity, navigation, and composer corrections; image inspection confirms the latest icon commit is not yet deployed. Source Skill doctor against https://ai.simonxu.net succeeded using the existing protected endpoint credential; NanoCore reports ready and protocol 0.5.0. This establishes connection only. The composer offers OrcaRouter; AI interface and Gateway diagnostics both confirm physical model deepseek/deepseek-v4-flash-free. Existing task history displays Task input as raw JSON, a usability finding awaiting an owning-path trace. New-conversation Recent ordering differed from the activity-ordered sidebar and is now corrected locally.

Current direction: commit proved bounded defects, restore the existing private-Thread audience boundary across public interfaces, and request deployment of the concrete batch before a code-changing Worker attempt against the intended source revision. The real development loop has not passed. Claude Code was invoked through Herdr for consultation but reports an expired login; the existing independent Consultant is reviewing the authorization finding while ordinary fixes continue.

## First Live Observations

The fixed deployed App is container openkit-staging, image tag openkit/app:staging-bdd94349e96fb0e6017a5b0f8d086c2e60fa6367, image ID sha256:f034d9f996d424a12c6e1122ee8bcc6baeaa9ee7a1b15cfcb470b3fa867c3e69, started 2026-09-16T04:51:13.371942156Z. This is earlier than local e44c78f0; do not claim the last local icon correction is deployed. Non-secret Docker identity was read through authorized SSH a2 with sudo. No service was changed.

The installed complete Skill at /Users/m5pro/.codex/skills/openkit passes doctor and workspace.list with the existing protected endpoint credential. Web uses the signed-in editor while the stored Skill credential has a different effective scope; parity observations must preserve that difference. AI interface displays OrcaRouter model deepseek/deepseek-v4-flash-free. A bounded Web Chat produced three relevant Chinese acceptance-evidence bullets in ws_7/th_81. This proves Chat only, not Worker execution.

Overview displays seven Workspace Review attention rows with no Open controls. The existing openHrefForRow omitted workspace_review and workspace_recovery, which have no Thread. Both now route to the existing selected-Workspace changes surface with an accurate accessible label; decisions remain there. Two focused regressions failed before the correction; 152 Workspace and Workspace Sync tests passed afterward. Web build passed with the existing chunk-size warning. Evidence: /tmp/openkit-overview-red.log, /tmp/openkit-overview-green.log, /tmp/openkit-overview-build.log. This is a Web projection correction; existing public sync review operations are already discoverable through the installed Skill.

Independent Consultant check_self_hosted_route returned Continue: prioritize the real development loop over page polish, reuse public Skill operations and existing App update receipts, and retain exact model/build/result attribution. Obtain the next direction observation after the first real development loop, before committing to a further batch of cross-backend changes.

Pages observed so far: existing Task history, Chat starter and successful Chat, Overview, Agents (empty even though Worker targets exist elsewhere; Refresh health exercised), Knowledge, Artifacts (internal reviews correctly excluded), Account, AI interface, Workspace changes, and Repositories. Repository loading fails after Retry; cross-interface diagnosis is next. Workspace changes exposes exact patches but foregrounds long internal IDs and duplicates operational inventories; retain as a usability finding rather than pretending it is a user-ready review experience.

## Current Development Attempt And Shared Contract Repair

The Web-created Task ws_7/th_82, Turn tu_conversation_e103462daef02515e9eee9ee, started at 2026-09-16T05:08:54.229Z to fix Recent conversation ordering and failed at 05:21:24.892Z: `worker_governance_turn_failed`, "Last worker inference stream failed before completion." It retained an accepted status Item but produced no code changes or Artifact. Its execution snapshot selects orcarouter, while the remounted composer shows the default GPT-6; these are different observations. Runtime evidence attributes 226 Gateway calls to this Turn, records successful transcript collection and teardown, and does not establish why inference failed. No push, approval, merge, cancellation or deployment was performed.

Repository diagnostics report missing local directories. The host repository /home/ubuntu/openkit/workspaces-repos/openkit exists at 3b85590; the live App container has no repository bind mount and /srv/repos/openkit is absent. The existing deployment script requires workspaces-repos bound at /srv/repos. The Worker separately materialized its Git source at older pin 4879812a5c705d46d04f293692a7edec5f810558; the missing Core mount is not evidence of the model-stream failure's cause. NanoHost is active and reports the configured target ready; readiness is not successful Task evidence.

The public usage.read operation and Web Usage page fail because CapabilityUsageCallSchema omits network although the canonical ledger and accepted Git push contract already require it. The schema now admits that existing family, with a Git push regression. Package tests pass 143/143, typecheck and lint pass, and Web plus Skill builds pass. The freshly built Skill interface suite exposes three separate existing parity/harness failures (missing listConversationNavigation and two token-delivery checks); retain /tmp/openkit-usage-skill-test.log and correct them rather than claiming a full Skill PASS.

Additional pages exercised: General draft edit and Reset without saving, Catalog native file-picker entry, Recovery (empty), Archived threads, Vault (read errors), Usage (read error), and Appearance (Spectrum/Noir/Paper switched and original Paper restored). The file picker caused no accessibility-tree change; that is not evidence of a Catalog defect and the speculative UI change was removed. Configuration draft validation, App update form choices, administration environment status, access-token metadata, audit records, backup controls and Workspace access recovery were inspected without effectful administration. No token, role, deployment, backup or environment change was performed. Authentication is restored for Cursor CLI; Herdr agents implement bounded corrections while the primary owns integration, the generated Skill, documentation, and commits.

## Verified Corrections And Remaining Blockers

Committed corrections include Overview review links (674ddca8), network capability usage (c968c174), typed repository access-denial presentation (b15cdde5), recorded Task failure after reload (c415442), public Skill conversation navigation with isolated credential test storage (fda08c23), Recent activity ordering with mode-correct routes (32e4e5d), public content slash preservation (b4476128), and retained Worker stream diagnostics (3f9065c3). Focused evidence: 152 Workspace tests, 143 App schema tests, 2 failed-Turn tests, 92 Chat tests, and 41 public Skill interface tests passed. Web typecheck and builds passed for the relevant slices; these local results await deployment verification.

Explicit Skill import created ar_import_60c324cd46d488f58441f088 version 1, "Dogfood report — 2026-09-16". Web opened its Markdown body correctly and added its exact-version reference to the test Chat th_81 without starting Agent work. Skill artifact.read incorrectly redacted the standalone slash in "OrcaRouter / DeepSeek Flash Free"; the shared public redactor now preserves that punctuation with path and credential protection retained. The 42-test Skill suite passed, the installed package was refreshed, and artifact.read returned the original body and digest.

The stored Skill credential belongs to user_local, while the browser session is a different user. On the test-created private Task th_82, Core Thread/Turn/Item reads returned content but the App dashboard correctly returned 404. Independent source review confirmed missing Core audience gates under docs/core/permissions.md and docs/specs/20260909-thread_visibility_and_sharing.md. No further cross-user private reads are needed. Restore the existing visibility helper at shared authorization seams and audit indirect identifiers before acceptance; this correction does not grant new rights or redefine private ownership.


## Bounded Worker Probe And Current Review

An explicit New Shard + Worker request through Web created workspace-visible Thread th_task_4a3e323ace91782dfd9f8559 and Turn tu_conversation_45b375d0ce20e450997343cb. It completed from 2026-09-16T06:04:47.869Z to 06:05:09.819Z (21,950 ms), running only git rev-parse HEAD and git status --short. Web and Skill both exposed the completed result. The authoritative package snapshot selected orcarouter; the Worker reported clean source revision 4879812a5c705d46d04f293692a7edec5f810558. The remounted composer displayed GPT-6 Astra, a separate unresolved selection/display defect. This proves bounded execution, not a code-change/review/apply loop.

The failed earlier Task had 226 attributed Gateway calls: 215 successful and 11 stream failures. Existing evidence does not distinguish transport loss from missing provider completion. A classifier collapsed the known provider_stream_truncated and provider_stream_failed diagnostics; the committed correction preserves these on durable capability calls while keeping the fixed redacted public Gateway JSON/SSE vocabulary and failed terminal state. All 204 focused Gateway, Worker inference, and executor tests passed; staged lint passed. The public Skill recovery reference describes how to inspect the same evidence without inferring an unsupported cause.

Independent review of the private-audience correction identified enforcement-order gaps in Generative UI and Action Center, opaque queue-id enumeration, and unfiltered Workspace Thread counts. Corrections and exact regressions are in progress. Existing invalid token fixtures and old missing/foreign Thread response expectations are being aligned with durable token validation and the nondisclosing 404 boundary; shared cross-user behavior and no-effect checks remain required. Workspace export, private-to-shared Worker handoff, and runtime context assembly remain separately identified surfaces, not claims of completed privacy coverage.

An authority conflict remains pending the engineer: canonical membership rules prohibit server-admin Workspace bypass, while accepted and merged Issue 13 / PR 12 and Issue 58 / PR 63 explicitly implement full-system server-admin bearer access without membership. The existing bypass is unchanged while the engineer chooses the governing rule. Both interpretations preserve exact private Thread ownership. Claude Code consultation through Herdr remains unavailable because its login is expired; no authority decision is inferred from that failure.


The complete NanoCore suite was exercised during integration: 2,975 passed, 70 failed, one skipped across 275 files. A detached 3f9065c3 baseline reproduced 66 failures across the ten affected pre-existing test files (272 tests passed there), so those failures are not attributed to the uncommitted Thread correction. The four newly failing cases were the in-progress Action Center audience regression and three Quick Chat admission fixtures, assigned to their owners for correction without weakening mode restrictions. The generated OpenAPI drift was the missing network usage projection from the earlier schema correction; regeneration and validation plus 25 OpenAPI tests passed, committed as f710243. Baseline comparison evidence: /tmp/openkit-audience-full-test.log and /tmp/openkit-audience-baseline-test.log. The broad suite is not claimed green.


The independent Consultant rechecked the merged Issue 13/58 and PR 12/63 evidence and withdrew the earlier recommendation to remove server-admin bypass from canonical text alone. Continue with the current authority question pending. Finish and commit the bounded audience correction, then stop expanding local implementation: request the concrete App revision, existing repository bind mount and obtainable exact Worker source revision, and use the next deployment window for a real code-change/review/apply loop.


## Accepted Audience Correction

Independent review accepted the bounded Thread-audience restoration after inspecting final production/test bytes. Central guard/list/count/create-replay/SSE checks passed 87 tests across 12 files; three Quick Chat tests retain their original mode rejection with valid owner-private fixtures. Action Center, scheduler, recovery and generated presentation tests passed 40 tests across ten files; the retained private-source/shared-target projection additionally covers both a different member and the source owner, with seven Generative UI tests passing. A foreign-Workspace Approval using a visible Thread id reproduced 403 instead of nondisclosing 404 before the exact Workspace-owner check and passed after it. NanoCore typecheck and build passed. Cursor service High Load interrupted the final two builders; the primary completed their bounded remaining changes and the independent reviewer accepted those final bytes.

The final full NanoCore run completed with 2,980 passed, 65 failed and one skipped across 275 files. Every remaining failure name also occurs in the detached 3f9065c3 baseline; the generated OpenAPI failure is resolved, and there are no new failure names. Evidence: /tmp/openkit-core-audience-final-test.log, /tmp/openkit-projection-audience-final-test.log, /tmp/openkit-source-audience-final-test.log, /tmp/openkit-audience-final-typecheck.log, /tmp/openkit-audience-final-build.log, /tmp/openkit-audience-final-full-test.log. This is bounded correction acceptance, not a green release gate or completed development migration.

## Next Live Window

Redeploy the final committed batch to the existing A2 staging App, restore the existing bind mount from /home/ubuntu/openkit/workspaces-repos to /srv/repos, and make the selected exact Worker repository source revision obtainable through its configured Git source. Reconfirm App image identity, repository mount and Worker checkout HEAD before starting a new code-changing Task. Use OrcaRouter / DeepSeek Flash Free, inspect the same resulting patch through Web and Skill, and exercise the existing human review/apply path. Do not infer that deploying the App updates the separately pinned Worker source. No push, service change or deployment was performed by this task.
