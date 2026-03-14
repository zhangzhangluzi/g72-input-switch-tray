#!/bin/sh
set -eu

TARGET="${1:-}"
DISPLAY_NAME="${DISPLAY_NAME:-G72}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUNDLED_DDCCTL="$SCRIPT_DIR/../bin/ddcctl"

case "$TARGET" in
  windows)
    INPUT_VALUE=16
    ;;
  mac)
    INPUT_VALUE=17
    ;;
  *)
    echo "Usage: $0 windows|mac" >&2
    exit 1
    ;;
esac

if [ -x "$BUNDLED_DDCCTL" ]; then
  "$BUNDLED_DDCCTL" -d 1 -i "$INPUT_VALUE"
  exit 0
fi

if command -v betterdisplaycli >/dev/null 2>&1; then
  betterdisplaycli set -namelike="$DISPLAY_NAME" -feature=ddc -vcp=inputSelect -value="$INPUT_VALUE" \
    || betterdisplaycli set -namelike="$DISPLAY_NAME" -feature=ddc -vcp=0x60 -value="$INPUT_VALUE"
  exit 0
fi

if command -v ddcctl >/dev/null 2>&1; then
  ddcctl -d 1 -i "$INPUT_VALUE"
  exit 0
fi

echo "No macOS DDC helper is available. Install BetterDisplay CLI or ddcctl." >&2
exit 1
