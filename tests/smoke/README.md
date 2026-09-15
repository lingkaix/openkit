# Smoke Tests

This directory owns direct-execution checks for built release artifacts.

Smoke scripts start the built artifact, verify its minimum health surface, and shut it down without becoming product workflow or regression suites. The NanoCore worker MCP smoke first admits its shared adjudicator through stand-in PASS, FAIL, and TIMEOUT outcomes, then carries one public Task over a disposable native NanoHost HTTP/2 session and an SDK client without invoking a real agent binary. Its explicitly selected repository tools must grant automatic approval without completing the active Worker and reach the host execution owner, where the fixture has no Vault grant and must return `auth-failed`; isolated NanoCore regressions separately prove local Git publication. NanoCore process/API behavior belongs in `apps/nanocore/e2e/`, and package or module behavior belongs in its L1 owner.

Run the complete built-artifact smoke gate from the repository root:

```bash
pnpm -w test:smoke
```

Individual scripts may be run directly after building their owning artifact. Smoke scripts do not receive sibling unit tests; non-trivial behavior must move to the lowest existing L1-L4 owner instead.
