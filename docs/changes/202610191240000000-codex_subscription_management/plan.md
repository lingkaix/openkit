---
type: change-plan
status: implemented
date: 2026-10-19
branch: lane/go-codex-subscription
---
# Codex Subscription Management

## Intent Revision 1

The engineer requests richer Codex subscription information, a manual banked-reset operation, and three optional per-account controls. The coordinator approved the L-GO direction at 12:40Z on 2026-10-19. The accepted internal OpenAI endpoints are not a new research question. Source: the coordinator's Codex subscription brief and research in the shared backlog, and the approved direction on the seams board.

Preserve existing account fields and credential custody. The new account booleans default to off, off, and on. Keep decimal credit strings exact. Spending a reset is an external effect: retain the exact request identity before dispatch, and treat a lost response as unknown. Only that identical request may be retried. Never use live credentials or accounts during this implementation.

## Intent Revision 2

At 12:50Z on 2026-10-19 the coordinator relayed the engineer's default reversal: weekly auto-use and expiry auto-use default to on, and credits use defaults to off. Absence has these new semantics for existing accounts. The independent author updated the default-value REDs before integration. The remaining scope is unchanged.

## Owners And Boundary

The [account owner](../../specs/20260721-provider_subscription_accounts.md) owns account settings, reset management, credential access, and sanitized Audit. The [Gateway owner](../../specs/20260526-llm_gateway_responses_api.md) owns quota admission, failover, and the one post-reset retry. Amend those owners narrowly in this change. The existing Server Audit retains reset identity; there is no new record family, routing strategy, credential path, or recovery engine. Web implementation belongs to the coordinator.

## Execution And Evidence

An independent test author derives and runs RED checks before production changes. L-GO then builds the smallest implementation and obtains a separate fresh review. Synthetic HTTP and isolated fixture accounts are the only effect domain. Complete affected modules, Native typecheck/build, schema/client checks, generated-output freshness, and repository checks qualify the final head. Preserve original oracles and failure output.

## Checkpoint

- Main base: `4add50b01efc9e8b448fa98ef27f10864cf0d0e4`; branch `lane/go-codex-subscription`.
- Independent author commits `23d0794a8`, `bb5f7f14d` and `cee538136` retain actual RED evidence, the revised defaults and explicit fixture-only alignment. Production and tests were normally merged from separate worktrees.
- The granted Gateway regions were announced before edits. Quota/schema transport and account/Gateway integration use separate producers. The first fresh review found four reachable issues; independent author `44fa27731` reproduced all four before the corrections. Test-only collaborator completion `6f67ee95d` preserves existing assertions and budgets.
- Corrections bind recovery material inside the reset fence, compare account prefixes literally, retain only reset-eligible failed members and isolate expiry checks through existing per-pair validity. The four new regressions and eleven original composed management cases pass; this is not complete-module qualification.
- Independent author `943058bf0` also reproduced a concurrent cold-cache admission defect: one failed overlapping read ignored another call's fresh full-window proof. The existing current-material, one-minute projection is now rechecked before admission; explicit fresh API reads still report their own failure. The unchanged assertion passes. No new cache, request state or recovery path was added. Fresh review of the corrected artifact and its final gate remain pending.
- Native build, complete App API 474 cases, Core Client 121 cases and the two root census cases pass. Complete quota/executor 39 cases and the 11 new composed account/Gateway/expiry cases pass. These are intermediate observations, not final acceptance.
- Failed and interrupted checks remain evidence, not waivers: the author's 311-pass/one-xAI-timeout run; the first complete affected gate with 1670 passes and twelve partial-collaborator fixture failures; and a bounded correction probe that passed fifteen management cases but reached its aggregate tool limit before complete consumer summaries. No assertion or per-test budget changed. Final complete-module qualification is still required.
