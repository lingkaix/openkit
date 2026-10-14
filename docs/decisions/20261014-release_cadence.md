---
status: Accepted
date: "2026-10-14"
decider: Engineer
---
# Prerelease Cadence And Bounded Automation

## Decision

The engineer accepted the eight recommendations supplied for rc.6 release-cadence work on 2026-10-14, quoted verbatim:

> 对于你上一轮新让我决定的八条，我都按照你的建议给你 yes。

Faithful English translation: "For the eight items you asked me to decide, I say yes to all as you recommended."

1. Use a bounded standing prerelease publication grant and a prospective release-blocker policy. The first covered tag is `v0.1.0-rc.6`. Stable publication, Latest, visibility, and credential changes remain engineer-reserved.
2. Automatically update the explicitly named test deployment after publication through existing product operations. Preserve separate effect-domain results, exact identities, and retained-data public reads. Stories 1 and 2 move to release-cycle and change-driven cadence; story 2 remains required on the promoted prerelease.
3. Execute overlapping Vitest unit and coverage suites once with coverage, after proving equal collection, failure propagation, and skip enforcement. Keep root and native tests.
4. Automatically run all sixteen Worker cases after each deployment update. Run the four runtime groups concurrently within admitted capacity, and A to D sequentially in each Thread. Generate per-case rows; independently check non-pass and undecidable rows. Remove the unused browser-launch prerequisite.
5. Choose #243 option (b): use an attempt-specific public synthetic exact-reply sentence. Wrong, stale, empty, and refusal replies remain non-pass. Preserve C and D Artifact bytes and lineage checks.
6. Extend existing notes, image records, and qualification summaries to generate compact records. Add the narrow #241 manifest with exact identities, portable checksums, and explicit compatibility/recovery assertions. Missing assertions stop automation.
7. Defer #193 and #240 from cadence work. Require #225, stable promotion without rebuild, before the first stable release.
8. Run the deterministic release-gate CI on every push to `main`.

The same-day effect boundary names the dedicated x86_64 machine as development/test infrastructure and `a1` as staging, dogfooding, and persistent test deployment. Production `a2` is excluded from automation. Scripts require one explicit SSH alias or URL target with no default. The ruling does not authorize this builder to publish or exercise deployment effects.

## Reason

The engineer expects two to three releases daily and wants less time and fewer engineer or external-Agent handoffs from acceptance through publication and update. The WP4 Consultant report at `/home/simonx/AI/temp/rc6/wp4-release-cadence-report.md` supplies measurements and recommendations, not authority. Its numbered decision table contains seven rows; the coordinator's accepted eighth item is main-push CI. This record preserves that distinction.

The reported exact-P candidate runs took [64m53s for rc.4](https://github.com/lingkaix/openkit/actions/runs/38347889829) and [65m42s for rc.5](https://github.com/lingkaix/openkit/actions/runs/38388878850). Tag runs took [35m23s for rc.4](https://github.com/lingkaix/openkit/actions/runs/38353473628) and [44m56s for rc.5](https://github.com/lingkaix/openkit/actions/runs/38396894772). The [rc.5 L0-L2 job](https://github.com/lingkaix/openkit/actions/runs/38388878850/job/115267665569) reportedly spent 22m39s on unit tests and 35m08s on coverage over overlapping suites.

WP4 reports a 17m57.716s rc.5 qualification window. The longest runtime group took 4m49.795s; adding retained overhead produces a 5m55.623s concurrent estimate. Six to eight minutes is a planning inference, not a measured concurrent pass. The five-to-fifteen-minute deployment allowance is unmeasured: rc.5's component update included #242 failures and a diagnostic workaround. Clean automation must demonstrate the boundary before relying on that estimate. Authorization waiting and Provider cost cannot be inferred from these records.

## Rejected Alternatives

- Per-tag publication authorization preserves a routine handoff without adding protection when all bounded conditions are mechanically observed.
- An unscoped green-CI grant loses publication, triage, and immutable-identity protections.
- Removing qualification or moving coverage to pre-stable cadence loses release-specific regression evidence.
- Treating arbitrary completed text as connectivity success weakens the deciding exact-output predicate.
- A separate release registry, migration graph, candidate channel, or reporting service adds responsibility without a current consumer need.
- Treating automated deployment as an L6 story loses independent Actor and Judge observations. Those rules remain binding for stories.

## Revisit When

Revisit on grant revocation, release-cycle completion, changed publication implementation, insufficient replacement/compatibility observations, Provider refusal under benign prompts, concurrency interference, or a new pre-publication acceptance consumer. An unassessed migration, uncertain effect, or strict-risk decision stops its dependent automation rather than broadening the grant.

## Affected Owners

- [Release Management](../specs/20260829-release_management.md) owns the bounded publication grant, cadence, release manifest, and separate update/qualification outcomes.
- [Test Strategy](../specs/20260529-test_strategy.md#ci-and-release-gates) owns CI cadence and deduplicated deterministic tests.
- [Persistent Deployment Acceptance](../specs/20260909-persistent_deployment_acceptance.md) owns attempt attribution and retained evidence.
- [App Update Delivery](../specs/20260910-app_update_delivery.md) owns App approval, compatibility, preflight, and receipt semantics; its automation amendment follows coordinated WP2 integration.
- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md) retains story membership, admission, independent Actor/Judge, and product-verdict rules.
