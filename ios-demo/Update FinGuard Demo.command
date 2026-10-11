#!/bin/zsh
set -eu
cd "${0:A:h}"
TASK_NODE="${STEWARD_NODE:-$(command -v node || true)}"
if [[ -z "$TASK_NODE" ]]; then
  TASK_NODE="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ ! -x "$TASK_NODE" ]]; then
  echo "Install Node.js 22 or newer before updating."
  exit 1
fi
if [[ ! -f ../web/node_modules/vite/bin/vite.js || ! -f node_modules/@capacitor/cli/bin/capacitor ]]; then
  echo "Install dependencies in web, server and ios-demo first (see README)."
  exit 1
fi
(cd ../web; "$TASK_NODE" node_modules/typescript/bin/tsc -b; "$TASK_NODE" node_modules/vite/bin/vite.js build)
"$TASK_NODE" prepare.mjs
"$TASK_NODE" node_modules/@capacitor/cli/bin/capacitor sync ios
echo "Ready: select your iPhone and own Team in Xcode, then press Run."
echo "Start FinGuard Demo.command starts the server on this Mac (STEWARD_OFFLINE=1: the isolated mock)."
