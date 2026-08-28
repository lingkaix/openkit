---
status: Accepted
---
# Sandbox Container Tests

A Worker Agent sandbox carries the OpenKit worker baseline and can provision a declared toolchain through mise, and that sandbox cannot start a container of its own.

Projects whose tests require a container runtime should concentrate container-owning effects behind one component boundary so that only that component's tests need the runtime. That is the effect-domain rule owned by [`docs/verification-instruments.md`](../verification-instruments.md); [`docs/engineering-doctrine.md`](../engineering-doctrine.md) provides the rationale, and this page does not restate it.

Tests of every other component then run against a contract and need no container runtime, which is what makes the project workable on this platform.

Where the real component must be exercised, a remote instance of it can serve tests that run inside the sandbox. This repository's current verification-only shape is one non-secret SSH alias passed explicitly at invocation: one lowercase ASCII label matching `[a-z][a-z0-9-]{0,62}`, supplied as one argument, for example `pnpm host:assert <alias>`. That shape is owned by [`docs/verification-instruments.md`](../verification-instruments.md). It is verification-only and is not a public or sandbox-default interface.

Multi-service integration that genuinely needs several containers at once belongs on test infrastructure the project owns, exercised from the sandbox rather than inside it.

OpenKit supplies no nested containers, no container-image build capability inside a sandbox, and no test infrastructure for those cases.
