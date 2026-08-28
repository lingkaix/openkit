---
type: change-plan
status: verified
date: 2026-08-12
---
# Execution Environment And Testability Boundary

## Intent

Realize the execution-environment and test-rule decisions accepted on 2026-08-11 and 2026-08-12, which are recorded in their owning documents, and record the engineering principle those decisions rest on where it can govern later work. Historical (superseded): the 2026-08-12 claim that those decisions had no implementation.

The decisions removed a single mandatory container from the definition of an ordinary check and replaced it with a published base image, a derived development image, three permitted environments, and four test rules. Historical (superseded): the 2026-08-12 claim that every one of them was still a statement about intent rather than a property of this repository, and that Docker was still required to run any ordinary gate and to make any commit.

The governing wording landed first, on 2026-08-12, as WP-1. Core wording is not delegable work: it is distilled discussion context, and a handoff cannot carry the context that the wording is. Historical (superseded): the claim that everything after WP-1 was therefore the review and cleanup of what that wording implied, against a repository that did not yet satisfy it.

This record owns coordination, task detail, and verification evidence. The decisions themselves remain owned by `docs/engineering-doctrine.md`, `docs/change-execution.md`, `AGENTS.md`, `docs/toolchain.md`, `docs/specs/20260721-worker_execution_environment_images.md`, `docs/specs/20260708-container_image_packaging.md`, and `docs/specs/20260529-test_strategy.md`.

## How To Use This Record

Every implementation decision below is settled. Historical (superseded): the statement that the only open question was the engineer-owned program-dependency scope for WP-6 recorded under Authority And Related Context. No package in this program is authorized to re-derive an implementation decision, propose an alternative design, or turn a task into another open question, and a builder that arrives without the originating discussion should not need it.

Where a package changes a document whose wording was decided in that discussion rather than derived from an existing owner, this record carries **reference wording** for it. Reference wording is a draft: it exists so an implementing agent adopts a settled decision instead of inventing one, and so a reviewer judges wording rather than design.

Reference wording is not authority. It carries no force until the owning document adopts it, and once adopted the owning document is authoritative and this record is a stale copy. A rule that exists only here is not in force. Improving the wording during implementation is expected and requires no escalation; changing what it decides is a design change and does.

Where a package's work is mechanical rather than editorial, this record carries a task list at the same level of detail and with the same standing.

## Authority And Related Context

- [`AGENTS.md`](../../../AGENTS.md)
- [`docs/change-execution.md`](../../change-execution.md)
- [`docs/documentation-model.md`](../../documentation-model.md)
- [`docs/engineering-doctrine.md`](../../engineering-doctrine.md)
- [`docs/toolchain.md`](../../toolchain.md)
- [`docs/specs/20260529-test_strategy.md`](../../specs/20260529-test_strategy.md)
- [`docs/specs/20260708-container_image_packaging.md`](../../specs/20260708-container_image_packaging.md)
- [`docs/specs/20260721-worker_execution_environment_images.md`](../../specs/20260721-worker_execution_environment_images.md)
- [`docs/core/foundation.md`](../../core/foundation.md)
- NanoCore Agent Function Model program, change record 202608130741380001

**Governing dependency — engineer decision, 2026-08-20:** As of 2026-08-20 this program depends on the NanoCore Agent Function Model program, change record 202608130741380001, completing first. The engineer's reason is that WP-4 renames `image` placement to `any` across twenty root scripts and both Git hooks, and WP-5 adds two L0 rules enforced across the whole test corpus, so together they change how every gate in this repository is executed — landing that while the NanoCore program still has unopened implementation packages would move the ground under them.

**Historical (superseded) open question for the engineer under [OM-002]:** Is WP-6 exempt from this program-level dependency? The case for asking is that WP-6 is Tier 1, produces one manual page, depends only on WP-1, and touches no gate and no script, so the recorded reason does not obviously apply to it. The case against an agent assuming an exemption is that the dependency was decided at program level, so WP-6 remains within it unless the engineer narrows the decision. This plan neither self-authorizes an exemption nor silently treats WP-6 as conclusively blocked; its opening condition is unresolved until the engineer answers. That question is superseded because WP-6 is verified.

## Scope

- Publish `worker-common` as a base artifact and install mise in it as the workspace-local toolchain provisioner.
- Keep internal `test-env` a sibling that MUST NOT `FROM worker-common`; it mirrors the exact worker Node digest. Workspace anchors own Node and pnpm versions. Test-image tagging hashes its own manifest-selected inputs, while a structural worker-common-derived throwaway smoke proves the external extension path.
- Replace `image`/`host` placement with `any`/`host`, remove the container dependency from ordinary gates and from both Git hooks, and give the second-opinion rule a mechanism.
- Land the enforcement the placement change depends on: an L0 rule and runner assertion for the anti-skip rule, whose only current enforcement is the environment monoculture this program removes.
- Enforce the container-independence and platform-declaration rules, accepted on 2026-08-12 in `docs/specs/20260529-test_strategy.md` and now owned by `docs/verification-instruments.md`.
- State in `docs/engineering-doctrine.md` why tests are the governing constraint on architecture under full delegation, state the effect-domain boundary rule that follows, and land its consequences in `docs/specs/20260529-test_strategy.md`, `docs/change-execution.md`, and the `AGENTS.md` completion gate. Landed 2026-08-12.
- Project that rule as guidance for projects developed on this platform whose own tests require a container runtime.
- Synchronize every projection this program makes stale, in the package that makes it stale.

## Non-Goals

- No change to what any existing check proves. Portability authorizes no oracle substitution, and a real container check that becomes a fake is a program failure rather than a simplification.
- No publication to GHCR. `worker-common` becomes a catalog entry with a release identity; first publication happens on the next version tag and is a Tier 4 event owned by that release, not by this program.
- No nested-container, Docker-in-Docker, or sandbox build capability. A worker whose task repository requires a container runtime remains unserved, and this program produces guidance for that case rather than a capability.
- No claim that NanoHost realizes the effect-domain rule. That boundary closes when NHC-6 of the current NanoHost Runtime Implementation Completion program, record identifier 202608150321350001, deletes the retired containment path, which this program does not touch, depend on, or accelerate.
- No new test infrastructure, runner, harness, scheduler, or evidence store. The A1 remote host keeps its existing role under the programs that already use it.
- No product runtime, protocol, API, durable state, credential, authorization, or sandbox-containment change.

## Impacted Surfaces

| Surface | Files |
| --- | --- |
| Worker images | `containers/workers/Dockerfile`, `containers/images.json`, `containers/workers/smoke-common.sh`, new base smoke script |
| Development image | `containers/test-env/Dockerfile`, `containers/test-env/smoke.sh`, `scripts/docker/test-image-tag.mjs` |
| Placement and commands | `scripts/test-env.sh`, root `package.json` scripts, `lefthook.yml` |
| Version anchors | `.mise.toml`, `.node-version`, `.nvmrc`, root `package.json` `engines` and `packageManager` |
| Executable projections | `tests/toolchain-version-mirrors.test.mjs`, `tests/test-execution-environment.test.mjs`, new L0 validators under `scripts/` |
| Governance | `docs/engineering-doctrine.md`, `docs/specs/20260529-test_strategy.md` |
| Non-authoritative projections | `README.md`, `CONTRIBUTING.md`, `containers/README.md`, `containers/workers/README.md`, `containers/test-env/README.md`, `docs/cookbooks/docker-test-env.md`, new `docs/manual/` page |

## Documentation Synchronization

This program changes what is true about the repository five times, and each change strands prose somewhere. The rule that decides where a statement belongs is:

- **Owning documents carry accepted decisions ahead of implementation.** That is what `implementation:` metadata and Known Debt sections exist for, and `docs/toolchain.md` and the two image specifications already hold this program's decisions in that form. Nothing in this program should move a decision out of its owner.
- **Projections describe the repository as it is.** A local `README.md`, a cookbook, `README.md`, `CONTRIBUTING.md`, and a manual page state what a reader will find today. A projection does not carry a pending decision and does not announce future work, because this record already owns that and a second record of it drifts.
- **A projection may not assert a rule its owner has reversed.** That is a defect from the moment the reversal is accepted rather than from the moment implementation lands, and it is repaired by deleting the reversed assertion, not by adding a forward-looking note.
- **Each package updates the projections its own change makes stale, inside that package.** Deferring them to closeout leaves the repository describing a state it is not in for the length of the program.

On 2026-08-12 the six projections below were edited to announce these decisions and then reverted, because forward-looking prose in a projection is scaffolding whose only purpose is to describe a gap this record owns. One deletion was retained: `containers/workers/README.md` stated that the common stage must never be tagged or published, which its owner had just reversed.

| Projection | Updated by | What changes |
| --- | --- | --- |
| `containers/README.md` | WP-2 | Four governed worker ids; `worker-common` described as the published base and extension point |
| `containers/workers/README.md` | WP-2 | Directory owns a published base plus three deployment images; mise named in the common tool set; extension path described |
| `containers/test-env/README.md` | WP-3, then WP-4 | WP-3: internal sibling that MUST NOT `FROM worker-common`, mirrors the exact worker Node digest; workspace anchors own Node/pnpm. WP-4: authoritative rather than mandatory, and the second-opinion rule |
| `docs/cookbooks/docker-test-env.md` | WP-3, then WP-4 | WP-3: test-image tagging hashes its own manifest-selected inputs. WP-4: the recipe stops being the only way to run a check |
| `README.md` | WP-4 | Docker stops being a prerequisite for ordinary commands |
| `CONTRIBUTING.md` | WP-4 | Setup no longer requires Docker; the two Local Validation Workflow bullets stop saying hooks run through the image |
| `docs/manual/` | WP-6 | New page; no existing page changes |

Closeout verifies that no projection describes a superseded state, and deletes the three Known Debt entries in `docs/toolchain.md` that this program closes.

## Coverage Map

Every requirement and finding raised in the originating discussion, each with exactly one disposition.

| Item | Disposition |
| --- | --- |
| Publish `worker-common`; catalog entry, labels, base smoke | WP-2 |
| Install and pin mise in the common stage; baseline table row; smoke assertion | WP-2 |
| Structural worker-common-derived throwaway smoke proves the external extension path | WP-2 |
| Internal `test-env` is a sibling that MUST NOT `FROM worker-common` and mirrors the exact worker Node digest | WP-3 |
| Workspace anchors own Node and pnpm versions | WP-3 |
| Test-image tagging hashes its own manifest-selected inputs | WP-3 |
| `any`/`host` placement replaces `image`/`host` | WP-4 |
| Twenty ordinary scripts stop requiring a container | WP-4 |
| Git hooks stop requiring a container | WP-4 |
| Incidentally host-placed checks return to `any` | WP-4 |
| Second-opinion rule gets a mechanism | WP-4 |
| Anti-skip L0 rule and runner assertion | WP-4 |
| Ordinary checks require no container runtime, enforced | WP-5 |
| Platform divergence declared rather than implicit, enforced | WP-5 |
| Tests as the oracle of a delegated system; testability as design-time concern | WP-1, landed 2026-08-12 in `docs/engineering-doctrine.md` |
| Effect-domain boundary rule | WP-1, landed 2026-08-12 in `docs/engineering-doctrine.md` and `docs/specs/20260529-test_strategy.md` |
| Observed cost admitting the effect-domain rule, and the reporting obligation for an observation no product surface may carry | WP-1, landed 2026-08-12; the measurement is retained here as WP-1 Observed case |
| Effect-domain violation becomes answerable at completion | WP-1, landed 2026-08-12 as `AGENTS.md` gate item `[TEST-012]` |
| A review of apparatus that has never run informs a gate and decides no predicate | WP-1, landed 2026-08-12 in `docs/change-execution.md`. The weak-oracle rule already existed; what was missing was its application to unrun apparatus. |
| Apparatus is an artifact, so an instrument produced outside the frozen lease is a counted lease expansion | WP-1, landed 2026-08-12 in `docs/change-execution.md`. Frozen slices already required an artifact inventory, so the amendment names apparatus as covered rather than adding an inventory rule. |
| Guidance for platform projects whose tests need containers | WP-6 |
| Projection synchronization across the program | Documentation Synchronization above; executed per package |
| Portability may not weaken an oracle | Rejected as a mechanical check. Accepted in `docs/specs/20260529-test_strategy.md` and enforced by review. No violation has been observed, and the admissibility bar in that specification forbids a necessary condition whose violation has not occurred. |
| Worker sandbox as a permitted environment, proven by running this suite inside one | Backlog. Owner: `docs/toolchain.md` Test Execution Environment. Activation: WP-2 and WP-3 complete, so a sandbox image carrying the baseline exists to run it in. |
| Nested-container capability for a worker on a task repository requiring one | Backlog. Owner: none today; the first owner candidate is `docs/specs/20260616-agent_environment_package.md`. Activation: an accepted workload that the guidance in WP-6 cannot serve. |
| NanoHost as the single component whose tests need a container runtime | Blocked on NHC-6, titled "Retired-path deletion", of change record 202608150321350001. Not admitted here. |
| Separate test infrastructure as an OpenKit-owned concern | Rejected. The originating statement was an engineering principle offered to projects built on this platform, not a proposal for this repository. WP-6 carries it as guidance. The A1 remote host is existing evidence-gathering under other programs and gains no new scope. |

## Work Package Queue

Six packages, ordered by dependency rather than by size. WP-1 is closed: its governing wording was authored in the originating discussion and landed on 2026-08-12, which is why the remainder of this record is the review and cleanup of work that wording implies rather than a plan to decide it. WP-2 precedes WP-3 because a derivation cannot reference an unpublished base. WP-3 precedes WP-4 because opening the placement model against an image that still pins its own runtime would move two variables at once. WP-4 carries the anti-skip enforcement rather than deferring it, because that package is what removes the enforcement the rule currently has. WP-6 follows WP-1 because a projection needs an owned principle to project, and that principle now exists. The internal dependency chain remains WP-2 with no package dependency, WP-3 on WP-2, WP-4 on WP-3, WP-5 on WP-4, and WP-6 on WP-1; the program-level dependency above is an additional opening condition and does not rewrite that chain.

As of 2026-08-20 this program has no machine-recorded state: the local `temp/state/` inventory contains no path with identifier 202608120101440001. WP-1 landed without delegation on 2026-08-12, and WP-2 through WP-6 have remained queued for eight days without an entry gate opening.

| Package | Mode | Status | Depends on |
| --- | --- | --- | --- |
| WP-1 Doctrine, Effect-Domain Rule, And Execution Mechanics | implementation | implemented, pending independent review | none |
| WP-2 Worker Base Publication And mise | implementation | planned; queued behind the program-level dependency | none |
| WP-3 Development Image Derivation And Version Anchors | implementation | planned; queued behind WP-2 and the program-level dependency | WP-2 |
| WP-4 Placement Model And Skip Enforcement | implementation | planned; queued behind WP-3 and the program-level dependency | WP-3 |
| WP-5 Test Rule Enforcement | implementation | planned; queued behind WP-4 and the program-level dependency | WP-4 |
| WP-6 Platform Guidance Projection | implementation | planned; necessity confirmed, program-dependency scope awaiting the engineer | WP-1 |

### 2026-08-20 Queued-Package Necessity Recheck

The recheck used current local observations and found every queued package still necessary; no predicate or criterion is discarded or moved.

| Package | Named observation | Necessity decision |
| --- | --- | --- |
| WP-2 | `containers/workers/Dockerfile` still has the addressable `AS worker-common` stage, but the catalog probe returned `worker-common-catalog-entries=0`, the common stage has no `org.openkit.image` or `org.openkit.smoke` label, and the repository search found no mise pin or base smoke script; host `mise --version` returned `2026.4.25 macos-arm64 (2026-04-28)`, which does not satisfy the missing image-level install and repository pin. | Still necessary; the existing stage is the seam WP-2 promotes, while its publication identity, image-level mise supply, smoke, derived-image proof, and projections remain absent. |
| WP-3 | `containers/test-env/Dockerfile` still begins `FROM node:24.16.0-bookworm-slim` and still runs `corepack prepare pnpm@10.33.3`; `.mise.toml`, `.node-version`, `.nvmrc`, and root `package.json` still anchor Node `24.16.0`, while `containers/workers/Dockerfile` carries the `24.18.0` baseline, and `scripts/docker/test-image-tag.mjs` hashes no base digest. | Still necessary; none of the derivation, version-anchor, or build-input predicates is settled. |
| WP-4 | The root-script probe returned `image=20`, `host=9`, and `any=0`; `scripts/test-env.sh` accepts only `image` or `host`; `lefthook.yml` still reaches `lint:staged` and `commitmsg:check` through the two image-placed root scripts; the anti-skip search returned no match. | Still necessary; placement, both hooks, second-opinion behavior, anti-skip enforcement, and the host-placement audit remain unsettled. |
| WP-5 | The rule search found no container-independence or platform-declaration validator, and root `check:repo` invokes no such validator; the skip inventory returned six executable pre-run environment or platform skip sites plus one contract-test string and no runtime-error-conditional skip. | Still necessary; neither L0 rule nor the finite corpus disposition exists, and the observed candidates remain inputs to that audit rather than evidence that enforcement exists. |
| WP-6 | `rg --files docs/manual` returned only `README.md`, `nanocore-data-root-config.en.md`, and `nanocore-deployment-modes.en.md`, and the content search returned no effect-domain or container-test guidance page. | Still necessary as a deliverable; whether it may open before the program-level dependency completes is the unresolved engineer question above. |

### WP-1 — Doctrine, Effect-Domain Rule, And Execution Mechanics — landed 2026-08-12

This package is closed and was not delegated. Its artifact is distilled discussion context, and a handoff cannot carry that: an implementer handed reference wording adopts it as a transcriber, which is the failure this repository already names when a test author is handed a prescribed fix. The engineer directed the work, the primary agent authored it as builder, and independence is supplied by review after the fact rather than by a different writer. That review has not happened and is the open obligation below.

What landed, and where each change is now authoritative:

| Owning document | Change |
| --- | --- |
| `docs/engineering-doctrine.md` | New section `Testability Is An Architectural Property`, placed before `Verify The Verifiers` so the order reads premise then calibration. It states the effect-domain rule, its falsifier, the observation admitting it, and the reporting obligation that observation implies. |
| `docs/specs/20260529-test_strategy.md` | Two paragraphs in `Principles`. A check requiring an effect domain its subject does not own is a finding against the architecture and is not repaired by granting access. An observation obtainable only by instrumenting the subject from outside is a gap in what the subject reports, repaired by a named channel decided with the subject before the acceptance gate rather than inside it. |
| `docs/change-execution.md` | A review of apparatus that has never run informs a gate and decides no predicate. Apparatus is an artifact, so an instrument produced outside the frozen lease is a counted lease expansion rather than an incidental part of doing the unit. |
| `AGENTS.md` | Completion-gate item `[TEST-012]`, taking the gate to its eight-item ceiling; the 2026-08-20 remeasurement is 2100 of 2100 words. |

The reference wording this record previously carried is deleted rather than retained. Under How To Use This Record above, adoption makes the owning document authoritative and leaves this record a stale duplicate, and each owning document is now complete without it.

#### Observed case

The doctrine rests on a measurement rather than an argument, and this record carries the measurement so the doctrine does not have to restate it. The unit is `WP6-F1` of the retired NanoHost Runtime Implementation program, record identifier 202608132249150001, whose frozen predicate is one real remote lifecycle from the fixed bootstrap marker through authenticated `starting`, terminal, transcript export, `bridge.close`, definite `sandbox.delete`, and package exit. Its recorded execution ran from 2026-08-11T18:01Z to 2026-08-11T20:47Z across sixteen program-state events and produced `precounted fixture`, `admission contract`, `rr2 fixture`, `closure worker identity`, `enrollment`, `bootstrap contract`, `attempt client`, and `capture binary`. The unit table freezes the predicate and its oracle and states no artifact inventory, so those artifacts were discovered during execution and none was counted. The externally reconstructed correlation is named in that package own scope, which requires an attempt-scoped external record correlating the effect attempt with the stock Gateway channel id while forbidding that id from NanoCore, Sandbox Integration, the Worker Agent, durable state, audit, and product diagnostics.

The same measurement admitted the two `docs/change-execution.md` changes in the table above. Both were briefly carried as backlog and were then landed in the same session, because each is a governing rule whose deferral would have left the measurement recorded and its consequence unenforced.

#### Open obligation

Independent review has not occurred for the current committed text of any of WP-1's four landed documents. The unreviewed set is the `Testability Is An Architectural Property` section in `docs/engineering-doctrine.md`, the two effect-domain and observation-channel principles in `docs/specs/20260529-test_strategy.md`, the unrun-apparatus and apparatus-inventory rules in `docs/change-execution.md`, and completion-gate item `[TEST-012]` in `AGENTS.md`, each in its current owning-document context. After WP-1 closed, commit `8599af10` amended both `AGENTS.md` and `docs/change-execution.md` again on 2026-08-20: `AGENTS.md` added `[TEST-013]` and `[EVID-001]` and revised its authority-ceiling, localization-exception, and commit-syntax wording, while `docs/change-execution.md` added the queued-package necessity recheck and shortened the role-assignment statement. The review obligation therefore covers the WP-1 text as it now sits beneath those later changes, not the 2026-08-12 snapshot. The producer was the primary agent under engineer direction, so [GOV-017] is satisfied only by an adjudicator that wrote none of them. That review judges wording, completeness, and ownership placement against the decisions in the Coverage Map above; it does not reopen the decisions themselves. It is the one item blocking this package from `verified`.

### WP-2 — Worker Base Publication And mise

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/specs/20260721-worker_execution_environment_images.md`; `docs/specs/20260708-container_image_packaging.md`
- **Scope:** promote the common stage to a published target with labels and smoke; add the catalog entry with `release: true` and no runtime selection; install and exactly pin mise with its baseline-table row, `PATH` exposure, and writable-home provisioning location; add the base smoke and the derived-image check; update the two container projections; publication to any registry, native runtime content, AgentManifest grants, and deployment selection are excluded
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 3 for public contract and release-matrix change; no credential, authorization, sandbox-containment, data-loss, or irreversible external effect occurs, because nothing is published
- **Dependencies:** none
- **Predicate:** all four targets build; the base carries the complete baseline, mise, and no native Agent runtime; a throwaway derivation over the base retains the full inherited baseline plus one added tool; no built-in grant names a mise supply host
- **Oracle:** `strong`; static catalog and Dockerfile assertions, base and final smoke runs, and one derived-image build, each prior, finite, reproducible, and re-runnable. Named failure: the relevant assertion or smoke exits nonzero and names the missing or mismatched target, catalog field, baseline tool or version, mise pin, native-runtime absence, inherited tool, or added derived-image tool; a setup, permission, registry, network, or collection failure does not decide the predicate
- **Failure disposition:** repair in place; a mise install that cannot reach an exactly pinned integrity-verified release blocks and escalates rather than falling back to a floating version
- **Next owner:** test author, builder, independent reviewer, verifier, then WP-3

#### Tasks

1. `containers/workers/Dockerfile`: make the existing `worker-common` stage an addressable published target. It needs `LABEL org.openkit.image="worker-common"` and `LABEL org.openkit.smoke=` pointing at its smoke command, matching the shape the three final targets already use. No new stage is created; the stage exists and is being promoted.
2. Install mise in the common stage at an exact pinned version from an integrity-verified upstream release, as a root-owned immutable binary on `PATH`, with everything it provisions written under the writable non-root home so a provision leaves the image-level supply unmutated. The exact version is chosen at implementation time; a floating or range pin blocks under the failure disposition above.
3. Add the mise row to the Common Development Environment baseline table in `docs/specs/20260721-worker_execution_environment_images.md`, in this same change. That specification's Version And Maintenance Lifecycle requires the baseline table and the image catalog to move together.
4. `containers/images.json`: add the `worker-common` entry. It carries `repository`, `dockerfile: containers/workers/Dockerfile`, `target: worker-common`, `context: .`, `kind: worker`, `release: true`, both platforms, `baseImage` at the pinned upstream Node digest, a smoke script and smoke command, and a local tag. It carries no `runtime` key, because it selects no native Agent runtime, and the absence is asserted rather than incidental.
5. Add the base smoke script. It runs the common assertions `containers/workers/smoke-common.sh` already makes — versions, command inventory, writable and immutable paths, absence of baked policy, shim dry run — plus the mise version, and additionally proves that no native Agent runtime is present. The three runtime smokes keep their own scripts unchanged.
6. Add the derived-image check. It builds a throwaway image whose Dockerfile is `FROM` the base plus one added tool, then asserts both that the added tool is present and that the complete inherited baseline is still present. It exists so the external extension path is exercised by the repository rather than first by a user.
7. Add static assertions: four catalog entries selecting four unique targets on one Dockerfile; the base entry is `release: true` and has no `runtime`; the mise pin in the Dockerfile agrees exactly with the specification baseline table; no built-in AgentManifest template names a language distribution server, release archive host, or registry mirror.
8. The 2026-08-20 local probe of `.github/workflows/ci.yml` confirmed that release CI reads `containers/images.json`, filters entries where `release === true`, and passes each catalog `target` to both its smoke build and publish build. A correct catalog entry is therefore sufficient and no workflow edit is admitted; a later contradiction is a finding against this package rather than an invitation to hand-maintain a second list.

#### Projection updates

- `containers/README.md`: the governed worker image ids become four; `worker-common` is described as the published base and the extension point for the three deployment images, for the repository development image, and for user or secondary-developer images.
- `containers/workers/README.md`: the directory owns a published base plus three deployment images rather than an internal stage; mise joins the described common tool set; the extension path is stated, including that deriving confers the baseline and no authority.

### WP-3 — Development Image Derivation And Version Anchors

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/toolchain.md`; `docs/specs/20260721-worker_execution_environment_images.md`
- **Scope:** rebase `containers/test-env/Dockerfile` onto the digest-pinned published base; delete its Node and pnpm declarations; retain the Rust toolchain and Playwright install as derivation additions; resolve the execution-identity difference between the base and the current image; add the base digest to the build-input digest; move every repository Node and pnpm anchor to the baseline value and move the mirror test in the same slice; update the two projections; placement, scripts, and hooks are excluded
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 3 for cross-package version change and deployment-adjacent build inputs; no product behavior, credential, or containment surface is touched
- **Dependencies:** WP-2 PASS
- **Predicate:** the development image declares no Node or pnpm version, resolves both from its base, and every repository anchor agrees with the baseline; changing the base digest changes the image tag; the full ordinary suite passes inside the rebased image
- **Oracle:** `strong`; the moved mirror test, a build-input digest comparison across a simulated base change, an image build plus smoke, and one full ordinary suite run. Named failure: the mirror test names a local Node or pnpm declaration or anchor mismatch, the digest comparison reports an unchanged tag after the simulated base change, or the built image, smoke, or ordinary suite reports the owned baseline or execution-identity assertion that failed; a setup, permission, Docker-daemon, or collection failure does not decide the predicate
- **Failure disposition:** repair in place; a native module that fails to build on the baseline Node is a finding against this package and is repaired rather than pinned around
- **Next owner:** test author, builder, independent reviewer, verifier, then WP-4

#### Tasks

1. `containers/test-env/Dockerfile`: replace `FROM node:24.16.0-bookworm-slim` with the digest-pinned published base. Delete the `corepack enable && corepack prepare pnpm@...` block, because the base already supplies pnpm. Retain the rustup install and its `ENV RUST_VERSION=`, the Playwright Chromium install, the Git `safe.directory` declaration, the `OPENKIT_TEST_EXECUTOR` marker, the baked identity file, and the build-input digest argument and label. Every retained line is a derivation addition; the deleted ones are re-pins the derivation is forbidden to own.
2. Resolve the execution-identity difference. The base creates and switches to the non-root `sandbox` user, while the development image currently runs as root over a host bind mount and configures `safe.directory` globally as root. The derivation must reach a working arrangement for a bind-mounted repository owned by the host user, and must reach it without weakening the base's non-root contract. This is the one task in the package whose shape is not already determined, and its resolution is reported at the exit gate.
3. `scripts/docker/test-image-tag.mjs`: add the pinned base digest to the hashed build inputs, so a base refresh produces a new development-image tag exactly as a Dockerfile edit does.
4. Move the version anchors to the baseline value: `.mise.toml`, `.node-version`, `.nvmrc`, and root `package.json` `engines` for Node; `.mise.toml` and root `package.json` `packageManager` for pnpm.
5. `tests/toolchain-version-mirrors.test.mjs`: the Node assertion stops reading `FROM node:` out of `containers/test-env/Dockerfile` and reads the worker Dockerfile instead; the pnpm assertion stops reading the corepack line out of the development image the same way. The test moves in this slice, not after it.
6. Reclaim the named dependency volumes as part of the change. `better-sqlite3` and `esbuild` are built per platform and cached there, and a Node major-minor move invalidates them.

#### Projection updates

- `containers/test-env/README.md`: the image is built by derivation from the published base; it declares no Node or pnpm of its own; the build-input digest now includes the base digest. The three-environment framing does not land here yet, because placement has not changed.
- `docs/cookbooks/docker-test-env.md`: the tag recipe gains the base digest as a build input, and base refresh joins Dockerfile edit as a cause of rebuild.

### WP-4 — Placement Model And Skip Enforcement

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/toolchain.md`; `docs/specs/20260529-test_strategy.md`
- **Scope:** replace `image` placement with `any`; keep `host` placement and its refusal-inside-image behavior; audit host-placed checks and return the incidentally placed ones to `any`; remove the container dependency from both Git hooks; give the second-opinion rule a mechanism; land the L0 anti-skip rule and the runner assertion; update four projections; CI keeps running every gate inside the image
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 3 because it changes how every gate in the repository is executed; no product surface, credential, or containment rule changes
- **Dependencies:** WP-3 PASS
- **Predicate:** an ordinary gate and a commit both complete with no container runtime available; `host`-placed checks still refuse to run inside the image; a runtime-error-conditional skip fails the L0 rule; a suite reporting a skip outside the declared opt-in set fails; no automatic environment fallback exists anywhere in the runner
- **Oracle:** `strong` for placement, hooks, skip enforcement, and the absence of automatic fallback through fixtures and one Docker-absent execution; `weak` for the judgement that a host placement is incidental rather than essential, which informs the audit and is settled per check by the reviewer against the stated criterion. Named failure: a fixture reports an `image` placement, an image-dependent hook, an accepted runtime-error-conditional or undeclared skip, a host check accepted inside the image, or an automatic fallback, or the Docker-absent execution reports that an ordinary gate or the commit failed because a container runtime was unavailable; setup, permission, dependency-install, or collection failure does not decide the predicate, and the weak placement judgement produces findings but no gate failure
- **Failure disposition:** repair in place; a check that cannot pass outside the image and is not a container-subject check is a finding against that check rather than a reason to keep image placement
- **Next owner:** test author, builder, independent reviewer, verifier, then WP-5

#### Tasks

1. `scripts/test-env.sh`: rename the `image` placement to `any`. An `any` check runs directly by default, and runs inside the image when the caller asks for it explicitly or when CI selects it. `host` keeps its current meaning and its refusal to run inside the image, and keeps its existing digest comparison when a check is already executing in the image.
2. Implement the second-opinion rule by omission rather than by machinery. There is no automatic fallback: nothing in the runner may respond to a failure by re-running the check somewhere else. The image run is an explicit separate invocation, and every result states the environment it ran in, so a host failure and an image pass are two labelled results and neither overwrites the other. A results store, a retry flag, or an automatic escalation path is out of scope and would reintroduce the failure this rule removes.
3. Root `package.json`: move the twenty `image`-placed scripts to `any`. The list is `build`, `build:openkit`, `bundle:openkit`, `test`, `typecheck`, `fmt`, `format:check`, `lint`, `check:repo`, `lint:staged`, `commitmsg:check`, `test:unit`, `test:coverage`, `test:e2e:nano`, `test:e2e:web`, `test:smoke`, `verify:l0-l2`, `verify`, `verify:release`, and `verify:full`.
4. Audit the nine `host`-placed scripts and return the incidentally placed ones to `any`. The criterion is the subject of the check, not the convenience of the runner: a check that drives Docker or a real worker runtime is essential, and one that is host-placed only because it is chained to such a check is incidental. `test:e2e:nano-restart:preflight` is the identified example — its body is a build plus `node --test` and `vitest` invocations and it drives no container. The audit enumerates the rest rather than assuming this is the only one, and records each decision with its reason.
5. Both Git hooks stop requiring a container as a consequence of task 3, since `lefthook.yml` invokes `lint:staged` and `commitmsg:check` through their root scripts. Confirm by making one commit with no container runtime available.
6. Add the L0 anti-skip rule: a validator that fails a deterministic suite containing a skip reachable from a runtime error, meaning a skip inside a catch block or conditioned on a thrown error, an error code, or a failed capability probe. A skip conditioned on a value decidable before the run — a platform predicate or a declared environment-variable opt-in — is permitted and is the form the corpus already uses.
7. Add the runner assertion: a suite that reports a skip outside the declared opt-in set fails. The two rules cover different moments; the validator catches the code, the assertion catches a skip arriving from anywhere the validator could not see.
8. Update `tests/test-execution-environment.test.mjs` for the renamed placement, and the hook-placement assertions in `tests/toolchain-version-mirrors.test.mjs`, which currently require both hook scripts to match `^bash scripts/test-env\.sh image\b`.

#### Projection updates

- `README.md`: Docker stops being a prerequisite for the ordinary command list; the image is described as where CI runs and as the authoritative environment on disagreement; host-placed gates keep their existing sentence.
- `CONTRIBUTING.md`: the setup section stops requiring Docker; the two Local Validation Workflow bullets stop saying the hooks run through the test execution image.
- `containers/test-env/README.md`: the image becomes authoritative rather than mandatory; the three permitted environments and the second-opinion rule land here now that they are real.
- `docs/cookbooks/docker-test-env.md`: the recipe stops being the only way to run a check and becomes the way to take a second opinion and the way CI runs.

### WP-5 — Test Rule Enforcement

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/verification-instruments.md`
- **Scope:** enforce that no ordinary deterministic check requires a container runtime, and that no deterministic check depends on a platform-varying interface without declaring it; audit the existing corpus against both and dispose of every hit; the portability-versus-oracle guard is deliberately not mechanized
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 2; material behavior within the test corpus and its L0 checks, with no public contract, durable state, or topology change
- **Dependencies:** WP-4 PASS
- **Predicate:** a newly added ordinary check that invokes a container runtime fails an L0 rule; a check referencing an enumerated platform-varying interface without a declaration fails; every existing hit is declared, converted into an asserted divergence, or reclassified as a container-subject check
- **Oracle:** `strong` for both L0 rules through fixtures and for corpus disposition through the enumerated finite hit list; the residual described below is carried openly and decides nothing. Named failure: the negative fixture for either rule exits zero instead of naming its container-runtime invocation or undeclared enumerated platform interface, or the finite audit ends with an existing hit lacking exactly one declared, asserted-divergence, or container-subject disposition; setup, permission, or collection failure does not decide the predicate, and the stated residual produces no gate failure
- **Failure disposition:** repair in place; a hit that cannot be declared without changing what the check proves is escalated rather than silently converted
- **Next owner:** test author, builder, independent reviewer, then closeout

#### Tasks

1. Add the container-independence rule: a validator that fails when a check outside `host` placement invokes a container runtime. The check is on invocation, not on subject matter, so a static check that reads a Dockerfile as text stays permitted and one that runs the image does not.
2. Add the platform-declaration rule as a bounded conversion rather than as a judgement. The unbounded question "is this check implicitly platform-dependent" becomes the finite question "does this check reference an enumerated platform-varying interface without a declaration". The enumeration is authored in this package and covers at minimum `process.platform`, the `node:os` platform and architecture accessors, signal delivery and process-group operations, `/proc` and cgroup paths, and case-sensitivity or link-resolution assumptions in path handling.
3. State the residual honestly in the rule's own comment and in the exit gate: a check can still depend on platform behavior without touching any enumerated interface, and that residual is uncovered. It is carried as a known limit rather than claimed as coverage, under the admissibility rule in the owning specification.
4. Audit the corpus against both rules and produce the disposition list. Each hit is declared, converted into an asserted divergence in the style of the existing macOS `EPERM` check, or reclassified as a container-subject check that belongs in `host` placement.

The corpus is expected to start close to clean. Measured on 2026-08-12 it held five skips, all decidable before the run, and no runtime-error-conditional skip, and every ordinary check already passes with no container runtime reachable from inside the image. The 2026-08-20 lexical recheck returned six executable pre-run environment or platform skip sites plus one contract-test string and no runtime-error-conditional skip; WP-5 still owns the finite semantic disposition rather than treating that lexical probe as its oracle. This package is expected to confirm the rule rather than to migrate the corpus, and a large semantic hit list is itself a finding worth reporting.

#### Projection updates

None expected. If the audit changes how a documented gate is invoked, that document is updated in this package.

### WP-6 — Platform Guidance Projection

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/documentation-model.md`; `docs/engineering-doctrine.md`
- **Scope:** one manual page advising projects developed on this platform how to structure work whose tests require a container runtime, projecting the effect-domain rule as the recommendation; no OpenKit capability, commitment, or infrastructure is described as existing
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 1; a non-authoritative projection of an accepted principle, changing no owned decision
- **Dependencies:** WP-1 PASS
- **Predicate:** the page states the recommendation, names what the platform does and does not provide today, and contains no rule absent from its owning doctrine
- **Oracle:** `strong` for type, suffix, and link validity through documentation validators; `weak` for guidance quality through independent review, which informs and decides nothing. Named failure: a documentation validator exits nonzero and names the invalid manual type, language suffix, canonical-English sibling, or link; setup, permission, or collection failure does not decide the predicate, and a guidance-quality review raises a finding but no gate failure
- **Failure disposition:** repair in place; a recommendation requiring a platform capability that does not exist is removed rather than promised
- **Next owner:** independent reviewer, then closeout

#### Content specification

The page is canonical `.en.md` under the localization rule in `docs/documentation-model.md`. It must make these claims and no others:

- A Worker Agent runs inside a sandbox that provides the OpenKit worker baseline and can provision a declared toolchain through mise, and that sandbox cannot start a container of its own.
- A project whose tests require a container runtime should concentrate container-owning effects behind one component boundary, so that only that component's tests need the runtime. This is the effect-domain rule and the page cites its owner rather than restating the reasoning.
- Tests of everything else then run against a contract and need no runtime, which is what makes the project workable on this platform.
- Where the real component must be exercised, a remote instance of it can serve tests running inside the sandbox. `OPENKIT_E2E_REMOTE_OPENSHELL` and its four companion inputs are named as an example of the shape this takes in this repository, explicitly as an example rather than as a supported public interface.
- Multi-service integration that genuinely needs several containers at once belongs on test infrastructure the project owns, exercised from the sandbox rather than inside it.

It must not claim that OpenKit provides nested containers, a build capability inside a sandbox, or test infrastructure, and it must not describe any of those as planned.

#### Projection updates

The page is itself the projection. No existing page changes.

## Frozen Slices And Denominators

WP-1 and WP-2 are frozen exact. WP-2 may open only after the program-level dependency completes and this record's required independent review passes. WP-3 through WP-6 are a provisional inventory: their seams and artifact sets are visible today and are refrozen exactly at each package's own entry gate, so a provisional package has no denominator until then; WP-6 additionally awaits the engineer's answer about whether the program-level dependency applies to its entry.

| Package | Slice | Seam | Artifact inventory | Risk tier | Expected magnitude |
| --- | --- | --- | --- | --- | --- |
| WP-1 | S-1-1 | Doctrine principle surface | `docs/engineering-doctrine.md` | Tier 3 | one section, 5 paragraphs |
| WP-1 | S-1-2 | Test-strategy principle consequence | `docs/specs/20260529-test_strategy.md` | Tier 3 | one paragraph |
| WP-2 | S-2-1 | Common stage target and mise supply | `containers/workers/Dockerfile`, baseline table in the owning specification | Tier 3 | 30–60 lines |
| WP-2 | S-2-2 | Image catalog identity | `containers/images.json` | Tier 3 | one entry, 10–20 lines |
| WP-2 | S-2-3 | Base smoke | new base smoke script, `containers/workers/smoke-common.sh` | Tier 3 | 20–40 lines |
| WP-2 | S-2-4 | Derived-image proof and static assertions | new check under `tests/`, `containers/` fixtures | Tier 3 | 40–80 lines |
| WP-2 | S-2-5 | Container projections | `containers/README.md`, `containers/workers/README.md` | Tier 3 | 10–20 lines |

| Package | Denominator | Breaker trips at |
| --- | --- | --- |
| WP-1 | 2 | 4 |
| WP-2 | 5 | 10 |
| WP-3 | set at its entry gate | — |
| WP-4 | set at its entry gate | — |
| WP-5 | set at its entry gate | — |
| WP-6 | set at its entry gate | — |

## Verification Plan

Each package exits on its own gate, and no package inherits another's evidence.

The program-level acceptance predicate is the Docker-unavailable program checks (`pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm check:repo`) plus both exact hook entrypoint commands (`pnpm run lint:staged` and `pnpm run commitmsg:check`). Historical (superseded): treating one Git commit through both hooks as a pending acceptance step belonging to WP-4. Until the Docker-unavailable observation exists, the program has not delivered its intent regardless of how many packages have passed. The terminal commit is an atomic post-verification handoff that reruns those hook entrypoints, not a remaining acceptance step; if either hook fails before the commit exists, the uncommitted verified claim reopens.

Three measured values are recorded at their gates under the measurement rule in `docs/change-execution.md`: the count of root scripts still requiring a container after WP-4, whose bound is zero outside `host` placement; the count of host-placed scripts reclassified as incidental, which has no bound and states how far the original placement had drifted; and the size of the WP-5 corpus hit list, whose magnitude decides whether the rules were already satisfied or are a migration.

Independent verification is required at WP-2, WP-3, and WP-4 under Tier 3. WP-5 and WP-6 require independent review without a separate verifier. No package in this program requires Tier 4 scrutiny, because nothing is published, no credential or authorization surface moves, and no sandbox-containment rule changes.

## Handoff Points

- This record requires independent review before WP-2 opens. It is orchestrator-authored coordination prose and carries no authority of its own.
- WP-1's four landed documents require independent review by an adjudicator that wrote none of them, under [GOV-017]. This is separate from the review of this record, because the documents are authority and this record is not.
- WP-2 to WP-3: the published base digest is the handoff artifact and is recorded at the WP-2 exit gate.
- WP-3 to WP-4: the baseline version anchor value, the resolution of the execution-identity task, and the moved mirror test.
- WP-4 to WP-5: the enumerated placement audit and its disposition list.
- WP-1 to WP-6: the adopted doctrine section, which the manual page cites rather than restates.
- Closeout: Historical (superseded): commit a program state file into this bundle. Current: no state file is created; if any unsolicited observations accumulate, the findings report remains in this bundle; the three closed Known Debt entries are deleted from `docs/toolchain.md`.

## Known Risks

- **The base runs as a non-root user and the development image does not.** The base creates and switches to `sandbox`, while the development image runs as root over a host bind mount. WP-3 task 2 owns this and it is the one task whose shape is not predetermined. Mitigation: it is named as a task rather than discovered during the build, and its resolution is reported at the exit gate rather than absorbed.
- **A native module fails to build on the baseline Node.** `better-sqlite3` and `esbuild` are compiled per platform. Mitigation: WP-3 owns the repair rather than pinning around it, and volume reclamation is an expected task rather than a defect.
- **A check silently depended on being inside the image.** The corpus has never run anywhere else, so WP-4 may expose checks that never declared an environmental assumption. Mitigation: the anti-skip enforcement lands in the same package, so such a check fails loudly instead of skipping, and the failure is the finding.
- **The placement audit turns into an open-ended refactor.** Deciding whether a host placement is incidental is the one weak oracle in this program. Mitigation: the criterion is stated as the subject of the check rather than the convenience of the runner, findings are dispositioned rather than fixed in place, and scope overflow is reported as decomposition evidence.
- **Publishing the base creates a compatibility surface before anyone consumes it.** Mitigation: the development image is the first consumer and lands one package later, so the surface is exercised inside this program rather than by an external user.
- **The doctrine rule reads as a claim about NanoHost.** The landed section names the NanoHost program as the measurement that admits the rule, which is one sentence away from reading as a claim that NanoHost realizes it. Mitigation: the adopted text states the measurement and states no ownership, WP-1's scope excludes any assertion about which component currently owns container effects, and the Coverage Map records the successor dependency on NHC-6 of change record 202608150321350001, which this program does not touch. This is the first thing the independent review should try to falsify.

## Backlog

- Prove the Worker Agent sandbox as a permitted environment by running this repository's deterministic suite inside one. Owner: `docs/toolchain.md` Test Execution Environment. Activation: WP-2 and WP-3 complete.
- A nested-container or sandbox-side build capability for a task repository whose tests require a container runtime. Owner: none today. Activation: an accepted workload that WP-6's guidance cannot serve.
- Name the effect-domain rule's realization in the runtime architecture once the retired containment path is deleted. Owner: `docs/specs/20260802-nanohost_runtime_and_transport.md`. Activation: NHC-6, titled "Retired-path deletion", of change record 202608150321350001 passes.

## Checkpoints

- **IMPLEMENTED — 2026-08-12:** WP-1 landed in the four owning documents named in its package section and settled its implementation predicate. Independent review remains open against their current committed text, so WP-1 is not `verified`.
- **BLOCKED — 2026-08-20:** By engineer decision, no remaining package is authorized to open before the NanoCore Agent Function Model program, change record 202608130741380001, completes, unless the engineer expressly exempts WP-6. The affected predicate is every remaining package entry gate; there is no commit or PR because this is a pre-entry dependency decision.

This program still has no machine state file. Historical (superseded): the 2026-08-20 claim that WP-2 through WP-6 remained unopened.

## Adaptive-loop pilot cutover

### Intent Epoch 1 — 2026-08-20 / 515a7e9cd1154e4b39a24574dc71885f5f32b94a (append-only)

The accepted product and ownership intent in this record is unchanged. Its earlier package queue, matrices, assignments, gates, events, exact leases, ceilings, denominators, and fixed role sequence remain historical Evidence only and no longer authorize dispatch. Accepted decisions, observed facts, and produced artifacts remain inputs to current work; none is deleted or reconstructed.

### Intent Epoch 2 — 2026-08-28 (append-only)

This epoch supersedes the WP-3 derivation that required `test-env` to be built `FROM` a digest-pinned published `worker-common`, and it supersedes the blocker routing that held WP-3 behind first GHCR publication. Every published worker image contains exactly its declared runtime set, whose cardinality may be zero, one, or many; `worker-common` is the empty set; current Codex, OpenCode, and Pi leaves remain singular facts; catalog `runtime` stays singular descriptive metadata until the first published multi-runtime artifact migrates it with CI, preflight, and OCI-label consumers; `control.adapter.targetRuntime` selects exactly one adapter per session; image contents confer no authority. There is no no-fifth-image or universal-image prohibition; combining runtimes is a release-coupling and supply-surface cost. Default out-of-box network grants are copy-on-init AgentManifest templates owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`. Historical Coverage Map rows, WP-3 derivation tasks, and Epoch 1 checkpoint text that required a published digest before WP-3 remain evidence and no longer authorize dispatch.

### Intent Epoch 3 — 2026-08-28 / engineer's worker-image, CI-environment, dogfood, and multi-runtime clarifications in this thread (append-only)

This entry supplies the source omitted from Intent Epoch 2 and records no change to that epoch's accepted content or reason.

### Current checkpoint

- **Current facts:** The NanoCore Agent Function Model dependency, WP-1, WP-2, current sibling WP-3, WP-4, WP-5, and WP-6 are verified. WP-2, WP-3, and WP-6 retain passing focused image, test-environment, documentation, local Docker evidence, and an independent repository-review PASS; the post-compaction direction check returned `Continue` after narrowing the manual's unavailable build capability to container-image builds. WP-4 and WP-5 have passing independent test-author fixtures and builder evidence, the ordinary independent repository reviewer returned PASS after four falsification-and-correction rounds, and the final Claude Opus 5 acceptance gate returned PASS after its three local findings were corrected and falsified; dogfood stays design and backlog until after first `worker-common` publication.
- **Current owner reconciliation:** a release worker base is identified by absent `runtime`, not by image id, and `workerContract` is required exactly when runtime metadata exists; `worker-common` is the empty declared set; the three current leaves retain singular `runtime` plus `workerContract`; five development grants are AEP-owner copy-on-init templates; `test-env` is an internal sibling mirroring the worker Node digest; Pi image smoke is an adjacent closed finding.
- **Current WP-4 and command-surface result:** the initial twenty `image` and seven `host` scripts became seventeen `any` leaves, four placement-free `verify:*` compositions, and six genuine `host` commands. Sixteen `any` leaves replace former `image` placements; the real-subscription preflight is the seventeenth and was the one incidentally host-placed command. Both Git hooks now reach `any`; `OPENKIT_TEST_USE_IMAGE=1` is the only image second-opinion selector; results are labelled; and no retry, fallback, result store, automatic second opinion, wrapper hierarchy, or Docker prerequisite remains in an ordinary command.
- **Current WP-5 result:** the static validator rejects runtime-result skips across every enclosing control-flow condition, direct literal container-runtime calls outside an exact host-mapped container-subject declaration, and undeclared members of the bounded platform-interface list. The dynamic runner executes once, rejects unnamed Vitest skip summaries, and authorizes plain TAP or Turbo-prefixed `tap-flat` skips only through a reporter test file that uniquely resolves against the discovered corpus plus an exact test or suite declaration in that file. Ten workspace Vitest `test` scripts select the built-in `tap-flat` reporter; Cargo and Node validator commands are unchanged. The semantic hit list became closed finding EETB-FND-005: thirty-one POSIX declarations, two asserted-divergence declarations, and zero direct container-runtime hits.
- **Package-command cleanup:** root `package.json` keeps execution placement only on leaf commands and keeps `verify:l0-l2`, `verify`, `verify:release`, and `verify:full` as direct compositions of those leaves, removing four redundant placement entries without creating a raw-command layer or another script owner.
- **Current focused evidence:** `node --test tests/test-execution-environment.test.mjs tests/test-governance-rules.test.mjs tests/toolchain-version-mirrors.test.mjs tests/release-preflight.test.mjs` passes sixty-one of sixty-one checks under Node 24.18.0; `node scripts/validate-test-governance.mjs`, `bash -n scripts/test-env.sh`, and `git diff --check` exit zero; a Turbo-filtered Vitest command passes through the dynamic runner with `tap-flat` output.
- **Adjacent NanoHost clippy correction:** Under the app-local Rust 1.97 pin, `apps/nanohost/src/image_acquisition.rs` replaced equivalent negated `is_some_and` OCI-platform checks with `Option::is_none_or`; focused evidence was seven `image_acquisition` tests plus `cargo fmt --check` and `cargo clippy --all-targets --all-features -- -D warnings` exiting 0.
- **Current program evidence:** with Docker absent from `PATH`, `pnpm test` passes all thirteen workspace tasks, `pnpm lint` passes all thirteen workspace tasks, `pnpm typecheck` passes all ten applicable tasks, `pnpm check:repo` validates 199 documents and 914 Biome files, `pnpm test:unit` passes all thirteen workspace tasks plus 511 root tests and the generated-bundle comparison, `pnpm test:coverage` passes the configured NanoCore and Web thresholds, `pnpm build` passes all eleven applicable tasks, and direct invocations of `pnpm run lint:staged` plus `pnpm run commitmsg:check -- temp/final-commit-message.txt` pass against the staged closeout bundle and requested conventional commit message. The build retains deferred finding EETB-FND-006 for the 987.59 kB Web entry chunk warning. Worker and test-image Docker builds and smokes passed before the final package-command text and test-governance corrections; those corrections changed no Dockerfile, dependency set, smoke subject, or image capability.
- **Next Action:** Terminal post-verification handoff; no unfinished program work remains. The requested commit is an atomic hook-rerunning handoff of `pnpm run lint:staged` and `pnpm run commitmsg:check`, not a pending acceptance step; if either hook fails before the commit exists, the uncommitted verified claim reopens.
- **Evidence that changes route:** a product or contract failure is corrected locally; an environment, setup, collection, or unrelated baseline failure proves no predicate; a named residual from the bounded validator is recorded rather than hidden; first `worker-common` GHCR publication activates dogfood design and does not alter WP-4 or WP-5.
- **Human-only decision after this slice:** authorize a version-tag release that publishes `worker-common`, which then activates the internal Codex-plus-Pi dogfood image as design work, or accept a different release sequence.

This plan intentionally has no legacy state file, and no state file is created for execution or closeout.

### Historical pilot start boundary (superseded)

Historical (superseded): after the dependency closes, inspect the actual WP-1 artifact directly, then run the cheapest current-state probe that can change the route. Do not reconstruct the former package pipeline or dispatch from its historical mechanics. Accept the artifact from its bytes and observed checks, keep one writer per path, and adapt later participation to the risk and uncertainty actually found.

## Closeout Summary

- **Verdict:** The accepted execution-environment and testability boundary is implemented and independently accepted; no production work package remains open in this plan.
- **Owners and commits:** The accepted Core and specification owners linked in Authority And Related Context govern the durable result, the dependency foundation is preserved in `dbffe4a0`, and the engineer-requested terminal implementation commit is an atomic post-verification handoff that reruns `pnpm run lint:staged` and `pnpm run commitmsg:check` rather than a pending acceptance step; no commit hash is recorded because that commit does not yet exist.
- **Unresolved findings:** `docs/changes/202608120101440001-execution_environment_and_testability_boundary/findings.md` retains deferred EETB-FND-003 for first-publication GHCR visibility and authentication ownership and deferred EETB-FND-006 for the Web entry-chunk warning; neither changes this closeout verdict.
- **Closeout state:** No legacy state file, dogfood image, multi-runtime artifact, nested-container mechanism, retry framework, or automatic second-opinion system was added. The required pilot `route-log.md` records only the observed entries named there.
- **External effects and cleanup:** No publish, push, deploy, or remote write occurred. The anonymous GHCR probe was read-only HTTP 403 and proved no package state. Local read-only inspection found retained `openkit/worker-common:dev`, `worker-codex:dev`, `worker-opencode:dev`, `worker-pi:dev`, `test-env:dev` and content-tagged `test-env` images plus `openkit-test-env-cc4e1f23ae21-*` named volumes; no deletion was performed and provenance of older retained artifacts is not reconstructed.

## Verification Evidence

The current focused suite passes sixty-one of sixty-one checks under Node 24.18.0; the Docker-unavailable program evidence covers test, lint, typecheck, repository checks, unit tests, coverage, and build; direct invocations of both exact hook entrypoint commands `pnpm run lint:staged` and `pnpm run commitmsg:check -- temp/final-commit-message.txt` pass against the staged closeout bundle and requested conventional commit message, and the terminal post-verification commit reruns them; worker and test-image Docker builds and smokes passed before the later command-text and governance-only corrections; ordinary repository review and the final Claude Opus 5 acceptance gate both returned PASS.
