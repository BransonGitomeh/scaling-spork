#!/bin/bash

# Variables
PROJECT_DIR="./"  # Replace with your project directory
COMPOSE_FILE="docker-compose.yaml"   # Replace with your compose file name
GIT_BRANCH="main"                    # Replace with your Git branch (e.g., main, master, etc.)

# Navigate to the project directory
cd "$PROJECT_DIR" || { echo "Failed to navigate to project directory"; exit 1; }

# Pull the latest code from Git
echo "Pulling latest code from Git..."
git fetch origin
git checkout "$GIT_BRANCH"
git pull origin "$GIT_BRANCH" || { echo "Failed to pull latest code"; exit 1; }

# Rebuild and restart the containers using Docker Compose
echo "Restarting containers with Docker Compose..."
docker compose -f "$COMPOSE_FILE" down || { echo "Failed to stop containers"; exit 1; }
docker compose -f "$COMPOSE_FILE" up -d --build || { echo "Failed to start containers"; exit 1; }

echo "Deployment completed successfully!"