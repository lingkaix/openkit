# Contributing Guide

Thank you for your interest in contributing. This document is the human-facing workflow guide for the repository.

## Table of Contents

- [Development Philosophy](#development-philosophy)
- [Engineering Standards (Source of Truth)](#engineering-standards-source-of-truth)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Code Review Guidelines](#code-review-guidelines)

## Development Philosophy

This project follows these core principles:

1. **AI-assisted development**: Maximize AI agent effectiveness with minimal errors, while keeping changes easy for engineers to review.
2. **Engineer ownership**: Engineers own the architecture, constraints, and final decisions.
3. **High cohesion, low coupling**: Each module should have a single, well-defined purpose.
4. **Readability first**: Prefer clear, boring, maintainable code over cleverness.

## Engineering Standards (Source of Truth)

The canonical engineering standards for this repository live in [AGENTS.md](./AGENTS.md).

Use that document for, by section and stable clause ID:
- **Build Loop** — test-first and proof-layer selection [TEST-002], [TEST-009]; code documentation [CODEDOC-001]; direct, cohesive implementation [QUALITY-001], [QUALITY-003], [SCOPE-012]; and proportional verification [CHECK-019]
- **Completion Gate** — the binary predicates to answer from the diff before finishing
- **Change Authority** — when a change needs an owning Core document or specification [AUTH-001], [AUTH-003]
- **Program Governance** — when material coordination activates and how independence follows consequence and uncertainty [GOV-ACTIVATE-001], [GOV-001], [GOV-017]
- **Local Guides & References** — local `README.md` and `AGENTS.md` requirements, every LOCAL clause
- **Non-negotiables** — English-only code and Markdown-only documentation [LANG-001]

The setup, scaffolding, and dependency obligations themselves are owned by `docs/toolchain.md` under `## Owns`, not by this document. Root `AGENTS.md` still owns when to load a cookbook or a local guide.

If this document and `AGENTS.md` disagree, treat `AGENTS.md` as the source of truth to avoid drift.

## Development Workflow

Before NanoHost real-use work on A1, run the repository-owned host workflow from the root:

```bash
pnpm host:provision a1
pnpm host:assert a1
pnpm host:nanohost:bring-up a1
pnpm host:teardown a1
```

Follow [`docs/cookbooks/nanohost-real-use-host.md`](./docs/cookbooks/nanohost-real-use-host.md), keep credentials outside repository artifacts, and retain only the redacted result at `temp/state/nanohost/host-manifest/a1/result.json`.

### 1. Setup Development Environment

```bash
# Install toolchain, dependencies, and tracked git hooks
bash scripts/repo-init.sh

# Verify the repository baseline
pnpm verify
```

`repo-init.sh` installs the pinned toolchain with mise and then checks that bare `node` and `pnpm` resolve to it. If it reports otherwise, follow the `PATH` instruction it prints before running anything else: every command below assumes bare `pnpm` is the pinned pnpm.

Docker is not required for ordinary checks. They run on this machine by default; a Worker Agent sandbox is also permitted. CI runs the same gates inside the `test-env` image, which is authoritative on disagreement. An explicit `OPENKIT_TEST_USE_IMAGE=1` invocation is a labelled second opinion and never a retry. The Test Execution Environment decision in [`docs/toolchain.md`](./docs/toolchain.md) owns this, including the short list of gates that stay on the host because they drive Docker themselves.

### 2. Create a New Feature

```bash
# Create a feature branch
git checkout -b feat/your-feature-name

# Write tests first
# ... edit test files ...
git add .
git commit -m "test: add tests for your-feature"

# Implement the feature
# ... edit implementation files ...
git add .
git commit -m "feat: implement your-feature"

# Run tests
pnpm test

# Run linting
pnpm lint
```

### 3. Execute A Material Agent Change

For multi-agent, cross-package, public-contract, durable-state, strict-effect, or long-running work, follow [`docs/change-execution.md`](./docs/change-execution.md). Preserve append-only user Intent, keep a rewritable checkpoint, predict the observable change before a material action, and revise the method when evidence defeats its premise.

Compose independent roles in proportion to consequence, uncertainty, effect cost, and producer bias rather than following a fixed sequence. Before accepting work, inspect the actual diff, bytes, or named execution output; a producer report is not enough. Parallel dispatch must name write ownership, and the same repository path may have only one writer at a time.

### 4. Pre-Commit Checklist

Before committing, ensure:
- [ ] All functions/types/interfaces are documented
- [ ] Tests pass (`pnpm test`)
- [ ] Changed apps/packages keep `AGENTS.md` and `README.md` accurate
- [ ] Relevant cookbook guidance was followed for setup or operational work
- [ ] Commit message follows Conventional Commits format
- [ ] All text is in English
- [ ] No linter errors (`pnpm lint`)
- [ ] Code is formatted (`pnpm fmt`)

### 5. Local Validation Workflow

- The tracked `lefthook.yml` is the single canonical Git-hook configuration; the repository has no example configuration or promotion lifecycle.
- `bash scripts/repo-init.sh` installs the Lefthook-managed hooks from that tracked configuration.
- Pre-commit runs `lint:staged`, so only staged files are validated.
- Commit-msg runs `commitmsg:check` to validate Conventional Commits.

This document owns the commit syntax and allowed types. A commit
subject is `<type>[optional scope]: <description>`, where type is one of `feat`, `fix`,
`docs`, `test`, `refactor`, `perf`, `build`, `ci`, or `chore`, and a `!` after the type or
scope marks a breaking change. `scripts/check-commit-msg.sh` enforces this list and is its
executable projection, not its owner: a type added there and not here is a defect.
- Hooks can be skipped with `git commit --no-verify`, but that should be rare and intentional.

### 6. Submit Changes

```bash
# Push your branch
git push origin feat/your-feature-name

# Create a pull request on GitHub/GitLab
# Ensure PR title follows Conventional Commits format
```

## Pull Request Process

### PR Title

Follow the same format as commit messages:
```
feat(scope): add new feature
fix(scope): resolve bug
```

### PR Description Template

```markdown
## Description
Brief description of the changes.

## Type of Change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Related Issues
Closes #123
Related to #456

## Testing
- [ ] Tests written before implementation
- [ ] All tests pass locally
- [ ] Added integration tests (if applicable)

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] Scope, entry predicates, exit predicates, and remaining findings have explicit dispositions for material work
- [ ] Risk-appropriate independent verification and final review completed
- [ ] No new warnings generated
- [ ] All functions/types documented
- [ ] Local `AGENTS.md` and `README.md` updated where needed
- [ ] Relevant cookbook guidance followed
```

### PR Review Process

1. **Automated checks**: CI runs the lightweight repository check for pull requests, skips ordinary branch pushes, and runs the release gate on version tags
2. **Code review**: At least one independent approval is required; anyone who edits the artifact after reviewing it is an author for that revision and another independent review is required
3. **Address feedback**: Make requested changes
4. **Merge**: Squash and merge (or rebase, per project policy)

## Code Review Guidelines

### For Reviewers

Check for:

1. **Documentation**: Every public element is documented
2. **Tests**: Tests exist and were committed before implementation
3. **Commit format**: Follows Conventional Commits 1.0.0
4. **Local guides**: Each affected app/package keeps `AGENTS.md` and `README.md` current
5. **Cookbooks**: CI or setup work follows relevant cookbook guidance when present
6. **Cohesion**: Each file has a clear, single purpose
7. **Language**: All text is in English
8. **Security**: No vulnerabilities (SQL injection, XSS, etc.)
9. **Performance**: No obvious performance issues
10. **Error handling**: Proper error handling and logging
11. **Naming**: Clear, descriptive names for variables and functions
12. **Scope**: Every change maps to user intent and an accepted owner; adjacent improvements are not silently absorbed
13. **Evidence**: Claimed completion is supported by actual artifacts or named execution output, and any deciding oracle is fit for its subject

### For Authors

When receiving feedback:
- Respond to all comments
- Ask questions if feedback is unclear
- Make requested changes promptly
- Mark conversations as resolved after addressing
- Thank reviewers for their time
- Request renewed independent review after making production changes in response to review

## Common Patterns

### Feature Branches

- `feat/feature-name` - New features
- `fix/bug-description` - Bug fixes
- `docs/topic` - Documentation updates
- `refactor/component-name` - Refactoring
- `test/feature-name` - Test additions

### Dependency Management

When adding dependencies:

```bash
# Add to specific workspace package
pnpm --filter <package-name> add <dependency>

# Add to root workspace
pnpm add -w <dependency>

# Add as dev dependency
pnpm add -D <dependency>
```

`docs/toolchain.md` owns when a lockfile update is committed. The lockfiles that update are:
- `pnpm-lock.yaml`
- `go.sum`
- `Cargo.lock`
- `uv.lock` (Python)

### Documentation Updates

- Update README.md when adding features
- Update local `AGENTS.md` and `README.md` for affected apps/packages
- Follow `docs/documentation-model.md` and `docs/change-execution.md` before adding documentation
- Add a curated change record in `docs/changes/` only for material PR, standalone, or release-level context
- Keep every durable rule complete in its owning governance, core, spec, or local-guide document; do not require a historical change record to interpret current behavior
- Add or update a spec in `docs/specs/` for non-trivial work
- Add examples in docs/ directory
- Add or update a cookbook in `docs/cookbooks/` when setup or operational guidance should become reusable
- Keep API documentation in sync with code

For local documentation roles:

- `AGENTS.md` is for agent-facing execution guidance
- `README.md` is for human-facing quick overview and usage

## Questions?

If you have questions about these guidelines:

1. Check existing code for examples
2. Open an issue for clarification
3. Ask in pull request comments
4. Contact maintainers

## Resources

- [Conventional Commits](https://www.conventionalcommits.org/)
- [Test-Driven Development](https://martinfowler.com/bliki/TestDrivenDevelopment.html)
- [GoDoc](https://go.dev/doc/comment)
- [JSDoc](https://jsdoc.app/)
- [PEP 257](https://peps.python.org/pep-0257/)
- [RustDoc](https://doc.rust-lang.org/rustdoc/)

---

Thank you for contributing!
