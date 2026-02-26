#!/usr/bin/env bash
# One-time AWS setup for remote sim offloading.
# Creates security group (SSH from current IP) and registers SSH key pair.
#
# Prerequisites:
#   - AWS CLI installed and configured (aws configure)
#   - SSH key at ~/.ssh/id_ed25519.pub
#
# Usage: bash scripts/aws-setup.sh [region]

set -euo pipefail

REGION="${1:-us-west-1}"
PROJECT="dh-apl"
SG_NAME="${PROJECT}-sim"
KEY_NAME="${PROJECT}"

echo "Setting up AWS resources in ${REGION}..."
echo ""

# --- Security group ---

MY_IP=$(curl -s https://checkip.amazonaws.com)
echo "Your public IP: ${MY_IP}"

SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=${SG_NAME}" \
  --query 'SecurityGroups[0].GroupId' \
  --output text \
  --region "${REGION}" 2>/dev/null || echo "None")

if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(aws ec2 create-security-group \
    --group-name "${SG_NAME}" \
    --description "SSH access for ${PROJECT} sim offloading" \
    --region "${REGION}" \
    --output text \
    --query 'GroupId')
  echo "Created security group: ${SG_ID}"
else
  echo "Security group exists: ${SG_ID}"
fi

aws ec2 authorize-security-group-ingress \
  --group-id "${SG_ID}" \
  --protocol tcp \
  --port 22 \
  --cidr "${MY_IP}/32" \
  --region "${REGION}" 2>/dev/null && echo "SSH rule added for ${MY_IP}" || echo "SSH rule already exists"

# --- SSH key pair ---

echo ""
KEY_EXISTS=$(aws ec2 describe-key-pairs \
  --key-names "${KEY_NAME}" \
  --region "${REGION}" \
  --output text 2>/dev/null || echo "")

if [ -z "$KEY_EXISTS" ]; then
  if [ ! -f ~/.ssh/id_ed25519.pub ]; then
    echo "Error: ~/.ssh/id_ed25519.pub not found"
    echo "Generate one with: ssh-keygen -t ed25519"
    exit 1
  fi
  aws ec2 import-key-pair \
    --key-name "${KEY_NAME}" \
    --public-key-material fileb://~/.ssh/id_ed25519.pub \
    --region "${REGION}" >/dev/null
  echo "Imported key pair: ${KEY_NAME}"
else
  echo "Key pair exists: ${KEY_NAME}"
fi

# --- Budget alarm ---

echo ""
echo "For cost protection, create a \$10/month budget alarm in the AWS Console:"
echo "  https://console.aws.amazon.com/billing/home#/budgets/create"
echo "  - Budget amount: \$10/month"
echo "  - Filter by tag: project = ${PROJECT}"
echo "  - Alert at 80% threshold"

# --- Summary ---

echo ""
echo "=== Setup Complete ==="
echo "Security Group: ${SG_ID}"
echo "Key Pair:       ${KEY_NAME}"
echo ""
echo "Add to config.json:"
echo '  "remote": {'
echo "    \"securityGroup\": \"${SG_ID}\","
echo '    "instanceType": "c7i.24xlarge",'
echo '    "vCpus": 96,'
echo '    "amiId": null,'
echo '    "spotMaxPrice": "1.50",'
echo '    "shutdownMinutes": 45,'
echo "    \"region\": \"${REGION}\","
echo '    "sshKeyPath": "~/.ssh/id_ed25519",'
echo '    "sshUser": "ubuntu",'
echo "    \"keyPairName\": \"${KEY_NAME}\""
echo '  }'
