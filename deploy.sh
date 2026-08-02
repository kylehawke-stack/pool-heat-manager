#!/bin/bash
# Deploy pool-heat-manager to a server via rsync + PM2
# Usage: ./deploy.sh
#
# Configure the target in .deploy.env (gitignored), e.g.:
#   DEPLOY_SERVER=root@your.server.ip
#   DEPLOY_REMOTE_DIR=/root/pool-heat-manager   # optional
#
# Prerequisites on the server (one-time):
#   npm install -g pm2 tsx
#   mkdir -p /root/pool-heat-manager/logs

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "${SCRIPT_DIR}/.deploy.env" ] && source "${SCRIPT_DIR}/.deploy.env"

SERVER="${DEPLOY_SERVER:?Set DEPLOY_SERVER (e.g. root@your.server.ip) in .deploy.env or the environment}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/root/pool-heat-manager}"

echo "=== Deploying pool-heat-manager to ${SERVER} ==="

# Sync files (exclude node_modules; .env and data/ stay on server)
echo "Syncing files..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '.deploy.env' \
  --exclude 'logs' \
  --exclude '.git' \
  --exclude 'data' \
  "${SCRIPT_DIR}/" \
  ${SERVER}:${REMOTE_DIR}/

# Install deps and restart
echo "Installing dependencies and restarting..."
ssh ${SERVER} << 'EOF'
  cd /root/pool-heat-manager
  npm ci --production=false

  # Start or restart with PM2
  pm2 describe pool-heat-manager > /dev/null 2>&1 && \
    pm2 restart pool-heat-manager || \
    pm2 start ecosystem.config.cjs

  # Save PM2 config so it survives reboots
  pm2 save

  echo ""
  echo "=== Status ==="
  pm2 status pool-heat-manager
EOF

echo ""
echo "=== Deploy complete ==="
echo "Health check: ssh ${SERVER} 'curl -s http://localhost:3100/health | jq'"
echo "Logs: ssh ${SERVER} 'pm2 logs pool-heat-manager'"
