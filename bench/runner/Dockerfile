# syntax=docker/dockerfile:1
# The bench rollout and grading image (vision 06 §4.2, roadmap M1-05). Built by the runner
# (`packages/wiki/src/bench/sandbox.ts`, `ensureRunnerImage`) from this directory only: the build
# context holds no grader, mutant, reference or repo source.
#
# Identity (06 §4.2, §4.8): the base image is pinned by digest; the apk packages are NOT pinned by
# version. Alpine's mirror serves only the current revision of a package, so an exact pin
# (`git=2.54.0-r0`) makes a from-scratch build fail the day a security patch lands. Instead the
# runner reads the package list actually installed (`apk info -v`, name-version for every package)
# out of the built image and hashes it into `harness.imageDigest`, together with this directory
# and the shim uid (`ensureRunnerImage` / `runnerImageDigest`). A package update therefore never
# breaks the build: it yields a new identity, so sealed evaluations made on the old image are
# incomparable and a resume across the update is refused (re-baseline). The local image id is not
# used: it changes on every rebuild.
#
# Users:
#   agent (10000)      runs every agent tool call; owns /work, /srv, its HOME (all tmpfs)
#   shim  (SHIM_UID)   the trajectory recorder; the only user that can connect to the shim socket
#                      (bind-mounted at /run/greenlight-shim, socket mode 0600 owned by SHIM_UID)
# The command shims on the agent's PATH (/opt/shims) hop to the shim user through doas, which runs
# only /opt/runner/record. The recorder runs the real command as the agent again, through
# /opt/runner/run-real (doas to root, which immediately drops to uid agent with the extra group
# shim), and reports what ran. The real binaries of the shimmed commands (git and its helpers,
# curl, the greenlight CLI under /opt/real) are root:shim 0750: the agent's own processes cannot
# run them, so every git/curl/greenlight call goes through a shim and is recorded. `pnpm` and `npx`
# are shims too: the image has no package manager and no network, so the recorder passes
# `pnpm [exec|run|dlx] greenlight …` / `npx [--package …] greenlight …` straight to the greenlight
# CLI (recorded as that greenlight command) and fails anything else at once with a clear message.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

ARG SHIM_UID=10001
ARG HTTPS_PROXY

# git/bash/curl for the agent; doas + setpriv for the recorder's uid hops. A build behind an egress
# proxy passes HTTPS_PROXY and (as a BuildKit secret named "ca") its CA bundle; neither is kept.
RUN --mount=type=secret,id=ca,required=false \
    sed -i 's#^http://#https://#' /etc/apk/repositories && \
    if [ -f /run/secrets/ca ]; then export SSL_CERT_FILE=/run/secrets/ca; fi && \
    if [ -n "$HTTPS_PROXY" ]; then export https_proxy="$HTTPS_PROXY"; fi && \
    apk add --no-cache git bash curl doas setpriv

# The base image's `node` user (uid 1000) would collide with a host uid passed as SHIM_UID.
RUN deluser --remove-home node 2>/dev/null; delgroup node 2>/dev/null; \
    addgroup -g 10000 agent && adduser -D -u 10000 -G agent -h /home/agent -s /bin/bash agent && \
    addgroup -g "$SHIM_UID" shim && adduser -D -H -u "$SHIM_UID" -G shim -h /nonexistent -s /sbin/nologin shim

COPY doas.conf /etc/doas.conf
COPY record.mjs git-ctx.sh shim.sh /opt/runner/
RUN chmod 0400 /etc/doas.conf && \
    printf '#!/bin/sh\nexec /usr/local/bin/node /opt/runner/record.mjs --docker "$@"\n' > /opt/runner/record && \
    printf '#!/bin/sh\nexec /bin/setpriv --reuid=10000 --regid=10000 --groups=%s -- /usr/bin/env -i "$@"\n' "$SHIM_UID" > /opt/runner/run-real && \
    chmod 0755 /opt/runner/record /opt/runner/shim.sh && chmod 0750 /opt/runner/run-real && \
    chown root:shim /opt/runner/run-real && chmod 0644 /opt/runner/record.mjs /opt/runner/git-ctx.sh && \
    mkdir -p /opt/shims /opt/real/greenlight /run/greenlight-shim /work /srv && \
    for c in git greenlight pnpm npx wrangler vercel gh terraform docker curl; do ln -s /opt/runner/shim.sh "/opt/shims/$c"; done && \
    for f in /usr/bin/git /usr/bin/git-shell /usr/bin/scalar /usr/bin/curl \
             /usr/bin/wrangler /usr/bin/vercel /usr/bin/gh /usr/bin/terraform /usr/bin/docker; do \
      if [ -f "$f" ] && [ ! -L "$f" ]; then chown root:shim "$f" && chmod 0750 "$f"; fi; \
    done && \
    chown root:shim /usr/libexec/git-core /opt/real && chmod 0750 /usr/libexec/git-core /opt/real

ENV PATH=/opt/shims:/usr/local/bin:/usr/bin:/bin \
    GREENLIGHT_WIKI=off \
    HOME=/home/agent
WORKDIR /work
USER agent
CMD ["sleep", "2147483647"]
