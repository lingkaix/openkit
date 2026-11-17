# Copy only the existing Playwright version's browser bytes from a digest-bound supplier.
# This avoids unverified browser downloads while keeping the runtime on the Worker Node pin.
FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe AS browser-supply
RUN rm -rf /ms-playwright/firefox-* /ms-playwright/webkit-*

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

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
ARG TARGETARCH
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
    jq \
    libc6-dev \
    make \
    pkg-config \
    python3 \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN node --input-type=module -e 'import fs from "node:fs"; import {createHash} from "node:crypto"; const r=await fetch("https://registry.npmjs.org/corepack/-/corepack-0.36.0.tgz"); if(!r.ok) throw Error("Corepack download failed"); const b=Buffer.from(await r.arrayBuffer()); if(createHash("sha512").update(b).digest("hex")!=="4a2889b01859a9d0623c74c497a393dec012ad1aca21c61340cb15197c7a104fe033c5853306237885fc4edf11894e08bf627a2db4fc2a919f08eb01a51581ff") throw Error("Corepack checksum mismatch"); fs.writeFileSync("/tmp/corepack.tgz",b);' \
  && npm install -g --offline --ignore-scripts --no-audit --no-fund /tmp/corepack.tgz \
  && rm /tmp/corepack.tgz \
  && corepack enable \
  && corepack prepare pnpm@10.34.9+sha512.f49b5a8ea0fdedb44bb3c0c1d6575092a53c2950d95b7ad15df11f17974877a2de3a01c07e934e9b28ce716e51c09a94962c7306d09be2e1e4b18a8c8762fd32 --activate \
  && pnpm --version

# Minimal rustup profile at the exact RUST_VERSION mirror. clippy and rustfmt
# are required NanoHost gate tools; curl is only a bootstrap dependency.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && case "${TARGETARCH}" in \
       amd64) rustup_target=x86_64-unknown-linux-gnu; rustup_sha256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55 ;; \
       arm64) rustup_target=aarch64-unknown-linux-gnu; rustup_sha256=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282 ;; \
       *) exit 1 ;; \
     esac \
  && curl --proto '=https' --tlsv1.2 -fsSL "https://static.rust-lang.org/rustup/archive/1.29.3/${rustup_target}/rustup-init" -o /tmp/rustup-init \
  && echo "${rustup_sha256}  /tmp/rustup-init" | sha256sum -c - \
  && chmod 0755 /tmp/rustup-init \
  && /tmp/rustup-init -y --no-modify-path --default-toolchain "${RUST_VERSION}" --profile minimal --component clippy,rustfmt \
  && rm /tmp/rustup-init \
  && apt-get purge -y --auto-remove curl \
  && rm -rf /var/lib/apt/lists/* \
  && rustc --version \
  && cargo --version \
  && cargo clippy --version \
  && rustfmt --version

# Cache and verify the sole tokenizer archive before ordinary offline Cargo gates.
ENV LINDERA_BUILD_DICTIONARY_CACHE_DIR="/opt/openkit-lindera"
COPY scripts/retrieval-dictionary.py /usr/local/lib/openkit/retrieval-dictionary.py
COPY packages/retrieval-kernel/vendor/ /usr/local/lib/openkit/vendor/
RUN python3 /usr/local/lib/openkit/retrieval-dictionary.py --cache "${LINDERA_BUILD_DICTIONARY_CACHE_DIR}" --archive /usr/local/lib/openkit/vendor/mecab-ipadic-2.7.0-20250920.tar.gz \
  && chown -R node:node "${LINDERA_BUILD_DICTIONARY_CACHE_DIR}"

# The repository arrives as a bind mount owned by the host user, which Git
# refuses to read as root without this declaration. pnpm test:unit runs
# `git diff --exit-code` on the generated CLI bundle and depends on it.
RUN mkdir -p /pnpm/store \
  && git config --global --add safe.directory /workspace

COPY --from=browser-supply /ms-playwright/ /ms-playwright/
COPY containers/test-env/browser-tools/package.json containers/test-env/browser-tools/package-lock.json /opt/openkit-browser-tools/
RUN npm ci --prefix /opt/openkit-browser-tools --ignore-scripts --no-audit --no-fund \
  && /opt/openkit-browser-tools/node_modules/.bin/playwright install-deps chromium \
  && apt-get purge -y --auto-remove xvfb \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/install-security-tools.mjs scripts/security-tools.json /usr/local/lib/openkit/security-tools/
RUN node /usr/local/lib/openkit/security-tools/install-security-tools.mjs --tool zizmor --directory /usr/local/bin \
  && node /usr/local/lib/openkit/security-tools/install-security-tools.mjs --tool osv-scanner --directory /usr/local/bin \
  && node /usr/local/lib/openkit/security-tools/install-security-tools.mjs --tool cargo-auditable --directory /usr/local/bin

# Deterministic credential tests consume these real CLIs against loopback fake services.
# Keep every supplier version/hash committed; stage ALL verified bytes before installation.
COPY scripts/download-native-client-tools.mjs scripts/native-client-tools.json /usr/local/lib/openkit/security-tools/
RUN node /usr/local/lib/openkit/security-tools/download-native-client-tools.mjs /tmp/openkit-native-clients \
  && apt-get update \
  && apt-get install -y --no-install-recommends unzip \
    /tmp/openkit-native-clients/docker-cli.deb \
    /tmp/openkit-native-clients/openssh-client.deb \
  && unzip -q /tmp/openkit-native-clients/aws.zip -d /tmp/openkit-native-clients \
  && /tmp/openkit-native-clients/aws/install --install-dir /opt/openkit-aws-cli --bin-dir /usr/local/bin \
  && install -m 0755 /tmp/openkit-native-clients/kubectl /usr/local/bin/kubectl \
  && node --input-type=module -e 'import {readFileSync} from "node:fs"; import {execFileSync} from "node:child_process"; const pins=JSON.parse(readFileSync("/usr/local/lib/openkit/security-tools/native-client-tools.json","utf8")).tools; const probe=(name,args)=>execFileSync(name,args,{encoding:"utf8"}).trim(); for(const [name,pkg] of [["docker","docker-ce-cli"],["openssh","openssh-client"]]) { if(probe("dpkg-query",["-W","-f=${Version}",pkg])!==pins[name].version) throw Error("Installed native client package version mismatch"); } if(!probe("aws",["--version"]).startsWith(`aws-cli/${pins.aws.version} `)) throw Error("AWS CLI version mismatch"); if(JSON.parse(probe("kubectl",["version","--client","--output=json"])).clientVersion.gitVersion!==pins.kubectl.version) throw Error("kubectl version mismatch"); const dockerVersion=pins.docker.version.split(":")[1].split("-")[0]; if(!probe("docker",["--version"]).startsWith(`Docker version ${dockerVersion},`)) throw Error("Docker CLI version mismatch"); execFileSync("ssh",["-V"],{stdio:"inherit"});' \
  && rm -rf /tmp/openkit-native-clients /var/lib/apt/lists/*

COPY containers/test-env/smoke.sh /usr/local/bin/openkit-test-env-smoke
RUN chmod +x /usr/local/bin/openkit-test-env-smoke

ARG OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST
RUN test -n "${OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST}" \
  && printf '%s\n' "${OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST}" \
    > /etc/openkit-test-env-build-input-digest
LABEL org.openkit.test-env.build-input-digest="${OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST}"

CMD ["bash"]
