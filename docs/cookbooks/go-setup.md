# Go Setup Cookbook

Use this cookbook when a repository based on this template needs to add a Go app or package.

## Policy

- Follow this cookbook instead of inventing a custom Go setup flow.
- Use `mise` to install and manage the Go toolchain and Go development tools for this sub-project.
- Keep Go-related tool versions in the appropriate `mise.toml` for the scope that owns the toolchain.
- Run Go setup and maintenance commands through `mise exec -- ...`.
- Use Go modules as the package management model.
- Use `go build` as the default builder.
- Use `gofmt` as the formatter.
- Use `golangci-lint` as the linter.
- Use `go test` for testing.

## Tooling Matrix

- runtime/compiler: `go`
- package manager: Go modules
- builder: `go build`
- linter: `golangci-lint run`
- formatter: `gofmt -w`
- test runner: `go test ./...`

## Setup Flow

1. Scaffold the module with `mise exec -- go mod init ...`.
2. Add a local `README.md`.
3. Add project-level commands for build, test, lint, and format.
4. Add a local `AGENTS.md` only when the module has local agent execution rules.

## Notes

- If Go is still an opt-in local stack, prefer a sub-project `mise.toml`; only promote Go entries into the root `.mise.toml` when the repository adopts Go as shared infrastructure.
- Keep Go setup local to the sub-project until the repository explicitly decides to promote Go to a root-level default stack.
