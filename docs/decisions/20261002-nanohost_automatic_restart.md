---
status: Accepted
date: "2026-10-02"
decider: Engineer, on the coordinator's recommendation
---
# The Service Manager Restarts NanoHost Automatically

## Decision

After the running NanoHost service exits or is killed, outside an explicit service-manager stop and outside the credential conditions that stay stopped under the existing rule, the OS service manager terminates the complete failure group and then starts a fresh NanoHost generation without an operator, after a bounded restart delay, and only after the complete previous failure group is observed gone. An explicit stop tears the group down and leaves it stopped until an explicit start. The fail-stop boundary, the fresh Runtime Epoch and the rule that no effect-capable member, Sandbox or escaped process crosses into the new generation are unchanged. The first start after installation stays an explicit operator start. [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md) owns the rule and the shipped service unit realizes it.

## Reason

Translated from Chinese. The engineer: "Configure NanoHost to be restarted automatically by systemd."

The engineer gave no separate reason. The coordinator's recommendation, which the engineer accepted, rested on an observed outage: the shipped unit carried `Restart=no` from the first implementation with no recorded decision, a terminal NanoHost exit on the staging host left the service stopped, and every later worker admission stayed capacity-saturated until an operator acted. The owner already assigned restart of a fresh epoch to the OS supervisor and fixed the order of terminating the group before starting a fresh generation, but an independent review found that it did not say whether the start needs an operator. The engineer's standing priority is product stability over runtime-level guarantees, and the fail-stop and fresh-epoch rules already make an unattended restart safe for retained data.

Source: review `temp/comm-redesign/reports/review-nanohost-exit.md` and the staging dogfood report `temp/a2-ops/deploy/reports/a2-dogfood-108.md`, Phase 3.

## Rejected Alternatives

- Operator-triggered restart only, the shipped `Restart=no`. Rejected; every terminal exit stops all worker execution until someone notices.
- A repository-owned supervisor or watchdog. Rejected by the existing owner; the platform service manager already supplies the fail-stop behavior.
- Member-local restart of the Gateway or a container-backend member inside the current epoch. Rejected by the existing owner; recovery always creates a new epoch.

## Revisit When

An automatic restart is observed to let an effect-capable member, a previous epoch's Sandbox or an escaped process survive into the new generation, or a restart loop harms the execution host.

## Affected Owners

- docs/specs/20260802-nanohost_runtime_and_transport.md
