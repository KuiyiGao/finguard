#!/bin/zsh
set -eu
cd "${0:A:h}"
TASK_NODE="${STEWARD_NODE:-$(command -v node || true)}"
if [[ -z "$TASK_NODE" ]]; then
  TASK_NODE="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ ! -x "$TASK_NODE" ]]; then
  echo "Node.js is missing. Install Node.js 22 or newer, then reopen this file."
  read -r
  exit 1
fi
if [[ "${STEWARD_OFFLINE:-}" == "1" ]]; then
  # Offline rehearsal only: the isolated mock API (no keys, no network) behind a static preview.
  if ! /usr/bin/curl -fsS --max-time 2 http://127.0.0.1:8799/api/health >/dev/null 2>&1; then
    nohup "$TASK_NODE" --import ../server/node_modules/tsx/dist/loader.mjs mock-server.mjs >api.log 2>&1 &
  fi
  if ! /usr/sbin/lsof -nP -iTCP:5190 -sTCP:LISTEN >/dev/null 2>&1; then
    (cd ../web; STEWARD_API=http://127.0.0.1:8799 nohup "$TASK_NODE" node_modules/vite/bin/vite.js preview --host 0.0.0.0 --port 5190 --strictPort >../ios-demo/web.log 2>&1 &)
  fi
  IOS_DEMO_PORT=5190 "$TASK_NODE" prepare.mjs
  open http://127.0.0.1:5190/console
  exit 0
fi
# The phone loads the team's server on port 8787: the same API, modes and keys as the desk and
# console (release/.env: Gemini agent, live Nessie reads, iMessage when configured).
if [[ ! -f ../web/dist/index.html ]]; then
  (cd ../web; "$TASK_NODE" node_modules/typescript/bin/tsc -b; "$TASK_NODE" node_modules/vite/bin/vite.js build)
fi
if ! /usr/bin/curl -fsS --max-time 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
  (cd ../server; nohup "$TASK_NODE" --import ./node_modules/tsx/dist/loader.mjs src/index.ts >../ios-demo/api.log 2>&1 &)
  sleep 3
fi
"$TASK_NODE" prepare.mjs
/usr/bin/curl -fsS --max-time 5 http://127.0.0.1:8787/api/health | /usr/bin/python3 -c 'import json,sys; m=json.load(sys.stdin).get("modes",{}); print("Server modes:", ", ".join(f"{k}={v}" for k,v in m.items()))' || echo "The server did not answer on port 8787; see api.log."
open http://127.0.0.1:8787/console
echo "Keep this Mac awake and on the same network as the iPhone (a Personal Hotspot works)."
