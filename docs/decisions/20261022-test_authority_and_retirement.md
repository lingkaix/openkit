---
status: Accepted
date: "2026-10-22"
decider: Engineer
---
# Test Authority And Retirement

## Decision

Tests project accepted owners and hold no authority of their own. A production change cites the owner clause it implements; a passing test is evidence, never the reason. Existing tests may be deleted. A test is rewritten or retired when it constrains a removed or replaced internal mechanism, when another passing check at an equal or lower sufficient layer already proves the same owner clause, or when it contradicts an accepted owner. The decision belongs to a test author independent of the builder, who records for each test either the owner clause and the check that now proves it, or the retired mechanism.

A unit is a module's public interface, not a function or class. Pure logic keeps fine-grained unit tests; stateful owners such as storage, scheduling, durable execution, and recovery are tested at their module boundary with their real in-process store; doubles replace only effects the subject does not own. A test that a behavior-preserving refactor breaks is a test defect. A suite's value is measured by fault detection, not by line count or coverage. Checks constrain behavior by default and pin an exact byte, count, order, or wording only where an owner requires it. Outside owner-module tests, test setup reaches state through owners and shared test-support builders rather than raw SQL, private setters, or fabricated records; deliberate fault injection after valid setup stays allowed. New behavior is proven primarily at its public seam. A setup-only migration keeps the scenario, its preconditions and injected faults, the real subject, and the semantics of every assertion, expected value, bound, and test name, and needs no separate test author or review round; ordinary focused verification still applies. Reviewers ask of each production hunk whether it would have been made without the failing check, and landing reports state test and production lines changed, with a reason for a ratio above three to one.

This record summarizes the engineer's instructions, given in Chinese and translated here, and the coordinator principles the engineer approved. The engineer approved these rules on 2026-10-22 and raised the root `AGENTS.md` word ceiling from 2100 to 2200 the same day, so that the governing clause is stated in full rather than by compressing unrelated clauses. The rules live in [Test Strategy](../specs/20260529-test_strategy.md) sections Test Authority And Lifecycle and L1 Package And App Unit Tests, `docs/change-execution.md`, the builder, test-author, and reviewer contracts, and root `AGENTS.md` [TEST-002] and [GOV-016].

## Reason

The builder contract forbade weakening an "accepted check", and every existing test was read as one. After the durable-execution and control-store landing, fix-forward work changed about 8,700 test lines against about 700 production lines. About 190 NanoCore test files wrote SQL directly and about 240 constructed stores by hand, so a correct internal change failed tests that encoded storage layout, call order, or exact counts that no owner requires. That made refactoring expensive, and it created pressure to bend production toward assertions instead of owners. An independent review of that wave found 22 of 23 production fixes justified by owner clauses and one that regressed recovery behavior, which shows that a green suite does not by itself justify a production change. Separating the decision to retire a test from the builder whose change fails it keeps the producer from setting its own pass condition while removing the presumption that every existing test is authority.

## Rejected Alternatives

Keeping per-function unit tests with doubled collaborators as the default makes every internal change a test change and proves stateful behavior only against doubles. Never deleting tests keeps every incidental constraint forever and makes change cost grow with suite size. Letting the builder delete or rewrite failing tests lets the producer choose its own pass condition. A hard test-to-production ratio gate invites gaming the measure; the ratio stays a review signal. Rewriting the whole suite before the release is deferred to the tracked test-architecture consolidation; these rules apply to new and touched tests now.

## Revisit When

A retired test's recorded covering check later misses a regression its retired test would have caught; calibration shows that behavior-constraining suites fail to detect injected faults the old assertions caught; or reports show the ratio signal routinely ignored or gamed.

## Affected Owners

- [Test Strategy](../specs/20260529-test_strategy.md).
- `docs/change-execution.md`.
- `docs/roles/builder.md`, `docs/roles/test-author.md`, and `docs/roles/reviewer.md`.
- Root `AGENTS.md` [AUTHORITY-002], [TEST-002], and [GOV-016].
