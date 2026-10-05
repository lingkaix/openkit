---
status: Accepted
date: "2026-10-05"
decider: Engineer
---
# NanoHost Checking And Installation Require Python

## Decision

Keep the embedded Python checker and explicitly require Python 3.8 or later at `/usr/bin/python3` for static checking and installation, including staged bundle verification. Deployment Host Requirements owns the prerequisite and fail-closed behavior. Python is not a runtime dependency of the NanoHost service.

## Reason

This is the smallest change to the existing checker. Python 3 ships with the targeted server distributions; Ubuntu 24.04, Debian 12 and RHEL 9 supply versions above the checker's floor. The implementation's assignment expressions require Python 3.8; its standard-library operations require no later minor version. This floor is the builder's implementation analysis under the engineer's explicit instruction to determine the minimum. [Python's 3.8 notes](https://docs.python.org/3/whatsnew/3.8.html) document assignment expressions; the [Ubuntu 24.04 package](https://packages.ubuntu.com/noble/python3), [Debian 12 package](https://packages.debian.org/bookworm/python3) and [RHEL 9 Python guide](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/installing_and_using_dynamic_programming_languages/assembly_introduction-to-python_installing-and-using-dynamic-programming-languages) document the available distribution versions.

## Rejected Alternatives

- Rewrite the checker in POSIX shell. Rejected in favor of retaining the existing implementation with an explicit prerequisite and corrected failure boundaries.
- Add a NanoHost binary subcommand with a shell boundary. Rejected in favor of the smaller change; the shell would still need to handle binary-loader failure and cross-target staging verification.

## Revisit When

Targeted server distributions cease to supply a usable interpreter, or evidence shows that this prerequisite prevents an otherwise supported deployment.

## Affected Owners

- docs/specs/20260909-deployment_host_requirements.md
