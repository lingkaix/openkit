# syntax=docker/dockerfile:1.7

FROM ghcr.io/astral-sh/uv:0.11.30@sha256:93b61e21202b1dab861092748e46bbd6e0e41dd84f59b9174efd2353186e1b47 AS uv

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS worker-shim-builder

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

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS worker-common

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG TARGETARCH
ARG GH_VERSION="2.96.0"
ARG GH_AMD64_SHA256="83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60"
ARG GH_ARM64_SHA256="06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909"
ARG MISE_VERSION="2026.8.14"
ARG MISE_AMD64_SHA256="7cd12d6002d5b3c83a89cad79023712faf2a36f9e8b2ee2061dac5135b3de0ed"
ARG MISE_ARM64_SHA256="bc2c447a7e498b0bed0a421cc2101b407fef09a3195670d35a4aa3f43cd868a1"
ARG PYTHON_VERSION="3.14.6"

ENV DEBIAN_FRONTEND="noninteractive" \
    HOME="/sandbox" \
    NPM_CONFIG_AUDIT="false" \
    NPM_CONFIG_FUND="false" \
    NPM_CONFIG_UPDATE_NOTIFIER="false" \
    OPENKIT_ARTIFACT_DIR="/openkit/artifacts" \
    OPENKIT_SESSION_DIR="/openkit/session" \
    PATH="/sandbox/.venv/bin:/usr/local/bin:/usr/bin:/bin" \
    PIP_DISABLE_PIP_VERSION_CHECK="1" \
    PYTHONDONTWRITEBYTECODE="1" \
    PYTHONUNBUFFERED="1" \
    UV_PYTHON_INSTALL_DIR="/opt/uv/python" \
    VIRTUAL_ENV="/sandbox/.venv" \
    XDG_CACHE_HOME="/sandbox/.cache" \
    XDG_CONFIG_HOME="/sandbox/.config" \
    XDG_DATA_HOME="/sandbox/.local/share" \
    XDG_STATE_HOME="/sandbox/.local/state"

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    dnsutils \
    fd-find \
    file \
    git \
    iproute2 \
    iputils-ping \
    jq \
    lsof \
    nano \
    net-tools \
    netcat-openbsd \
    nftables \
    openssh-client \
    passwd \
    pkg-config \
    procps \
    ripgrep \
    tar \
    tini \
    traceroute \
    unzip \
    vim \
    xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd

COPY --from=uv /uv /uvx /usr/local/bin/

RUN corepack enable \
  && corepack prepare pnpm@10.33.3 --activate \
  && pnpm --version

RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) gh_arch="amd64"; gh_sha256="${GH_AMD64_SHA256}" ;; \
    arm64) gh_arch="arm64"; gh_sha256="${GH_ARM64_SHA256}" ;; \
    *) echo "Unsupported GitHub CLI Docker target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  gh_archive="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"; \
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_archive}" -o "/tmp/${gh_archive}"; \
  echo "${gh_sha256}  /tmp/${gh_archive}" | sha256sum -c -; \
  tar -xzf "/tmp/${gh_archive}" -C /tmp; \
  install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh; \
  rm -rf "/tmp/${gh_archive}" "/tmp/gh_${GH_VERSION}_linux_${gh_arch}"; \
  gh --version

RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) mise_arch="x64"; mise_sha256="${MISE_AMD64_SHA256}" ;; \
    arm64) mise_arch="arm64"; mise_sha256="${MISE_ARM64_SHA256}" ;; \
    *) echo "Unsupported mise Docker target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  mise_binary="mise-v${MISE_VERSION}-linux-${mise_arch}"; \
  curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/${mise_binary}" -o "/tmp/${mise_binary}"; \
  echo "${mise_sha256}  /tmp/${mise_binary}" | sha256sum -c -; \
  install -m 0755 "/tmp/${mise_binary}" /usr/local/bin/mise; \
  rm -f "/tmp/${mise_binary}"; \
  mise --version

RUN uv python install "${PYTHON_VERSION}" \
  && python_path="$(uv python find "${PYTHON_VERSION}")" \
  && ln -s "${python_path}" /usr/local/bin/python3 \
  && ln -s "${python_path}" /usr/local/bin/python \
  && uv cache clean

COPY --from=worker-shim-builder /deploy/worker-shim/ /usr/local/lib/openkit/worker-shim/
COPY containers/workers/openkit-file-effect /usr/local/bin/openkit-file-effect
COPY containers/workers/openkit-worker-shim /usr/local/bin/openkit-worker-shim
COPY containers/workers/smoke-common.sh /usr/local/bin/openkit-worker-common-smoke
COPY containers/workers/openkit-worker-common-base-smoke.sh /usr/local/bin/openkit-worker-common-base-smoke

RUN /usr/sbin/groupadd --system sandbox \
  && /usr/sbin/useradd --system --gid sandbox --home-dir /sandbox --create-home --shell /bin/bash sandbox \
  && mkdir -p \
    /sandbox/.cache \
    /sandbox/.config \
    /sandbox/.local/share \
    /sandbox/.local/state \
    /sandbox/.npm \
    /sandbox/openkit/artifacts \
    /sandbox/openkit/sessions \
    /sandbox/openkit/session \
    /workspace \
  && ln -s /sandbox/openkit /openkit \
  && mkdir -p \
    /workspace/worktrees/main \
    /workspace/inputs \
    /workspace/data \
    /workspace/artifacts/in \
    /workspace/outputs \
    /workspace/scratch \
    /workspace/.openkit/cache \
    /openkit/session \
    /openkit/instructions \
  && uv venv --python "${PYTHON_VERSION}" --seed /sandbox/.venv \
  && uv cache clean \
  && printf '%s\n' \
    'export PATH="/sandbox/.venv/bin:/usr/local/bin:/usr/bin:/bin"' \
    'export VIRTUAL_ENV="/sandbox/.venv"' \
    'export UV_PYTHON_INSTALL_DIR="/opt/uv/python"' \
    'export PS1="\u@\h:\w\$ "' \
    > /sandbox/.bashrc \
  && printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > /sandbox/.profile \
  && chmod +x /usr/local/bin/openkit-file-effect /usr/local/bin/openkit-worker-shim /usr/local/bin/openkit-worker-common-smoke /usr/local/bin/openkit-worker-common-base-smoke \
  && chown -R sandbox:sandbox /sandbox /workspace

LABEL org.openkit.image="worker-common"
LABEL org.openkit.smoke="/usr/local/bin/openkit-worker-common-base-smoke"

ENTRYPOINT ["tini", "-g", "--"]
CMD ["openkit-worker-shim"]

USER sandbox

FROM worker-common AS worker-codex

ARG TARGETARCH
ARG CODEX_CLI_VERSION="0.144.1"

LABEL org.openkit.image="worker-codex"
LABEL org.openkit.worker.runtime="codex"
LABEL org.openkit.worker.contract="openkit-worker-v1"
LABEL org.openkit.worker-shim="/usr/local/bin/openkit-worker-shim"
LABEL org.openkit.smoke="/usr/local/bin/openkit-worker-codex-smoke"

USER root

RUN export CODEX_HOME=/tmp/codex-home \
    HOME=/tmp/codex-home \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    XDG_CACHE_HOME=/tmp/codex-cache \
    XDG_CONFIG_HOME=/tmp/codex-config \
    XDG_DATA_HOME=/tmp/codex-data \
    XDG_STATE_HOME=/tmp/codex-state; \
  set -eux; \
  mkdir -p "${CODEX_HOME}"; \
  case "${TARGETARCH:-amd64}" in \
    amd64) codex_npm_arch="x64"; codex_npm_tag="linux-x64"; codex_target="x86_64-unknown-linux-musl" ;; \
    arm64) codex_npm_arch="arm64"; codex_npm_tag="linux-arm64"; codex_target="aarch64-unknown-linux-musl" ;; \
    *) echo "Unsupported Codex Docker target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  npm install \
    --prefix /tmp/codex-native \
    --omit=dev \
    --ignore-scripts \
    "@openai/codex-linux-${codex_npm_arch}@npm:@openai/codex@${CODEX_CLI_VERSION}-${codex_npm_tag}"; \
  mkdir -p /usr/local/lib/codex; \
  cp -R "/tmp/codex-native/node_modules/@openai/codex-linux-${codex_npm_arch}/vendor/${codex_target}/." /usr/local/lib/codex/; \
  ln -s /usr/local/lib/codex/bin/codex /usr/local/bin/codex; \
  codex --version; \
  codex exec --help >/dev/null; \
  rm -rf \
    /tmp/codex-cache \
    /tmp/codex-config \
    /tmp/codex-data \
    /tmp/codex-home \
    /tmp/codex-native \
    /tmp/codex-state \
    /tmp/npm-cache

COPY containers/worker-codex/smoke.sh /usr/local/bin/openkit-worker-codex-smoke

RUN chmod +x /usr/local/bin/openkit-worker-codex-smoke

USER sandbox

FROM worker-common AS worker-opencode

ARG OPENCODE_VERSION="1.18.1"

LABEL org.openkit.image="worker-opencode"
LABEL org.openkit.worker.runtime="opencode"
LABEL org.openkit.worker.contract="openkit-worker-v1"
LABEL org.openkit.worker-shim="/usr/local/bin/openkit-worker-shim"
LABEL org.openkit.smoke="/usr/local/bin/openkit-worker-opencode-smoke"

USER root

RUN export HOME=/tmp/opencode-home \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    XDG_CACHE_HOME=/tmp/opencode-cache \
    XDG_CONFIG_HOME=/tmp/opencode-config \
    XDG_DATA_HOME=/tmp/opencode-data \
    XDG_STATE_HOME=/tmp/opencode-state \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
  && npm install --global --omit=dev "opencode-ai@${OPENCODE_VERSION}" \
  && test "$(readlink -f /usr/local/bin/opencode)" = "/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe" \
  && opencode --version \
  && rm -rf /tmp/npm-cache /tmp/opencode-cache /tmp/opencode-config /tmp/opencode-data /tmp/opencode-home /tmp/opencode-state \
  && test ! -e /etc/opencode

COPY containers/worker-opencode/smoke.sh /usr/local/bin/openkit-worker-opencode-smoke

RUN chmod +x /usr/local/bin/openkit-worker-opencode-smoke

USER sandbox

FROM worker-common AS worker-pi

ARG PI_VERSION="0.80.7"

LABEL org.openkit.image="worker-pi"
LABEL org.openkit.worker.runtime="pi"
LABEL org.openkit.worker.contract="openkit-worker-v1"
LABEL org.openkit.worker-shim="/usr/local/bin/openkit-worker-shim"
LABEL org.openkit.smoke="/usr/local/bin/openkit-worker-pi-smoke"

USER root

RUN export HOME=/tmp/pi-home \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    PI_CODING_AGENT_DIR=/tmp/pi-agent \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    XDG_CACHE_HOME=/tmp/pi-cache \
    XDG_CONFIG_HOME=/tmp/pi-config \
    XDG_DATA_HOME=/tmp/pi-data \
    XDG_STATE_HOME=/tmp/pi-state \
  && npm install --global --omit=dev --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && pi --version \
  && rm -rf /tmp/npm-cache /tmp/pi-agent /tmp/pi-cache /tmp/pi-config /tmp/pi-data /tmp/pi-home /tmp/pi-state \
  && touch /usr/local/lib/openkit/allow-anthropic-api-key

COPY containers/worker-pi/smoke.sh /usr/local/bin/openkit-worker-pi-smoke

RUN chmod +x /usr/local/bin/openkit-worker-pi-smoke

USER sandbox
