#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Building UI..."
npm run build

echo "Build complete."
