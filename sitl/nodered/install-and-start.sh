#!/usr/bin/env bash
# Opt-in Compose profile: install this package into /data then start Node-RED.
# Uses the image's app directory (has the "start" script); userDir stays /data.
# Always reinstalls the package — /data is persistent and --install-links copies
# the tree, so an existence check would leave a stale or partial install.
set -euo pipefail

MODULE_SRC="${MODULE_SRC:-/opt/node-red-contrib-mavlink}"
USER_DIR="${USER_DIR:-/data}"
APP_DIR="${NODE_RED_APP_DIR:-/usr/src/node-red}"

mkdir -p "${USER_DIR}"
cd "${USER_DIR}"

echo "nodered: installing @cmc0619/node-red-contrib-mavlink from ${MODULE_SRC}"

# Migration: a nodered-data volume created before the @cmc0619 scope still lists
# the unscoped package in /data/package.json. Deleting only the directory leaves
# that dependency entry behind, so the install below re-fetches it and Node-RED
# then finds two modules defining the same thirteen node types — it warns
# "'mavlink-in' already registered by module @cmc0619/..." once per node on every
# start and keeps a stale copy in /data. `npm uninstall` drops the entry and the
# tree together. It exits non-zero when the dependency is absent, which is the
# normal case on a fresh volume, so it must not trip `set -e`.
npm uninstall --unsafe-perm --no-fund --no-audit node-red-contrib-mavlink || true

rm -rf node_modules/@cmc0619/node-red-contrib-mavlink
npm install --unsafe-perm --no-fund --no-audit --install-links "${MODULE_SRC}"

cd "${APP_DIR}"
exec npm start --cache "${USER_DIR}/.npm" -- --userDir "${USER_DIR}"
