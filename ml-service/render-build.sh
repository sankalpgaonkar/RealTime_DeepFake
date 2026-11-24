#!/bin/bash
# render-build.sh - Optimized build script for Render free tier
# Installs CPU-only PyTorch first (saves ~600MB vs default CUDA build),
# then installs remaining dependencies.

set -e

echo "[BUILD] Installing CPU-only PyTorch to minimize install size..."
pip install --extra-index-url https://download.pytorch.org/whl/cpu \
    "torch==2.1.2+cpu" \
    "torchvision==0.16.2+cpu"

echo "[BUILD] Installing remaining dependencies (excluding torch/torchvision)..."
# Install everything else from requirements.txt, skipping torch/torchvision (already installed above)
grep -v "^torch" requirements.txt | grep -v "^torchvision" | pip install -r /dev/stdin

echo "[BUILD] Build complete!"
