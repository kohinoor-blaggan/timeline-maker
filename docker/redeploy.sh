#!/bin/bash
set -e

cd "$(dirname "$0")/.."

git pull origin main
docker compose -f docker/docker-compose.yml up --build -d

echo "Done. App running at http://localhost:5051"
