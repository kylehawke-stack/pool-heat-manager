#!/bin/bash
# Deploy pool-heat-manager to DigitalOcean
# Usage: ./deploy.sh
#
# Prerequisites on the DO server (one-time):
#   npm install -g pm2 tsx
#   mkdir -p /root/pool-heat-manager/logs

set -e

SERVER="root@your.server.ip"
REMOTE_DIR="/root/pool-heat-manager"

echo "=== Deploying pool-heat-manager ==="

# Sync files (exclude node_modules, .env stays on server)
echo "Syncing files..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'logs' \
  --exclude '.git' \
  /home/brady/pool-heat-manager/ \
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
