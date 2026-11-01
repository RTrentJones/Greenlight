#!/bin/sh
# What the git shim reports about the repository (the ShimContext inputs of
# packages/wiki/src/bench/trajectory.ts). Runs as the agent under the recorder's fixed BASE
# environment (the agent's own environment is reported separately, as the difference from that
# base, so `normalizeShimEvent` layers GIT_CONFIG_* and `-c` exactly as git does). Data only.
#
#   git-ctx.sh state <cwd> <git>          branch, upstreams and `git config --list`
#   git-ctx.sh origin <bare repo> <git>   every ref of the bare origin (did a push move one?)
mode=$1
if [ "$mode" = origin ]; then
  "$3" --git-dir="$2" for-each-ref --format='%(objectname) %(refname)' 2>/dev/null
  exit 0
fi
cd -- "$2" 2>/dev/null || exit 0
GIT=$3
echo "@branch"
"$GIT" symbolic-ref --short -q HEAD 2>/dev/null
echo "@refs"
"$GIT" for-each-ref --format='%(refname:short) %(upstream:remotename) %(upstream:lstrip=3)' refs/heads 2>/dev/null
echo "@config"
"$GIT" config --list 2>/dev/null
exit 0
