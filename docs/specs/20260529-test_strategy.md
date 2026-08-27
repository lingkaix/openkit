---
status: Accepted
implementation: Partial
---
# OpenKit Test Strategy

## Owns

This spec owns OpenKit's L0-L6 testing layer model, test responsibility boundaries, deterministic gate policy, test data and fixture hygiene, smoke and artifact health posture, real-provider opt-in rules, and the relationship between AI-assisted story tests and lower-level regression coverage.

## Does Not Own

This spec does not own what makes a verdict believable: oracle classification, harness admission, the effect-domain and observation-channel rules, and the execution-environment rules including the container rule and the real-use host manifest belong to `docs/verification-instruments.md`. This spec decides which layer proves which invariant; that document decides whether the instrument deciding it can be believed, and states its own application scope.

This spec does not own individual test implementation files, CI workflow syntax, release management policy, story file content, browser UI design, provider credentials, or package-specific test commands beyond the layer contract.

## Core References

- `docs/core/architecture.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/agent-workflow.md`
- `docs/core/audit.md`

## Summary

OpenKit needs a layered automated testing system that proves package-local behavior, cross-package contracts, NanoCore server behavior, Web UI behavior, release artifact health, and realistic product workflows.

The repository already has package unit tests, NanoCore black-box e2e tests, Web Playwright e2e tests, staging UI e2e tests, Docker-focused tests, a root `verify:release` tag gate, and a root `verify:full` explicit local gate.

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

Contract tests should catch drift between packages before browser or process tests become the first signal.

Integration and e2e tests should prove boundaries that unit tests cannot represent: process boot, HTTP status, SSE replay, persistence, authentication, browser rendering, and user interaction.

Smoke tests should be shallow, fast, and release-artifact-oriented.

`docs/specs/20260529-l6_story_acceptance.md` owns L6 execution, evidence, and defect-reduction mechanics.

The normal test gate must not require real OpenAI, ChatGPT subscription, Codex login, external network, or browser profile state. `docs/verification-instruments.md` owns the container rule, its one exception, and the platform-divergence rule that makes more than one execution environment affordable, together with the effect-domain rule that decides what it means when the lowest sufficient layer turns out to need an effect its subject does not own.

Opt-in tests may use real providers or real local host tools, but they must be explicitly named and skipped by default.

## Test Taxonomy

| Layer | Name | Primary question | Default gate | Main tools |
| --- | --- | --- | --- | --- |
| L0 | Static and repository checks | Is the repository structurally valid before runtime behavior is tested? | PR and release | Biome, TypeScript, repo scripts, generated-schema drift checks |
| L1 | Package and app unit tests | Does one package or app module behave correctly in isolation? | PR and release | Vitest, jsdom, Solid Testing Library |
| L2 | Contract and conformance tests | Do shared schemas, route payloads, clients, and protocol events agree? | PR and release | Zod, Vitest, generated JSON Schema, fixture conformance |
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

L0 should also enforce that every app and package keeps its own `AGENTS.md`, `README.md`, and package-level scripts aligned with root task names.

L0 failures should not require browser traces or process logs because they are usually source-level problems.

## L1 Package And App Unit Tests

Every package and app must own local unit tests for its public behavior and high-risk private logic.

Package tests should run without booting NanoCore unless the package itself is NanoCore.

Schema packages should test strict accepts, strict rejects, error paths, and generated artifact consistency.

Client packages should test request construction, response parsing, SSE parsing, retry semantics, terminal status handling, and error normalization against fake transports.

NanoCore unit tests should cover route builders, service logic, storage migrations, auth middleware decisions, provider registries, gateway converters, runtime config parsing, readiness checks, and adapter normalization with fakes.

Web unit tests should cover state reducers, hooks, component rendering, accessibility-visible labels, optimistic states, error states, and event-to-UI mapping.

Unit tests may use mocks, fakes, and in-memory stores, but they must not assert behavior that only a real process, browser, or network boundary can prove.

## L2 Contract And Conformance Tests

Contract tests are the main guardrail against cross-package drift.

Protocol schema changes must start in `packages/protocol`, including parser tests, conformance fixtures, and generated JSON Schema updates.

App API payload changes must start in `packages/app-api-schemas`, then move through NanoCore route tests, `@openkit/core-client` tests, and Web tests.

Core-client tests must prove the browser and integration clients consume only current protocol and App API shapes.

NanoCore route tests must prove emitted payloads match shared schemas instead of route-local duplicated schemas.

Web tests must prove the UI consumes current shapes without preserving removed fallbacks.

For behavior crossing package boundaries, update every affected producer and consumer, but test each distinct invariant only where it can fail. A schema fixture may prove a shared shape for several consumers; add NanoCore, client, Web, or browser tests only when that layer adds behavior or a distinct failure boundary.

When a contract intentionally breaks during internal development, tests should reject the removed shape instead of preserving compatibility coverage.

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

A fixed mechanical proof belongs at L3 when it drives NanoCore or another public process boundary, or at L4 when it drives the browser. A confirmed defect found at L6 receives its deterministic regression at the lowest sufficient layer.

## Test Data And Environment Policy

Tests should use disposable data roots, temporary workspaces, and deterministic fixtures by default.

Fixtures that contain secrets must use fake secret markers that are safe to commit.

Tests must not read from or write to a developer's persistent `data/` directory unless a test is explicitly marked manual or opt-in.

Tests must not require global ports when dynamic ports are practical.

Tests must clean up child processes even when assertions fail.

Tests must avoid wall-clock sleeps when they can wait on a state transition, HTTP response, SSE event, DOM condition, or process output.

Network access should be disabled or mocked by default unless the test is explicitly marked opt-in.

Quota-consuming provider tests must include a clear environment variable gate and must not run in normal CI by accident.

The container rule and its one exception, the platform-divergence rule, oracle classification, and harness admission were previously stated in this specification and are now owned by `docs/verification-instruments.md`. A check chooses its layer under this specification and is believed under that one.

## CI And Release Gates

Pull requests should run only the lightweight repository check by default.

Ordinary branch pushes should not run CI by default.

Version tags matching `v*.*.*` or `V*.*.*` should run the release gate as separate named jobs: `l0-l2`, `nanocore-e2e`, and `smoke`.

Manual workflow dispatch should expose `pr-check`, `l0-l2`, `nanocore-e2e`, `web-e2e`, `smoke`, `release-gate`, and `full` selections.

The release gate should run `pnpm -w verify:release`.

Release candidates may additionally run staging smoke tests and packaged-route browser tests through explicit manual workflows.

L4 Web e2e and L6 story acceptance should stay out of automatic PR and tag gates unless a later release policy explicitly promotes a subset. They remain manual gates to preserve CI resources.

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

L3 opt-in real-provider tests use a stricter failure-evidence contract than the general NanoCore list above. Each writes one owner-only (`0600`) redacted terminal result per attempted run, after that run's cleanup attempt settles and including when lifecycle work or cleanup fails. The result must retain enough to attribute a failure to product behavior rather than an external cause, and must never retain raw SSE, error text, request or response payloads, credential material, file paths, provider-private values, or durable product records. Evidence that cannot separate a product failure from a provider or environment failure is insufficient, not merely terse.

Cleanup always runs to settlement. When lifecycle work and cleanup both fail, the first lifecycle failure controls both the reported phase and the propagated error; the later cleanup failure is reported only as its own outcome, never replaces the first failure, and retains no raw secondary error. When cleanup is the first failure, it controls the reported phase and propagates.

Terminal failure classification is derived only from a parsed public Gateway terminal payload's error code, is restricted to the fixed public failure vocabulary owned by `docs/specs/20260526-llm_gateway_responses_api.md`, and maps every missing, non-string, or unrecognized code onto one generic fallback. A raw provider code is never retained. Run cardinality is fixed by the test rather than by its caller: at most one diagnostic cardinality override may exist per test, every other explicit value must be rejected before auth-source content access or any provider effect, and that override authorizes no general runner parameterization or additional lifecycle variant.

`apps/nanocore/e2e/provider-subscription-real-lifecycle-runner.test.mjs` is the executable projection of this contract for C04 and holds no authority of its own. It owns the exact summary field set and types, the phase values, the code enumeration, and the override's name; this specification owns only the invariants above.

## Coverage Expectations

Coverage thresholds are useful for regression pressure, but they are not the testing strategy.

The repository should keep coverage gates for deterministic package tests where they are stable.

Coverage should not force meaningless tests around generated files, fixtures, or adapter glue that is better proven by contract and e2e tests.

High-risk areas should require scenario coverage even when line coverage is already high.

High-risk areas include protocol parsers, SSE replay, auth/session boundaries, request idempotency, storage migrations, secret redaction, provider credential resolution, worker scheduling, artifact access, and browser flows that gate real user work.

For worker scheduling, high-risk coverage means launch authorization, exact worker identity, no concurrent duplicate launch, secret-safe control, and the documented restart fallback. It does not mean testing hypothetical fairness, multi-target placement, every legal state permutation, or every crash instruction boundary under the current single-target baseline.

## Current Implementation Projection

The repository implements the established layer gates and deterministic test placement:

- Root scripts expose the accepted deterministic gates: `verify`, `verify:l0-l2`, `verify:release`, `verify:full`, `test:e2e:nano`, `test:e2e:web`, and `test:smoke`, plus explicitly gated real-provider and real-worker L3 commands.
- `.github/workflows/ci.yml` implements the accepted trigger posture: lightweight PR checks, tag-triggered release gate jobs for L0-L2, NanoCore e2e, and smoke, plus manual workflow dispatch for `pr-check`, `l0-l2`, `nanocore-e2e`, `web-e2e`, `smoke`, `release-gate`, and `full`.
- Unit, contract, NanoCore e2e, Web e2e, staging e2e, and smoke entrypoints exist in the repository-owned locations named by this spec.
- `apps/web/e2e/openkit-local-self-check.spec.ts` is the C01 L4 entrypoint under `pnpm -w test:e2e:web`. The C02-C04 L3 entrypoints are `apps/nanocore/e2e/pi-ai-real-provider-runner.mjs`, `apps/nanocore/e2e/task-mode-real-worker-runner.mjs`, and `apps/nanocore/e2e/provider-subscription-real-lifecycle-runner.mjs`, behind `pnpm -w test:e2e:real-provider`, `pnpm -w test:e2e:real-task-mode`, and `pnpm -w test:e2e:real-subscription` respectively.
- L6 story artifacts remain outside the deterministic gate and follow `docs/specs/20260529-l6_story_acceptance.md`.

Remaining L6 work is owned by `docs/specs/20260529-l6_story_acceptance.md`.

## Risks And Mitigations

Risk: Browser e2e becomes slow and flaky.

Mitigation: Keep selectors accessible, isolate data roots, use dynamic ports, avoid sleeps, collect traces, and move non-UI assertions down to L1 or L2.

Risk: NanoCore e2e accidentally depends on local host state.

Mitigation: Use temporary data roots, fake providers, deterministic workers, and explicit opt-in flags for real Codex or real provider tests.

Risk: AI story tests become non-reproducible.

Mitigation: Apply the L6 acceptance contract and reduce every confirmed failure into a lower-layer regression test.

Risk: Contract drift appears first in Web e2e.

Mitigation: Add schema and core-client tests before browser tests, and keep route payload builders validated against shared schemas.

Risk: Smoke tests grow into slow e2e suites.

Mitigation: Limit smoke tests to boot, health, route availability, and minimal render checks.

Risk: Release gates become too expensive for normal development.

Mitigation: Keep PR gates to the lightweight repository check, run L0-L3 plus L5 only on version tags or manual release-gate dispatch, and reserve L4, L6, staging, real-provider, and real-subscription tests for explicit manual workflows.

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
- `docs/specs/superseded/agent-workflow/20260526-nano_core_lightweight_agents.md`
- `docs/specs/20260528-core_client_boundary.md`
- `docs/specs/superseded/20260529-remove_legacy_compatibility.md`
- `apps/nanocore/README.md`
- `apps/web/README.md`
