#!/usr/bin/env bash
set -euo pipefail

openkit-worker-common-smoke
! command -v codex
! command -v opencode
! command -v pi
! command -v dsh
! command -v openkit-pi-runtime-host

echo "OpenKit worker-common image smoke OK"
