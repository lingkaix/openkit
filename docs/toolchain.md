---
status: Accepted
---
# Toolchain

This guide answers one cross-cutting question: which tools does this repository use, and where is each version pinned.

## Judgments

Calibrated premises about scope and priority for the toolchain, formed from team shape and ecosystem conditions rather than derived from a contract. Per `docs/documentation-model.md` they are not behavioral contracts, no implementation choice cites one as its sole authority, and any behavioral question resolves at the owning core document or specification.

### One Default Path Beats Per-Package Choice

The repository picks one JS/TS toolchain and applies it everywhere, accepting a worse fit for individual packages in exchange for one thing an agent has to learn and one place a version is pinned. Breadth of tool choice is deliberately traded away.

Rests on: a small team with agents doing most routine work, where the cost of a wrong guess about which tool a package uses exceeds the cost of a suboptimal tool; and a repository still small enough that no package has an established conflicting need.

Overturned by: a package whose real requirements the default path cannot meet without workarounds that are themselves harder to learn than a second toolchain would be. One such package retires the premise for that scope, through the cookbook-driven route below rather than by silently diverging.

### Correct By Default Beats Correct By Discipline

A toolchain obligation that every caller must remember at every command is treated as a defect in the environment rather than as a discipline problem. The repository makes the pinned toolchain resolvable as bare commands and forbids a per-command wrapper prefix, accepting a one-time `PATH` obligation in exchange for removing a step that can be skipped.

Rests on: agents performing most routine work through non-interactive shells, where shell-activation hooks never load; and a wrapper prefix being a no-op whenever the toolchain is already resolvable, so the rule cannot teach itself through ordinary failure. It is silently optional most of the time and silently wrong the rest, which selects for exactly the habit of dropping it. Its observed failure mode is also the expensive one: not a rejected command, but a command that succeeds against an unpinned runtime.

Overturned by: a supported environment where the pinned toolchain cannot be placed on `PATH`, which would make the prefix load-bearing rather than ceremonial. Bootstrap is that case in miniature and is the single documented exception.

### Capability Is Discovered, Not Declared

No document enumerates the capabilities an ordinary deterministic check requires, because that list is unbounded and would always sit one failure behind reality. What is fixed instead is the disposition of the unknown: a check that meets an environment it cannot run in fails, and a skip is reachable only from an opt-in decided before the run. The environment is then free to vary — a developer host provisioned by mise, CI inside the repository image, and a Worker Agent sandbox are all permitted hosts for the same check — because an insufficient one announces itself instead of quietly passing. When two permitted environments disagree about the same check, both results stand and the disagreement is itself the finding.

Rests on: the observed failure mode being a disposition defect rather than an enumeration failure. `EPERM` answered by a per-test skip converts absent coverage into a passing gate, and no predicted capability list would have prevented it, while the rule that does prevent it is one sentence long. It also rests on a measurement: the test corpus contains five skips, all decidable before the run — three on `process.platform` and two on declared environment-variable opt-ins — and no runtime-error-conditional skip at all, so this rule starts satisfied rather than as a migration.

Supersedes: The Environment Declares Capability, Not The Host, whose own overturning condition arrived from inside the product rather than from a developer machine, because a Worker Agent sandbox is a supported development environment that cannot run a container. What survives from it is the failure mode above and the refusal to let a host silently decide coverage. What does not survive is the inference that one mandatory image is the only way to enforce that; the image enforced the rule by removing the variance rather than by detecting a violation, which is why it also removed environments the repository now has to support.

Overturned by: an observed case where a check passes in one permitted environment and fails in another for a reason that is neither the code under test nor a recorded difference between the environments. That would mean variance is no longer attributable, and the repository would owe the enumeration this judgment declines to write.

### Optional Stacks Stay Optional Until A Real Need Lands

Python, Go, Rust, and Zig are supported as opt-in paths rather than provisioned in advance, because an unused stack still costs version pinning, CI time, and agent context.

Rests on: cookbooks being able to add a stack when one is needed, and keeping unused stacks out of the root default toolchain.

Overturned by: accepted work that requires one of them, at which point that stack joins the default path for its scope. NanoHost is that case for Rust: the version stays app-local in `apps/nanohost/mise.toml`, and the deterministic test image mirrors the same exact pin so ordinary repository gates can run NanoHost Cargo scripts.

## Owns

This document holds six narrow repository-operation decisions, which `docs/documentation-model.md` permits because no core document or specification owns them: repository default tooling, the toolchain provisioning boundary, the test execution environment, setup procedure, dependency procedure, and version maintenance. None authorizes anything about product behavior or architecture.

### Default Tooling

The default-tooling decision is:

- Node.js is the default runtime.
- pnpm is the default package manager, and pnpm workspaces the default workspace model.
- TypeScript is the default compiler for typed JS/TS projects.
- Turborepo is the default build orchestrator.
- Biome is the default linter and formatter.
- lefthook is the default git-hook manager.
- mise is the default tool installer and version anchor, bounded by Toolchain Provisioning Boundary below.
- Python, Go, Rust, and Zig are not part of the root default toolchain and are adopted only through cookbook-driven setup.
- Bun is not the package manager and is not provisioned. It is adopted through the same cookbook-driven route as any other optional stack.

Replacing any default named above is a repository design change that must update this guide in the same change and carry a change record.

Biome uses the recommended preset with two repository-wide rule exclusions. `complexity/useOptionalChain` is disabled because its rewrite is an unsafe style normalization across guard branches, including strict-risk paths where an equivalent-looking rewrite does not justify semantic churn. `suspicious/noUndeclaredEnvVars` is disabled because it assumes Turbo owns environment-dependent execution, while repository release and Skill entry paths legitimately execute directly outside Turbo; Turbo-owned tasks remain responsible for declaring their actual cache dependencies.

### Toolchain Provisioning Boundary

mise installs and pins tools. It is not the command surface, and no gate invokes it: a gate runs bare `pnpm ...` against whatever toolchain is already resolvable, which mise provisioned beforehand on a developer machine and which the image carries directly. Making the developer machine a primary environment for ordinary checks makes that prior provisioning load-bearing rather than convenient, and the obligation it creates is the `PATH` one below and nothing more.

- `.mise.toml` declares installed tool versions and nothing else. It MUST NOT define tasks. A mise task whose body is a package-manager script is a pass-through layer over an owner that already exists, and it splits one command surface into two with divergent names and coverage.
- Repository commands are the `scripts` in root `package.json`, invoked as bare `pnpm ...`. Root `package.json` is their single owner.
- The tracked `lefthook.yml` is the single canonical Git-hook configuration; no example configuration or promotion lifecycle exists. Its pre-commit hook invokes `lint:staged` and its commit-msg hook invokes `commitmsg:check`; both commands use `any` placement through their root package scripts. `scripts/repo-init.sh` installs the hooks from that tracked configuration.
- A per-command `mise exec --` or `mise run` prefix MUST NOT appear in active guidance, scripts, CI, or container files. Historical change records and terminal specifications may retain execution evidence. `scripts/repo-init.sh` is the sole active exception, because bootstrap runs before the pinned toolchain is guaranteed to be resolvable.
- Making the pinned toolchain resolvable is an environment obligation, not a per-command one: the mise shims directory belongs on `PATH` for every shell, agent, and sandbox that runs repository commands, because shell-activation hooks do not load in non-interactive shells. `scripts/repo-init.sh` checks the invoking environment and prints the required `PATH` line when it does not hold.
- A container image MUST NOT depend on mise existing on the host that builds or runs it. That rule constrains where a tool comes from, not whether the tool may be present: `worker-common` installs mise as an in-image capability under `docs/specs/20260721-worker_execution_environment_images.md`, which the rule permits because the image supplies it rather than inheriting it from an enclosing machine.
- An image at the root of a derivation chain pins its own runtime and package-manager versions; a derived image inherits them and MUST NOT re-pin them. `worker-common` is that public derivation root for user and secondary-developer images. `containers/test-env` is an internal sibling, not a derived image: it pins the same exact Node digest independently and keeps its own Corepack pnpm pin. Every `any` CI job takes Node and pnpm from the development image. The app-image container-subject host leaf is the one Node-based host CI exception: its commit-pinned mise action installs only the root `.mise.toml` Node declaration, so it adds no version owner or pnpm path. The surviving pins are mirrored declarations under Version Maintenance below.
- mise inside a sandbox serves a different question from mise on a developer machine. On a developer machine it provisions this repository's pinned toolchain. Inside a sandbox it provisions the toolchain a task repository declares for itself, as a workspace-local effect with no network authority of its own. Neither use makes mise a command surface, and neither is authority to add a repository-level tool without the present-need rule below.
- A tool is pinned in `.mise.toml` only when something in the repository uses it. An unused pin costs install time and implies support that does not exist.

### Test Execution Environment

The test-execution decision is:

- An `any`-placed deterministic repository check has three permitted environments, and no one of them defines it: a developer machine whose toolchain mise provisions, the repository development image, and a Worker Agent sandbox. The developer machine is the primary path, so Docker is no longer an obligation for ordinary development. The image is authoritative for that placement: CI runs every `any` gate inside it, and when its permitted environments disagree the image result decides. An admitted `host` leaf instead runs only in its named host environment and CI non-container job.
- The repository development image is `containers/test-env`. It is an internal sibling of the public `worker-common` base: it pins the same exact upstream Node digest in its own Dockerfile and MUST NOT be built `FROM worker-common`. There is no publication dependency for this sibling. `docs/specs/20260721-worker_execution_environment_images.md` owns the public base and the external derivation path; this decision owns the internal test image and the Node-digest mirror.
- The sibling adds what the gates execute and the worker baseline does not carry, and nothing else. It MUST NOT drift from the worker Node digest: a development image that reaches a different Node than the product ships is testing something the product does not run. It installs no worker runtime, because the checks needing one never run in the image and a runtime's release cadence would otherwise sit on the critical path of every unrelated gate through the image tag.
- Two placements exist, and they answer different questions. A check placed `any` may run in any permitted environment; the caller and CI select which, and the check never selects for itself. A check placed `host` MUST NOT run inside the image and is reserved for checks that drive Docker or a real worker runtime themselves plus the one fixed-path NanoHost installer namespace gate: the NanoCore restart gate, the real-codex, real-provider, real-subscription, real-task-mode, app-image administrator-recovery, and NanoHost installer gates, `app:run`, and `init`. The installer gate requires Bubblewrap, fails when the binary or its minimal namespace self-check is unavailable, writes only through fresh temporary bind targets, and runs in CI as the same unprivileged shell leaf from a non-container job after that job installs the Ubuntu `bubblewrap` and `slirp4netns` packages and enables unprivileged user namespaces on its disposable runner; `slirp4netns` supplies the fixed bind target that the gate replaces with its fixture, and the gate never invokes a service, container, App Server, or host lifecycle operation. The app-image gate is manual-only, uses disposable bind mounts, starts no product server, and resolves its Node harness from the root mise pin through the same commit-pinned action already used for the NanoHost Rust host leaf. The image receives no Docker socket or Bubblewrap, because handing it a host-shaped capability would make its containment decorative. A placed root command is wrapped by `scripts/test-env.sh` exactly once and MUST NOT invoke another placed root; composition inlines the inner build or bundle step. The `verify:*` commands remain placement-free composites that call those placed leaves.
- An ordinary deterministic check without a declared opt-in boundary MUST NOT answer a missing capability by skipping itself. A skip would turn absent deterministic coverage into a passing gate, which is the failure this decision exists to remove. The check fails instead, and the failure names the environment it ran in. Explicit real-Codex, real-provider, real-subscription, and real-worker gates keep the environment-variable, skip-aware opt-in contract owned by `docs/specs/20260529-test_strategy.md`: absent opt-in skips the real gate, while a selected gate fails when its declared prerequisite is missing. Root `check:repo` runs `scripts/validate-test-governance.mjs` for the static rule, and root `test` and `test:unit` run their suites once through that script's reported-skip assertion. Every workspace Vitest `test` command selects the built-in `tap-flat` reporter so Turbo output preserves an attributable test hierarchy. A reported TAP skip is authorized only from file-bound declarations resolved against discovered test files: the title must include a test-file component that uniquely suffix-matches one discovered test file that declared it, and an exact suite or test hierarchy component declared in that file. A title with no matching reporter file, a suffix shared with another discovered test file, a declared name that is only the file path, or a flat skip name is undeclared. An unnamed default-reporter skip summary fails instead of being guessed from an allow-list. Exact file pragmas remain whole-file platform declarations; a `skipIf`/`runIf` platform predicate exempts only its associated test or suite subtree.
- Re-running a failed check in the image produces a second result and never repairs the first. Both results stand, and a host failure followed by an image pass is not a pass: it is the recorded finding that this check passes only in the image, which is a fact about the repository that nothing previously could observe. Treating the second run as a retry would restore the original failure in a new form, because it would let an environment difference silently absorb a real defect, and deciding which of the two it was is exactly the unbounded judgement that `docs/verification-instruments.md` forbids a check from making about itself.
- This decision owns where an ordinary check runs. It does not own what a check may require or what it may prove: `docs/verification-instruments.md` owns the rule that an ordinary deterministic check requires no container runtime, the one exception for checks whose subject is container behavior, the rule that platform divergence is declared rather than avoided, the guard forbidding a portable fake from replacing a real oracle, and the real-use host manifest that stands where this image cannot reach. Three permitted environments are affordable only because those rules hold, so a change here that outruns them is a defect in this decision rather than a gap in that document.
- The image is addressed by a digest of its build inputs, printed by `scripts/docker/test-image-tag.mjs`. No branch name, run id, or `latest` tag participates, so a tree cannot be tested against an image built from a different Dockerfile. The sibling Node digest is part of the Dockerfile and therefore part of that address; a floating Node tag would defeat the mirror.
- When a check is already executing inside the image, it compares the image's embedded build-input digest with the digest of the current mounted tree and rejects a mismatch before running.
- `.github/workflows/ci.yml` runs every `any`-placed gate job inside that image and each admitted `host` leaf only in its named non-container job; it publishes the image to the registry and repository named in `containers/images.json` when the digest tag is absent. The image stays `release: false`: it is never deployed and never carries a product version.
- Dependency trees and the pnpm store live in named volumes rather than in the bind mount, because `better-sqlite3` and `esbuild` are built per platform and a shared `node_modules` would hand the container the host's binaries. Reclaim them with `docker volume rm $(docker volume ls -q --filter name=openkit-test-env-)`.
- The real-use verification tier has no equivalent of this image, because its environment is a live host rather than an artifact this decision can address. `docs/verification-instruments.md` owns the host manifest that stands in its place, its two runnable halves, its identity, its growth method, and the attempt-local credential rule that binds every mechanism reaching such a host. This decision reaches as far as the image and no further.

### Setup And Dependency Procedure

Root `AGENTS.md` routes setup, CI, dependency, generator, and toolchain work here, and these obligations are owned here rather than in root. They bind whenever that work happens:

- Prefer official CLIs, framework generators, or approved templates for setup and generated-project work.
- Do not handcraft new sub-project starter files unless the relevant cookbook explicitly permits it.
- Keep setup instructions and automation in version-controlled files.
- Add dependencies through the package manager.
- Prefer maintained current versions unless the user requests otherwise.
- When commits are authorized, commit the corresponding lockfile update with the dependency change.
- If a dependency affects workflow or architecture, document why it exists: keep workflow rationale in the affected guide or this toolchain guide, and keep architecture rationale in the applicable accepted Core document or specification.

### Version Maintenance

- If any default or procedure obligation named in `## Owns` changes, update this guide in the same change and carry a change record.
- The worker baseline leads the Node and pnpm versions and this repository follows. `docs/specs/20260721-worker_execution_environment_images.md` sets them for `worker-common`, `containers/test-env/Dockerfile` mirrors the same Node digest as a sibling, and the developer-machine declarations mirror that same Node version. The direction is fixed rather than incidental: the alternative has the repository testing on a runtime the product does not ship.
- If the managed Node version changes, update the baseline table in that specification, `containers/workers/Dockerfile`, `containers/test-env/Dockerfile`, `.mise.toml`, `.node-version`, `.nvmrc`, and root `package.json` `engines` in the same change. A `test-env` Node digest that does not equal the worker-common `FROM node:… AS worker-common` line is a mirror failure. Every `any` CI job takes Node from the development image, while the app-image container-subject host leaf consumes the same `.mise.toml` pin through its commit-pinned mise action.
- If the pnpm version changes, update the same specification's baseline table, `containers/workers/Dockerfile`, `.mise.toml`, and `packageManager` in root `package.json` in the same change, keep `engines` consistent, and keep the `corepack prepare pnpm@…` line in `containers/test-env/Dockerfile` equal to that pin. `.github/workflows/ci.yml` takes pnpm from the development image.
- If the Biome version changes, update the `biome` pin in `.mise.toml` and the root `@biomejs/biome` dev dependency to the same exact version in the same change.
- If the NanoHost-scoped Rust version changes, update `apps/nanohost/mise.toml` and the unquoted `ENV RUST_VERSION=` line in `containers/test-env/Dockerfile` to the same exact version in the same change. The Dockerfile rustup install MUST consume `${RUST_VERSION}` rather than a second hard-coded literal. That Dockerfile edit changes `OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST` and forces a test-image rebuild and republish.
- If the worker-common Node digest changes, update the `FROM` line in `containers/test-env/Dockerfile` to the same digest in the same change. That is a sibling mirror, not a derivation from a published `worker-common` digest, and it requires no GHCR publication. That edit changes `OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST` and forces a rebuild and republish.
- Every mirrored declaration above MUST name an exact version rather than a floating range. A floating pin in one mirror defeats the anchor: the version a contributor resolves and the version CI gates on can then diverge without any file changing, which is the failure the mirrors exist to prevent.
- If setup or command entry points change, update `README.md`, `CONTRIBUTING.md`, and the relevant `docs/cookbooks/` documents.

## Does Not Own

This guide does not own tool-version values, the documentation type system, testing taxonomy, verification depth, oracle classification, harness admission, the real-use host manifest, engineering rationale, product behavior, architecture, or general agent execution rules. The six decisions under `## Owns` are the sole exception. Everything else below is a non-authoritative link projection; where it disagrees with an owner or executable file, that source wins and this document is the defect.

## Realization And Version Links

- Default-tool realization: `.mise.toml`, root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `turbo.json`, `biome.json`, `lefthook.yml`, `scripts/repo-init.sh`
- Test-execution realization: `containers/test-env/Dockerfile`, `containers/test-env/smoke.sh`, `containers/test-env/README.md`, `containers/workers/Dockerfile`, `containers/images.json`, `scripts/test-env.sh`, `scripts/docker/test-image-tag.mjs`, root `package.json` scripts, `.github/workflows/ci.yml`, `docs/cookbooks/docker-test-env.md`
- Runtime and package-manager versions: `.mise.toml`, root `package.json`, `.node-version`, `.nvmrc`, `containers/workers/Dockerfile`, `containers/test-env/Dockerfile`, and scope-local `mise.toml` files
- Optional-stack setup: `docs/cookbooks/python-setup.md`, `docs/cookbooks/go-setup.md`, `docs/cookbooks/rust-setup.md`, `docs/cookbooks/zig-setup.md`

## Command Links

- Executable task and script inventory: root `package.json`
- Human quick start: `README.md`
- Setup and operational recipes: `docs/cookbooks/README.md`

## Related Authority

- Agent execution rules and completion gate: root `AGENTS.md`
- Human contribution workflow: `CONTRIBUTING.md`
- Documentation types and generated projections: `docs/documentation-model.md`
- Change execution and verification depth: `docs/change-execution.md`
- Oracle classification, harness admission, and the real-use host manifest: `docs/verification-instruments.md`
- Test taxonomy: `docs/specs/20260529-test_strategy.md`
- Public worker base and external derivation contract: `docs/specs/20260721-worker_execution_environment_images.md`
- Image catalog, release identity, and publishing policy: `docs/specs/20260708-container_image_packaging.md`
- Engineering rationale and product direction: `docs/engineering-doctrine.md`, `docs/product-vision.md`, `docs/roadmap.md`
- System scope and fallback doctrine: `docs/core/foundation.md`
- Directory-local workflow: the directory's `README.md`

## Known Debt

### Node And pnpm Anchors Follow The Worker Baseline

Version Maintenance above fixes the direction — the worker baseline leads and this repository follows. Node is `24.18.0` in `.mise.toml`, `.node-version`, `.nvmrc`, and `engines.node`, and `containers/test-env/Dockerfile` pins the same digest as `FROM node:… AS worker-common`. pnpm remains `10.33.3` across mise, `packageManager`, worker Corepack, and the test-env Corepack line. Owner: this decision. A later digest drift is a mirror failure repaired in the same change as the worker baseline.

### Defaults-Realization Generation Debt

The Realization And Version Links default-tool inventory is a hand-written derivable projection. Owner: the Generated Projections rules in `docs/documentation-model.md`, with the named configuration files and cookbooks as source facts. Activation: when a generator slice is authorized, replace that inventory with a generated projection and a `--check` drift gate.

### Version Source-Of-Truth Generation Debt

The version-source inventory is a hand-written derivable projection. Sources: `.mise.toml`, root `package.json`, `.node-version`, `.nvmrc`, `containers/test-env/Dockerfile`, and scope-local `mise.toml` files. Owner: the Generated Projections rules in `docs/documentation-model.md`; executable files remain authoritative for values and `## Owns` remains authoritative only for maintenance procedure. Activation: when a generator slice is authorized, generate the inventory and add a `--check` comparison across mirrored declarations.

The mirrored-declaration agreement rule under Version Maintenance is enforced by `tests/toolchain-version-mirrors.test.mjs`, which compares every Node, pnpm, and Biome declaration mechanically. Only the generated-inventory portion of this debt remains. Node agreement is `.mise.toml`, `.node-version`, `.nvmrc`, and `engines.node`; the sibling Node digest is a separate `test-env` versus worker-common comparison; pnpm still includes the test-env Corepack line.

### Command Entry-Point Generation Debt

The Command Links inventory is a hand-written derivable projection. Source: root `package.json` scripts, with `README.md` retaining the human quick-start projection. Owner: the Generated Projections rules in `docs/documentation-model.md`. Activation: when a generator slice is authorized, generate the command inventory with a `--check` mode.

### Fork Pull Requests Cannot Publish The Test Execution Image

The `test-image` job needs `packages: write` to publish a digest tag that is not yet in the registry. A pull request from a fork receives a read-only token, so a fork that also changes `containers/test-env/Dockerfile` produces a tag nobody can publish and every gate job fails to start. Same-repository pull requests, which are how this repository is developed today, are unaffected. Activation: when a fork contribution is accepted, add a build-and-load fallback for that case rather than weakening the digest-tag rule, which is what keeps a tree from being tested against a foreign image.
