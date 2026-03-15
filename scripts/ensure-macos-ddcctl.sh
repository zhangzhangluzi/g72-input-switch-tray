#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT_DIR="$ROOT_DIR/resources/bin"
OUTPUT_BIN="$OUTPUT_DIR/ddcctl"
CACHE_BIN="$ROOT_DIR/.cache/ddcctl-src/bin/release/ddcctl"

mkdir -p "$OUTPUT_DIR"

if [ -x "$OUTPUT_BIN" ]; then
  exit 0
fi

if [ -x "$CACHE_BIN" ]; then
  cp "$CACHE_BIN" "$OUTPUT_BIN"
  chmod +x "$OUTPUT_BIN"
  exit 0
fi

"$ROOT_DIR/scripts/build-macos-ddcctl.sh"
