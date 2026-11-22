#!/bin/bash

# Stop Script for Native macOS Services

echo "=========================================="
echo "  Stopping SENTINEL-X Services"
echo "=========================================="

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

# Kill ML Service
if [ -f logs/ml-service.pid ]; then
    PID=$(cat logs/ml-service.pid)
    kill $PID 2>/dev/null || true
    rm logs/ml-service.pid
fi
if lsof -ti:5001 >/dev/null 2>&1; then
    kill -9 $(lsof -ti:5001) 2>/dev/null || true
fi
echo "✓ Stopped ML Service (Port 5001)"

# Kill Backend
if [ -f logs/backend.pid ]; then
    PID=$(cat logs/backend.pid)
    kill $PID 2>/dev/null || true
    rm logs/backend.pid
fi
if lsof -ti:3001 >/dev/null 2>&1; then
    kill -9 $(lsof -ti:3001) 2>/dev/null || true
fi
echo "✓ Stopped Backend (Port 3001)"

# Kill Frontend (Port 3002)
if lsof -ti:3002 >/dev/null 2>&1; then
    kill -9 $(lsof -ti:3002) 2>/dev/null || true
fi
echo "✓ Stopped Frontend (Port 3002)"

echo "All app services stopped."
