#!/bin/bash
# Build script for pensieve
# Handles TypeScript compilation and asset distribution

set -e

echo "Building pensieve..."

# Compile TypeScript
npm run tsc

# Copy templates and prompts to dist
mkdir -p dist/templates
cp -r src/templates/* dist/templates/

mkdir -p dist/ai-prompts
cp -r docs/ai-prompts/* dist/ai-prompts/

echo "Build complete ✓"
