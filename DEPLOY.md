# Expense Bot — AWS EC2 Deployment Guide

End-to-end guide for deploying the Expense Bot (MCP Server + ADK Agent + Telegram Bot) on a hardened AWS EC2 instance.

---

## Architecture

```
Telegram User ──HTTPS──► Telegram API ◄──long-poll──┐
                                                     │
              ┌──────── EC2 Instance ────────────┐   │
              │                                  │   │
              │  ┌─────────────────────────────┐ │   │
              │  │  Telegram Bot (Python)       │◄┘   │
              │  │  outbound only, no ports     │     │
              │  └──────────┬──────────────────┘ │   │
              │             │ localhost:8000      │   │
              │  ┌──────────▼──────────────────┐ │   │
              │  │  ADK Runner (Python/Gemini) │ │   │
              │  │  127.0.0.1:8000             │ │   │
              │  └──────────┬──────────────────┘ │   │
              │             │ localhost:6666      │   │
              │  ┌──────────▼──────────────────┐ │   │
              │  │  MCP Server (Node.js)       │ │   │
              │  │  127.0.0.1:6666             │ │   │
              │  └──────────┬──────────────────┘ │   │
              └─────────────┼────────────────────┘   │
                            │ SSL                     │
                   ┌────────▼────────┐                │
                   │ Supabase Postgres│               │
                   │ (ERP Database)   │               │
                   └─────────────────┘
```

**Key security property:** Zero inbound HTTP/HTTPS ports. The Telegram bot uses long-polling (outbound only). MCP and ADK are bound to `127.0.0.1` — invisible from the internet.

---

## Prerequisites

- An **AWS account**
- **AWS CLI v2** installed locally (`brew install awscli` or [install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html))
- A **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)
- A **Google Gemini API Key**
- Your **Supabase DATABASE_URL**

---

## Step 1: Configure AWS CLI

Login via AWS Identity Center (recommended) or configure with access keys:

```bash
# Option A: Browser-based login (SSO)
aws login

# Option B: Access key based
aws configure
# Enter: Access Key ID, Secret Access Key, Region (ap-south-1), Output format (json)
```

Verify identity:

```bash
aws sts get-caller-identity
```

### Required IAM Permissions

The IAM user/role you use locally needs these policies:
- `AmazonEC2FullAccess`
- `AmazonSSMFullAccess`
- `IAMFullAccess` (only needed during initial setup, can be removed after)

---

## Step 2: Create AWS Resources

### 2.1 Create Key Pair

```bash
aws ec2 create-key-pair \
  --key-name expense-bot-key \
  --query 'KeyMaterial' \
  --output text > ~/.ssh/expense-bot-key.pem

chmod 400 ~/.ssh/expense-bot-key.pem
```

> ⚠️ **Keep this file safe.** Anyone with this file can SSH into your server. Share it with team members securely (password manager, not Slack/email).

### 2.2 Create Security Group

```bash
# Create the group
aws ec2 create-security-group \
  --group-name expense-bot-sg \
  --description "Expense Bot EC2"

# Allow SSH from anywhere (team access)
aws ec2 authorize-security-group-ingress \
  --group-name expense-bot-sg \
  --protocol tcp --port 22 --cidr 0.0.0.0/0
```

> **Tip:** For tighter security, replace `0.0.0.0/0` with your office IP: `--cidr <YOUR_IP>/32`. Find your IP with `curl -s https://checkip.amazonaws.com`.

### 2.3 Create IAM Role for EC2 (SSM Access)

This allows the EC2 instance to read secrets from AWS SSM Parameter Store without storing AWS credentials on the server.

```bash
# Step 1: Create the role
aws iam create-role \
  --role-name expense-bot-ssm-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Step 2: Attach SSM read permission
aws iam attach-role-policy \
  --role-name expense-bot-ssm-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess

# Step 3: Create instance profile wrapper
aws iam create-instance-profile \
  --instance-profile-name expense-bot-ssm-role

# Step 4: Link role to instance profile
aws iam add-role-to-instance-profile \
  --instance-profile-name expense-bot-ssm-role \
  --role-name expense-bot-ssm-role
```

### 2.4 Store Secrets in SSM Parameter Store

```bash
aws ssm put-parameter \
  --name '/expense-bot/prod/DATABASE_URL' \
  --type SecureString \
  --value 'postgresql://...'

aws ssm put-parameter \
  --name '/expense-bot/prod/GOOGLE_API_KEY' \
  --type SecureString \
  --value 'AIza...'

aws ssm put-parameter \
  --name '/expense-bot/prod/TELEGRAM_BOT_TOKEN' \
  --type SecureString \
  --value '123456:ABC...'

aws ssm put-parameter \
  --name '/expense-bot/prod/OPENAI_API_KEY' \
  --type SecureString \
  --value 'sk-...'

aws ssm put-parameter \
  --name '/expense-bot/prod/GOOGLE_GENAI_USE_VERTEXAI' \
  --type SecureString \
  --value 'false'
```

To update an existing secret, add `--overwrite`:

```bash
aws ssm put-parameter \
  --name '/expense-bot/prod/GOOGLE_API_KEY' \
  --type SecureString \
  --value 'NEW_VALUE' \
  --overwrite
```

---

## Step 3: Launch EC2 Instance

### 3.1 Get the Latest Ubuntu 24.04 AMI

```bash
AMI_ID=$(aws ssm get-parameter \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --region ap-south-1 \
  --query "Parameter.Value" \
  --output text)

echo "Using AMI: $AMI_ID"
```

### 3.2 Launch the Instance

```bash
aws ec2 run-instances \
  --image-id $AMI_ID \
  --instance-type t3.micro \
  --key-name expense-bot-key \
  --security-groups expense-bot-sg \
  --iam-instance-profile Name=expense-bot-ssm-role \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=expense-bot}]' \
  --query "Instances[0].[InstanceId,State.Name]" \
  --output table
```

### 3.3 Get the Public IP

Wait ~30 seconds for the instance to boot, then:

```bash
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=expense-bot" "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].PublicIpAddress" \
  --output text
```

---

## Step 4: Provision the Server

### 4.1 SSH In

```bash
ssh -i ~/.ssh/expense-bot-key.pem ubuntu@<EC2_PUBLIC_IP>
```

### 4.2 Clone and Run Setup Script

```bash
# Clone repo to temp location
git clone https://github.com/kdkk123456/expense_bot.git /tmp/expense-bot

# Run the provisioning script
sudo bash /tmp/expense-bot/deploy/setup-ec2.sh https://github.com/kdkk123456/expense_bot.git

# Clean up temp clone
rm -rf /tmp/expense-bot
```

**If the setup script fails at pip install** (Ubuntu 24.04 PEP 668), complete manually:

```bash
cd /opt/expense-bot && sudo git pull origin main
sudo python3 -m venv /opt/expense-bot/venv
sudo chown -R expensebot:expensebot /opt/expense-bot/venv
sudo -u expensebot /opt/expense-bot/venv/bin/pip install -r /opt/expense-bot/requirements.txt
sudo ufw --force reset && sudo ufw default deny incoming && sudo ufw default allow outgoing && sudo ufw allow ssh && sudo ufw --force enable
sudo cp /opt/expense-bot/deploy/expense-*.service /etc/systemd/system/
sudo chmod +x /opt/expense-bot/deploy/fetch-secrets.sh /opt/expense-bot/deploy/deploy.sh
sudo systemctl daemon-reload
sudo systemctl enable expense-secrets expense-mcp expense-adk expense-telegram
```

---

## Step 5: Start Services

```bash
# Fetch secrets from SSM
sudo systemctl start expense-secrets

# Start MCP server (wait for it to bind)
sudo systemctl start expense-mcp
sleep 3

# Start ADK runner (wait for it to bind)
sudo systemctl start expense-adk
sleep 3

# Start Telegram bot
sudo systemctl start expense-telegram
```

### Verify All Running

```bash
sudo systemctl status expense-mcp expense-adk expense-telegram --no-pager
```

Expected output: all three should show `active (running)`.

---

## Day-to-Day Operations

### View Logs

```bash
# Follow all service logs
journalctl -u expense-mcp -u expense-adk -u expense-telegram -f

# View a specific service's logs
journalctl -u expense-mcp -n 50 --no-pager
journalctl -u expense-adk -n 50 --no-pager
journalctl -u expense-telegram -n 50 --no-pager
```

### Deploy Code Updates

After pushing changes to the `main` branch:

```bash
ssh -i ~/.ssh/expense-bot-key.pem ubuntu@<EC2_PUBLIC_IP>
sudo bash /opt/expense-bot/deploy/deploy.sh
```

Or manually:

```bash
cd /opt/expense-bot
sudo git pull origin main
sudo systemctl restart expense-mcp
sleep 3
sudo systemctl restart expense-adk
sleep 3
sudo systemctl restart expense-telegram
```

### Restart a Single Service

```bash
sudo systemctl restart expense-mcp       # MCP server
sudo systemctl restart expense-adk       # ADK runner
sudo systemctl restart expense-telegram  # Telegram bot
```

### Stop All Services

```bash
sudo systemctl stop expense-telegram expense-adk expense-mcp
```

### Update a Secret

```bash
# From your local machine:
aws ssm put-parameter \
  --name '/expense-bot/prod/GOOGLE_API_KEY' \
  --type SecureString \
  --value 'NEW_VALUE' \
  --overwrite

# Then on the EC2 server, reload secrets and restart:
sudo systemctl restart expense-secrets
sudo systemctl restart expense-mcp expense-adk expense-telegram
```

---

## Troubleshooting

### Service Won't Start

```bash
# Check the specific service's logs
journalctl -u expense-mcp -n 100 --no-pager

# Check if secrets were loaded
sudo cat /run/expense-bot/env   # Should show KEY=VALUE pairs

# Check if MCP port is bound
ss -tlnp | grep 6666

# Check if ADK port is bound
ss -tlnp | grep 8000
```

### Postgres Connection Fails (IPv6 `ENETUNREACH`)

**Symptom:** MCP logs show `connect ENETUNREACH 2406:da14:...`

EC2 instances may lack IPv6 connectivity. The MCP service forces IPv4 via:
```ini
Environment=NODE_OPTIONS=--dns-result-order=ipv4first
```
Verify this line exists in `/etc/systemd/system/expense-mcp.service`. If missing, re-copy:
```bash
sudo cp /opt/expense-bot/deploy/expense-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart expense-mcp
```

### Git Pull Fails (`dubious ownership`)

**Symptom:** `fatal: detected dubious ownership in repository at '/opt/expense-bot'`

The repo is owned by `expensebot` but `git pull` runs as `root` via sudo:
```bash
sudo git config --global --add safe.directory /opt/expense-bot
```

### Python `ModuleNotFoundError` (PEP 668)

**Symptom:** `No module named 'openpyxl'` or similar import errors.

The systemd service files must point to the venv Python, not system Python. Check:
```bash
grep ExecStart /etc/systemd/system/expense-telegram.service
# Expected: /opt/expense-bot/venv/bin/python3
grep ExecStart /etc/systemd/system/expense-adk.service
# Expected: /opt/expense-bot/venv/bin/adk
```

If they point to `/usr/bin/python3` or `/usr/local/bin/adk`, re-copy the service files:
```bash
sudo cp /opt/expense-bot/deploy/expense-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart expense-adk expense-telegram
```

### Secrets Not Loading

```bash
# Verify the EC2 instance has the IAM role
curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/

# Manually run the fetch script
sudo bash /opt/expense-bot/deploy/fetch-secrets.sh
cat /run/expense-bot/env
```

### Telegram Bot Not Responding

```bash
# Check if all three services are running
sudo systemctl is-active expense-mcp expense-adk expense-telegram

# Test MCP from inside the server
curl -s http://127.0.0.1:6666/sse

# Test ADK from inside the server
curl -s http://127.0.0.1:8000/
```

### Can't SSH Into Server

```bash
# Verify the instance is running
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=expense-bot" \
  --query "Reservations[0].Instances[0].[State.Name,PublicIpAddress]" \
  --output text

# Make sure key has correct permissions
chmod 400 ~/.ssh/expense-bot-key.pem
```


---

## Security Checklist

| Layer | Description | Status |
|-------|------------|--------|
| Network | No inbound HTTP/HTTPS ports | ✅ |
| Network | SSH restricted via security group | ✅ |
| Network | UFW firewall (defense-in-depth) | ✅ |
| Services | MCP bound to `127.0.0.1:6666` | ✅ |
| Services | ADK bound to `127.0.0.1:8000` | ✅ |
| Process | Dedicated `expensebot` user (no login) | ✅ |
| Process | systemd `NoNewPrivileges` | ✅ |
| Process | systemd `ProtectSystem=strict` | ✅ |
| Secrets | Stored in AWS SSM Parameter Store | ✅ |
| Secrets | Loaded to RAM (tmpfs `/run/`) only | ✅ |
| Secrets | No `.env` file on server | ✅ |
| OS | Automatic security updates | ✅ |
| OS | fail2ban installed | ✅ |

---

## Cost Estimate

| Resource | Monthly Cost (approx) |
|----------|--------------------|
| EC2 `t3.micro` (ap-south-1) | ~₹800 |
| EBS 20 GiB gp3 | ~₹150 |
| Data transfer (minimal) | ~₹50 |
| SSM Parameter Store | Free (standard params) |
| **Total** | **~₹1,000/month** |

---

## File Structure

```
expense_bot/
├── agent.py                          # Gemini agent definition
├── telegram_bot.py                   # Telegram bot (long-polling)
├── main.py                           # Local CLI runner
├── requirements.txt                  # Python dependencies
├── mcp/
│   ├── index.js                      # MCP server (Express + SSE)
│   ├── package.json
│   └── package-lock.json
└── deploy/
    ├── setup-ec2.sh                  # One-time EC2 provisioning
    ├── deploy.sh                     # Code update & restart
    ├── fetch-secrets.sh              # SSM → tmpfs secrets fetch
    ├── expense-secrets.service       # systemd: fetch secrets at boot
    ├── expense-mcp.service           # systemd: MCP server
    ├── expense-adk.service           # systemd: ADK runner
    └── expense-telegram.service      # systemd: Telegram bot
```
