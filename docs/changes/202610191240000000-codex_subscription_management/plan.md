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
- Independent author owns only the dispatched test paths in its separate worktree. Production edits have not started.
- Gateway regions are granted by the coordinator; announce edit start on the seams board before writing them.
- Next observation: a runnable intended assertion failure on the existing quota/account operation seams, not a collection or setup error.
