#!/bin/bash
set -e

# Start WireGuard inside the container if config is present
if [ -f /etc/wireguard/wg0.conf ]; then
  echo ">>> Starting WireGuard tunnel inside container (manual setup)..."
  PRIVATE_KEY=$(grep "^PrivateKey" /etc/wireguard/wg0.conf | awk '{print $3}')
  ADDRESS=$(grep "^Address" /etc/wireguard/wg0.conf | awk '{print $3}')
  MTU=$(grep "^MTU" /etc/wireguard/wg0.conf | awk '{print $3}')
  PEER_PUBKEY=$(grep "^PublicKey" /etc/wireguard/wg0.conf | awk '{print $3}')
  ENDPOINT=$(grep "^Endpoint" /etc/wireguard/wg0.conf | awk '{print $3}')
  KEEPALIVE=$(grep "^PersistentKeepalive" /etc/wireguard/wg0.conf | awk '{print $3}')
  ip link add wg0 type wireguard
  grep -v -E "^\s*(Address|DNS|MTU|Table|SaveConfig|PostUp|PreDown|PostDown|PreUp)\s*=" /etc/wireguard/wg0.conf > /tmp/wg_stripped.conf
  wg setconf wg0 /tmp/wg_stripped.conf
  ip addr add "$ADDRESS" dev wg0
  ip link set mtu "${MTU:-1420}" up dev wg0
  GW=$(ip route | grep "^default" | awk '{print $3}')
  WG_HOST=$(echo "$ENDPOINT" | cut -d: -f1)
  WG_IP=$(getent ahosts "$WG_HOST" 2>/dev/null | awk '{ if ($1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) print $1; }' | head -1)
  if [ -z "$WG_IP" ]; then
    WG_IP=$(getent hosts "$WG_HOST" 2>/dev/null | awk '{print $1}' | head -1)
  fi
  if [ -n "$WG_IP" ]; then
    ip route add "$WG_IP/32" via "$GW" 2>/dev/null || true
  fi
  ip route del default 2>/dev/null || true
  ip route add default dev wg0
  echo ">>> WireGuard is up — container traffic routed through VPN"
fi

# If PROXY_URL is set, configure proxychains
if [ -n "$PROXY_URL" ]; then
  PROTOCOL="${PROXY_URL%%://*}"
  PROXY_LINE="${PROXY_URL#*://}"
  case "$PROTOCOL" in
    socks5|socks5h) PROXY_TYPE="socks5" ;;
    socks4)         PROXY_TYPE="socks4" ;;
    http|https)     PROXY_TYPE="http" ;;
    *)              PROXY_TYPE="http" ;;
  esac
  echo ">>> Configuring proxychains with $PROTOCOL proxy..."
  sed -i "s|^# PROXY_URL.*|$PROXY_TYPE $PROXY_LINE|" /etc/proxychains4.conf
  LAUNCHER="proxychains4"
else
  LAUNCHER=""
fi

echo ">>> Starting stream-proxy on port ${PORT:-3000}..."

if [ -n "$LAUNCHER" ]; then
  exec $LAUNCHER -f /etc/proxychains4.conf node server.js
else
  exec node server.js
fi
