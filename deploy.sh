#!/bin/bash

# Variables
PROJECT_DIR="./"  # Replace with your project directory
COMPOSE_FILE="docker-compose.yaml"   # Replace with your compose file name
GIT_BRANCH="main"                    # Replace with your Git branch (e.g., main, master, etc.)
SERVICE_NAME="node-app"              # Replace with the name of your specific service

# Navigate to the project directory
cd "$PROJECT_DIR" || { echo "Failed to navigate to project directory"; exit 1; }

# Pull the latest code from Git
echo "Pulling latest code from Git..."
git fetch origin
git checkout "$GIT_BRANCH"
git pull origin "$GIT_BRANCH" || { echo "Failed to pull latest code"; exit 1; }

# Rebuild and restart only the specified container
echo "Rebuilding and restarting the $SERVICE_NAME container..."
docker compose -f "$COMPOSE_FILE" up -d --build --no-deps "$SERVICE_NAME" || { echo "Failed to rebuild and restart $SERVICE_NAME"; exit 1; }

echo "Deployment completed successfully!"