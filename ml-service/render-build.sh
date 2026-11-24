#!/bin/bash
# render-build.sh - Optimized build script for Render free tier
# Installs CPU-only PyTorch first (saves ~600MB vs default CUDA build),
# then installs remaining dependencies.

set -e

echo "[BUILD] Installing CPU-only PyTorch and NumPy 1.x..."
pip install --extra-index-url https://download.pytorch.org/whl/cpu \
    "torch==2.1.2+cpu" \
    "torchvision==0.16.2+cpu" \
    "numpy>=1.24.0,<2.0.0"

echo "[BUILD] Installing remaining dependencies..."
pip install -r requirements.txt

echo "[BUILD] Build complete!"
