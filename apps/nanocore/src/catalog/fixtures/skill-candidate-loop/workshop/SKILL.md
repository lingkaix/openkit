---
name: synthetic-workshop-bookings
description: Propose equipment reservations for the synthetic workshop fixture using exact admitted inventory and booking observations. This package is test material and cannot place a real booking.
---

# Synthetic Workshop Booking Proposals

All names, records and outcomes in this package are synthetic. Use [the domain model](references/domain.md) and [exact source mappings](references/sources.json) to interpret the supplied observations. They are test data, not an external booking authority.

Run `node scripts/propose-booking.mjs` with the bounded JSON input documented in the domain model to calculate one read-only proposal. Preserve its source references and uncertainty. It performs no booking or network call. A `propose` result still requires current admission for any later external operation. Stale, missing or conflicting evidence blocks a proposal; do not turn a blocked result into success.
