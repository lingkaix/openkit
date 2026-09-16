---
type: change-plan
status: verified
---
# Conversation Author Identity

## Intent

The engineer's September 16 browser comment requests group-chat attribution: show human names and avatars, align the authenticated account on the right, align other humans and agents on the left, and visually distinguish human and agent messages. Each completed fix must be committed separately. Deployment and push are outside this change.

## Owners

`docs/specs/20260715-multi_user_workspace_system.md` owns immutable attribution and its bounded projection; `DESIGN.md` owns message presentation. No durable identity or roster is added.

## Checkpoint

The previous Composer fix is commit `88720adf`. Initial regressions failed on missing viewer identity and named message articles. Consultant check_author_projection returned Continue for the existing authorized dashboard boundary, requiring unknown-author metadata refresh and clearing viewer-bearing caches at account transitions. Producer paths confirm that Worker transcript Items use the admitted Turn and its assigned `agentId`; internal replies use separate Turns without that assignment. The implementation uses recorded Worker names and otherwise the honest Agent label. Implementation and focused checks are complete. Independent reviewer review_conversation_targets found no actionable findings after reading the actual diff and owners and independently checking bounded API projection, Web attribution and live refresh, account-transition isolation, baseline failures, and the narrow generated contract delta.

## Acceptance

Current-account humans alone align right with You; other humans align left with display names and circle avatars; agents align left with square avatars and unboxed text. Missing profiles retain stable ids. Only recorded Thread participants are projected, without private fields. Account changes discard viewer metadata. Focused regressions, typechecks/build, generated contract validation, and independent review precede the dedicated commit.

## Verification

- Initial focused API and Web checks failed on the intended missing attribution behavior before implementation; test fixture corrections then created actual Items and renamed the local User after app initialization.
- `pnpm --filter @openkit/nanocore exec vitest run src/thread-dashboard.test.ts`: 7 passed, including bounded participants, missing profile fallback, and existing authorization coverage.
- `pnpm --filter @openkit/app-api-schemas test`: 143 passed; `pnpm --filter @openkit/core-client test`: 83 passed.
- `pnpm --filter @openkit/web exec vitest run src/screens/chat/chat.test.tsx src/primitives/primitives.test.tsx`: 154 passed, including two viewer identities and a newly arriving author.
- `pnpm --filter @openkit/web exec vitest run src/screens/account/account.test.tsx -t 'independently isolates'`: 3 passed; 77 unrelated tests not selected.
- The broader account run had 79 passes and one existing failure: the neutral Account screen assertion rejects the sidebar's Deployment backup label. The exact failure reproduced against archived `88720adf` Web source under `temp/conversation-author-baseline/`; this change does not alter that sidebar or weaken its check.
- App API schema build, NanoCore and Core Client typechecks, Web production build, and OpenAPI validation passed. Web retains the existing large-chunk warning.
- OpenAPI generation exposed unrelated existing drift, including system-authored approval-decision schemas. Only this change's generated viewer and participants fields and required entries are retained. `temp/conversation-author-review/check-openapi.ts` proved the baseline-to-current generated dashboard-schema delta is exactly those two fields and the retained fields match generation. Global generated-snapshot equality is not claimed.
- Local browser rendering used actual shared Message components with production CSS at 831 by 803 and 390 by 803. Computed alignment and avatar shapes matched the request, and document width equaled viewport width at both sizes. The temporary tab and server were closed and the viewport reset. This is local visual evidence, not a staging deployment.
- Focused Biome and `git diff --check` passed; documentation-model validation passed for 273 documents.

## Closeout Summary

The authenticated human's messages have a right-aligned name, circular initials avatar, and You marker. Other humans appear left with bubbles; agents appear left with square avatars and unboxed content. Names come from the authorized Thread dashboard rather than a user directory. Historical identity and responsibility remain immutable. No staging deployment or push occurred. Independent review found no actionable findings. The dedicated commit containing this record closes the authorized local fix; staging remains unchanged.
