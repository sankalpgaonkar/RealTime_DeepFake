#!/bin/bash
# VERITRACE-X Deepfake Detection System - Shutdown Script (Native Mode)
set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"
exec ./stop-native.sh "$@"
