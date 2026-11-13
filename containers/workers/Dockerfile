# syntax=docker/dockerfile:1.7

FROM ghcr.io/astral-sh/uv:0.11.30@sha256:93b61e21202b1dab861092748e46bbd6e0e41dd84f59b9174efd2353186e1b47 AS uv

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS worker-shim-builder

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

RUN node --input-type=module -e 'import fs from "node:fs"; import {createHash} from "node:crypto"; const r=await fetch("https://registry.npmjs.org/corepack/-/corepack-0.36.0.tgz"); if(!r.ok) throw Error("Corepack download failed"); const b=Buffer.from(await r.arrayBuffer()); if(createHash("sha512").update(b).digest("hex")!=="4a2889b01859a9d0623c74c497a393dec012ad1aca21c61340cb15197c7a104fe033c5853306237885fc4edf11894e08bf627a2db4fc2a919f08eb01a51581ff") throw Error("Corepack checksum mismatch"); fs.writeFileSync("/tmp/corepack.tgz",b);' \
  && npm install -g --offline --ignore-scripts --no-audit --no-fund /tmp/corepack.tgz \
  && rm /tmp/corepack.tgz \
  && corepack enable \
  && corepack prepare pnpm@10.33.3+sha512.a19744364a7e248b92657a4ca5973f9354d21caf982579674b1c539f32c7420c47138ad8b1254df07aba9bc782d9b3029e3db34d5dbff974326eb74dac8ff489 --activate \
  && pnpm --version

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/worker-protocol/package.json packages/worker-protocol/package.json
COPY packages/config-schema/package.json packages/config-schema/package.json
COPY packages/worker-shim/package.json packages/worker-shim/package.json
COPY packages/codex-app-server-schema/package.json packages/codex-app-server-schema/package.json
COPY packages/pi-runtime-host/package.json packages/pi-runtime-host/package.json
COPY patches/pi-coding-agent-1.4.0-openkit-native-state.patch patches/pi-coding-agent-1.4.0-openkit-native-state.patch

RUN pnpm install --frozen-lockfile

COPY packages/protocol packages/protocol
COPY packages/worker-protocol packages/worker-protocol
COPY packages/config-schema packages/config-schema
COPY packages/worker-shim packages/worker-shim
COPY packages/codex-app-server-schema packages/codex-app-server-schema
COPY packages/pi-runtime-host packages/pi-runtime-host

RUN pnpm --filter @openkit/protocol build \
  && pnpm --filter @openkit/worker-protocol build \
  && pnpm --filter @openkit/config-schema build \
  && pnpm --filter @openkit/worker-shim build \
  && pnpm --filter @openkit/pi-runtime-host build \
  && rm package.json \
  && pnpm --filter @openkit/worker-shim deploy --prod --legacy /deploy/worker-shim \
  && pnpm --filter @openkit/pi-runtime-host deploy --prod --legacy /deploy/pi-runtime-host

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS worker-common

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
    BASH_ENV="/opt/openkit/.bashrc" \
    ENV="/opt/openkit/.bashrc" \
    HOME="/sandbox" \
    NPM_CONFIG_AUDIT="false" \
    NPM_CONFIG_FUND="false" \
    NPM_CONFIG_UPDATE_NOTIFIER="false" \
    OPENKIT_ARTIFACT_DIR="/openkit/artifacts" \
    PATH="/opt/openkit/venv/bin:/usr/local/bin:/usr/bin:/bin" \
    PIP_DISABLE_PIP_VERSION_CHECK="1" \
    PYTHONDONTWRITEBYTECODE="1" \
    PYTHONUNBUFFERED="1" \
    UV_PYTHON_INSTALL_DIR="/opt/uv/python" \
    VIRTUAL_ENV="/opt/openkit/venv" \
    XDG_CACHE_HOME="/sandbox/.cache" \
    XDG_CONFIG_HOME="/sandbox/.config" \
    XDG_DATA_HOME="/sandbox/.local/share" \
    XDG_STATE_HOME="/sandbox/.local/state"

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

RUN node --input-type=module -e 'import fs from "node:fs"; import {createHash} from "node:crypto"; const r=await fetch("https://registry.npmjs.org/corepack/-/corepack-0.36.0.tgz"); if(!r.ok) throw Error("Corepack download failed"); const b=Buffer.from(await r.arrayBuffer()); if(createHash("sha512").update(b).digest("hex")!=="4a2889b01859a9d0623c74c497a393dec012ad1aca21c61340cb15197c7a104fe033c5853306237885fc4edf11894e08bf627a2db4fc2a919f08eb01a51581ff") throw Error("Corepack checksum mismatch"); fs.writeFileSync("/tmp/corepack.tgz",b);' \
  && npm install -g --offline --ignore-scripts --no-audit --no-fund /tmp/corepack.tgz \
  && rm /tmp/corepack.tgz \
  && corepack enable \
  && corepack prepare pnpm@10.33.3+sha512.a19744364a7e248b92657a4ca5973f9354d21caf982579674b1c539f32c7420c47138ad8b1254df07aba9bc782d9b3029e3db34d5dbff974326eb74dac8ff489 --activate \
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

COPY --chmod=0755 --from=worker-shim-builder /deploy/worker-shim/ /usr/local/lib/openkit/worker-shim/
COPY --chmod=0755 containers/workers/openkit-file-effect /usr/local/bin/openkit-file-effect
COPY --chmod=0755 containers/workers/openkit-worker-shim /usr/local/bin/openkit-worker-shim
COPY --chmod=0755 containers/workers/smoke-common.sh /usr/local/bin/openkit-worker-common-smoke
COPY --chmod=0755 containers/workers/openkit-worker-common-base-smoke.sh /usr/local/bin/openkit-worker-common-base-smoke
COPY --chmod=0644 containers/workers/python-tools.txt /usr/local/lib/openkit/python-tools.txt

RUN /usr/sbin/groupmod --new-name sandbox node \
  && /usr/sbin/usermod --login sandbox --home /sandbox --shell /bin/bash node \
  && rm -rf /home/node \
  && test "$(id -u sandbox)" = "1000" \
  && test "$(id -g sandbox)" = "1000" \
  && mkdir -p \
    /openkit/artifacts \
    /openkit/instructions \
    /openkit/threads \
    /openkit/sessions \
    /opt/openkit \
    /sandbox/.cache \
    /sandbox/.config \
    /sandbox/.local/share \
    /sandbox/.local/state \
    /sandbox/.npm \
    /tmp/openkit-bootstrap \
    /workspace \
  && mkdir -p \
    /workspace/worktrees \
    /workspace/inputs \
    /workspace/data \
    /workspace/artifacts/in \
    /workspace/outputs \
    /workspace/scratch \
    /workspace/.openkit/cache \
  && uv venv --python "${PYTHON_VERSION}" /opt/openkit/venv \
  && uv pip install --python /opt/openkit/venv/bin/python --no-build --no-deps --require-hashes -r /usr/local/lib/openkit/python-tools.txt \
  && uv cache clean \
  && printf '%s\n' \
    'export PATH="/opt/openkit/venv/bin:/usr/local/bin:/usr/bin:/bin"' \
    'export VIRTUAL_ENV="/opt/openkit/venv"' \
    'export UV_PYTHON_INSTALL_DIR="/opt/uv/python"' \
    'export PS1="\u@\h:\w\$ "' \
    > /opt/openkit/.bashrc \
  && chown -R 1000:1000 /openkit /sandbox /tmp/openkit-bootstrap /workspace \
  && chmod 0700 /tmp/openkit-bootstrap

ENV TEMP="/tmp/openkit-bootstrap" \
    TMP="/tmp/openkit-bootstrap" \
    TMPDIR="/tmp/openkit-bootstrap"

# Exact coordinated release provenance lives in root-owned image bytes, never runtime ENV.
ARG OPENKIT_RELEASE_TAG
ARG OPENKIT_SOURCE_COMMIT
RUN node -e 'const fs=require("node:fs"); const sourceCommit=process.env.OPENKIT_SOURCE_COMMIT||null; const releaseTag=process.env.OPENKIT_RELEASE_TAG||null; if(sourceCommit!==null&&!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Invalid Worker source identity"); fs.mkdirSync("/usr/local/lib/openkit",{recursive:true}); fs.writeFileSync("/usr/local/lib/openkit/release-identity.json",JSON.stringify({releaseTag,sourceCommit})+"\n",{mode:0o444});'
LABEL org.opencontainers.image.revision="${OPENKIT_SOURCE_COMMIT}"
LABEL org.opencontainers.image.version="${OPENKIT_RELEASE_TAG}"

LABEL org.openkit.image="worker-common"
LABEL org.openkit.smoke="/usr/local/bin/openkit-worker-common-base-smoke"
LABEL org.openkit.storage.family="openkit-worker"
LABEL org.openkit.storage.version="1"

VOLUME ["/workspace", "/sandbox", "/openkit/threads"]

WORKDIR /tmp/openkit-bootstrap

ENTRYPOINT ["tini", "-g", "--"]
CMD ["openkit-worker-shim"]

USER 1000:1000

FROM worker-common AS worker-runtimes

ARG TARGETARCH
ARG CODEX_CLI_VERSION="0.166.0"
ARG OPENCODE_VERSION="2.2.5"
ARG DEEPSEEK_VERSION="0.2.1-rc.5"

LABEL org.openkit.image="worker-runtimes"
LABEL org.openkit.worker.runtimes="codex,pi,opencode,deepseek"
LABEL org.openkit.worker.contract="openkit-worker-v1"
LABEL org.openkit.worker-shim="/usr/local/bin/openkit-worker-shim"
LABEL org.openkit.smoke="/usr/local/bin/openkit-worker-runtimes-smoke"

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
    amd64) codex_npm_tag="linux-x64"; codex_target="x86_64-unknown-linux-musl"; codex_sha512="0b10e6dfe0f57296c625e1eb77320da06fb7c27f4156770fe2aa5969a3589317bc88fb5124e6320899e73e8563591201bc8f6f3ca6d1a227ec312039c43694a7" ;; \
    arm64) codex_npm_tag="linux-arm64"; codex_target="aarch64-unknown-linux-musl"; codex_sha512="c3449c02c06bf5a64ab4816b87a1cde8a536ca328a7920b361f6dbec307409c8f80583f3799b54790a6b6f270b0b0b97dc015075b7636a998b868da2a2def88d" ;; \
    *) echo "Unsupported Codex Docker target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl --proto '=https' --tlsv1.2 -fsSL "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}-${codex_npm_tag}.tgz" -o /tmp/codex.tgz; \
  echo "${codex_sha512}  /tmp/codex.tgz" | sha512sum -c -; \
  mkdir -p /usr/local/lib/codex; \
  tar -xzf /tmp/codex.tgz --strip-components=3 -C /usr/local/lib/codex "package/vendor/${codex_target}"; \
  rm /tmp/codex.tgz; \
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

# Native packages resolve from the shim's ancestor, without entering worker-common.
COPY containers/workers/runtime-supply/package.json containers/workers/runtime-supply/package-lock.json /usr/local/lib/openkit/runtime-supply/
RUN test "$(node -p 'require("/usr/local/lib/openkit/runtime-supply/package.json").dependencies["@opencode/cli"]')" = "${OPENCODE_VERSION}" \
  && test "$(node -p 'require("/usr/local/lib/openkit/runtime-supply/package.json").dependencies["@opencode/client"]')" = "${OPENCODE_VERSION}" \
  && test "$(node -p 'require("/usr/local/lib/openkit/runtime-supply/package.json").dependencies["@deepseek-ai/dsh"]')" = "${DEEPSEEK_VERSION}" \
  && export HOME=/tmp/runtime-home \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    XDG_CACHE_HOME=/tmp/runtime-cache \
    XDG_CONFIG_HOME=/tmp/runtime-config \
    XDG_DATA_HOME=/tmp/runtime-data \
    XDG_STATE_HOME=/tmp/runtime-state \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
  && npm ci --prefix /usr/local/lib/openkit/runtime-supply --omit=dev --ignore-scripts --no-audit --no-fund \
  && ln -s runtime-supply/node_modules /usr/local/lib/openkit/node_modules \
  && ln -s /usr/local/lib/openkit/runtime-supply/node_modules/.bin/opencode /usr/local/bin/opencode \
  && ln -s /usr/local/lib/openkit/runtime-supply/node_modules/.bin/dsh /usr/local/bin/dsh \
  && rm -rf /tmp/npm-cache /tmp/runtime-home /tmp/runtime-cache /tmp/runtime-config /tmp/runtime-data /tmp/runtime-state

# OpenCode's existing allowlisted postinstall links its locked native optional package.
# Enforce the canonical allowlist and prohibit any network download during that one script.
COPY pnpm-workspace.yaml /tmp/runtime-build-policy/pnpm-workspace.yaml
RUN --network=none cd /tmp/runtime-build-policy \
  && pnpm config get onlyBuiltDependencies --json | node -e 'const fs=require("node:fs"); if(!JSON.parse(fs.readFileSync(0,"utf8")).includes("@opencode/cli")) throw Error("OpenCode build script is not allowlisted");' \
  && export HOME=/tmp/runtime-home \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    XDG_CACHE_HOME=/tmp/runtime-cache \
    XDG_CONFIG_HOME=/tmp/runtime-config \
    XDG_DATA_HOME=/tmp/runtime-data \
    XDG_STATE_HOME=/tmp/runtime-state \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
  && npm rebuild --prefix /usr/local/lib/openkit/runtime-supply @opencode/cli --offline --ignore-scripts=false --no-audit --no-fund \
  && opencode --version \
  && rm -rf /tmp/runtime-build-policy /tmp/npm-cache /tmp/runtime-home /tmp/runtime-cache /tmp/runtime-config /tmp/runtime-data /tmp/runtime-state \
  && test ! -e /etc/opencode

# Preserve the frozen workspace patch and every transitive production asset.
COPY --chmod=0755 --from=worker-shim-builder /deploy/pi-runtime-host/ /usr/local/lib/openkit/pi-runtime-host/
COPY --chmod=0644 patches/pi-coding-agent-1.4.0-openkit-native-state.patch /usr/local/lib/openkit/pi-native-state.patch
COPY --chmod=0644 containers/worker-runtimes/versions.json /usr/local/lib/openkit/worker-runtimes-versions.json
COPY --chmod=0644 containers/worker-runtimes/smoke-package.json /usr/local/lib/openkit/image-smoke-package.json
COPY --chmod=0755 containers/worker-runtimes/smoke.sh /usr/local/bin/openkit-worker-runtimes-smoke

RUN ln -s /usr/local/lib/openkit/pi-runtime-host/dist/bin/openkit-pi-runtime-host.js /usr/local/bin/openkit-pi-runtime-host \
  && ln -s /usr/local/lib/openkit/pi-runtime-host/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /usr/local/bin/pi

USER 1000:1000
