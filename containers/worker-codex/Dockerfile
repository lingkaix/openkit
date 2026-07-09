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
  && pnpm --filter @openkit/worker-shim deploy --prod --legacy /deploy/worker-shim

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS runtime

LABEL org.openkit.image="worker-codex"
LABEL org.openkit.worker-shim="/usr/local/bin/openkit-codex-shim"
LABEL org.openkit.worker-sidecar="/usr/local/bin/openkit-worker-sidecar"
LABEL org.openkit.smoke="/usr/local/bin/openkit-worker-codex-smoke"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG TARGETARCH
ARG CODEX_CLI_VERSION="0.130.0"

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

RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    "amd64") codex_npm_arch="x64"; codex_npm_tag="linux-x64"; codex_target="x86_64-unknown-linux-musl" ;; \
    "arm64") codex_npm_arch="arm64"; codex_npm_tag="linux-arm64"; codex_target="aarch64-unknown-linux-musl" ;; \
    *) echo "Unsupported Codex Docker target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  npm install \
    --prefix /tmp/codex-native \
    --omit=dev \
    --ignore-scripts \
    "@openai/codex-linux-${codex_npm_arch}@npm:@openai/codex@${CODEX_CLI_VERSION}-${codex_npm_tag}"; \
  mkdir -p /usr/local/lib/codex; \
  cp -R "/tmp/codex-native/node_modules/@openai/codex-linux-${codex_npm_arch}/vendor/${codex_target}/." /usr/local/lib/codex/; \
  ln -sf /usr/local/lib/codex/codex/codex /usr/local/bin/codex; \
  codex --version; \
  codex app-server --help >/dev/null; \
  rm -rf /tmp/codex-native

COPY --from=builder /deploy/worker-shim/ /usr/local/lib/openkit/worker-shim/
COPY containers/worker-codex/smoke.sh /usr/local/bin/openkit-worker-codex-smoke

RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'exec node /usr/local/lib/openkit/worker-shim/dist/bin/openkit-codex-shim.js "$@"' \
  > /usr/local/bin/openkit-codex-shim

RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'exec node /usr/local/lib/openkit/worker-shim/dist/bin/openkit-worker-sidecar.js "$@"' \
  > /usr/local/bin/openkit-worker-sidecar

RUN chmod +x /usr/local/bin/openkit-codex-shim /usr/local/bin/openkit-worker-sidecar /usr/local/bin/openkit-worker-codex-smoke \
  && groupadd --system sandbox \
  && useradd --system --gid sandbox --home-dir /sandbox --create-home --shell /bin/bash sandbox \
  && mkdir -p /sandbox/openkit/session /sandbox/openkit/artifacts /sandbox/openkit/config /workspace \
  && ln -s /sandbox/openkit /openkit \
  && chown -R sandbox:sandbox /sandbox /workspace

ENTRYPOINT ["tini", "-g", "--"]
CMD ["openkit-codex-shim", "--package", "/openkit/config/package.json"]
