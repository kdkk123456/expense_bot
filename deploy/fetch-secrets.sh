#!/bin/bash
# ============================================================================
# Expense Bot — Fetch Secrets from AWS SSM Parameter Store
# Writes secrets to /run/expense-bot/env (tmpfs — RAM only, never on disk)
# Called by expense-secrets.service at boot.
# ============================================================================
set -euo pipefail

SECRET_DIR="/run/expense-bot"
SECRET_FILE="${SECRET_DIR}/env"
SSM_PATH="/expense-bot/prod/"
REGION="${AWS_DEFAULT_REGION:-ap-south-1}"

# Ensure the directory exists (tmpfs)
mkdir -p "$SECRET_DIR"

echo "Fetching secrets from SSM path: ${SSM_PATH} (region: ${REGION})"

# Fetch all parameters under the path and write as KEY=VALUE
aws ssm get-parameters-by-path \
  --path "$SSM_PATH" \
  --with-decryption \
  --region "$REGION" \
  --query "Parameters[*].[Name,Value]" \
  --output text | while IFS=$'\t' read -r name value; do
    # Extract just the parameter name (last segment of the path)
    key=$(basename "$name")
    echo "${key}=${value}"
done > "$SECRET_FILE"

# Lock down permissions — only the service user can read
chmod 600 "$SECRET_FILE"
chown expensebot:expensebot "$SECRET_FILE"

PARAM_COUNT=$(wc -l < "$SECRET_FILE")
echo "✅ Loaded ${PARAM_COUNT} secrets into ${SECRET_FILE} (tmpfs)"
