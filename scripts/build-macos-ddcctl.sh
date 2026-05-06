#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK_DIR="$ROOT_DIR/.cache/ddcctl-src"
OUTPUT_DIR="$ROOT_DIR/resources/bin"
DDCCTL_REPO_URL="https://github.com/kfix/ddcctl.git"
DDCCTL_COMMIT="06c7ab6eba5b1c903678f8113a92cef990acaf90"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" "$OUTPUT_DIR"

git init "$WORK_DIR"
git -C "$WORK_DIR" remote add origin "$DDCCTL_REPO_URL"
git -C "$WORK_DIR" fetch --depth 1 origin "$DDCCTL_COMMIT"
git -C "$WORK_DIR" checkout --detach FETCH_HEAD
make -C "$WORK_DIR"
cp "$WORK_DIR/bin/release/ddcctl" "$OUTPUT_DIR/ddcctl"
chmod +x "$OUTPUT_DIR/ddcctl"
