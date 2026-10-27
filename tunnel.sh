#!/usr/bin/env bash
# Plan B for HTTPS: a free Cloudflare quick tunnel, no account needed. Prints an https://….trycloudflare.com
# address that reaches server.mjs on this VM. The address changes every time you run this, and the tunnel
# stops when you close this window (or press Ctrl+C). Run ./setup.sh first so the server is running.
set -euo pipefail
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i /tmp/cloudflared.deb >/dev/null
fi
curl -sf http://127.0.0.1:8080/api/health >/dev/null || { echo "server.mjs isn't running: run ./setup.sh first"; exit 1; }
echo "Look for the line with https://….trycloudflare.com below: that is your server's address."
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8080
