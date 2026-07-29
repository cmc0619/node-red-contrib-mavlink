#!/usr/bin/env bash
# Opt-in Compose profile: install this package into /data then start Node-RED.
set -euo pipefail

MODULE_SRC="${MODULE_SRC:-/opt/node-red-contrib-mavlink}"
cd /data

if [[ ! -d node_modules/node-red-contrib-mavlink ]]; then
  echo "nodered: installing node-red-contrib-mavlink from ${MODULE_SRC}"
  npm install --unsafe-perm --no-fund --no-audit --install-links "${MODULE_SRC}"
fi

exec npm start --cache /data/.npm -- --userDir /data
