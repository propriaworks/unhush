#!/bin/bash
# Copy VAD runtime assets (ONNX model, AudioWorklet, WASM binaries) to public/vad/
# These files are loaded at runtime by @ricky0123/vad-web and onnxruntime-web.
set -e

DEST="public/vad"
mkdir -p "$DEST"

# Find vad-web dist directory (works with pnpm, npm, yarn)
VAD_DIST=$(node -e "console.log(require.resolve('@ricky0123/vad-web/dist/silero_vad_v5.onnx'))" 2>/dev/null | xargs dirname)
if [ -z "$VAD_DIST" ]; then
  VAD_DIST="node_modules/@ricky0123/vad-web/dist"
fi

# Find onnxruntime-web dist directory (transitive dep, may not be hoisted by pnpm)
ORT_DIST=$(node -e "
  const path = require('path');
  try {
    // Try direct resolution first (npm/yarn)
    const p = require.resolve('onnxruntime-web');
    console.log(path.dirname(p) + '/dist');
  } catch {
    // pnpm: onnxruntime-web is a sibling of the vad-web package in the .pnpm store
    const vadPath = require.resolve('@ricky0123/vad-web');
    // Go up from @ricky0123/vad-web/dist/index.js to the node_modules container
    const nodeModulesDir = path.resolve(path.dirname(vadPath), '..', '..', '..');
    const ortDir = path.join(nodeModulesDir, 'onnxruntime-web', 'dist');
    console.log(ortDir);
  }
" 2>/dev/null)
if [ -z "$ORT_DIST" ] || [ ! -d "$ORT_DIST" ]; then
  # fallback: find in .pnpm store
  ORT_DIST=$(find node_modules/.pnpm -path "*/onnxruntime-web/dist" -type d 2>/dev/null | head -1)
fi

if [ -z "$ORT_DIST" ] || [ ! -d "$ORT_DIST" ]; then
  echo "ERROR: Could not find onnxruntime-web dist directory"
  exit 1
fi

echo "Copying VAD assets from: $VAD_DIST"
echo "Copying ONNX Runtime assets from: $ORT_DIST"

# VAD model (v5 only, ~2MB)
cp "$VAD_DIST/silero_vad_v5.onnx" "$DEST/"

# AudioWorklet script
cp "$VAD_DIST/vad.worklet.bundle.min.js" "$DEST/"

# ONNX Runtime WASM binaries and their JS loaders
cp "$ORT_DIST"/ort-wasm-simd-threaded.wasm "$DEST/"
cp "$ORT_DIST"/ort-wasm-simd-threaded.mjs "$DEST/"

echo "VAD assets copied to $DEST/"
ls -lh "$DEST/"
