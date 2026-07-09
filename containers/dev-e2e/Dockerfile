FROM node:24-bookworm-slim

LABEL org.openkit.image="dev-e2e"
LABEL org.openkit.smoke="/usr/local/bin/openkit-dev-e2e-smoke"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PNPM_HOME="/pnpm"
ENV PATH="/opt/codex/codex-path:${PNPM_HOME}:${PATH}"
ENV PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"
ENV OPENKIT_CORE_MODE="local"
ENV OPENKIT_BIND_HOST="0.0.0.0"
ENV OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR="1"

WORKDIR /workspace

ARG TARGETARCH
ARG CODEX_CLI_VERSION="0.130.0"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    caddy \
    curl \
    git \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.33.3 --activate \
  && pnpm --version

RUN npx --yes playwright@1.60.0 install --with-deps chromium \
  && npm cache clean --force \
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
  mkdir -p /opt/codex; \
  cp -R "/tmp/codex-native/node_modules/@openai/codex-linux-${codex_npm_arch}/vendor/${codex_target}/." /opt/codex/; \
  ln -sf /opt/codex/bin/codex /usr/local/bin/codex; \
  codex --version; \
  codex app-server --help >/dev/null; \
  rm -rf /tmp/codex-native
# OpenCode is useful in dev/e2e diagnostics, but the image must stay buildable if npm cannot resolve it.
RUN npm install --global @opencode-ai/opencode || echo "Skipping optional @opencode-ai/opencode CLI install."
RUN npm cache clean --force || true

COPY containers/dev-e2e/smoke.sh /usr/local/bin/openkit-dev-e2e-smoke
RUN chmod +x /usr/local/bin/openkit-dev-e2e-smoke

CMD ["bash"]
