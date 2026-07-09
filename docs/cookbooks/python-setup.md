# Python Setup Cookbook

Use this cookbook when a repository based on this template needs to add a Python app or package.

## Policy

- Follow this cookbook instead of inventing a custom Python setup flow.
- Use `mise` to install and manage the Python runtime and Python development tools for this sub-project.
- Keep Python-related tool versions in the appropriate `mise.toml` for the scope that owns the toolchain.
- Run Python setup and maintenance commands through `mise exec -- ...`.
- Use `uv` as the package manager and environment manager.
- Use `hatchling` as the build backend unless the project has a documented reason to choose another backend.
- Use `ruff` for linting and formatting.
- Use `mypy` for static type checking.
- Use `pytest` for testing.

## Tooling Matrix

- runtime: `python`
- package manager: `uv`
- builder: `hatchling`
- linter: `ruff check`
- formatter: `ruff format`
- type checker: `mypy`
- test runner: `pytest`

## Setup Flow

1. Scaffold the project with `mise exec -- uv init ...` or another approved Python project generator.
2. Add a local `README.md`.
3. Configure `pyproject.toml` with `hatchling`, `ruff`, `mypy`, and `pytest`.
4. Add package-level commands for build, test, lint, format, and typecheck.
5. Add a local `AGENTS.md` only when the project has local agent execution rules.

## Notes

- If Python is still an opt-in local stack, prefer a sub-project `mise.toml`; only promote Python entries into the root `.mise.toml` when the repository adopts Python as shared infrastructure.
- Keep Python setup local to the sub-project until the repository explicitly decides to promote Python to a root-level default stack.
