#!/bin/bash
# ============================================================================
# Expense Bot — EC2 One-Time Provisioning Script
# Run as root (or with sudo) on a fresh Ubuntu 24.04 LTS t3.micro instance.
# ============================================================================
set -euo pipefail

APP_USER="expensebot"
APP_DIR="/opt/expense-bot"
REPO_URL="${1:?Usage: $0 <git-repo-url>}"

echo "============================================"
echo "  Expense Bot — EC2 Setup"
echo "============================================"

# --------------------------------------------------
# 1. System updates & essential packages
# --------------------------------------------------
echo "[1/8] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  curl wget git unzip build-essential software-properties-common \
  ufw fail2ban unattended-upgrades

# --------------------------------------------------
# 2. Enable automatic security updates
# --------------------------------------------------
echo "[2/8] Enabling unattended security upgrades..."
cat > /etc/apt/apt.conf.d/20auto-upgrades <<EOF
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

# --------------------------------------------------
# 3. Install Node.js 20 LTS
# --------------------------------------------------
echo "[3/8] Installing Node.js 20 LTS..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node.js $(node -v) installed"

# --------------------------------------------------
# 4. Install Python 3.11+ & pip
# --------------------------------------------------
echo "[4/8] Installing Python 3..."
apt-get install -y -qq python3 python3-pip python3-venv
echo "  Python $(python3 --version) installed"

# --------------------------------------------------
# 5. Install AWS CLI v2 (for SSM Parameter Store access)
# --------------------------------------------------
echo "[5/8] Installing AWS CLI v2..."
if ! command -v aws &>/dev/null; then
  TMPDIR=$(mktemp -d)
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "$TMPDIR/awscliv2.zip"
  unzip -q "$TMPDIR/awscliv2.zip" -d "$TMPDIR"
  "$TMPDIR/aws/install" --update
  rm -rf "$TMPDIR"
fi
echo "  AWS CLI $(aws --version) installed"

# --------------------------------------------------
# 6. Create dedicated application user
# --------------------------------------------------
echo "[6/8] Creating application user '${APP_USER}'..."
if ! id "$APP_USER" &>/dev/null; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

# --------------------------------------------------
# 7. Clone repository & install dependencies
# --------------------------------------------------
echo "[7/8] Cloning repository and installing dependencies..."
if [ ! -d "$APP_DIR" ]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  echo "  $APP_DIR already exists, pulling latest..."
  cd "$APP_DIR" && git pull origin main
fi

chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# Node.js dependencies (MCP server)
echo "  Installing Node.js dependencies..."
cd "$APP_DIR/mcp"
sudo -u "$APP_USER" npm ci --production

# Python virtual environment & dependencies
echo "  Creating Python virtual environment..."
cd "$APP_DIR"
python3 -m venv venv
chown -R "$APP_USER":"$APP_USER" venv
echo "  Installing Python dependencies into venv..."
sudo -u "$APP_USER" "$APP_DIR/venv/bin/pip" install -r requirements.txt --quiet

# --------------------------------------------------
# 8. Configure UFW firewall
# --------------------------------------------------
echo "[8/8] Configuring UFW firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw --force enable
echo "  UFW enabled: deny all inbound except SSH"

# --------------------------------------------------
# Install systemd service files
# --------------------------------------------------
echo "Installing systemd services..."
cp "$APP_DIR/deploy/expense-secrets.service"  /etc/systemd/system/
cp "$APP_DIR/deploy/expense-mcp.service"      /etc/systemd/system/
cp "$APP_DIR/deploy/expense-adk.service"      /etc/systemd/system/
cp "$APP_DIR/deploy/expense-telegram.service" /etc/systemd/system/

# Make fetch-secrets.sh executable
chmod +x "$APP_DIR/deploy/fetch-secrets.sh"
chmod +x "$APP_DIR/deploy/deploy.sh"

systemctl daemon-reload
systemctl enable expense-secrets expense-mcp expense-adk expense-telegram

echo ""
echo "============================================"
echo "  ✅ EC2 Setup Complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Store secrets in SSM Parameter Store:"
echo "     aws ssm put-parameter --name '/expense-bot/prod/DATABASE_URL' --type SecureString --value '<value>'"
echo "     aws ssm put-parameter --name '/expense-bot/prod/GOOGLE_API_KEY' --type SecureString --value '<value>'"
echo "     aws ssm put-parameter --name '/expense-bot/prod/TELEGRAM_BOT_TOKEN' --type SecureString --value '<value>'"
echo "     aws ssm put-parameter --name '/expense-bot/prod/OPENAI_API_KEY' --type SecureString --value '<value>'"
echo "     aws ssm put-parameter --name '/expense-bot/prod/GOOGLE_GENAI_USE_VERTEXAI' --type SecureString --value '<value>'"
echo ""
echo "  2. Start all services:"
echo "     sudo systemctl start expense-secrets"
echo "     sudo systemctl start expense-mcp"
echo "     sleep 3"
echo "     sudo systemctl start expense-adk"
echo "     sleep 3"
echo "     sudo systemctl start expense-telegram"
echo ""
echo "  3. Check status:"
echo "     sudo systemctl status expense-mcp expense-adk expense-telegram"
echo "     journalctl -u expense-mcp -u expense-adk -u expense-telegram -f"
