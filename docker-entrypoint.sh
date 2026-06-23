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

echo ">>> Starting stream-proxy on port ${PORT:-3000}..."
exec node server.js
