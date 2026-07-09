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

Use that document for:
- **TDD** (tests first) and the **two-commit** workflow per feature
- **Documentation standards** for every language (GoDoc/JSDoc/PyDoc/RustDoc)
- **Conventional Commits** format and examples
- **Local app/package guide requirements** (`AGENTS.md` + `README.md`)
- **Cookbook-first setup workflow** for CI and project scaffolding
- **Code organization** guidance
- **English-only** code and **Markdown-only** documentation

If this document and `AGENTS.md` disagree, treat `AGENTS.md` as the source of truth to avoid drift.

## Development Workflow

### 1. Setup Development Environment

```bash
# Install toolchain, dependencies, and tracked git hooks
bash scripts/repo-init.sh

# Verify the repository baseline
mise run verify
```

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
mise run test

# Run linting
mise run lint
```

### 3. Pre-Commit Checklist

Before committing, ensure:
- [ ] All functions/types/interfaces are documented
- [ ] Tests pass (`mise run test`)
- [ ] Changed apps/packages keep `AGENTS.md` and `README.md` accurate
- [ ] Relevant cookbook guidance was followed for setup or operational work
- [ ] Commit message follows Conventional Commits format
- [ ] All text is in English
- [ ] No linter errors (`mise run lint`)
- [ ] Code is formatted (`mise run fmt`)

### 4. Local Validation Workflow

- The template keeps hook config in `lefthook.example.yml` until first init.
- `bash scripts/repo-init.sh` renames it to `lefthook.yml` when `lefthook.yml` is not present yet.
- Git hooks are managed by `lefthook`.
- Pre-commit runs `lint-staged`, so only staged files are validated.
- Commit messages are validated against Conventional Commits.
- Hooks can be skipped with `git commit --no-verify`, but that should be rare and intentional.

### 5. Submit Changes

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
- [ ] No new warnings generated
- [ ] All functions/types documented
- [ ] Local `AGENTS.md` and `README.md` updated where needed
- [ ] Relevant cookbook guidance followed
```

### PR Review Process

1. **Automated checks**: CI runs the lightweight repository check for pull requests, skips ordinary branch pushes, and runs the release gate on version tags
2. **Code review**: At least one approval required
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

### For Authors

When receiving feedback:
- Respond to all comments
- Ask questions if feedback is unclear
- Make requested changes promptly
- Mark conversations as resolved after addressing
- Thank reviewers for their time

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
mise exec -- pnpm --filter <package-name> add <dependency>

# Add to root workspace
mise exec -- pnpm add -w <dependency>

# Add as dev dependency
mise exec -- pnpm add -D <dependency>
```

Always commit lock files:
- `pnpm-lock.yaml`
- `go.sum`
- `Cargo.lock`
- `uv.lock` (Python)

### Documentation Updates

- Update README.md when adding features
- Update local `AGENTS.md` and `README.md` for affected apps/packages
- Follow `docs/change-tracking.md` before adding specs, change records, or working logs
- Add a curated change record in `docs/changes/` only for material PR, standalone, or release-level context
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
