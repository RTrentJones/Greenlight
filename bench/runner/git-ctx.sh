#!/bin/sh
# What the git shim reports about the repository (the ShimContext inputs of
# packages/wiki/src/bench/trajectory.ts). Runs as the agent, with the agent's environment (so
# GIT_CONFIG_* variables apply), and prints data only.
#
#   git-ctx.sh state <cwd> <git> [global options…]   branch, upstreams, push/alias config, read
#                                                     with the command's own -c/-C options
#   git-ctx.sh origin <bare repo> <git>               every ref of the bare origin (to observe
#                                                     whether a push really moved one)
mode=$1
if [ "$mode" = origin ]; then
  "$3" --git-dir="$2" for-each-ref --format='%(objectname) %(refname)' 2>/dev/null
  exit 0
fi
cd -- "$2" 2>/dev/null || exit 0
GIT=$3
shift 3
echo "@branch"
"$GIT" "$@" symbolic-ref --short -q HEAD 2>/dev/null
echo "@refs"
"$GIT" "$@" for-each-ref --format='%(refname:short) %(upstream:remotename) %(upstream:lstrip=3)' refs/heads 2>/dev/null
echo "@config"
"$GIT" "$@" config --get-regexp '^(push\.default|remote\.pushdefault|branch\..*\.pushremote|alias\..*)$' 2>/dev/null
exit 0
