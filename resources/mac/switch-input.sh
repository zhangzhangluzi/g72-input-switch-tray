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
    echo "用法：$0 windows|mac" >&2
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

echo "没有可用的 macOS DDC 辅助程序。请安装 BetterDisplay CLI 或 ddcctl。" >&2
exit 1
