#!/bin/bash
set -e

# Deployment script for CRM Chat
# Run this on a machine with Nix installed and network access

# Configuration (set via environment variables)
DOCKER_USER="${DOCKER_USER:?DOCKER_USER environment variable is required}"
DOCKER_TOKEN="${DOCKER_TOKEN:?DOCKER_TOKEN environment variable is required}"
DOKPLOY_URL="${DOKPLOY_URL:-https://dokploy.kaminazuma.com}"
DOKPLOY_API_KEY="${DOKPLOY_API_KEY:?DOKPLOY_API_KEY environment variable is required}"
DOKPLOY_WEB_APP_ID="${DOKPLOY_WEB_APP_ID:?DOKPLOY_WEB_APP_ID environment variable is required}"
DOKPLOY_SUBSCRIBER_APP_ID="${DOKPLOY_SUBSCRIBER_APP_ID:-}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== CRM Chat Deployment ===${NC}"

# Check for nix
if ! command -v nix &> /dev/null; then
    echo -e "${RED}Error: Nix is not installed${NC}"
    echo "Install Nix: curl -L https://nixos.org/nix/install | sh"
    exit 1
fi

# Step 1: Build Docker images
echo -e "${YELLOW}Building Docker images...${NC}"

echo "Building crm-chat-web-img..."
nix build .#crm-chat-web-img --extra-experimental-features "nix-command flakes"
WEB_IMG_PATH=$(readlink -f result)

echo "Building telegram-subscriber-img..."
nix build .#telegram-subscriber-img --extra-experimental-features "nix-command flakes"
SUBSCRIBER_IMG_PATH=$(readlink -f result)

# Step 2: Load images into Docker
echo -e "${YELLOW}Loading images into Docker...${NC}"

docker load < "$WEB_IMG_PATH"
docker load < "$SUBSCRIBER_IMG_PATH"

# Step 3: Login to Docker Hub
echo -e "${YELLOW}Logging into Docker Hub...${NC}"
echo "$DOCKER_TOKEN" | docker login -u "$DOCKER_USER" --password-stdin

# Step 4: Push images
echo -e "${YELLOW}Pushing images to Docker Hub...${NC}"

docker push nick395/crm-chat-web:latest
docker push nick395/telegram-subscriber:latest

# Step 5: Deploy to Dokploy
echo -e "${YELLOW}Deploying to Dokploy...${NC}"

# Trigger web deployment
echo "Deploying crm-chat-web..."
curl -s -X POST "$DOKPLOY_URL/api/application.deploy" \
  -H "Authorization: Bearer $DOKPLOY_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"applicationId\": \"$DOKPLOY_WEB_APP_ID\"}"

# Trigger telegram-subscriber deployment if app ID is set
if [ -n "$DOKPLOY_SUBSCRIBER_APP_ID" ]; then
  echo "Deploying telegram-subscriber..."
  curl -s -X POST "$DOKPLOY_URL/api/application.deploy" \
    -H "Authorization: Bearer $DOKPLOY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"applicationId\": \"$DOKPLOY_SUBSCRIBER_APP_ID\"}"
fi

echo ""
echo -e "${GREEN}Deployment triggered!${NC}"
echo "Check Dokploy dashboard for deployment status: $DOKPLOY_URL"
