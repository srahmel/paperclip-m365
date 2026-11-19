#!/bin/bash
set -Eeuo pipefail

fail() { printf '%s\n' "wp01 setup: $*" >&2; exit 1; }
[ "$#" -eq 3 ] || fail "usage: setup.sh REPO WORK SOURCE_REVISION"
repo=$1
work=$2
source_revision=$3
source=$work/source
store=$work/pnpm-store
cache=$work/npm-cache
tarballs=$work/tarballs
packages=$work/packages/node_modules
plugin=$work/plugin
plugin_cache=$work/plugin-npm-cache
plugin_install=$work/plugin-installed
plugin_artifact_dir=$work/plugin-artifact
plugin_manifest=$plugin_artifact_dir/package-manifest.json
readonly_empty=$work/readonly-empty
log=$work/fresh-install.log
plugin_log=$work/plugin-verify.log

[ ! -e "$source" ] || fail "source path is not fresh: $source"
[ ! -e "$store" ] || fail "pnpm store is not fresh: $store"
[ ! -e "$cache" ] || fail "npm cache is not fresh: $cache"
[ ! -e "$plugin" ] || fail "plugin build path is not fresh: $plugin"
[ ! -e "$plugin_cache" ] || fail "plugin npm cache is not fresh: $plugin_cache"
[ ! -e "$plugin_install" ] || fail "plugin install path is not fresh: $plugin_install"
[ ! -e "$plugin_artifact_dir" ] || fail "plugin artifact path is not fresh: $plugin_artifact_dir"
mkdir -p "$work" "$store" "$cache" "$tarballs" "$packages" "$plugin" "$plugin_cache" "$plugin_install" "$plugin_artifact_dir" "$readonly_empty"

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

(cd "$repo" && tar --exclude=.git --exclude=node_modules --exclude=dist --exclude='*.tgz' -cf - .) \
  | tar -xf - -C "$plugin"
(
  cd "$plugin"
  npm ci --ignore-scripts --cache "$plugin_cache"
  WP01_SOURCE_REVISION="$source_revision" WP01_PACKAGE_MANIFEST="$plugin_manifest" \
    npm run verify 2>&1 | tee "$plugin_log"
)
plugin_artifact=$plugin/paperclip-plugin-m365-0.1.0.tgz
[ -f "$plugin_artifact" ] || fail "verified plugin artifact is missing"
node "$repo/scripts/package-integrity.mjs" verify \
  "$plugin_artifact" "$plugin_manifest" "$source_revision" install
npm install --prefix "$plugin_install" --ignore-scripts --cache "$plugin_cache" "$plugin_artifact"
test -f "$plugin_install/node_modules/paperclip-plugin-m365/dist/manifest.js"
test -f "$plugin_install/node_modules/paperclip-plugin-m365/dist/worker.js"
test -f "$plugin_install/node_modules/paperclip-plugin-m365/dist/ui/index.js"
cp "$plugin_artifact" "$plugin_artifact_dir/paperclip-plugin-m365-0.1.0.tgz"
chmod 0555 "$readonly_empty"

printf '%s\n' "{\"probe\":\"wp01-ci-setup\",\"status\":\"pass\",\"sourceRevision\":\"$source_revision\",\"pnpmStore\":\"fresh\",\"npmCache\":\"fresh\",\"pluginInstall\":\"digest-verified-packed-artifact\"}"
