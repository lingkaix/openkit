---
status: Accepted
implementation: Partial
kind: process
---
# OpenKit Test Strategy

## Owns

This spec owns OpenKit's L0-L6 testing layer model, test responsibility boundaries, test authority and lifecycle including test retirement, deterministic gate policy, test data and fixture hygiene, smoke and artifact health posture, real-provider opt-in rules, and the relationship between AI-assisted story tests and lower-level regression coverage.

## Does Not Own

This spec does not own what makes a verdict believable: oracle classification, harness admission, the effect-domain and observation-channel rules, and the execution-environment rules including the container rule and the real-use host manifest belong to `docs/verification-instruments.md`. This spec decides which layer proves which invariant; that document decides whether the instrument deciding it can be believed, and states its own application scope.

This spec does not own individual test implementation files, CI workflow syntax, release management policy owned by `docs/specs/20260829-release_management.md`, story file content, browser UI design, provider credentials, or package-specific test commands beyond the layer contract.

## Core References

- `docs/core/architecture.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/work-model.md`
- `docs/core/evidence.md`

## Summary

OpenKit needs a layered automated testing system that proves package-local behavior, cross-package contracts, NanoCore server behavior, Web UI behavior, release artifact health, and realistic product workflows.

The repository already has package unit tests, NanoCore black-box e2e tests, Web Playwright e2e tests, Docker-focused tests, a root `verify:release` tag gate, and a root `verify:full` explicit local gate.

This spec makes those layers explicit, defines the responsibilities and boundaries for each layer, and adds an agentic story testing model for AI-assisted product acceptance.

The testing system should be deterministic by default, evidence-rich at the browser and process boundaries, and strict about reducing discovered failures into lower-level regression tests.

Test-first is the strong default for a known feature or defect, not a universal ordering rule. When the failure, environment, or deciding oracle is unknown, a focused probe may establish the fact before a regression is written; once the behavior is understood, the lowest-sufficient lasting proof remains required.

## Goals

- Give every app and package a clear local test responsibility.
- Keep protocol, App API, NanoCore, core-client, and Web behavior structurally aligned through contract and conformance tests.
- Treat NanoCore server e2e as a black-box process/API/SSE/storage suite.
- Treat Web UI e2e as real browser operation through visible user-facing flows.
- Add smoke tests that quickly prove built packages, staging bundles, and containers can boot and serve key health paths.
- Add AI-assisted story tests that simulate realistic human workflows without replacing deterministic tests.
- Make CI and release gates understandable, fast enough for normal development, and strong enough for release confidence.
- Keep real provider, real subscription, and quota-consuming tests opt-in unless a release owner explicitly enables them.

## Non-goals

- Do not preserve historical compatibility behavior only for tests.
- Do not turn AI story tests into the primary regression mechanism.
- Do not make every pull request run every expensive browser, container, provider, or agentic workflow.
- Do not require local persisted state, local user credentials, or host-specific secrets for the normal deterministic gate.
- Do not let Web e2e bypass the UI for assertions that should be visible to users.
- Do not let NanoCore e2e import `src/` implementation modules instead of driving the built app boundary.

## Principles

Tests should sit at the lowest layer that can prove the behavior.

Choose test order according to what is known. Name and observe the intended red result before production implementation when a contract already defines the failure. Probe first when a test would otherwise encode an unverified premise or exercise an unadmitted instrument. Neither path permits shipping changed behavior without durable evidence.

L0-L6 is a taxonomy of available proof boundaries, not a checklist for every feature, bug, command, or state transition. One invariant should normally have one primary regression at the lowest sufficient layer and at most one higher-layer check for a distinct integration risk.

Verification depth is risk-proportional:

- Security, authorization, credential, sandbox, data-loss, durable-authority, and irreversible external-effect boundaries require strict negative and adversarial coverage.
- Persisted product truth, public command idempotency, migrations, and no-duplicate-effect fences require focused transition and restart coverage at the lowest boundary that can prove them.
- Availability, cleanup, projection, reconnect, and operator-diagnostic behavior require representative success plus the documented safe fallback, not exhaustive cross-product testing.
- Deferred scale, multi-process, multi-target, fairness, hot-failover, compatibility, and transparent-recovery ideas require no implementation tests until an accepted current contract activates them.

Unit tests should catch pure logic, parser, reducer, component, schema, and adapter behavior.

Contract tests should catch drift and behavioral disagreement between packages before browser or process tests become the first signal.

Integration and e2e tests should prove boundaries that unit tests cannot represent: process boot, HTTP status, SSE replay, persistence, authentication, browser rendering, and user interaction.

Smoke tests should be shallow, fast, and release-artifact-oriented.

`docs/specs/20260529-l6_story_acceptance.md` owns L6 execution, evidence, and defect-reduction mechanics.

The normal test gate must not require real OpenAI, ChatGPT subscription, Codex login, external network, or browser profile state. `docs/verification-instruments.md` owns the container rule, its one exception, and the platform-divergence rule that makes more than one execution environment affordable, together with the effect-domain rule that decides what it means when the lowest sufficient layer turns out to need an effect its subject does not own.

Opt-in tests may use real providers or real local host tools, but they must be explicitly named and skipped by default.

## Test Authority And Lifecycle

A test is a projection of an accepted owner and holds no authority of its own. Its expected values are an oracle under `docs/verification-instruments.md`; an expected value read from the implementation instead of derived from an owner fails the Prior property there and confirms the artifact instead of testing it. A production change cites the owner clause it implements. A passing test afterwards is evidence, never the reason. When a failing test demands behavior that no owner requires, the test is the suspect, and the conflict goes to a test author instead of into production code.

A check constrains either behavior or implementation. A behavior-constraining check fails only when an owner-required observable changes: a returned result, a persisted fact read through its owner, a public status, an event a consumer relies on, or a refusal. An implementation-constraining check also fails when a correct refactor changes something no owner names, such as internal call order, the exact number of queries or writes, private table or column layout, helper names, the order of an unordered result, diagnostic wording, or byte-exact output. Write behavior-constraining checks by default. Pin an exact byte, count, order, or wording only where an owner requires it, and name that clause beside the assertion. Where a return value cannot prove a responsibility such as recovery, a check may observe internals, and it asserts that responsibility rather than the mechanism that currently provides it.

Test setup reaches state through the owners production uses. Outside an owning module's own tests, setup does not write raw SQL, call private setters, hand-assemble durable records or receipts, or depend on another module's storage layout; it calls the owner's operations directly or through a shared builder in the package's test-support module. When an owner changes how state is produced, the builder changes once instead of every test. A test that needs a valid state no owner can produce has found a missing owner operation or an impossible state, and reports it instead of fabricating that state. Deliberate fault injection after valid setup, such as damaging stored bytes or interrupting a step to prove a required refusal or recovery, remains required where the risk-proportional rules above call for it; it never fabricates a successful durable record or receipt.

New behavior is proven primarily at its public seam, through contract and black-box checks at the lowest layer that can observe it. A white-box check is added only for a responsibility that no public result reveals, and it names that responsibility. Before adding a check, inspect existing coverage and apply the one-primary-regression rule above: extend or replace an existing primary regression of the same invariant instead of adding a parallel one at the same layer.

A test is rewritten or retired, not preserved, when one of three conditions holds: it constrains an internal mechanism that has been removed or replaced; another passing check at an equal or lower sufficient layer already proves the same owner clause; or it contradicts an accepted owner. A test author independent of the builder decides, and records for each rewritten or retired test either the owner clause and the check that now proves it, or the retired mechanism. The builder whose change fails a test never decides that test's retirement. Deleting a test without a recorded disposition is the weakening root `AGENTS.md` forbids; deleting one with a disposition is ordinary maintenance. Replacing a test with one regenerated from the new implementation is a deletion without a disposition, because its expected values confirm the new code instead of an owner.

Test code is maintained cost. A landing report states the test and production lines it changed, and a ratio above three to one states its reason, such as a new public seam or a recovery matrix. The ratio informs review; it is neither a target nor a gate.

After a refactor, each failing test is first classified as setup-only, when the test reaches the same scenario, preconditions, and injected faults through a seam that moved; a test defect, when it constrains implementation or contradicts an owner; or a product defect. `docs/change-execution.md` owns how each class is executed. A change that must modify an existing test brings that test under these rules; existing tests the change does not need stay with their tracked cleanup work. The decision and its reason are recorded in [a decision record](../decisions/20261022-test_authority_and_retirement.md).

## Test Taxonomy

| Layer | Name | Primary question | Default gate | Main tools |
| --- | --- | --- | --- | --- |
| L0 | Static and repository checks | Is the repository structurally valid before runtime behavior is tested? | PR and release | Biome, TypeScript, repo scripts, generated-schema drift checks |
| L1 | Package and app unit tests | Does one package or app module behave correctly in isolation? | PR and release | Vitest, jsdom, Solid Testing Library |
| L2 | Contract and conformance tests | Do the two sides of a boundary agree in shape and in behavior at the crossing, including under failure? | PR and release | Zod, Vitest, generated JSON Schema, fixture conformance, in-process composition of real producers and consumers |
| L3 | NanoCore black-box integration and e2e | Does NanoCore boot and satisfy its API, SSE, storage, auth, and worker contracts as a process? | Release, selected PRs | Vitest e2e harness, temporary data roots, HTTP clients, built NanoCore |
| L4 | Web browser e2e | Can a real user complete visible UI workflows in a browser? | Release, selected PRs | Playwright, Vite, NanoCore test server, browser traces |
| L5 | Smoke and artifact health tests | Do built packages, staging routes, and containers start and expose minimum health? | Release and deployment | Build scripts, Docker/staging scripts, health probes, packaged-route Playwright |
| L6 | Agentic story acceptance tests | Does the product satisfy realistic intent across a complete use case? | Release candidate, manual review | See `docs/specs/20260529-l6_story_acceptance.md` |

## Existing Entrypoints

The root fast verification command is `pnpm -w verify`.

The root tag release gate is `pnpm -w verify:release`.

`verify:release` currently runs L0-L2 verification, NanoCore black-box e2e, and built-artifact smoke tests.

The root explicit full local gate is `pnpm -w verify:full`.

`verify:full` adds Web Playwright e2e to the release gate.

NanoCore package-local tests run with `pnpm --filter @openkit/nanocore test`.

NanoCore black-box e2e runs with `pnpm --filter @openkit/nanocore run test:e2e`.

Web unit and component tests run with `pnpm --filter @openkit/web test`.

Web browser e2e runs with `pnpm --filter @openkit/web e2e`.

Web staging browser e2e runs with `pnpm --filter @openkit/web e2e:staging`.

Built-artifact smoke tests run with `pnpm -w test:smoke`.

Real Codex and real subscription smoke tests must stay opt-in through explicit environment variables.

## Ownership Matrix

| Surface | Unit owner | Contract owner | Boundary owner | Browser or smoke owner |
| --- | --- | --- | --- | --- |
| Core protocol records and SSE events | `packages/protocol` | `packages/protocol` conformance and generated schema tests | NanoCore event emission and `@openkit/core-client` parsing | Web e2e for visible stream behavior |
| App API schemas | `packages/app-api-schemas` | `@openkit/core-client` and NanoCore route tests | NanoCore route responses | Web e2e for user-visible diagnostics and app flows |
| Typed HTTP/SSE client | `packages/core-client` | Protocol and App API schema fixtures | NanoCore e2e through real HTTP/SSE | Web e2e when browser behavior depends on client semantics |
| NanoCore runtime and storage | `apps/nanocore` | Protocol, App API, config-schema, and route tests | NanoCore process e2e | Smoke tests for packaged and containerized boot |
| Web UI | `apps/web` | Client and schema shape tests | Playwright through Vite and NanoCore | Staging packaged-route e2e |
| Docker and staging distribution | `scripts/docker/**` and package-local Docker tests | Config-schema and staging fixture tests | Staged container or packaged server boot | Staging smoke and packaged route tests |

## L0 Static And Repository Checks

L0 should fail before any expensive runtime test when formatting, linting, typechecking, generated output, or repository structure is invalid.

The current root scripts already include `check:repo`, `lint`, `typecheck`, `build`, and commit-message checks.

Generated protocol or schema artifacts should have drift tests that fail if source schemas changed without regenerating committed outputs.

L0 should also check each app and package for its required `README.md` and package-level scripts aligned with root task names. A local `AGENTS.md` is optional under root `AGENTS.md` LOCAL-001.

L0 failures should not require browser traces or process logs because they are usually source-level problems.

## L1 Package And App Unit Tests

A unit is a module's public interface, not a function or a class. A module is tested through the operations its callers use, so an internal refactor that preserves behavior leaves its tests passing. A behavior-preserving refactor that fails a unit test has found a test defect, handled under Test Authority And Lifecycle.

Every package and app must own local unit tests for its public behavior. Private logic is tested directly only when it is pure and its own interface is a stable contract, or when no public result reveals a high-risk responsibility.

Test weight follows the kind of code:

- Pure logic, such as parsers, schemas, reducers, converters, and algorithms, gets fine-grained unit tests, because its interface is its behavior.
- Stateful owners, such as storage, scheduling, durable execution, and recovery, are tested at the owning module's boundary with their real in-process store, such as a temporary SQLite database, rather than with doubles of their internal collaborators.
- Glue and adapter code is proven by contract or boundary tests rather than per-function unit tests.

Doubles stand in for effects the subject does not own, such as providers, networks, clocks, and external processes, not for the subject's own collaborators.

Package tests should run without booting NanoCore unless the package itself is NanoCore.

Schema packages should test strict accepts, strict rejects, error paths, and generated artifact consistency.

Client packages should test request construction, response parsing, SSE parsing, retry semantics, terminal status handling, and error normalization against fake transports.

NanoCore unit tests should cover route builders, service logic, storage migrations, auth middleware decisions, provider registries, gateway converters, runtime config parsing, readiness checks, and adapter normalization, using real in-process storage for storage, scheduling, and recovery behavior and fakes for providers, workers, and other effects NanoCore does not own.

Web unit tests should cover state reducers, hooks, component rendering, accessibility-visible labels, optimistic states, error states, and event-to-UI mapping.

Unit tests may use fakes for effects their subject does not own, and an in-memory store only where durability, recovery, and concurrency are not the behavior under test. They must not assert behavior that only a real process, browser, or network boundary can prove.

## L2 Contract And Conformance Tests

Contract tests are the main guardrail against cross-package drift. L2 asks whether the two sides of a boundary agree, in shape and in behavior at the crossing, including under failure. It answers with two forms, and both are core parts of the layer:

- Shared schema and fixture conformance proves shape: both sides are checked against one schema or fixture.
- Composition proves behavior: the real producer and the real consumer run together in process, with no double on either side of the crossing; a double may stand only further out, such as a fake runtime beyond a collector. The test injects faults at the crossing, such as a failure between two steps, a restart that reopens storage, duplicate delivery, reordering, and splitting, and asserts invariants of the crossing rather than single examples.

Fixture conformance alone does not prove that two sides behave the same, because one author wrote the fixture from intent and both sides can agree with it while disagreeing with each other. When a change alters a representation that crosses different owners, such as encoding and serialization, chunking, identity and order, or a durability handoff, the primary regression for that crossing's invariants is a composition test, not one test on each side. Composition tests stay deterministic and in process and do not boot NanoCore, which keeps them at L2 and suitable for pull-request gates. `docs/change-execution.md` owns naming the seam and dispatching a test author who reads the owning contract of each side; the reason for this definition is recorded in [L2 Proves Boundary Behavior With Real Producers And Consumers](../decisions/20260923-l2_includes_composition_tests.md).

Tests at a module's public seam protect its contract and observable consequences, observing internals only where a return value cannot prove a responsibility such as recovery; they do not freeze incidental helper order.

Protocol schema changes must start in `packages/protocol`, including parser tests, conformance fixtures, and generated JSON Schema updates.

App API payload changes must start in `packages/app-api-schemas`, then move through NanoCore route tests, `@openkit/core-client` tests, and Web tests.

Core-client tests must prove the browser and integration clients consume only current protocol and App API shapes.

NanoCore route tests must prove emitted payloads match shared schemas instead of route-local duplicated schemas.

Web tests must prove the UI consumes current shapes without preserving removed fallbacks.

For behavior crossing package boundaries, update every affected producer and consumer, but test each distinct invariant only where it can fail; for a crossing between different owners, that place is the composition test above. A schema fixture may prove a shared shape for several consumers; add NanoCore, client, Web, or browser tests only when that layer adds behavior or a distinct failure boundary.

When a contract of a first-party surface that ships with each release intentionally breaks, tests should reject the removed shape instead of preserving compatibility coverage. A change to retained data instead carries the migration and data-continuity evidence named in `docs/core/contract-evolution.md`.

## L3 NanoCore Black-box Integration And E2E

NanoCore e2e should boot NanoCore as a process and interact through HTTP, SSE, filesystem state, and public runtime boundaries.

The harness should use fresh temporary data roots by default.

The suite collectively should verify empty boot, local mode boot, server mode boot, authentication, unauthenticated rejection, user scoping, API status codes, representative idempotent mutations, persistence, one bounded restart path, migration idempotency, secret redaction, configuration loading, agent readiness diagnostics, and one local turn execution with fake or internal workers where possible. A single change should add only the process-boundary regression it needs, not another copy of this inventory.

SSE tests must verify cursor behavior, replay semantics, terminal `204 No Content` behavior, malformed cursor handling, and client-visible error events.

Storage tests must verify durable state across restart without relying on a developer's local `data/` directory.

Auth tests must verify cookie behavior, CSRF-sensitive paths where relevant, server-mode isolation, local-mode assumptions, logout, and rejected cross-user access.

Worker scheduling tests should default to fake or self-check workers so normal e2e remains deterministic.

Real Codex, real ChatGPT subscription, and real provider inference tests must remain skip-aware opt-in tests.

No NanoCore black-box e2e spec should import NanoCore `src/` modules for the behavior under test.

## L4 Web Browser E2E

Web e2e must operate through a real browser and visible UI flows.

The default implementation should use Playwright because it is deterministic, CI-friendly, and already part of `apps/web`.

Chrome DevTools MCP is useful for manual reproduction, exploratory debugging, and authenticated local browser checks, but the committed deterministic CI suite should prefer Playwright.

Browser tests should start isolated NanoCore and Vite processes on dynamic ports unless they intentionally target a packaged staging route.

Browser tests should use accessible selectors and user-visible text where practical.

Browser tests should avoid direct API calls except for controlled setup, cleanup, or assertions that are impossible or wasteful through the UI.

The suite should cover Workspace and Thread setup, one representative user-visible work entry, settings diagnostics and redaction, server-mode sign-up and sign-in, logout, unauthenticated rejection, and staging packaged routes. Add browser coverage for streaming, Gates, interruption, Artifacts, provider visibility, or account controls only when the browser boundary can expose a failure that the owning lower-layer test cannot represent; do not replay every mode invariant at L4 or preserve an unsupported adapter sequence merely to satisfy an old inventory.

Every browser failure should preserve enough evidence to debug the problem without rerunning locally: trace, screenshot, video when enabled, console logs, network logs, and server process logs.

Browser tests should not depend on an existing browser profile, extension state, manually logged-in account, or previous local data root.

## L5 Smoke And Artifact Health Tests

Smoke tests answer whether a built artifact can start and serve the minimum useful surface.

Smoke tests should be shallow and fast.

A package smoke test may build the package and execute its binary or exported entrypoint with `--help`, `health`, or a no-op command.

A NanoCore smoke test should start the built server, hit `/health` or equivalent health endpoints, verify `/api` readiness, and shut down cleanly.

A Web smoke test should build the SPA, serve the built output, load the root route, and verify that the app shell renders without relying on Vite dev behavior.

A staging or container smoke test should build the image, start it with a disposable data root and non-secret test config, hit public health and UI routes, verify that secrets are not printed, and shut down cleanly.

Smoke tests must not become full e2e suites.

If a smoke test needs more than a minimal boot path, that behavior belongs in NanoCore e2e, Web e2e, or agentic story acceptance.

## L6 Agentic Story Acceptance Tests

L6 is the agent-first, opt-in product-intent layer. `docs/specs/20260529-l6_story_acceptance.md` owns its admission, story, execution, evidence, and failure contracts.

A fixed mechanical proof belongs at L3 when it drives NanoCore or another public process boundary, or at L4 when it drives the browser. L6 Story Acceptance owns how a confirmed defect leaves L6, including a recorded reason when the defect is not reduced.

## Test Data And Environment Policy

Tests should use disposable data roots, temporary workspaces, and deterministic fixtures by default.

Fixtures that contain secrets must use fake secret markers that are safe to commit.

Tests must not read from or write to a developer's persistent `data/` directory unless a test is explicitly marked manual or opt-in.

Tests must not require global ports when dynamic ports are practical.

Tests must clean up child processes even when assertions fail.

Tests must avoid wall-clock sleeps when they can wait on a state transition, HTTP response, SSE event, DOM condition, or process output.

Network access should be disabled or mocked by default unless the test is explicitly marked opt-in.

Quota-consuming provider tests must include a clear environment variable gate and must not run in normal CI by accident.

The test placement rule and its admitted exceptions, the platform-divergence rule, oracle classification, and harness admission are owned by `docs/verification-instruments.md`. A check chooses its layer under this specification and is believed under that one.

## CI And Release Gates

Pull requests should run the lightweight repository check and the isolated NanoHost installer fixed-path gate by default. [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) owns the installer proof.

Every push to `main` MUST run the complete deterministic release gate, including L4 Web e2e. Main pushes share one concurrency group: a newer pending head replaces an older pending head, but an in-progress main run is not cancelled. Other ordinary branch pushes do not run CI by default.

A lowercase version tag that builds release artifacts and matches `v*.*.*` should run the release gate as separate jobs for L0-L2, L3 NanoCore e2e, and L5 smoke. Under [Release Management](20260829-release_management.md#candidate-ci-and-tag-reuse), the complete-suite L0-L2 shards and NanoCore e2e tag job each first seek a completed main-push release-gate run or qualifying `workflow_dispatch` run of the same workflow on exactly the tagged commit where that same job succeeded in its latest attempt. Each records the qualifying run and skips its tests when found, or runs its tests as before when absent. L0-L2 requires the complete successful shard aggregate and execution-file inventory under that owner. Main-push shards may reuse exact-P dispatch evidence under the same rules. The candidate gate uses a main-push release-gate run or selects `release-gate` or `full` on exactly the publishing commit; reuse never crosses commits. On a tag that builds release artifacts, L5 and every other tag job still run, including preflight and `main` membership, portability, the installer, NanoHost build and qualification, packaging, promotion of the proved exact-P candidate index and platform digests, anonymous `worker-common` inspection, GitHub Release creation and upload, and download verification. Prerelease image build and per-platform exact-digest smoke run once in candidate CI and are admitted on the tag under Release Management; all existing publication predicates remain required. A stable promotion tag builds nothing. It runs promotion of the already-published digests, the release pointers, GitHub Release creation, and published-release verification.

Manual workflow dispatch should expose the lightweight repository check, L0-L2, L3 NanoCore e2e, L4 Web e2e, L5 smoke, the complete release gate, and the registry-observation refresh owned by [Release Management](20260829-release_management.md#prerelease-candidate-images). Workflow identifiers belong in the implementation projection.

The release gate should cover the L0-L2, L3 NanoCore e2e and L5 smoke composition projected by `verify:release`, through its admitted shards. The additional jobs and exact-commit reuse rules remain owned by Release Management.

The overlapping deterministic Vitest unit and coverage suites execute once with coverage enabled. Substitution requires equal collected test inventories, propagated injected failure, and preserved skip enforcement. Repeat that admission proof when suite-selection or command inputs change. Routine execution reuses the admitted recipe instead of collecting both inventories again. Root JavaScript tests, native Cargo tests, schema/catalog validation, builds, and artifact gates remain distinct required executions. A missing suite, changed inventory, collection failure, undeclared skip, or failed command fails the gate. Coverage executes on every exact P; cycle-only coverage is insufficient. Disjoint file partitions may execute a large package in parallel. Each partition must prove equal unit and coverage case collection and exact executed-case cardinality; the complete union must equal the unpartitioned file inventory. Duplicate case names retain their multiplicity. Merge the actual coverage blobs and apply the original whole-package thresholds before the aggregate passes. Per-partition threshold deferral is allowed only with that required merge; it cannot admit an incomplete, failing or skipped partition. [Release cadence](../decisions/20261014-release_cadence.md) records this decision.

Release candidates may additionally run staging smoke tests and packaged-route browser tests through explicit manual workflows.

L4 Web e2e and L6 story acceptance should stay out of automatic PR and tag gates unless a later release policy explicitly promotes a subset. L4 also runs on every main push and the manual `release-gate` and `full` selections; L6 remains manual.

Real provider and real subscription tests should run only under explicit environment-variable opt-in and should be reported separately from the deterministic gate.

Failed release gates should publish enough artifacts to identify the layer that failed without requiring a local rerun.

## Naming And Placement

Unit tests should live next to the source they cover using existing `*.test.ts` or equivalent conventions.

NanoCore black-box e2e tests should stay under `apps/nanocore/e2e/`.

Web browser e2e tests should stay under `apps/web/e2e/`.

Staging browser e2e tests should stay under `apps/web/e2e/staging/` or a more specific staging-owned location if the suite grows.

Docker and packaging smoke tests should stay near the build scripts or package that owns the artifact.

L6 story artifacts live under `tests/stories/`; their contract and execution support are owned by `docs/specs/20260529-l6_story_acceptance.md`.

The current mechanical acceptance proofs belong to these deterministic layers:

| Proof | Name | Destination |
| --- | --- | --- |
| C01 | `openkit-local-self-check` | L4 Web browser e2e |
| C02 | `pi-ai-gateway-real-provider` | L3 opt-in real-provider e2e |
| C03 | `task-mode-real-worker-release` | L3 opt-in real-worker e2e |
| C04 | `provider-subscription-real-lifecycle` | L3 opt-in real-provider e2e |

## Failure Evidence

Unit and contract tests should show focused assertion messages, fixture diffs, and schema parse errors.

NanoCore e2e should preserve server stdout, stderr, selected data-root snapshots, HTTP request summaries, SSE transcripts, and process exit reasons.

Web e2e should preserve Playwright traces, screenshots, videos when enabled, browser console logs, network summaries, and server logs.

Smoke tests should preserve build output, container logs, health responses, process exit status, and startup timing.

L6 evidence follows `docs/specs/20260529-l6_story_acceptance.md`.

Evidence must redact secrets before it is committed, uploaded, or pasted into a change record.

L3 opt-in real-provider tests use a stricter failure-evidence contract than the general NanoCore list above. Each writes one owner-only (`0600`) redacted terminal result per attempted runner invocation, after its cleanup attempts settle and including when lifecycle work or cleanup fails. An invocation may contain the test's fixed sequence of lifecycle runs; their outcomes share that result. The result must retain enough to attribute a failure to product behavior rather than an external cause, and must never retain raw SSE, error text, request or response payloads, credential material, file paths, provider-private values, or durable product records. Evidence that cannot separate a product failure from a provider or environment failure is insufficient, not merely terse.

Cleanup always runs to settlement. When lifecycle work and cleanup both fail, the first lifecycle failure controls both the reported phase and the propagated error; the later cleanup failure is reported only as its own outcome, never replaces the first failure, and retains no raw secondary error. When cleanup is the first failure, it controls the reported phase and propagates.

Terminal failure classification is derived only from a parsed public Gateway terminal payload's error code, uses only the public failure meanings owned by `docs/specs/20260526-llm_gateway_responses_api.md` and the fixed code allowlist projected by the runner test, and maps every missing, non-string, or unrecognized code onto one generic fallback. A raw provider code is never retained. Run cardinality is fixed by the test rather than by its caller: at most one diagnostic cardinality override may exist per test, every other explicit value must be rejected before auth-source content access or any provider effect, and that override authorizes no general runner parameterization or additional lifecycle variant.

`apps/nanocore/e2e/provider-subscription-real-lifecycle-runner.test.mjs` is the executable projection of this contract for C04 and holds no authority of its own. It owns the exact summary field set and types, the phase values, the code enumeration, and the override's name; this specification owns only the invariants above.

## Coverage Expectations

Coverage thresholds are useful for regression pressure, but they are not the testing strategy. A suite's value is its power to detect injected faults, which `docs/specs/20260719-verification_calibration.md` measures, not its line count or line coverage.

The repository should keep coverage gates for deterministic package tests where they are stable.

Coverage should not force meaningless tests around generated files, fixtures, or adapter glue that is better proven by contract and e2e tests.

High-risk areas should require scenario coverage even when line coverage is already high.

High-risk areas include protocol parsers, SSE replay, auth/session boundaries, request idempotency, storage migrations, secret redaction, provider credential resolution, worker scheduling, artifact access, and browser flows that gate real user work.

For worker scheduling, high-risk coverage means launch authorization, exact worker identity, no concurrent duplicate launch, secret-safe control, and the documented restart fallback. It does not mean testing hypothetical fairness, multi-target placement, every legal state permutation, or every crash instruction boundary under the current single-target baseline.

## Current Implementation Projection

The repository implements the established layer gates and deterministic test placement:

- Root scripts expose the accepted deterministic gates: `verify`, `verify:l0-l2`, `verify:release`, `verify:full`, `test:e2e:nano`, `test:e2e:web`, and `test:smoke`, plus explicitly gated real-provider and real-worker L3 commands.
- Every main push triggers the nonpublishing release gate. `test:ci` projects the complete coverage-owner shards and retains native suites, the root Node inventory and recursive script Node tests under Release Management. Container-subject script tests retain exactly one full host lane; the root shard file list and complete aggregate prove selection without duplication. Every distinct non-Vitest package test command uses the same command-failure and undeclared-skip guard as Vitest coverage and root tests. The existing `.github/workflows/ci.yml` implements lightweight PR checks, main-push and tag-triggered release gate jobs for L0-L2, NanoCore e2e, and smoke, plus manual workflow dispatch for `pr-check`, `l0-l2`, `nano-core-e2e`, `web-e2e`, `smoke`, `release-gate`, `full`, and `registry-admission`. The complete L0-L2 shards and the `nano-core-e2e` tag job use `scripts/release-ci-reuse.mjs` to implement the exact-commit reuse contract above, with the host aggregate requiring the complete shard set. The helper admits both workflow-dispatch and main-push evidence, per job and exact commit. Main pushes also run the manual release gate's nonpublishing Worker-image and stopped-server recovery smoke; L4 runs on main and the manual release/full gates; publication jobs remain tag-only.
- Unit, contract, NanoCore e2e, Web e2e, and smoke entrypoints exist in the repository-owned locations named by this spec. The Web staging e2e script `e2e:staging` and `apps/web/e2e/staging/` do not exist, although `scripts/docker/e2e-app.sh` still calls the script (#516).
- `apps/web/e2e/openkit-local-self-check.spec.ts` is the C01 L4 entrypoint under `pnpm -w test:e2e:web`. The C02-C04 L3 entrypoints are `apps/nanocore/e2e/pi-ai-real-provider-runner.mjs`, `apps/nanocore/e2e/task-mode-real-worker-runner.mjs`, and `apps/nanocore/e2e/provider-subscription-real-lifecycle-runner.mjs`, behind `pnpm -w test:e2e:real-provider`, `pnpm -w test:e2e:real-task-mode`, and `pnpm -w test:e2e:real-subscription` respectively. Two further opt-in L3 entrypoints exist: `pnpm -w test:e2e:real-codex`, which runs `apps/nanocore/vitest.e2e.real-codex.config.ts`, and `apps/nanocore/e2e/worker-responses-relay-real-provider-runner.mjs`, which has no root script and is described in `apps/nanocore/README.md`.
- L6 story artifacts remain outside the deterministic gate and follow `docs/specs/20260529-l6_story_acceptance.md`.

Remaining L6 work is owned by `docs/specs/20260529-l6_story_acceptance.md`.

## Risks And Mitigations

Risk: Browser e2e becomes slow and flaky.

Mitigation: Keep selectors accessible, isolate data roots, use dynamic ports, avoid sleeps, collect traces, and move non-UI assertions down to L1 or L2.

Risk: NanoCore e2e accidentally depends on local host state.

Mitigation: Use temporary data roots, fake providers, deterministic workers, and explicit opt-in flags for real Codex or real provider tests.

Risk: AI story tests become non-reproducible.

Mitigation: Apply the L6 acceptance contract, including its reduction rule.

Risk: Contract drift appears first in Web e2e.

Mitigation: Add schema and core-client tests before browser tests, and keep route payload builders validated against shared schemas.

Risk: Smoke tests grow into slow e2e suites.

Mitigation: Limit smoke tests to boot, health, route availability, and minimal render checks.

Risk: The suite pins implementation, so correct refactors fail many tests and builders bend production to satisfy them.

Mitigation: Apply Test Authority And Lifecycle: behavior-constraining assertions, setup through owners and shared builders, retirement by an independent test author, and the reported test-to-production ratio.

Risk: Release gates become too expensive for normal development.

Mitigation: Keep PR gates to the lightweight repository check and isolated installer gate, require L0-L3 evidence plus fresh L5 on main pushes, version tags, or explicit manual release-gate dispatch, allowing exact-commit reuse for tag L0-L3 where the release owner permits it, and include L4 in main and complete manual release gates, and reserve L6, staging, real-provider, and real-subscription tests for explicit manual workflows.

## Resolved Decisions

- Stable, fixed browser workflows belong at L4; stable, fixed NanoCore or public process workflows belong at L3.
- No additional staging or Docker smoke check is mandatory beyond the current built-artifact smoke job until a concrete deployment target or release-candidate policy promotes it.

## Deferred Work

- Promote only stable and cheap mechanical proofs into L3, L4, or explicit release-candidate manual gates.
- Revisit mandatory staging or Docker smoke gates only when a concrete packaged deployment path becomes release-critical.

## Related Docs

- `README.md`
- `docs/verification-instruments.md`
- `docs/change-execution.md`
- `docs/app-api.md`
- `docs/specs/20260529-l6_story_acceptance.md`
- `docs/specs/20260528-core_client_boundary.md`
- `apps/nanocore/README.md`
- `apps/web/README.md`
