FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS builder

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.33.3 --activate \
  && pnpm --version

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/worker-protocol/package.json packages/worker-protocol/package.json
COPY packages/worker-shim/package.json packages/worker-shim/package.json

RUN pnpm install --frozen-lockfile

COPY packages/worker-protocol packages/worker-protocol
COPY packages/worker-shim packages/worker-shim

RUN pnpm --filter @openkit/worker-protocol build \
  && pnpm --filter @openkit/worker-shim build \
  && rm package.json \
  && pnpm --filter @openkit/worker-shim deploy --prod --legacy /deploy/worker-shim

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS runtime

LABEL org.openkit.image="worker-opencode"
LABEL org.openkit.worker.runtime="opencode"
LABEL org.openkit.worker.contract="openkit-worker-v1"
LABEL org.openkit.worker-shim="/usr/local/bin/openkit-worker-shim"
LABEL org.openkit.smoke="/usr/local/bin/openkit-worker-opencode-smoke"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG OPENCODE_VERSION="1.18.1"

ENV HOME="/sandbox"
ENV OPENKIT_SESSION_DIR="/openkit/session"
ENV OPENKIT_ARTIFACT_DIR="/openkit/artifacts"
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    iproute2 \
    tini \
  && rm -rf /var/lib/apt/lists/*

RUN export HOME=/tmp/opencode-home \
    XDG_CACHE_HOME=/tmp/opencode-cache \
    XDG_CONFIG_HOME=/tmp/opencode-config \
    XDG_DATA_HOME=/tmp/opencode-data \
    XDG_STATE_HOME=/tmp/opencode-state \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
  && npm install --global --omit=dev "opencode-ai@${OPENCODE_VERSION}" \
  && test "$(readlink -f /usr/local/bin/opencode)" = "/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe" \
  && opencode --version \
  && npm cache clean --force \
  && rm -rf /tmp/opencode-cache /tmp/opencode-config /tmp/opencode-data /tmp/opencode-home /tmp/opencode-state \
  && test ! -e /etc/opencode

COPY --from=builder /deploy/worker-shim/ /usr/local/lib/openkit/worker-shim/
COPY containers/worker-opencode/smoke.sh /usr/local/bin/openkit-worker-opencode-smoke

RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'exec 3<<<"${OPENKIT_CONTROL_TOKEN:-}"' \
  'exec env -i \' \
  '  ALL_PROXY="${ALL_PROXY:-}" \' \
  '  COLORTERM="${COLORTERM:-}" \' \
  '  HOME="${HOME:-/sandbox}" \' \
  '  HTTPS_PROXY="${HTTPS_PROXY:-}" \' \
  '  HTTP_PROXY="${HTTP_PROXY:-}" \' \
  '  LANG="${LANG:-C.UTF-8}" \' \
  '  LC_ALL="${LC_ALL:-}" \' \
  '  LC_CTYPE="${LC_CTYPE:-}" \' \
  '  LOGNAME="${LOGNAME:-sandbox}" \' \
  '  NODE_USE_ENV_PROXY=1 \' \
  '  OPENKIT_AGENT_SESSION_ID="${OPENKIT_AGENT_SESSION_ID:-}" \' \
  '  OPENKIT_ARTIFACT_DIR="${OPENKIT_ARTIFACT_DIR:-/openkit/artifacts}" \' \
  '  OPENKIT_CONTROL_BASE_URL="${OPENKIT_CONTROL_BASE_URL:-}" \' \
  '  OPENKIT_CONTROL_TOKEN_FD=3 \' \
  '  OPENKIT_PACKAGE_SNAPSHOT_ID="${OPENKIT_PACKAGE_SNAPSHOT_ID:-}" \' \
  '  OPENKIT_REQUEST_ID="${OPENKIT_REQUEST_ID:-}" \' \
  '  OPENKIT_SESSION_DIR="${OPENKIT_SESSION_DIR:-/openkit/session}" \' \
  '  OPENKIT_THREAD_ID="${OPENKIT_THREAD_ID:-}" \' \
  '  OPENKIT_TURN_ID="${OPENKIT_TURN_ID:-}" \' \
  '  OPENKIT_WORKER_INFERENCE_TOKEN="${OPENKIT_WORKER_INFERENCE_TOKEN:-}" \' \
  '  OPENKIT_WORKSPACE_ID="${OPENKIT_WORKSPACE_ID:-}" \' \
  '  NO_PROXY="${NO_PROXY:-}" \' \
  '  PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}" \' \
  '  SHELL="${SHELL:-/bin/bash}" \' \
  '  SSL_CERT_DIR="${SSL_CERT_DIR:-}" \' \
  '  SSL_CERT_FILE="${SSL_CERT_FILE:-}" \' \
  '  TEMP="${TEMP:-}" \' \
  '  TERM="${TERM:-}" \' \
  '  TMP="${TMP:-}" \' \
  '  TMPDIR="${TMPDIR:-/tmp}" \' \
  '  USER="${USER:-sandbox}" \' \
  '  http_proxy="${http_proxy:-}" \' \
  '  https_proxy="${https_proxy:-}" \' \
  '  no_proxy="${no_proxy:-}" \' \
  '  node /usr/local/lib/openkit/worker-shim/dist/bin/openkit-worker-shim.js "$@"' \
  > /usr/local/bin/openkit-worker-shim

RUN chmod +x /usr/local/bin/openkit-worker-shim /usr/local/bin/openkit-worker-opencode-smoke \
  && groupadd --system sandbox \
  && useradd --system --gid sandbox --home-dir /sandbox --create-home --shell /bin/bash sandbox \
  && mkdir -p /sandbox/openkit/session /sandbox/openkit/artifacts /sandbox/openkit/config /workspace \
  && ln -s /sandbox/openkit /openkit \
  && chown -R sandbox:sandbox /sandbox /workspace

USER sandbox

ENTRYPOINT ["tini", "-g", "--"]
CMD ["openkit-worker-shim", "--package", "/openkit/config/package.json"]

FROM runtime AS production
