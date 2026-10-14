#!/bin/sh
# Launcher for skill-usage-hook.mjs (macOS / Linux / WSL).
# Order: node on PATH -> fnm default alias -> common install locations.
# When no node is found the launcher exits quietly: a missing runtime must
# never break a tool call.
#
# CLI passthrough: skill-usage-hook.mjs --check / --discover / --stats
set -u
HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOOK="$HOOK_DIR/skill-usage-hook.mjs"

if command -v node >/dev/null 2>&1; then
  NODE=$(command -v node)
elif [ -x "$HOME/.local/share/fnm/aliases/default/bin/node" ]; then
  NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
elif [ -x "$HOME/.nvm/versions/node/current/bin/node" ]; then
  NODE="$HOME/.nvm/versions/node/current/bin/node"
elif [ -x /usr/local/bin/node ]; then
  NODE=/usr/local/bin/node
elif [ -x /opt/homebrew/bin/node ]; then
  NODE=/opt/homebrew/bin/node
else
  exit 0
fi

exec "$NODE" --no-warnings "$HOOK" "$@"
