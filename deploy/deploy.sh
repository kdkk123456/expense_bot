#!/bin/bash
# ============================================================================
# Expense Bot — Deployment Script
# Run on the EC2 instance to pull latest code and restart all services.
# Idempotent — safe to run multiple times.
# ============================================================================
set -euo pipefail

APP_DIR="/opt/expense-bot"

echo "============================================"
echo "  Expense Bot — Deploying..."
echo "============================================"

# --------------------------------------------------
# 1. Pull latest code
# --------------------------------------------------
echo "[1/4] Pulling latest code..."
cd "$APP_DIR"
git pull origin main

# --------------------------------------------------
# 2. Install/update dependencies
# --------------------------------------------------
echo "[2/4] Installing Node.js dependencies..."
cd "$APP_DIR/mcp"
npm ci --production --quiet

echo "[2/4] Installing Python dependencies..."
cd "$APP_DIR"
/opt/expense-bot/venv/bin/pip install -r requirements.txt --quiet

# Pulling/installing as root leaves new files root-owned; the services run
# as 'expensebot' and must be able to write runtime dirs (e.g. ADK's .adk
# session store inside the agent package). Re-assert ownership after pull.
echo "      Fixing ownership for expensebot user..."
sudo chown -R expensebot:expensebot "$APP_DIR"

# The shell scripts must stay executable; a git checkout/restore can drop the
# bit, which makes systemd's ExecStart fail with 203/EXEC.
sudo chmod +x "$APP_DIR"/deploy/*.sh

# --------------------------------------------------
# 3. Reload systemd (in case service files changed)
# --------------------------------------------------
echo "[3/4] Reloading systemd..."
sudo cp "$APP_DIR/deploy/expense-secrets.service"  /etc/systemd/system/
sudo cp "$APP_DIR/deploy/expense-mcp.service"      /etc/systemd/system/
sudo cp "$APP_DIR/deploy/expense-adk.service"      /etc/systemd/system/
sudo cp "$APP_DIR/deploy/expense-telegram.service" /etc/systemd/system/
sudo systemctl daemon-reload

# --------------------------------------------------
# 4. Restart services in dependency order
# --------------------------------------------------
echo "[4/4] Restarting services..."

sudo systemctl restart expense-secrets
echo "  ✅ Secrets fetched"

sudo systemctl restart expense-mcp
echo "  ⏳ Waiting for MCP server to bind..."
sleep 3

sudo systemctl restart expense-adk
echo "  ⏳ Waiting for ADK runner to bind..."
sleep 3

sudo systemctl restart expense-telegram
echo "  ✅ Telegram bot started"

# --------------------------------------------------
# Status check
# --------------------------------------------------
echo ""
echo "============================================"
echo "  Service Status"
echo "============================================"
sudo systemctl is-active expense-mcp expense-adk expense-telegram || true
echo ""
sudo systemctl status expense-mcp expense-adk expense-telegram --no-pager -l || true

echo ""
echo "============================================"
echo "  ✅ Deployment Complete!"
echo "============================================"
echo ""
echo "Tail logs with:"
echo "  journalctl -u expense-mcp -u expense-adk -u expense-telegram -f"
