#!/bin/bash
set -Eeuo pipefail

fail() { printf '%s\n' "wp01 setup: $*" >&2; exit 1; }
[ "$#" -eq 2 ] || fail "usage: setup.sh REPO WORK"
repo=$1
work=$2
source=$work/source
store=$work/pnpm-store
cache=$work/npm-cache
tarballs=$work/tarballs
packages=$work/packages/node_modules
readonly_empty=$work/readonly-empty
log=$work/fresh-install.log

[ ! -e "$source" ] || fail "source path is not fresh: $source"
[ ! -e "$store" ] || fail "pnpm store is not fresh: $store"
[ ! -e "$cache" ] || fail "npm cache is not fresh: $cache"
mkdir -p "$work" "$store" "$cache" "$tarballs" "$packages" "$readonly_empty"

git init -q "$source"
git -C "$source" remote add origin https://github.com/paperclipai/paperclip.git
git -C "$source" fetch --depth=1 origin d69631b01b9c658f80bf8bed389863dce82643e1
git -C "$source" checkout -q --detach FETCH_HEAD
git -C "$source" fetch --depth=1 origin refs/tags/v2026.1106.0:refs/tags/v2026.1106.0
node "$repo/experiments/wp00/verify-source.mjs" "$source"

export npm_config_cache=$cache
export npm_config_devdir=$work/node-gyp
pnpm install --dir "$source" --frozen-lockfile --store-dir "$store" 2>&1 | tee "$log"
node "$repo/experiments/wp00/install-log-policy.mjs" "$log" "$source/pnpm-lock.yaml"
node "$repo/experiments/wp00/verify-source.mjs" "$source"

npm pack @paperclipai/plugin-sdk@2026.1106.0 --pack-destination "$tarballs" --ignore-scripts
npm pack @paperclipai/shared@2026.1106.0 --pack-destination "$tarballs" --ignore-scripts
npm pack zod@4.6.7 --pack-destination "$tarballs" --ignore-scripts
npm pack three@0.185.1 --pack-destination "$tarballs" --ignore-scripts
node "$repo/experiments/wp00/prepare-artifacts.mjs" "$tarballs" "$packages"
chmod 0555 "$readonly_empty"

printf '%s\n' '{"probe":"wp01-ci-setup","status":"pass","sourceInstall":"fresh","pnpmStore":"fresh","npmCache":"fresh"}'
