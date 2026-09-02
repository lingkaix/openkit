---
status: Accepted
---
# Verification Instruments

## Purpose, Scope, And Ownership

`docs/verification-instruments.md` owns the evidence layer: which evidence to go and get and what it costs, and whether the verdict it yields can be believed. That is oracle classification and the three responses to a weak oracle, harness admission, the effect-domain and observation-channel rules that decide whether a check can be written at its subject's boundary at all, and the execution-environment rules that bound what a check may require and what it may prove — the container rule and its single exception, the declared-divergence rule, and the real-use host manifest. Which permitted environment an ordinary check runs in, and how two disagreeing results from two permitted environments are reconciled, remain with `docs/toolchain.md`.

These rules apply to every deciding instrument this repository relies on, including gate oracles, documentation validators, and review propositions, and not only to instruments that live in test files.

Four conditions decide whether a program can settle a predicate and stop, and they fail independently. The evidence that would decide the predicate must have been sought at all. An instrument capable of returning a verdict must exist, and must have been shown capable of returning a negative one. The function converting that instrument's observation into a verdict must be sound. The environment the instrument ran in must let the verdict mean what it appears to mean. A program stuck at its acceptance boundary is stuck on one of these four, the symptom rarely says which, and each was first written down after a different program lost time to a different one. They are governed together for that reason rather than filed under whichever surface each happens to touch.

`docs/change-execution.md` owns when material work needs a deciding instrument and who accepts its result, and it consumes the classes defined here. It does not require an instrument for every task. `docs/documentation-model.md` owns the documentation type system and precedence. `docs/engineering-doctrine.md` holds the rationale for this document; it explains these rules and states none, and no decision may cite it as its sole authority.

This document does not own the L0-L6 test taxonomy, which layer proves which invariant, test data and fixture hygiene, real-provider opt-in rules, or coverage expectations, all of which belong to `docs/specs/20260529-test_strategy.md` and consume this document rather than restate it. It does not own L6 story-acceptance semantics (`docs/specs/20260529-l6_story_acceptance.md`), the fault-injection program that measures detection power over time (`docs/specs/20260719-verification_calibration.md`), the product's own runtime evaluation loop (`docs/specs/20260710-self_improvement_evaluation_loop.md`), which permitted environment an ordinary check runs in and which image carries it (`docs/toolchain.md`), individual test files, or CI workflow syntax.

This document owns its seven top-level sections and at most 4600 words. Material work loads it when an instrument will decide acceptance, so an unbounded rulebook would still displace the subject it protects. An agent that reaches the ceiling moves the reason for a rule into `docs/engineering-doctrine.md` and never deletes a rule, drops a qualifier, or compresses away a criterion to fit; only an engineer may raise it. `tests/verification-instruments-contract.test.mjs` is its executable projection and holds no authority.

## Evidence Acquisition

The other three conditions concern a verdict that exists. This one is independent of them, and it is the one this repository has actually paid for: the evidence that would have settled a predicate was cheap, obtainable, and never obtained. No rule about evidence that arrives can reach that, because nothing arrived.

Root `AGENTS.md` [EVID-001] states the obligation: before asking an engineer, name the cheapest known, safe, and authorized probe whose result could change the decision, and run it. This section supplies the scale that makes "cheapest" decidable. It does not require showing that no cheaper probe exists, which would be an unbounded oracle of the form Oracle Classification below prohibits.

Attention cost is what a probe spends of a human, metered apart from every other cost because it is the only one that cannot be bought:

| Cost | What it takes |
| --- | --- |
| `none` | No human at any point |
| `ambient` | A human may read the result or not, and nothing waits on the choice |
| `glance` | One look to confirm, under a minute |
| `judgment` | A decision only a human can make, minutes |
| `deliberation` | Investigation or negotiation with others, an hour or more |

Reading a source file, running one check, reading git history, mutating an instrument and restoring it, and running the whole suite all cost `none`. Asking the engineer costs `judgment` or more, and it was the only probe this process had institutionalised: every gate asked a human, and no rule caused anyone to run a mutation. [EVID-001] corrects that inversion, and it is a cost reduction rather than an obligation.

A probe is a candidate only where some pending decision would differ depending on its result. A cheap probe whose outcome changes nothing is not a cheap win.

Evidence that was obtainable and was not obtained is its own failure, distinct from a design that was wrong, an implementation that diverged, an instrument that failed to intercept, and an effect that exceeded its authorization. It is dispositioned under `docs/change-execution.md` and names the probe that was available.

## Oracle Classification

A gate has two parts and they fail differently. The **check** runs the system and produces an observation. The **oracle** supplies what that observation should have been and compares the two. A test file is not an oracle; the expected values its assertions encode are.

Four properties decide whether an oracle can be relied on. Each has a falsifier, and each absence produces a distinct and recognizable pathology.

| Property | The oracle | Falsifier | Pathology when absent |
| --- | --- | --- | --- |
| Prior | fixes its expected value before the artifact it judges exists, deriving it from an owner independent of that artifact | Would this oracle read differently if the artifact had been written differently? | It confirms the artifact instead of testing it |
| Bounded | asks a finite enumerated set of questions and can return "all answered" | Is its instruction of the form "name one"? | It never converges; every round is correct and the sequence settles nothing |
| Reproducible | returns the same verdict from the same observation whichever competent evaluator runs it | Run it twice with independent evaluators and compare | The verdict records who was asked rather than what is true |
| Re-runnable | costs little enough per verdict to be re-run on every change, including on changes to the oracle itself | Measure the cost of one verdict | The verdict becomes final because re-deriving it is unaffordable, and no intervention can be measured |

An oracle missing any of the four is weak. Weakness is a property to be named, not a defect to be hidden: much of what must be judged in this repository has no strong oracle available today, and an honest weak oracle is far better than a mechanical proxy that looks strong.

One name can collide with ordinary scope language. When the property is meant, write `bounded oracle`. A bare `bounded` in a gate, review, or state event means the scope sense.

Three responses follow, and the third is the engineering work.

**Declare.** Every gate states its oracle's class as the result of running each property's falsifier, not as an unexamined claim. A gate that cannot say which of the four properties its oracle holds does not have a sufficient entry condition, whatever else its fields contain. The falsifier column above is the instrument rather than an illustration, and asserting a property without running it is a producer adjudicating its own oracle, which this pipeline prohibits everywhere else.

**Demote.** A weak oracle informs and does not gate. It produces findings, backlog entries, and evidence for an engineer; it does not decide a predicate. This takes nothing away, because a weak oracle was never deciding — it was producing an opinion that a gate then treated as a decision.

**Convert.** Replace a question about a property with a question about an observation that the property implies. Sufficiency is lost and the four properties are gained, and for a gate that trade is almost always right: a gate exists to stop bad outcomes cheaply rather than to certify good ones, so what it needs is a cheaply checkable necessary condition, not an expensive unbounded sufficient one. Conversion has a characteristic shape — the enumeration moves to a machine and only the adjudication stays with a judgement — because unbounded search is the part that fails to terminate while deciding a named finite list is the part that does.

Harness Admission below is one worked conversion and is kept as the reference example. "Is this harness trustworthy", which is derived from reading, unbounded, and evaluator-dependent, becomes "has it produced each of its declared terminal outcomes", which is prior, finite, reproducible, and seconds long.

Two limits bound all of this.

Some judgements have no strong oracle and will not acquire one; whether a change is the smallest coherent one is the standing example. These are demoted to informing and decided by an engineer, which is the legitimate use of human judgement here — deciding what no mechanism can decide, rather than compensating for a mechanism nobody built.

A converted oracle can be worse than the weak one it replaced, precisely because it looks strong. The guard is evidential: **a necessary condition is admissible only when its violation has actually been observed.** Harness Admission qualifies, because each of its clauses corresponds to a defect that occurred. A mechanical proxy designed from first principles, with no observed violation behind it, does not qualify; it adds ceremony and measures nothing.

**Portability is never a reason to weaken an oracle.** A check whose subject is container behavior MUST NOT be converted into a check against a fake, a simulated runtime, or a recorded transcript on the grounds that the real one is inconvenient to reach. That substitution keeps the gate and replaces its oracle with one that can no longer observe what the gate exists to decide, which is the exact inversion of Demote: the correct response to an oracle that is expensive to run is to run it less often at a declared boundary, never to keep its cadence and lower its evidence.

An environment rule constrains where an ordinary check runs; it grants no authority to change what any check proves.

## Harness Admission

A harness is the executable apparatus a gate runs through: its driver, runner, fixture stack, stand-in targets, and the oracle that converts an observation into a gate outcome. Below L3 the harness is normally the test file itself and this section adds nothing. At L3 and above, and for every real-use verification gate, the harness is a distinct artifact that is authored alongside the checks it will judge, and this section owns when it may be believed.

**A harness that has never produced a deliberate FAIL is not admitted as an oracle.** An instrument observed only passing has not been shown to be capable of failing, so a green result from it is not evidence about the product. Before a harness authored or materially changed for a gate may decide that gate, it must have produced each of its declared terminal outcomes in a self-check against stable stand-in targets that do not exercise the product: at minimum one success and one failure, plus one timeout wherever the harness declares a timeout outcome. The self-check is not a gate run, consumes no scenario denominator, and produces no product evidence.

Three properties are established by that self-check and cannot be established by reading:

- A stand-in target must remain observable until the harness has finished evaluating its success condition. A target that completes and disappears before the oracle inspects it proves nothing about the oracle, because a correct run and a run that never happened then look identical.
- A harness must reach its success outcome through an explicit terminal status. A final predicate whose ordinary successful outcome is falsy is not a success path, and a harness whose success branch has never been executed does not have one.
- A harness must not record an outcome it did not observe. Recording `inapplicable`, `skipped`, `not-applicable`, or any equivalent classification requires the observation that establishes it and the authority that decided it; an outcome written unconditionally is fabricated evidence regardless of whether its value happens to be correct.

**A gate's case count is evidence only for the cases whose deciding assertion executed.** Where a gate reports a count over a frozen enumerated scenario set, its self-check establishes that the deciding assertion ran on each of them. A case that reached a terminal outcome without traversing that assertion contributes to the count and to nothing else, and the recorded instance read as complete coverage: fifty-eight of fifty-eight green while the comparison core executed zero times.

An instrument's discriminating power is established by intervention and never by reading, and a record of it names seven things: the instrument state measured, as a commit or content digest; the check that ran it; the intervention; the code path it was applied to; the code path the check exercises; the observed result on each side; and the date. The last four fields are not bookkeeping. A mutation placed in a branch no check enters yields a green suite indistinguishable from a sound oracle, and one verdict recorded without them became unreproducible inside a working day of being cited as current. The record is Harness Admission evidence about one instrument; `docs/specs/20260719-verification_calibration.md` owns the ongoing fault-injection program and the audit records that measure detection power across the suite over time, and consumes this rather than restating it.

An unchanged harness already admitted under this section stays admitted. Changing its driver control flow, its oracle, its terminal statuses, its stand-in targets, or the observations its outcome depends on returns it to unadmitted.

A gate executed by an unadmitted harness produces no evidence. Its result is void whether it passed or failed, it settles no predicate, and re-running the gate requires the self-check first.

## Effect Domains And Observation Channels

A check that requires an effect domain its subject does not own is a finding against the architecture rather than against the check. It is reported under `docs/engineering-doctrine.md` Testability Is An Architectural Property and is not repaired by granting the check access to that domain. The lowest-layer rule in `docs/specs/20260529-test_strategy.md` decides where a proven behavior is tested; this decides what it means when the lowest sufficient layer turns out to need an effect its subject does not own.

When a check can decide its predicate only by instrumenting its subject from outside, the missing observation is a gap in what the subject reports, and the repair is a named observation channel owned with the subject rather than an instrument owned by the check. Where no product surface may carry that observation, the channel is verification-only, is named by the subject's owning specification, and is decided before the acceptance gate that needs it rather than inside it. An acceptance unit that discovers it must build such an instrument returns to the subject's owner; building the instrument inside the gate is the expensive path this rule exists to prevent. A probe whose deciding observation comes from the subject's own records, schemas, or interfaces, where no owned channel already carries it, is such an instrument however it locates them. The repair is owed on the first occurrence; reconstructing the same subject's same missing observation a second time, whatever the probe is named, is the signal that it was missed, and it is promoted to that owner before a third.

## Execution Environment

The rules below decide what a result obtained in a given environment is evidence of. Which permitted environment an ordinary check runs in, which image carries it, and how that image is addressed remain with `docs/toolchain.md`.

### No Container Runtime In An Ordinary Check

An ordinary deterministic check MUST NOT require a container runtime. `scripts/validate-test-governance.mjs` mechanically rejects direct literal `docker`, `podman`, or `nerdctl` child-process invocations in ordinary test files, and root `check:repo` runs that conversion. The conversion is deliberately bounded: computed command names, helper-mediated invocation, and container dependence expressed through an unenumerated interface remain residual review work rather than a false completeness claim. `docs/toolchain.md` separately owns where the check executes and keeps the authoritative image free of a Docker socket.

The single exception is a check whose subject is container behavior itself: sandbox creation and deletion, image admission and import, process-group termination, epoch invalidation, residue absence after a kill. Removing the container from such a check does not make it portable, it deletes it. These are not ordinary deterministic checks and this rule does not reach them; they sit at L3 and above, stay host-placed, run behind a declared environment-variable opt-in, remain outside the ordinary suite, carry the exact `// openkit-test-container-subject` declaration, and are accepted by the validator only when a root `package.json` command names that file under `scripts/test-env.sh host` placement.

The boundary is the subject of the assertion, never the convenience of the runner. A check that asserts what a Dockerfile or image manifest says is an ordinary static check and belongs in the ordinary suite; a check that asserts what happens when that image runs is not. Two checks over the same file can therefore fall on opposite sides, and that is correct rather than an inconsistency to resolve.

### Platform Divergence Is Declared, Not Avoided

A deterministic check MUST NOT assert platform-specific behavior implicitly. Where a check depends on a property that differs across supported operating systems — signal delivery and process-group semantics, `/proc` and cgroup availability, filesystem case sensitivity and link resolution, loopback aliasing and port reuse — it states that dependency in a form decidable before the run.

The objective is attributable divergence.

Three forms satisfy this and already exist in the repository. A check may exclude a platform through a pre-run predicate, as `it.skipIf(process.platform === 'win32')` does, which is a declared opt-out and not a runtime-error skip. A POSIX-only check may carry the exact `// openkit-test-platform: posix` declaration. A check may instead carry `// openkit-test-platform-divergence`, make the divergence its subject and assert it; that is the strongest form, because it converts a platform difference from an obstacle into a contract. `scripts/validate-test-governance.mjs` mechanically enumerates `process.platform`, Node OS platform and architecture calls, process-group operations, accessed `/proc` and cgroup paths, and link-resolution calls as a bounded necessary condition. A check that has one of those surfaces but none of the declarations fails `check:repo`; dependence through another platform interface remains explicit residual review work rather than claimed scanner completeness.

### The Real-Use Host Manifest

`docs/toolchain.md` names the environments an ordinary deterministic check may run in and addresses the repository development image by a digest of its build inputs, so a result obtained there names the environment that produced it. The real-use verification tier has no comparable artifact, and the rules below are what stands in its place.

- The real-use verification tier has no equivalent of the image, because its environment is a live host that no artifact currently describes. Its equivalent is a host manifest: a declared positive state carrying an identity, held in this repository beside the image it parallels rather than inside whichever program first needed it. A manifest that lives in a program's working state dies with that program and is rebuilt from nothing by the next one, and this repository has already paid that price once. The manifest has two separately runnable halves: an idempotent provisioning half that applies it, and an assertion half that checks a live host against it fail-closed in seconds. The assertion half runs immediately before a gate as well as after provisioning, because the interval between preparing a host and using it is exactly where drift enters.
- A manifest is applied by a command and never by a role. A manifest a role must interpret and apply is a runbook, and two correct applications of one runbook produce two different hosts with nothing in the evidence to tell them apart. The role's work is to run the command and adjudicate its result, which reduces the question of whether the host was prepared correctly to whether the command exited zero and the assertion half passed. This needs no new registered role: a builder owns the manifest and the command, and an independent reviewer or verifier adjudicates the outcome.
- A manifest is not authoritative until a real bring-up has run against a host it produced. A manifest whose host has never carried the subject is the same weak oracle as an instrument that has never met its dependency, and reviewing it establishes nothing about its completeness; `docs/change-execution.md` owns that rule and the scheduling it implies. The useful property is that one run settles both questions at once, because deploying from the manifest and bringing the real subject up on the result is simultaneously the manifest's proof and the instrument's first contact with its dependency.
- A manifest is grown rather than authored. Its first version is a skeleton known to be incomplete; each bring-up failure names what is missing and the missing fact is added. Completeness is therefore never a gate on the manifest. It is a growing record of what running has established, and its worth is that the next agent does not rediscover what this one already paid for.
- A manifest describes the machine and never the product's state. The machine is prepared once, asserted, and long-lived; the product starts cold on every attempt. Merging the two returns this tier to reconstructing the world per attempt, which is the cost the manifest exists to remove.
- The recommended host form is one the program can create and destroy, because clean entry is then a property of construction rather than a predicate to assert and a residue to prove absent, and a large part of a real-use harness exists only to hand a shared machine back intact. This is a recommendation rather than a precondition, and a borrowed or shared host remains workable when the assertion half is honest about what it cannot control and the harness keeps the cleanup obligations that sharing imposes. What is not optional is that the program owns the state the manifest asserts: a manifest asserting facts about a machine that other parties change is a claim rather than an identity, and a disposable host bought with an undeclared provisioner has only moved the incompleteness from the harness into the provisioner.
- The demonstrated NanoHost deployment consumer promotes the unique manifest bytes to `apps/nanohost/deploy/host-manifest.json`. The provision and assertion halves and the other real-use harness programs remain under `tests/support/host/`, read that exact promoted file, and do not copy or own its declared machine facts. `tests/` owns repository-level tests and shared cross-package test support, and `tests/support/` owns setup support with demonstrated consumers; the root drift check keeps the promoted manifest honest against the rest of the repository on the same terms as the image's. A future placement change requires another demonstrated consumer and owner amendment rather than a compatibility copy.
- The manifest is addressed by a digest of its own content, computed the way `scripts/docker/test-image-tag.mjs` computes the image's build-input digest. On success the assertion half emits exactly `manifestDigest=<64-lowercase-hex>` followed by one newline, where the value is the SHA-256 of the exact raw `apps/nanohost/deploy/host-manifest.json` bytes; a retained result consumes that observed value rather than recomputing or copying it. Without a computed identity emitted by the assertion that produced the observation, the environment identity that `docs/change-execution.md` requires of every real-use result is a phrase rather than a fact.
- Fixture and remote assertion modes collect their observations separately and submit the same normalized fact object to one shared comparator. A fixture-only byte comparison, remote-only comparator, or stub that reports a configured result without executing that comparator does not admit the assertion half under Harness Admission.
- Provisioning and bring-up are two commands and never one. Provisioning takes a machine to the manifest's declared state and runs once for as long as that state holds; bring-up starts the real subject on a provisioned machine, reaches the readiness a predicate requires, and runs on every attempt. Collapsing them makes every attempt pay for provisioning and hides which of the two failed, which is the distinction the manifest exists to make legible.
- The assertion half runs through the existing `pnpm host:assert <alias>` command before real use rather than from a parallel preflight or wrapper. Bring-up runs the same assertion immediately before starting the subject.
- Test credentials are generated per attempt, are attempt-local, and are removed on every terminal path. No manifest, closure, sealed artifact, or committed file carries credential material of any kind: a manifest declares that a credential satisfying a stated requirement must exist and never its value, and an attempt offered a credential from a sealed or static input rejects it rather than consuming it. This is a `[SCOPE-004]` boundary and it does not relax inside any workspace however bounded, nor inside the agent iteration workspace that `docs/engineering-doctrine.md` defines. The rule is stated here because the first program to need a real-use credential solved it correctly inside its own fixture with no owner to carry the solution forward, and because a manifest is precisely the artifact that would otherwise attract the value, being the place a reader looks for what the host must have.

### Verification-Only Remote Host Access

A real-use host command receives one non-secret SSH alias explicitly at invocation. The alias is one lowercase ASCII label matching `[a-z][a-z0-9-]{0,62}` and is passed as one argument, never evaluated as shell text or accepted as an SSH option; absence, a second target, or any other spelling fails before contact. Repository files provide no default alias and hold no hostname, user, key, identity file, SSH option, or trust override. The operator's local SSH configuration alone resolves the alias to the host, user, and private-key reference, and ordinary OpenSSH host-key verification applies without `StrictHostKeyChecking` relaxation, an alternate empty known-hosts file, trust-on-first-use substitution, or another bypass.

This boundary is verification-only. It may be invoked only by the producer whom the engineer explicitly authorizes to contact the named host for that exact strict-risk real-use task; neither a role assignment nor a change plan grants that authority. It grants no product-runtime, general-purpose remote-execution, installation, credential-provisioning, tunnel, or fallback authority; reviewers and verifiers adjudicate the retained result without inheriting authority to contact the host.

The strong-risk oracle for the NanoHost real-use host instrument is the following closed matrix and no open-ended search:

- Both URL-and-credential consumers, bring-up and direct teardown, are checked against exactly five accepted origin classes — HTTPS with its default port, HTTPS with an explicit port, and HTTP with literal `localhost`, `127.0.0.1`, or `[::1]` — and exactly seven rejected classes: `file`, another scheme, user information, path, query, fragment, and non-loopback plaintext.
- Bring-up is checked at exactly seven terminal edges: assertion failure, service-start failure, readiness rejection or timeout, `HUP`, `INT`, `TERM`, and success. Every edge decides cleanup invocation and attempt-credential removal.
- Direct teardown is checked at exactly four outcomes: stop failure, decommission failure, post-stop-still-active, and successful inactive completion.

The matrix is enumerated by executable checks; independent review decides only this named list and classifies any observation outside it under `docs/change-execution.md` rather than treating “name one more defect” as a gate oracle.

## Known Debt

None.
