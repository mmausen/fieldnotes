#!/usr/bin/env bash
# One-shot setup for the whole thing: transcribe.cpp, both models, the Python
# venv, and the tldraw canvas.
#
# Idempotent -- safe to re-run; every step skips whatever is already in place.
# First run takes a while (a C++ build plus ~1.6 GB of weights). After that,
# re-running is seconds.
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$PWD"
SRV="$ROOT/transcribe-diarize"
CANVAS="$ROOT/canvas"
VENV="$SRV/.venv"

# transcribe.cpp is pinned; bump deliberately and re-run the smoke test after.
TCPP_COMMIT="${TCPP_COMMIT:-223c9b067ce32694544e841bde1db50fa041d916}"
ASR_URL="https://huggingface.co/handy-computer/multitalker-parakeet-streaming-0.6b-v1-gguf/resolve/main/multitalker-parakeet-streaming-0.6b-v1-Q8_0.gguf"
ASR_GGUF="$SRV/models/multitalker-parakeet-streaming-0.6b-v1-Q8_0.gguf"
DIAR_GGUF="$SRV/models/diar_streaming_sortformer_4spk-v2.1-F32.gguf"

need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)" >&2; exit 1; }; }
need python3 "brew install python"
need cmake   "brew install cmake"
need git     "install git, or: xcode-select --install"
need curl    "install curl"
need uv      "brew install uv     # only needed to convert the diarizer"
need node    "brew install node   # for the tldraw canvas"
need npm     "brew install node"

# --- 1. python venv ----------------------------------------------------------
# Deliberately a venv, not the system/Homebrew interpreter: the transcribe_cpp
# binding is built against our local libtranscribe and shouldn't leak out of
# this project. Everything afterwards runs through $PY.
echo "==> 1/5  python venv"
[ -d "$VENV" ] || python3 -m venv "$VENV"
PY="$VENV/bin/python"

# --- 2. transcribe.cpp -------------------------------------------------------
echo "==> 2/5  transcribe.cpp"
if [ ! -d "$SRV/cpp/.git" ]; then
  echo "    cloning"
  git clone https://github.com/handy-computer/transcribe.cpp.git "$SRV/cpp"
fi
git -C "$SRV/cpp" fetch --depth 1 origin "$TCPP_COMMIT" 2>/dev/null \
  || git -C "$SRV/cpp" fetch origin
git -C "$SRV/cpp" checkout -q "$TCPP_COMMIT"

if [ ! -f "$SRV/cpp/build/src/libtranscribe.dylib" ] \
   && [ ! -f "$SRV/cpp/build/src/libtranscribe.so" ]; then
  echo "    building (shared lib required by the python binding)"
  cmake -S "$SRV/cpp" -B "$SRV/cpp/build" -DCMAKE_BUILD_TYPE=Release \
        -DTRANSCRIBE_BUILD_SHARED=ON
  cmake --build "$SRV/cpp/build" -j "$(getconf _NPROCESSORS_ONLN)"
fi

# --- 3. python deps ----------------------------------------------------------
echo "==> 3/5  python deps"
"$PY" -m pip install -q -r "$SRV/requirements.txt"
# --no-deps: the binding pins transcribe-cpp-native==0.2.0.*, which is not on
# PyPI. TRANSCRIBE_LIBRARY (set by server.py) points it at our local build.
"$PY" -m pip install -q --no-deps "$SRV/cpp/bindings/python"

# --- 4. models ---------------------------------------------------------------
echo "==> 4/5  models"
mkdir -p "$SRV/models"
if [ ! -f "$ASR_GGUF" ]; then
  echo "    downloading ASR model (734 MB)"
  curl -fL --progress-bar -o "$ASR_GGUF" "$ASR_URL"
fi
# The published sortformer GGUF repo is not publicly readable (HTTP 401), so the
# diarizer is converted locally from the NVIDIA NeMo checkpoint instead.
if [ ! -f "$DIAR_GGUF" ]; then
  echo "    converting diarizer from the NeMo checkpoint (downloads ~900 MB, slow)"
  ( cd "$SRV/cpp" && uv run --project scripts/envs/sortformer \
      scripts/convert-sortformer.py nvidia/diar_streaming_sortformer_4spk-v2.1 \
      --out "$DIAR_GGUF" )
fi

# --- 5. tldraw canvas --------------------------------------------------------
# Built rather than left to a dev server: server.py serves canvas/dist at / when
# it exists, so the whole app is one process on one port.
echo "==> 5/5  tldraw canvas"
npm --prefix "$CANVAS" install --no-fund --no-audit --loglevel=error

# Interview cross-referencer: a local sentence-embedding model + the onnxruntime
# WASM, served from canvas/public so nothing hits a CDN at runtime. Both are
# regenerated here (not committed) -- the model is downloaded once, the WASM is
# copied from the installed onnxruntime-web.
MODEL_DIR="$CANVAS/public/models/Xenova/all-MiniLM-L6-v2"
if [ ! -f "$MODEL_DIR/onnx/model_quantized.onnx" ]; then
  echo "    downloading embedding model (all-MiniLM-L6-v2, ~23 MB)"
  mkdir -p "$MODEL_DIR/onnx"
  HF="https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main"
  for f in config.json tokenizer.json tokenizer_config.json; do
    curl -fsSL "$HF/$f" -o "$MODEL_DIR/$f"
  done
  curl -fsSL "$HF/onnx/model_quantized.onnx" -o "$MODEL_DIR/onnx/model_quantized.onnx"
fi
mkdir -p "$CANVAS/public/ort"
cp "$CANVAS"/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.wasm "$CANVAS/public/ort/" 2>/dev/null || true
cp "$CANVAS"/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.mjs  "$CANVAS/public/ort/" 2>/dev/null || true

npm --prefix "$CANVAS" run build >/dev/null

cat <<EOF

done. start it with:

  $VENV/bin/python $SRV/server.py

then open http://127.0.0.1:8000
EOF
