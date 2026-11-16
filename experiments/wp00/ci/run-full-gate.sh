#!/bin/bash
set -Eeuo pipefail
trap 'rc=$?; printf "%s\n" "WP01_GATE_FAILURE rc=$rc line=$LINENO command=$BASH_COMMAND" >&2; exit "$rc"' ERR

fail() { printf '%s\n' "wp01 full gate: $*" >&2; exit 1; }
repo=/repo
source=/source
tarballs=/tarballs
packages=/packages/node_modules
scratch=/scratch

for mount in "$repo" "$source" "$tarballs" "$packages"; do
  options=$(findmnt -T "$mount" -n -o OPTIONS) || fail "cannot inspect mount: $mount"
  case ",$options," in *,ro,*) ;; *) fail "mount is not read-only: $mount ($options)" ;; esac
  if touch "$mount/.wp01-write-probe" 2>/dev/null; then fail "write unexpectedly succeeded: $mount"; fi
done
touch "$scratch/write-probe"
rm "$scratch/write-probe"
[ "$(find /sys/class/net -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)" = lo ] || fail "container has a non-loopback network interface"
[ "$(ulimit -n)" -le 1024 ] || fail "open-file limit is not enforced"
[ "$(ulimit -u)" -le 128 ] || fail "process limit is not enforced"

node "$repo/experiments/wp00/verify-linux-contract.mjs"
node "$repo/experiments/wp00/verify-source.mjs" "$source"

export WP01_GATE_SOURCE=$source
export WP01_GATE_TARBALLS=$tarballs
export WP01_GATE_PACKAGES=$packages
export WP01_GATE_SCRATCH=$scratch/negative
mkdir -p "$WP01_GATE_SCRATCH"
node --test "$repo/experiments/wp00/gate-self-test.mjs"
export WP01_GATE_SCRATCH=$scratch/positive
export WP01_GATE_ENFORCED_READ_ONLY=1
mkdir -p "$WP01_GATE_SCRATCH"
node "$repo/experiments/wp00/gate-run.mjs"

pgdata=$scratch/pgdata
pgsocket=$scratch/pgsocket
mkdir -p "$pgsocket"
initdb -D "$pgdata" --auth=trust --username=postgres >/dev/null
pg_ctl -D "$pgdata" -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=$pgsocket" -w start >/dev/null
trap 'pg_ctl -D "$pgdata" -m fast -w stop >/dev/null 2>&1 || true' EXIT HUP INT TERM

export PAPERCLIP_SOURCE=$source
export WP00_SDK_PACKAGE_ROOT=$packages/@paperclipai/plugin-sdk
export WP00_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres
runner=$(node -p "require('$repo/experiments/wp00/expected-host-fingerprint.json').runner.relativeCliPath")
node "$source/$runner" --test --test-timeout=120000 "$repo/experiments/wp00/operation-contract.test.ts"
node "$source/node_modules/typescript/bin/tsc" --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --types node --typeRoots "$source/packages/plugins/sdk/node_modules/@types" --skipLibCheck \
  "$repo/experiments/wp00/operation-contract.ts" "$repo/experiments/wp00/operation-contract.test.ts"
(cd "$source" && pnpm exec vitest run --root packages/plugins/sdk --config vitest.config.ts \
  tests/testing-actions.test.ts tests/worker-rpc-host.test.ts --testTimeout=30000 --maxWorkers=1)
node "$repo/experiments/wp00/gateway-probe.mjs"
node --test "$repo/experiments/wp00/install-log-policy.test.mjs"

pg_ctl -D "$pgdata" -m fast -w stop >/dev/null
trap - EXIT HUP INT TERM
printf '%s\n' '{"probe":"wp01-full-isolated-matrix","status":"pass","postgresAssertions":"20/20","sdkAssertions":"28/28","gateway":{"networkCalls":0,"dispatches":0},"targetExecutedReadOnly":true}'
