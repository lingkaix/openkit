# Repository Test Support

This directory owns repository-level tests, shared cross-package test support, smoke checks, and L6 story artifacts that do not belong to one app or package.

Package and app unit, contract, integration, and browser tests remain with their owning package or app. Root tests must not duplicate a lower-layer invariant or turn shared support into a parallel product implementation.

## Layout

- `app-image-entrypoint.test.mjs` checks App proxy routing, shared upstream idle keep-alive ordering against NanoCore's configured timeout and socket buffer, and process supervision. Its lifecycle cases require Bash with `wait -n` support.

- `dogfood-deploy.test.mjs` executes the A2 helper's Bash functions with isolated external-command doubles to verify release-metadata digest selection, obsolete NanoHost environment removal, and complete App cutover mount arguments. OCI index parsing uses real `jq` and supervisor release-metadata lookup uses real `python3`, both provided by the test image; the doubles replace external effects rather than parsing behavior.

- `openkit-skill-interface.test.mjs` exercises bundled token creation, rotation, and bootstrap with both macOS and Linux credential paths on either POSIX host. Its isolated minimal-host fixture makes machine-id files and keychain executables unavailable, and uses the child's temporary-home fallback seed for parent readback.
- `story-metadata.test.mjs` provides focused unit coverage for the shared scalar Story parser in `scripts/lib/story-metadata.mjs`.
- `toolchain-version-mirrors.test.mjs` checks the configuration invariants owned by `docs/toolchain.md` Toolchain Provisioning Boundary, Test Execution Environment, and Version Maintenance: `.mise.toml` defines no tasks; every mirrored Node and pnpm declaration across `.mise.toml`, root `package.json`, `.node-version`, `.nvmrc`, and `containers/test-env/Dockerfile` names the same exact version; the Biome pins in `.mise.toml` and root `package.json` agree on the exact supported version; `.github/workflows/ci.yml` does not provision Node or pnpm itself or bypass the NanoHost-scoped Rust pin with `rustup`; every `any` CI gate runs inside the test execution image; and the admitted NanoHost installer `host` leaf runs in its named non-container job. It asserts configuration values rather than document prose, so it stays inside the `AGENTS.md` rule against asserting source text.
- `web-user-operation-surface-contract.test.mjs` imports runtime `PUBLIC_OPERATION_ACCESS` and published Tier-A titles from `apps/web/src/app/surfaces.ts`. It checks a grouped disposition inventory accounts for every canonical-user and Workspace operation, excludes server and Gateway-actor operations (including native environment administration and subscription auto-topup), includes pending-request answers in Chat and withdrawal in Overview, rejects duplicates, and admits a `live` or `workflow` row only when its surface title is a published Tier-A catalog title. A `roadmap` disposition is permitted only for the four unpublished Automation CRUD operations (`R092`), Knowledge proposal drafting (`R070`), Knowledge proposal reversal (`R072`), the three deferred Workspace archive operations (`R008`), and the two deferred Workspace deletion and recovery operations (`R049`). This is catalog, disposition, and published-surface admission only; it does not prove UI behavior.
- `release-product-inputs.test.mjs` uses temporary Git repositories to verify live-round product-input classification, ancestry, renamed paths, and unsafe file modes; `release-ci-reuse.test.mjs` uses HTTP fixtures to verify exact-commit dispatch evidence, latest attempts, complete pagination, and conservative API failure. `release-workflow.test.mjs` verifies tag-only per-job reuse, shell fallback, permissions, and byte-identical publication/packaging jobs against the recorded main baseline.
- `release-preflight.test.mjs`, `release-image-state.test.mjs`, `package-release-assets.test.mjs`, `release-workflow.test.mjs`, and the isolated `support/nanohost-release-installer-live.sh` gate enforce release identity, registry failure handling, portable Skill and both-target NanoHost reproducibility and packaging, digest-pinned inputs, both-target fixed-path installer safety, and the candidate-smoke-promotion workflow structure owned by `docs/specs/20260829-release_management.md`.
- `nanohost-transport-assumptions.test.mjs` verifies that the retained stock buffer evidence belongs to the selected OpenShell source commit, detects corrupt or stale evidence, and checks finite contribution arithmetic. It does not certify the semantic memory bound; Cargo-owned adapter regressions and the opt-in stock probe remain under `apps/nanohost`.
- `nanohost-release-installer.test.mjs` registers its staging safety test only on Linux through a pre-run `process.platform` predicate. The NanoHost Distribution owner admits only Linux distributions; its staging exemption skips runtime host probes while retaining the installer boundary. Its x86-64 staging case verifies target payload bytes without host or service effects. POSIX checker-boundary fixtures remain in `host-profile-v2.test.mjs`.
- `support/` contains cross-package test data and setup support with demonstrated consumers.
- `smoke/` contains built-artifact health checks.
- `stories/` contains versioned L6 Story Markdown artifacts.

The finite governance contract tests project declared document and role seams. They check registration and instruction consistency, not semantic completeness, live dispatch, fresh attention, or operational effectiveness; independent artifact review supplies the relevant engineering judgment.

The administrator CLI catalog and Web operation disposition tests consume the shared Kernel definition keys for the migrated slice. They preserve their whole-catalog coverage and duplicate checks without maintaining a second handwritten slice list. Cross-projection result and stored-record behavior belongs to NanoCore's `src/operation-projections.test.ts`; root catalog checks do not replace that composition proof.

## Commands

Run root JavaScript unit tests, including Story parser tests, through the root unit gate:

```bash
pnpm -w test:unit
```

Run the Story schema L0 check and focused parser unit test directly:

```bash
node scripts/validate-story-schema.mjs
node --test tests/story-metadata.test.mjs
```

Mechanical acceptance tests stay with the app layer that owns their boundary. Run the root L4 gate with:

```bash
pnpm -w test:e2e:web
```

The app-owned L3 real-provider, real-subscription, real-task-mode, and NanoCore-restart gates are documented in `apps/nanocore/README.md` and remain default-off.

## Release-round acceptance instrument

`support/release-round.mjs` is a Node 24 instrument for the frozen 21-scenario first-release checklist owned by `docs/cookbooks/release.md`, with evidence obligations owned by `docs/specs/20260909-persistent_deployment_acceptance.md` and `docs/verification-instruments.md`.

Use one private JSON parameter file and a new private evidence directory; authorize the declared live effects separately before executing the first two commands.

```bash
node tests/support/release-round.mjs --help
node tests/support/release-round.mjs prepare --params /example/private/params.json --evidence-dir /example/private/round
node tests/support/release-round.mjs round --evidence-dir /example/private/round
node tests/support/release-round.mjs decide --evidence-dir /example/private/round --request example-request --decision grant
node tests/support/release-round.mjs summarize --evidence-dir /example/private/round --adjudications /example/private/checks.json
```

`prepare` refuses an existing evidence directory, pins the entire instrument, parameters and candidate checklist blob, archives exact source, checks the remote machine identity and archive digest, records exact changed Worker input paths and unchanged NanoHost attribution, and performs the isolated client's tool-visibility preflight outside the round window.

`round` requires completed preparation and admits one writer, performs exact-source App build/smoke/replacement and Web extraction, proves authenticated readiness, updates changed Worker images through administrator-reviewed admission before Worker rows, runs each runtime's A–D rows sequentially and the four runtime groups sequentially, then Chat, Task, Goal, External Agent, telemetry and cleanup observation.

A failed or refused independent scenario does not authorize a retry or stop unrelated scenarios; an unknown mutation outcome seals the entire round for inspection, and the start receipt refuses a second invocation.

Task's explicit current-owner replay uses the original successful admission's exact request and input; it is a checklist probe performed once after terminal observation, never a recovery attempt after an unknown response.

`decide` requires the complete retained Pending Request and fresh matching product intent, refuses stale or altered grants, bounds the wait, records the operator and declared responsible actor, and submits once.

The driver grants no approval automatically; the operator must read the complete `pending/<request-digest>.json` before granting or denying with the request's original id.

Task grants admit only branch creation from the declared base, pushes confined to that branch and allowed file paths, and one non-draft pull request from that branch into the declared base in the declared repository.

Goal grants admit the exact current immutable proposed Plan for the declared intent and one card, or the exact completion candidate backed by one linked Task and the required note Artifact, with no observed GitHub writes.

All parameter keys below are required, objects are closed, and unknown keys, secret-shaped content, arbitrary commands and alternate endpoint paths are refused; the synthetic fixture in `fixtures/release-round/synthetic.mjs` shows the complete shape using `staging.example.invalid` and invented values.

| Group | Required fields |
| --- | --- |
| Identity and scope | `roundId`, full `candidateCommit`, expected `checklistBlob`, `scenarioRevision`, neutral `evidenceAlias`, `workspaceId`, `protectedIds`, effect-specific `authority` references, pre-round `knownReferences` |
| `cli` | Absolute `executable`, protected `credentialFile` path, HTTPS `origin` with no credentials, path override, query or fragment |
| `deployment` | `sshAlias`, `machineId`, absolute `root`, `archiveDirectory`, `buildDirectory`, `webDirectory`, `environmentFile`, `container`, `imageRepository`, `expectedContainer`, `expectedImage`, `configurationDigest`, `bindingRevision`, `bindingDigest`, `nanoHostDigest`, `workerDigest`, `workerAgents`, `componentCommits`, `componentPaths`, `protectedMetadataPaths`, `payloadDigests`, `diagnosticUnit`, `minimumFreeBytes` |
| Component maps | `componentCommits` and `componentPaths` each have `nanoHost` and `worker`; `payloadDigests` maps absolute payload paths to SHA-256 hex digests; protected metadata paths are observed without opening their contents |
| `runtimes` | Exactly `codex`, `pi`, `opencode`, `deepseek`, each with `agentId`, `profileId`, `modelId`, `configurationVersion`, `marker`, `filename` |
| `issue` | Independently verified `repository`, `number`, `title`, `state` |
| `task` | `repository`, `issue`, `base`, distinct `branch`, `agentId`, `allowedFiles`, reviewed `expectedPatch`, `decidingActorId` |
| `goal` | `intent`, `filename`, `decidingActorId`, `requiredContent` strings for the acceptance note |
| `external` | Absolute maintained client `executable`, `modelId`, `persona`, `goal`, private independent `judgeFile` |
| `bounds` | Positive bounded `readAttempts` (at most ten), `pollMs`, `observationMs`, `decisionMs`, `processMs` |
| `sequence` | Nonnegative declared `priorCount` and nullable `resetReason`; the coordinator must supply the accepted prior sequence and any product-input/configuration/reset ruling |

The configuration digest identifies environment-file bytes without saving them, the binding digest identifies the protected catalog configuration, and payload digests plus metadata observations protect retained host payloads and authority-bearing files.

Live preparation requires exact SHA-256 configuration, NanoHost and Worker pins; historical unavailable identities are confined to offline replay and appear as `unavailable` in the public row.

The public row hashes the scenario-revision description and expands declared reset reasons only in the private summary.

Changed NanoHost inputs still refuse preparation and require the maintained NanoHost build/install and Initial NanoHost Provisioning procedure; this runner does not build or restart NanoHost.

Changed Worker inputs are admitted with the exact `git diff --name-only` path list, then built on the host after App readiness from the App's exact extracted candidate tree using `containers/workers/Dockerfile` target `worker-runtimes` for the host platform only.

The Buildx OCI exporter disables provenance and SBOM attestations and exports a single image manifest; the runner derives the expected digest from the archive's verified manifest bytes, and the fixed installed `/usr/lib/openkit/nanohost image import` command verifies and imports it once without registry publication.

`deployment.workerAgents` is a required unique list containing every Agent used by runtime rows, Task and Goal; validation requires the declared runtime and Task Agents, and the operator must include every Agent eligible for the Goal's linked work.

The runner discovers current Agent file ids and exact revisions through `runtime.file-list` and `runtime.agent-environment-read`, creates one round-owned private administration Thread through a single `administration.conversation-submit` acknowledgement in the server-derived Home Workspace, verifies its completed response without tool actions, and prepares each Agent once with a bare imported digest, `pullPolicy: never` and no `replaceNow`.

For each Worker candidate, the operator reads the entire `pending/<candidate-id-digest>.json` and invokes the existing `decide` command with the resolved candidate's Artifact id as `--request`; this second subject kind binds the retained candidate, target, image digest and configuration revision, with the exact unchanged `activationConfirmation` copied only after a grant.

A denied decision performs no activation; any definite Worker maintenance refusal fails Deployment and stops dependent rows as incomplete, while an unknown build/import/preparation/activation outcome seals the round for inspection with no mutation retry.

Every declared Agent must report the imported digest and a reloaded matching configuration before any Worker row, and the resulting Worker attribution records the candidate source and imported digest.

For the next round on that same candidate, the operator updates `deployment.componentCommits.worker` to the candidate and `deployment.workerDigest` to the imported digest; unchanged Worker inputs then skip build, import, preparation and activation.

Every host batch and administrator CLI call checks the declared machine identity, phase-specific operations and round-owned Thread scope; credentials are opened only through a regular mode-0600 path, passed to the existing CLI or recording bridge in memory, redacted from saved outputs and scanned when the round or an operator decision exits; a sealed round refuses every decision before a product call.

The external client is a fresh isolated process outside a checkout, with shell, browser, plugins and delegation disabled, given only persona and goal; its digest-pinned stdio bridge records real remote MCP exchanges and restricts product calls to the scenario's reads.

The supported public `thread.items` operation currently returns the full retained log with `nextCursor: null`; a non-null cursor is refused as incomplete because its input schema exposes no continuation cursor, while complete Turns are read from the dashboard and then `turn.read`.

Worker and scheduler inventories are complete array operations, not paginated Item operations; the instrument does not invent extra public operation names or input keys.

`summarize` is offline and writes only derived evidence projections, validates pins and closed-window coverage, recomputes Artifact bytes and origins and the deciding public-record predicates, and proposes non-pass outcomes with evidence references.

An independent checker supplies a JSON array of `{ "scenario": "pi.A", "code": "E", "reference": "example-accepted-boundary", "checker": "example-checker" }` entries for non-pass rows only; allowed final codes are `K`, `E`, `N`, `T`, `I`, and known references must predate the round.

An adjudication for a mechanical `P`, a duplicate adjudication, or promotion of missing deciding evidence to a definite failure is refused; a missing adjudication leaves the round unclassified and its consecutive count at zero; final `I` and `T` rows both leave the round incomplete.

The External Agent also requires an independent semantic judgment identifying `checker`, exact `recordId`, recomputed `publicReplyDigest`, `answerDigest`, `servedCandidate`, `servedImage` and `grounded`; retain it as `external-judgment.json` before final offline summarization if it was unavailable during collection.

Task meaningfulness is bounded by the reviewed file set and expected patch; the independent instrument reviewer must judge that criterion before live use, and cleanup consequences remain an independent review responsibility.

`summary.json` retains complete private classifications, evidence references, transport coverage and Worker failures by distinct failed Turn; `row.md` contains exactly seven columns with neutral receipt/check aliases and the SHA-256 of `manifest.json`.

The manifest hashes every retained source evidence file and the checker input, excluding the derived `summary.json`, `row.md` and `manifest.json` to avoid recursive hashes; preserve the private bundle in the existing access-controlled custody before temporary files expire.

Client, proxy, App, external MCP and sampled health observations remain separate; missing diagnostic coverage is `unavailable`, not a covered zero, and sshd diagnostic lines do not count as product resets.

For offline historical admission only, `summarize --legacy-prefix example-round` reads unchanged `logs/example-round-*` files and requires private `legacy-attribution.json`, `legacy-cleanup.json` and `legacy-external-judgment.json` supplements from independently retained observations; historical unavailable identities remain explicit rather than invented.

The legacy reader preserves parse failures and all matching files, including retained diagnostic/script-diff files, in the manifest and does not use old judge verdicts as pass predicates.

Run the local stand-ins without network, SSH, a real CLI or credential files:

```bash
node --test tests/release-round.test.mjs tests/openkit-public-redaction.test.mjs
node scripts/validate-test-governance.mjs
```

The root `lint` task runs workspace package lint tasks and does not cover this root test directory; run scoped `biome check` over the entry point, three helpers, fixture and test file using the repository's pinned Biome version.

These stand-ins and historical replays prove instrument behavior and record mapping; an independent reviewer must inspect the actual driver, effect boundaries and outputs before its admitted commit/digest decides a counted live round.
