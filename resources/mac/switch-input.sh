#!/bin/sh
set -eu

INPUT_VALUE="${1:-}"
DISPLAY_NAME="${DISPLAY_NAME:-}"
DISPLAY_INDEX="${DISPLAY_INDEX:-1}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUNDLED_DDCCTL="$SCRIPT_DIR/../bin/ddcctl"

case "$INPUT_VALUE" in
  ''|*[!0-9]*)
    echo "用法：$0 <输入值数字>" >&2
    exit 1
    ;;
esac

if [ -x "$BUNDLED_DDCCTL" ]; then
  "$BUNDLED_DDCCTL" -d "$DISPLAY_INDEX" -i "$INPUT_VALUE"
  exit 0
fi

if [ -n "$DISPLAY_NAME" ] && command -v betterdisplaycli >/dev/null 2>&1; then
  betterdisplaycli set -namelike="$DISPLAY_NAME" -feature=ddc -vcp=inputSelect -value="$INPUT_VALUE" \
    || betterdisplaycli set -namelike="$DISPLAY_NAME" -feature=ddc -vcp=0x60 -value="$INPUT_VALUE"
  exit 0
fi

if command -v ddcctl >/dev/null 2>&1; then
  ddcctl -d "$DISPLAY_INDEX" -i "$INPUT_VALUE"
  exit 0
fi

echo "没有可用的 macOS DDC 辅助程序。请安装 BetterDisplay CLI 或 ddcctl。" >&2
exit 1
