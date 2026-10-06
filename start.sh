#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v node >/dev/null 2>&1 || { echo 'Install Node.js 22.13+ from https://nodejs.org'; exit 1; }
if [ ! -f dist/client/index.html ] || [ ! -d node_modules ]; then node scripts/setup.mjs; fi
exec npm start
