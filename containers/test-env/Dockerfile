FROM node:24.16.0-bookworm-slim

LABEL org.openkit.image="test-env"
LABEL org.openkit.smoke="/usr/local/bin/openkit-test-env-smoke"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
ENV PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"
ENV OPENKIT_CORE_MODE="local"
ENV OPENKIT_BIND_HOST="127.0.0.1"

# Exact NanoHost-scoped Rust pin. apps/nanohost/mise.toml owns the version;
# this unquoted ENV is the parseable image mirror, and rustup below consumes
# ${RUST_VERSION} rather than a second hard-coded literal. Containers pin their
# own versions and do not install mise (docs/toolchain.md).
ENV RUST_VERSION=1.97.1
ENV RUSTUP_HOME="/usr/local/rustup"
ENV CARGO_HOME="/usr/local/cargo"
ENV PATH="${CARGO_HOME}/bin:${PATH}"

# Marks this image as the test execution environment. scripts/test-env.sh reads
# it to decide whether to run a check directly or re-enter the image first, so a
# repository check can never silently run against a host capability set.
ENV OPENKIT_TEST_EXECUTOR="1"
ENV npm_config_store_dir="/pnpm/store"

WORKDIR /workspace

# Baked identity paired with OPENKIT_TEST_EXECUTOR so host-controlled
# environment metadata alone cannot claim test-image placement.
RUN touch /etc/openkit-test-env

# Contents are derived from what repository gates execute, not from what a
# developer might want at a shell. No worker runtime is installed: real-runtime
# gates run on the host under scripts/test-env.sh host, and adding a runtime here
# would put its release cadence on the critical path of every unrelated gate.
# C/C++ build tools stay so NanoHost cargo build, test, and clippy can
# compile OpenShell protobuf-src and aws-lc-sys and link the result.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    cmake \
    g++ \
    gcc \
    git \
    libc6-dev \
    make \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.33.3 --activate \
  && pnpm --version

# Minimal rustup profile at the exact RUST_VERSION mirror. clippy and rustfmt
# are required NanoHost gate tools; curl is only a bootstrap dependency.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain "${RUST_VERSION}" --profile minimal \
      --component clippy,rustfmt \
  && apt-get purge -y --auto-remove curl \
  && rm -rf /var/lib/apt/lists/* \
  && rustc --version \
  && cargo --version \
  && cargo clippy --version \
  && rustfmt --version

# The repository arrives as a bind mount owned by the host user, which Git
# refuses to read as root without this declaration. pnpm test:unit runs
# `git diff --exit-code` on the generated CLI bundle and depends on it.
RUN mkdir -p /pnpm/store \
  && git config --global --add safe.directory /workspace

RUN npx --yes playwright@1.61.1 install --with-deps chromium \
  && apt-get purge -y --auto-remove xvfb \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

COPY containers/test-env/smoke.sh /usr/local/bin/openkit-test-env-smoke
RUN chmod +x /usr/local/bin/openkit-test-env-smoke

ARG OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST
RUN test -n "${OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST}" \
  && printf '%s\n' "${OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST}" \
    > /etc/openkit-test-env-build-input-digest
LABEL org.openkit.test-env.build-input-digest="${OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST}"

CMD ["bash"]
