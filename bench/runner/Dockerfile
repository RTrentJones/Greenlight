# syntax=docker/dockerfile:1
# The bench rollout and grading image (vision 06 §4.2, roadmap M1-05). Built by the runner
# (`packages/wiki/src/bench/sandbox.ts`, `ensureRunnerImage`) from this directory only: the build
# context holds no grader, mutant, reference or repo source. Its image id is part of the
# BaselineIdentity (`harness.imageDigest`), so any change here re-baselines.
#
# Users:
#   agent (10000)      runs every agent tool call; owns /work, /srv, its HOME (all tmpfs)
#   shim  (SHIM_UID)   the trajectory recorder; the only user that can connect to the shim socket
#                      (bind-mounted at /run/greenlight-shim, socket mode 0600 owned by SHIM_UID)
# The command shims on the agent's PATH (/opt/shims) hop to the shim user through doas, which runs
# only /opt/runner/record. The recorder runs the real command as the agent again and reports what
# ran; the agent cannot connect to the socket itself, so it cannot forge or edit an event.
FROM node:22-alpine

ARG SHIM_UID=10001
ARG HTTPS_PROXY

# git/bash/curl for the agent; doas for the recorder's uid hop. A build behind an egress proxy
# passes HTTPS_PROXY and (as a BuildKit secret named "ca") its CA bundle; neither is kept.
RUN --mount=type=secret,id=ca,required=false \
    sed -i 's#^http://#https://#' /etc/apk/repositories && \
    if [ -f /run/secrets/ca ]; then export SSL_CERT_FILE=/run/secrets/ca; fi && \
    https_proxy="$HTTPS_PROXY" apk add --no-cache git bash curl doas

# The base image's `node` user (uid 1000) would collide with a host uid passed as SHIM_UID.
RUN deluser --remove-home node 2>/dev/null; delgroup node 2>/dev/null; \
    addgroup -g 10000 agent && adduser -D -u 10000 -G agent -h /home/agent -s /bin/bash agent && \
    addgroup -g "$SHIM_UID" shim && adduser -D -H -u "$SHIM_UID" -G shim -h /nonexistent -s /sbin/nologin shim

COPY doas.conf /etc/doas.conf
COPY record.mjs git-ctx.sh shim.sh /opt/runner/
RUN chmod 0400 /etc/doas.conf && \
    printf '#!/bin/sh\nexec /usr/local/bin/node /opt/runner/record.mjs --docker "$@"\n' > /opt/runner/record && \
    chmod 0755 /opt/runner/record /opt/runner/shim.sh && chmod 0644 /opt/runner/record.mjs /opt/runner/git-ctx.sh && \
    mkdir -p /opt/shims /opt/greenlight /run/greenlight-shim /work /srv && \
    for c in git greenlight wrangler vercel gh terraform docker curl; do ln -s /opt/runner/shim.sh "/opt/shims/$c"; done

ENV PATH=/opt/shims:/usr/local/bin:/usr/bin:/bin \
    GREENLIGHT_WIKI=off \
    HOME=/home/agent
WORKDIR /work
USER agent
CMD ["sleep", "2147483647"]
