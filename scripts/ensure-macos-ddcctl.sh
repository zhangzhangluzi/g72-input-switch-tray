#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT_DIR="$ROOT_DIR/resources/bin"
OUTPUT_BIN="$OUTPUT_DIR/ddcctl"
OUTPUT_STAMP="$OUTPUT_DIR/ddcctl.commit"
CACHE_BIN="$ROOT_DIR/.cache/ddcctl-src/bin/release/ddcctl"
EXPECTED_COMMIT=$(awk -F'"' '/^DDCCTL_COMMIT=/{print $2; exit}' "$ROOT_DIR/scripts/build-macos-ddcctl.sh")

if [ -z "$EXPECTED_COMMIT" ]; then
  echo "无法读取 ddcctl pinned commit。" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

if [ -x "$OUTPUT_BIN" ] && [ -f "$OUTPUT_STAMP" ] && [ "$(cat "$OUTPUT_STAMP")" = "$EXPECTED_COMMIT" ]; then
  exit 0
fi

if [ -x "$CACHE_BIN" ] &&
  [ -d "$ROOT_DIR/.cache/ddcctl-src/.git" ] &&
  [ "$(git -C "$ROOT_DIR/.cache/ddcctl-src" rev-parse HEAD 2>/dev/null || true)" = "$EXPECTED_COMMIT" ]; then
  cp "$CACHE_BIN" "$OUTPUT_BIN"
  chmod +x "$OUTPUT_BIN"
  printf '%s\n' "$EXPECTED_COMMIT" > "$OUTPUT_STAMP"
  exit 0
fi

"$ROOT_DIR/scripts/build-macos-ddcctl.sh"
