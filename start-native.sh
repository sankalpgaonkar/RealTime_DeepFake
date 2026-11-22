#!/bin/bash

# Native Startup Script for macOS (Non-Docker)
# Starts MongoDB, Redis, ML Service, Backend, and Frontend

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

mkdir -p logs backend/logs backend/uploads

echo "=========================================="
echo "  Starting VERITRACE-X System (Native)"
echo "=========================================="

# 1. Check/Start MongoDB
echo "[1/5] Checking MongoDB..."
if grep -q "mongodb+srv://" backend/.env 2>/dev/null; then
    echo "✓ Configured with cloud MongoDB Atlas cluster"
elif ! nc -z 127.0.0.1 27017 >/dev/null 2>&1; then
    echo "Starting local MongoDB..."
    mongod --config /opt/homebrew/etc/mongod.conf --fork || true
    echo "✓ Local MongoDB is running on port 27017"
else
    echo "✓ Local MongoDB is running on port 27017"
fi

# 2. Check/Start Redis
echo "[2/5] Checking Redis..."
if ! nc -z 127.0.0.1 6379 >/dev/null 2>&1; then
    echo "Starting Redis..."
    brew services start redis || redis-server --daemonize yes
fi
echo "✓ Redis is running on port 6379"

# 3. Start ML Service (Port 5001)
echo "[3/5] Starting ML Service on port 5001..."
if lsof -ti:5001 >/dev/null 2>&1; then
    echo "Port 5001 is already in use. Killing existing process..."
    kill -9 $(lsof -ti:5001) 2>/dev/null || true
fi
(
    cd ml-service
    source venv/bin/activate
    PORT=5001 python app.py > ../logs/ml-service.log 2>&1 &
    echo $! > ../logs/ml-service.pid
)
echo "✓ ML Service started in background (logs: logs/ml-service.log)"

# 4. Start Backend (Port 3001)
echo "[4/5] Starting Backend on port 3001..."
if lsof -ti:3001 >/dev/null 2>&1; then
    echo "Port 3001 is already in use. Killing existing process..."
    kill -9 $(lsof -ti:3001) 2>/dev/null || true
fi
(
    cd backend
    npm run dev > ../logs/backend.log 2>&1 &
    echo $! > ../logs/backend.pid
)
echo "✓ Backend started in background (logs: logs/backend.log)"

# 5. Start Frontend (Port 3002)
echo "[5/5] Starting Frontend on port 3002..."
echo ""
echo "Access Points:"
echo "  - Frontend:   http://localhost:3002"
echo "  - Backend:    http://localhost:3001"
echo "  - ML Service: http://localhost:5001"
echo ""
echo "Press Ctrl+C to stop the frontend. Run ./stop-native.sh to stop background services."
echo "------------------------------------------------------------------"

npm run dev
