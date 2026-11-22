#!/bin/bash
# VERITRACE-X Deepfake Detection System - Startup Script (Native Mode)
set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"
exec ./start-native.sh "$@"
