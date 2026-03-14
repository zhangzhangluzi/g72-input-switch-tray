#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK_DIR="$ROOT_DIR/.cache/ddcctl-src"
OUTPUT_DIR="$ROOT_DIR/resources/bin"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" "$OUTPUT_DIR"

git clone --depth 1 https://github.com/kfix/ddcctl.git "$WORK_DIR"
make -C "$WORK_DIR"
cp "$WORK_DIR/bin/release/ddcctl" "$OUTPUT_DIR/ddcctl"
chmod +x "$OUTPUT_DIR/ddcctl"
