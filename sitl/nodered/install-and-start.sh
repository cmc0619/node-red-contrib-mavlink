#!/usr/bin/env bash
# Opt-in Compose profile: install this package into /data then start Node-RED.
# Uses the image's app directory (has the "start" script); userDir stays /data.
set -euo pipefail

MODULE_SRC="${MODULE_SRC:-/opt/node-red-contrib-mavlink}"
USER_DIR="${USER_DIR:-/data}"
APP_DIR="${NODE_RED_APP_DIR:-/usr/src/node-red}"

mkdir -p "${USER_DIR}"
cd "${USER_DIR}"

if [[ ! -d node_modules/node-red-contrib-mavlink ]]; then
  echo "nodered: installing node-red-contrib-mavlink from ${MODULE_SRC}"
  npm install --unsafe-perm --no-fund --no-audit --install-links "${MODULE_SRC}"
fi

cd "${APP_DIR}"
exec npm start --cache "${USER_DIR}/.npm" -- --userDir "${USER_DIR}"
