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
# We use manual setup instead of wg-quick because the sysctl call
# for src_valid_mark always fails from inside a container, and wg-quick
# treats that as fatal (tears everything down).
if [ -f /etc/wireguard/wg0.conf ]; then
  echo ">>> Starting WireGuard tunnel inside container (manual setup)..."
  # Load config values
  PRIVATE_KEY=$(grep "^PrivateKey" /etc/wireguard/wg0.conf | awk '{print $3}')
  ADDRESS=$(grep "^Address" /etc/wireguard/wg0.conf | awk '{print $3}')
  MTU=$(grep "^MTU" /etc/wireguard/wg0.conf | awk '{print $3}')
  PEER_PUBKEY=$(grep "^PublicKey" /etc/wireguard/wg0.conf | awk '{print $3}')
  ENDPOINT=$(grep "^Endpoint" /etc/wireguard/wg0.conf | awk '{print $3}')
  KEEPALIVE=$(grep "^PersistentKeepalive" /etc/wireguard/wg0.conf | awk '{print $3}')
  # Create and configure the WireGuard interface
  ip link add wg0 type wireguard
  wg set wg0 private-key <(echo "$PRIVATE_KEY")
  wg set wg0 peer "$PEER_PUBKEY" endpoint "$ENDPOINT" persistent-keepalive "${KEEPALIVE:-25}" allowed-ips 0.0.0.0/0
  ip addr add "$ADDRESS" dev wg0
  ip link set mtu "${MTU:-1420}" up dev wg0
  # Route all container traffic through wg0 (only affects this container's netns)
  ip route del default 2>/dev/null || true
  ip route add default dev wg0
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
