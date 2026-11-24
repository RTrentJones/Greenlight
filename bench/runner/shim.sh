#!/bin/sh
# Trajectory shim (vision 06 §4.6): /opt/shims/<cmd> -> this script. It hands the command to the
# recorder, which runs as the shim user (the only user that can reach the shim socket), runs the
# real binary as the agent again, and reports argv, cwd and exit. A recording device: it enforces
# nothing. The agent's environment travels as data (base64 of `env -0`), never as the recorder's
# own environment, so NODE_OPTIONS / LD_PRELOAD cannot reach the recorder.
exec /usr/bin/doas -n -u shim /opt/runner/record "$(basename "$0")" "$PWD" "$(env -0 | base64 -w0)" "$@"
