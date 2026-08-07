# AgentCore Runtime accepts linux/arm64 only, and the build host is darwin/arm64,
# so this compiles and runs at native speed under Finch.
#
# Two properties are load-bearing and easy to break: the image must stay under
# the 2 GB hard cap, and it must stay well under 53 filesystem layers, because
# >53 layers combined with a non-numeric USER is a documented HTTP 424
# "Failed to mount overlay" at container start.

ARG NODE_VERSION=24.19.0
ARG NODE_SHA256=01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc
ARG HERDR_VERSION=0.8.0
ARG HERDR_SHA256=f647ac66468d9efbc642fe534fb284468f0aea60641606fc008dfc0d82a3ca87
# Pinned, not `latest`: node and herdr are already fetched by exact version and
# checksum, so the agent packages were the only thing that made two builds of the
# same commit differ. pi matters most — it owns the layout of ~/.pi/agent, which
# is where herdr's status hook has to land.
ARG CLAUDE_CODE_VERSION=2.1.222
ARG PI_VERSION=0.83.0


FROM --platform=linux/arm64 arm64v8/ubuntu:24.04 AS builder

ARG NODE_VERSION
ARG NODE_SHA256
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      libatomic1 \
      libc6-dev \
      python3 \
      xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" \
 && printf '%s  /tmp/node.tar.xz\n' "${NODE_SHA256}" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
 && rm -f /tmp/node.tar.xz \
 && node --version

WORKDIR /opt/coding-cube
COPY package.json package-lock.json ./

# node-pty publishes no linux prebuild, so this is a real node-gyp compile:
# src/unix/pty.cc includes <pty.h> and the target links -lutil, which is why the
# base has to be glibc rather than musl. build_from_source also makes node-pty's
# own prebuild script delete the 58 MB of darwin/win32 binaries we cannot use.
# The require() is a smoke test — a failed compile otherwise only surfaces in
# production as a WebSocket close 1011.
RUN npm_config_build_from_source=true npm ci --omit=dev --no-audit --no-fund \
 && node -e "require('node-pty')" \
 && rm -rf node_modules/node-pty/prebuilds \
 && rm -rf node_modules/@mediapipe node_modules/@xterm \
 && npm cache clean --force


FROM --platform=linux/arm64 arm64v8/ubuntu:24.04 AS runtime

ARG HERDR_VERSION
ARG HERDR_SHA256
ARG CLAUDE_CODE_VERSION
ARG PI_VERSION
ENV DEBIAN_FRONTEND=noninteractive

# python3 is a hard dependency, not a convenience: herdr's Claude integration
# hook pipes a heredoc into python3 to emit the agent-status frame, and without
# it /ping reports Healthy while an agent is working.
# fd-find and ripgrep are here for the same class of reason: pi's first
# interactive start calls ensureTool('fd'|'rg'), which hits the GitHub releases
# API and downloads both unless they are already on PATH. Shipping them keeps the
# first prompt of every fresh session off the network. apt names the fd binary
# `fdfind`, which is already in pi's systemBinaryNames list.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      fd-find \
      git \
      less \
      libatomic1 \
      locales \
      openssh-client \
      procps \
      python3 \
      ripgrep \
      tzdata \
 && locale-gen en_US.UTF-8 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version \
 && npm --version

# HOME is the load-bearing one: herdr derives its socket path from $HOME and
# ignores HERDR_SOCKET_PATH entirely whenever --session is passed, which every
# call in this repo does. HERDR_SOCKET_PATH is set to the same path the $HOME
# default resolves to, so a hypothetical call without --session cannot disagree
# with the live server; it is not what selects the path.
ENV HOME=/home/cube \
    LANG=en_US.UTF-8 \
    NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    TERM=xterm-256color \
    COLORTERM=truecolor \
    HERDR_SOCKET_PATH=/home/cube/.config/herdr/herdr.sock \
    CODING_CUBE_GATEWAY_ONLY=1 \
    CODING_CUBE_HERDR=/usr/local/bin/herdr \
    CODING_CUBE_SHELL=/bin/bash \
    CODING_CUBE_WORKDIR=/mnt/workspace/work \
    CODING_CUBE_WORKSPACE="Coding Cube"

RUN curl -fsSL -o /usr/local/bin/herdr \
      "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-aarch64" \
 && printf '%s  /usr/local/bin/herdr\n' "${HERDR_SHA256}" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/herdr \
 && herdr --version

# herdr puts herdr.sock, herdr-client.sock and herdr-server.log side by side in
# $HOME/.config/herdr, and managed session storage does not support mknod, so
# that directory has to stay on the container's own writable layer. Only durable
# children (plugins) are ever symlinked out to the mount.
# Nothing is pre-created at the socket path: herdr reads an existing herdr.sock
# as proof a server is already running, prints "herdr server is already running"
# and exits without ever binding.
# 0777 because herdr creates its sockets 0600 and the uid AgentCore gives a
# platform-spawned shell is undocumented — the gateway widens the socket once the
# server has bound, which only helps if the directory holding it is writable and
# traversable by whoever connects. The isolation boundary is the microVM.
# /home/cube/.claude and friends are otherwise left uncreated: session-store.js
# owns those paths and replaces them with directory symlinks into the mount.
# $HOME/.pi/agent/extensions is the exception, and it is load-bearing. herdr
# refuses to install its pi integration unless that directory already exists
# ("pi extension directory not found at ... install pi first"), and pi only
# creates it the first time an extension is installed — `pi --version`, `pi list`
# and a credential-less `pi -p` all leave $HOME untouched, so nothing in a normal
# boot ever makes it. Without the integration a Pi agent's status never reaches
# /ping, so a Pi session that is working reads as idle and AgentCore evicts the
# microVM mid-task. Both copies are needed: the seed copy is what a durable boot
# clones onto session storage, and the $HOME copy is what an ephemeral boot is
# left with, since session-store.js only mkdirs those paths when there is no
# mount to seed from. mkdir -p keeps the existing children either way.
# safe.directory is blanket because session storage stores but does not enforce
# ownership, so git's dubious-ownership check would otherwise fail on the repos.
RUN mkdir -p \
      /home/cube/.cache \
      /home/cube/.pi/agent/extensions \
      /opt/seed/home/.claude \
      /opt/seed/home/.coding-cube \
      /opt/seed/home/.config/herdr/plugins \
      /opt/seed/home/.pi/agent/extensions \
 && mkdir -m 0777 -p /home/cube/.config/herdr \
 && mkdir -m 0700 -p /opt/seed/home/.ssh \
 && git config --system --add safe.directory '*'

# Global rather than under $HOME: session storage gets symlinked into $HOME on
# first boot, which would shadow anything installed there.
RUN npm install -g --no-audit --no-fund \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force \
 && rm -rf /home/cube/.npm /root/.npm

# Both integration installers are directory-gated — pi on $HOME/.pi/agent/extensions,
# claude on $HOME/.claude — and both fail closed at runtime with nothing worse than
# a warning in the boot log, so a version bump that moves either layout would be
# invisible until an agent silently stopped reporting "working". Prove the contract
# here instead. Run against a throwaway HOME so the real one keeps the shape
# session-store.js expects; the gateway reinstalls both on every boot anyway.
RUN check=/tmp/integration-check \
 && mkdir -p "$check/.pi/agent/extensions" "$check/.claude" \
 && HOME="$check" herdr --session default integration install pi \
 && HOME="$check" herdr --session default integration install claude \
 && test -f "$check/.pi/agent/extensions/herdr-agent-state.ts" \
 && test -f "$check/.claude/hooks/herdr-agent-state.sh" \
 && rm -rf "$check"

# src/server must stay exactly two levels below the app root: config.js derives
# paths.root from import.meta.url and static.js resolves node_modules as a
# sibling of public/.
WORKDIR /opt/coding-cube
COPY package.json package-lock.json ./
COPY --from=builder /opt/coding-cube/node_modules ./node_modules
COPY src ./src
COPY public ./public
COPY spike/bin/ /usr/local/bin/
COPY spike/config/herdr-config.toml /opt/seed/home/.config/herdr/config.toml
RUN chmod 0755 /usr/local/bin/cube-face /usr/local/bin/cube-wait-face \
 && sh -n /usr/local/bin/cube-face \
 && node --check /usr/local/bin/cube-wait-face

# Numeric on purpose. A non-numeric USER is half of the documented overlay-mount
# failure, and a uid split between the gateway and a platform-spawned shell would
# give them different $HOME. AWS states the isolation boundary is the microVM
# itself, so uid 0 costs nothing here.
USER 0
EXPOSE 8080
ENTRYPOINT ["node", "/opt/coding-cube/src/server/agentcore.js"]
