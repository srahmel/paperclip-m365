#!/bin/sh
set -eu

fail() { printf '%s\n' "isolation gate: $*" >&2; exit 1; }
[ "$#" -eq 6 ] || fail "usage: run-gate.sh MODE REPO SOURCE TARBALLS PACKAGES NODE_ROOT"
mode=$1 repo=$2 source=$3 tarballs=$4 packages=$5 node_root=$6
[ -x "$node_root/bin/node" ] || fail "pinned Linux Node toolchain missing"
[ "$("$node_root/bin/node" --version)" = "v24.22.1" ] || fail "Node version mismatch"
command -v bwrap >/dev/null || fail "bubblewrap is unavailable"
command -v prlimit >/dev/null || fail "prlimit is unavailable"
command -v timeout >/dev/null || fail "timeout is unavailable"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/wp01-gate-XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM

exec timeout --signal=KILL 180s prlimit --cpu=150 --as=3221225472 --nproc=128 --nofile=4096 --fsize=1073741824 -- \
  bwrap --die-with-parent --new-session --unshare-user --unshare-pid --unshare-net --unshare-ipc --unshare-uts \
  --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --dir /tmp/wp01-scratch --bind "$scratch" /tmp/wp01-scratch \
  --clearenv --setenv PATH "$node_root/bin:/usr/bin:/bin" \
  --setenv TMPDIR /tmp/wp01-scratch --setenv HOME /tmp/wp01-scratch/home --setenv WP01_GATE_SCRATCH /tmp/wp01-scratch/tests \
  --setenv WP01_GATE_SOURCE "$source" --setenv WP01_GATE_TARBALLS "$tarballs" --setenv WP01_GATE_PACKAGES "$packages" \
  --chdir "$repo" "$node_root/bin/node" $([ "$mode" = selftest ] && printf '%s' '--test experiments/wp00/gate-self-test.mjs' || printf '%s' 'experiments/wp00/gate-run.mjs')
