#!/bin/bash
set -e

REPO_URL="https://github.com/oldhunterr/stream-proxy.git"
APP_DIR="/app"

if [ -d "$APP_DIR/.git" ]; then
  echo ">>> Repo exists — pulling latest..."
  cd "$APP_DIR"
  git pull
else
  echo ">>> Cloning repo from $REPO_URL ..."
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo ">>> Installing dependencies..."
npm install

# Start WireGuard inside the container if config is present
if [ -f /etc/wireguard/wg0.conf ]; then
  echo ">>> Starting WireGuard tunnel inside container..."
  wg-quick up wg0 2>&1 | grep -v "^\[#\]"
  echo ">>> WireGuard is up — container traffic routed through VPN"
fi

# If PROXY_URL is set, write it into proxychains config and wrap node
if [ -n "$PROXY_URL" ]; then
  # Format: socks5://user:pass@host:port  or  http://host:port
  PROXY_LINE="${PROXY_URL#*://}"
  PROTOCOL="${PROXY_URL%%://*}"
  # Map protocol to proxychains format
  case "$PROTOCOL" in
    socks5|socks5h) PROXY_TYPE="socks5" ;;
    socks4)         PROXY_TYPE="socks4" ;;
    http|https)     PROXY_TYPE="http" ;;
    *)              PROXY_TYPE="http" ;;
  esac
  echo ">>> Configuring proxychains with $PROTOCOL proxy..."
  # Replace the placeholder line in proxychains config
  sed -i "s|^# PROXY_URL.*|$PROXY_TYPE $PROXY_LINE|" /etc/proxychains4.conf
  LAUNCHER="proxychains4"
else
  LAUNCHER=""
fi

echo ">>> Starting stream-proxy on port ${PORT:-3000}..."

if [ -n "$LAUNCHER" ]; then
  echo ">>> (routing through $PROTOCOL proxy)"
  exec $LAUNCHER -f /etc/proxychains4.conf node server.js
else
  exec node server.js
fi
