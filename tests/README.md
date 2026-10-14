# Repository Test Support

This directory owns repository-level tests, shared cross-package test support, smoke checks, and L6 story artifacts that do not belong to one app or package.

Package and app unit, contract, integration, and browser tests remain with their owning package or app. Root tests must not duplicate a lower-layer invariant or turn shared support into a parallel product implementation.

## Layout

- `app-image-entrypoint.test.mjs` checks App proxy routing, shared upstream idle keep-alive ordering against NanoCore's configured timeout and socket buffer, and process supervision. Its lifecycle cases require Bash with `wait -n` support.

- `openkit-skill-interface.test.mjs` exercises bundled token creation, rotation, and bootstrap with both macOS and Linux credential paths on either POSIX host. Its isolated minimal-host fixture makes machine-id files and keychain executables unavailable, and uses the child's temporary-home fallback seed for parent readback.
- `story-metadata.test.mjs` provides focused unit coverage for the shared scalar Story parser in `scripts/lib/story-metadata.mjs`.
- `toolchain-version-mirrors.test.mjs` checks the configuration invariants owned by `docs/toolchain.md` Toolchain Provisioning Boundary, Test Execution Environment, and Version Maintenance: `.mise.toml` defines no tasks; every mirrored Node and pnpm declaration across `.mise.toml`, root `package.json`, `.node-version`, `.nvmrc`, and `containers/test-env/Dockerfile` names the same exact version; the Biome pins in `.mise.toml` and root `package.json` agree on the exact supported version; `.github/workflows/ci.yml` does not provision Node or pnpm itself or bypass the NanoHost-scoped Rust pin with `rustup`; every `any` CI gate runs inside the test execution image; and the admitted NanoHost installer `host` leaf runs in its named non-container job. It asserts configuration values rather than document prose, so it stays inside the `AGENTS.md` rule against asserting source text.
- `web-user-operation-surface-contract.test.mjs` imports runtime `PUBLIC_OPERATION_ACCESS` and published Tier-A titles from `apps/web/src/app/surfaces.ts`. It checks a grouped disposition inventory accounts for every canonical-user and Workspace operation, excludes server and Gateway-actor operations (including native environment administration and subscription auto-topup), includes pending-request answers in Chat and withdrawal in Overview, rejects duplicates, and admits a `live` or `workflow` row only when its surface title is a published Tier-A catalog title. A `roadmap` disposition is permitted only for the four unpublished Automation CRUD operations (`R092`), Knowledge proposal drafting (`R070`), Knowledge proposal reversal (`R072`), the three deferred Workspace archive operations (`R008`), and the two deferred Workspace deletion and recovery operations (`R049`). This is catalog, disposition, and published-surface admission only; it does not prove UI behavior.
- `release-ci-reuse.test.mjs` uses HTTP fixtures to verify exact-commit dispatch and main-push evidence, latest attempts, complete pagination, and conservative API failure. `release-workflow.test.mjs` verifies tag-only per-job reuse, shell fallback, permissions, and byte-identical publication/packaging jobs against the recorded main baseline. `release-notes.test.mjs` checks that `scripts/release-notes.mjs --check` rejects a missing file, a missing heading, an extra level-2 heading, an empty section, a duplicate heading, a tab after `##`, a leading space before `##`, an empty `##`, a fence opener, and a setext underline, and accepts a valid file. It also requires equal notes for an initial publication and a same-tag reuse, and checks `--compare-body` against one matching body and one differing body.
- `release-preflight.test.mjs`, `release-image-state.test.mjs`, `package-release-assets.test.mjs`, `release-workflow.test.mjs`, and the isolated `support/nanohost-release-installer-live.sh` gate enforce release identity, registry failure handling, portable Skill and both-target NanoHost reproducibility and packaging, digest-pinned inputs, both-target fixed-path installer safety, and the candidate-smoke-promotion workflow structure owned by `docs/specs/20260829-release_management.md`.
- `nanohost-transport-assumptions.test.mjs` verifies that the retained stock buffer evidence belongs to the selected OpenShell source commit, detects corrupt or stale evidence, and checks finite contribution arithmetic. It does not certify the semantic memory bound; Cargo-owned adapter regressions and the opt-in stock probe remain under `apps/nanohost`.
- `nanohost-release-installer.test.mjs` registers its staging safety test only on Linux through a pre-run `process.platform` predicate. The NanoHost Distribution owner admits only Linux distributions; its staging exemption skips runtime host probes while retaining the installer boundary. Its x86-64 staging case verifies target payload bytes without host or service effects. POSIX checker-boundary fixtures remain in `host-profile-v2.test.mjs`.
- `support/` contains cross-package test data and setup support with demonstrated consumers.
- `smoke/` contains built-artifact health checks.
- `stories/` contains versioned L6 Story Markdown artifacts.

The finite governance contract tests project declared document and role seams. They check registration and instruction consistency, not semantic completeness, live dispatch, fresh attention, or operational effectiveness; independent artifact review supplies the relevant engineering judgment.

The Web operation census counts deployment-admin App-update preflight in the server partition and keeps it outside the canonical-user and Workspace surface inventory.

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

`support/release-round.mjs` is a Node 24 instrument for Worker qualification and shared release-round support, with the matrix owned by `docs/cookbooks/release.md`, with evidence obligations owned by `docs/specs/20260909-persistent_deployment_acceptance.md` and `docs/verification-instruments.md`.

Use one private JSON parameter file and a new private evidence directory; authorize the declared live effects separately before executing the first two commands.

```bash
node tests/support/release-round.mjs --help
node tests/support/release-round.mjs prepare --target example-host --params /example/private/params.json --evidence-dir /example/private/round
node tests/support/release-round.mjs round --target example-host --evidence-dir /example/private/round
node tests/support/release-round.mjs summarize --evidence-dir /example/private/round --adjudications /example/private/checks.json
```

`prepare` refuses an existing evidence directory. It pins the instrument, the parameters, and the candidate checklist blob. Worker-only preparation launches no browser because no qualification case uses a deciding browser observation. It records changed Worker input paths and unchanged NanoHost attribution. Live preparation requires the published `releaseTag`; offline historical summaries may report its absence as unavailable.

`round` requires completed preparation and admits one writer. On completion it automatically generates the offline summary and per-case rows. `round` and `summarize` return nonzero unless all sixteen rows pass. The runner does not build an image or replace a container. It runs each runtime's A–D rows and the four runtime groups concurrently within admitted capacity, then telemetry and cleanup.

`prepare` defaults to Worker-only purpose and makes no browser launch. For a browser-dependent catalog story, use `--purpose browser-story`: preparation must retain successful blank-page launch and session closure in `browser-preflight.json`. Failed launch, timeout, exception or failed close prevents `prepare-complete.json`; inspect that retained failure before a fresh attempt. This shared prerequisite does not perform or judge the story.

`round` can outlive the operator's shell call and must be launched as a process that survives the operator's shell call, in its own session, for example with Python `subprocess.Popen(..., start_new_session=True)` or `setsid`. Supply standard input from the null device, append output to a private process log such as `/example/private/round-process.log`, use the declared protected operator environment, and record the round process's exit status in that log.

A failed or refused independent scenario does not authorize a retry or stop unrelated scenarios; an unknown mutation outcome seals the entire round for inspection, and the start receipt refuses a second invocation.

All original parameter keys below are required; the additive `releaseTag` is required for new live preparations. Objects are closed, and unknown keys, secret-shaped content, arbitrary commands and alternate endpoint paths are refused; the synthetic fixture in `fixtures/release-round/synthetic.mjs` shows the complete shape using `staging.example.invalid` and invented values.

| Group | Required fields |
| --- | --- |
| Identity and scope | `roundId`, full `candidateCommit`, expected `checklistBlob`, `scenarioRevision`, neutral `evidenceAlias`, `workspaceId`, `protectedIds`, effect-specific `authority` references, pre-round `knownReferences` |
| `cli` | Absolute `executable`, protected `credentialFile` path, HTTPS `origin` with no credentials, path override, query or fragment |
| `deployment` | `sshAlias`, `machineId`, `container`, `imageRepository`, `configurationDigest`, `nanoHostDigest`, `workerDigest`, `appImage`, `webIdentity`, `componentCommits`, `componentPaths`, `diagnosticUnit` |
| Component maps | `componentCommits` and `componentPaths` each have `nanoHost` and `worker` |
| `runtimes` | Exactly `codex`, `pi`, `opencode`, `deepseek`, each with `agentId`, `profileId`, `modelId`, `configurationVersion`, `marker`, `filename` |
| `issue` | Independently verified `repository`, `number`, `title`, `state` |
| `bounds` | Positive bounded `readAttempts` (at most ten), `pollMs`, `observationMs`, `processMs` |

Live preparation requires exact SHA-256 configuration, NanoHost, and Worker pins. A value that is not that digest form appears as `unavailable` in the public row.

The public row hashes the scenario-revision description.

Changed NanoHost inputs still refuse preparation and require the maintained NanoHost build/install and Initial NanoHost Provisioning procedure; this runner does not build or restart NanoHost.

`appImage` is the exact App image identity that the deployment runs.

`webIdentity` is the exact Web identity that the deployment serves.

The operator copies both from the retained update receipt or the retained installation record.

When `appImage` or `webIdentity` is not a SHA-256 digest, the public row shows `unavailable`.

The runner does not convert an OCI manifest digest and a local image id into each other.

Every host batch and administrator CLI call checks the declared machine identity and round-owned Thread scope. Credentials are opened only through a regular mode-0600 path, passed to the existing CLI in memory, redacted from saved outputs, and scanned when the round exits.

The supported public `thread.items` operation currently returns the full retained log with `nextCursor: null`; a non-null cursor is refused as incomplete because its input schema exposes no continuation cursor, while complete Turns are read from the dashboard and then `turn.read`.

`summarize` is offline and writes only derived evidence projections, validates pins and closed-window coverage, recomputes Artifact bytes and origins and the deciding public-record predicates, and proposes non-pass outcomes with evidence references.

An independent checker supplies a JSON array of `{ "scenario": "pi.A", "code": "E", "reference": "example-accepted-boundary", "checker": "example-checker" }` entries for non-pass rows only; allowed final codes are `K`, `E`, `N`, `T`, `I`, and known references must predate the round.

An adjudication for a mechanical `P`, a duplicate adjudication, or promotion of missing evidence to an observed failure is refused. A missing adjudication leaves the round unclassified. Final `I` and `T` rows leave the round incomplete.

`summary.json` retains complete private classifications, evidence references, transport coverage and Worker failures by distinct failed Turn; `cases.md` contains sixteen per-case public rows; `summary.json.publicRows` supplies the bounded notes projection. `row.md` retains the aggregate seven-column diagnostic projection with neutral receipt/check aliases and the SHA-256 of `manifest.json`.

The manifest hashes every retained source evidence file and the checker inputs, excluding the derived `summary.json`, `row.md`, `cases.md`, and `manifest.json` to avoid recursive hashes; preserve the private bundle in the existing access-controlled custody before temporary files expire.

Client, proxy, App, external MCP and sampled health observations remain separate; missing diagnostic coverage is `unavailable`, not a covered zero, and sshd diagnostic lines do not count as product resets.

Run the local stand-ins without network, SSH, a real CLI or credential files:

```bash
node --test tests/release-round.test.mjs tests/openkit-public-redaction.test.mjs
node scripts/validate-test-governance.mjs
```

The root `lint` task runs workspace package lint tasks and does not cover this root test directory; run scoped `biome check` over the entry point, three helpers, fixture and test file using the repository's pinned Biome version.

These stand-ins prove instrument behavior and record mapping. An independent reviewer must inspect the actual driver, effect boundaries, and outputs before its admitted commit and digest decide a counted live round.

## Release Cadence Checks

`pnpm test:ci` executes overlapping Vitest suites once with coverage and TAP skip enforcement, runs distinct native/catalog suites through the same skip/failure guard, and runs root tests and the existing generated-Skill check. Before substitution, and after suite-selection or command-input changes, `node scripts/release-tests.mjs --inventory-only` compares actual collected file/case inventories with and without coverage. Routine `test:ci` uses that admitted recipe and does no duplicate collection. Collection failure or missing cases fails closed. Offline regressions inject command failure and undeclared skips into the same guard. This command builds required dependencies and performs no release effects.

`release-publication-check.mjs` consumes a private current observation snapshot, not a producer verdict. Its grant binds the asset set and approved publication-input fingerprint. It independently reads publication job blocks, invoked scripts and their current static dependencies from Git at P and `baseline.sha`, retains blob identities, and compares the actual fingerprints; matching snapshot fields alone cannot prove unchanged bytes. It checks exact-P review/main membership, successful run/jobs, reconciled blocker triage, unused or admitted immutable-retry identities, the declared observation validity without a fixed one-hour cap, and prerelease/Latest flags. It never tags or publishes.

`release-record.mjs --manifest-output` uses existing image records and portable checksums. The `assertions` JSON contains exact `sourceCommit`, `appDigest`, `previousAppImageId`, true `migrationFree`, `configurationCompatible`, and `retainedDataCompatible`, `recovery: "previous-image-compatible"`, and neutral reviewed `provenance` alias. Unknown authority-bearing assertions refuse. `previousAppImageId` is the actual Docker image ID, while `appDigest` is the published OCI index digest; they are not interchangeable. Use `--compare-manifest FILE` with the same generation inputs to verify downloaded bytes against the publication facts. The manifest does not replace host assessment. `--draft-input` generates the existing two-section reviewed input from nonempty `changes` and `knownIssues` arrays. `--header` and `--qualification-summary` extend notes with existing compact evidence; post-publication closeout stays in the private release record.

`release-update-app.mjs` exposes the App procedure for offline composition tests. Its CLI requires explicit target, private params, a separate protected `--deployment-record` artifact, and a new evidence directory, then refuses until an exact live platform-identity adapter is supplied. The App owner admits the bounded administrator-run path. Private parameters additionally pin `helperSha256` from the verified target operations archive; the injected adapter must read the retained `a1` deployment artifact separately from params and observe its exact physical target before App operations. Its core fields are `reference`, `sshAlias`, canonical `origin`, `machineId` and `container`; `grant.deploymentReference` binds that record. The adapter rechecks the binding, physical target and current retained administrator grant immediately before start. Tests prove idle refusal, complete prepared-summary bindings, installed/preparation helper identity, grant revocation and target changes, pinned receipt identity, single submission, honest unknown results, exact component identity, and selected retained Workspace reads. It neither implements NanoHost replacement nor grants Worker activation approval.

Run the focused offline checks:

```bash
node --test tests/release-publication-check.test.mjs tests/release-manifest.test.mjs tests/release-tests.test.mjs tests/release-update-app.test.mjs tests/release-round.test.mjs tests/release-notes.test.mjs
```
