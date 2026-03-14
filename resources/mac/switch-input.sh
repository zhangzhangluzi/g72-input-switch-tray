#!/bin/sh
set -eu

INPUT_VALUE="${1:-}"
DISPLAY_NAME="${DISPLAY_NAME:-}"
DISPLAY_INDEX="${DISPLAY_INDEX:-1}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUNDLED_DDCCTL="$SCRIPT_DIR/../bin/ddcctl"
LAST_ERROR=""
DISPLAY_INDEX_CANDIDATES=""

case "$INPUT_VALUE" in
  ''|*[!0-9]*)
    echo "用法：$0 <输入值数字>" >&2
    exit 1
    ;;
esac

add_display_index_candidate() {
  candidate="$1"

  case "$candidate" in
    ''|*[!0-9]*)
      return
      ;;
  esac

  case " $DISPLAY_INDEX_CANDIDATES " in
    *" $candidate "*) ;;
    *) DISPLAY_INDEX_CANDIDATES="$DISPLAY_INDEX_CANDIDATES $candidate" ;;
  esac
}

remember_error() {
  if [ -n "${1:-}" ]; then
    LAST_ERROR="$1"
  fi
}

try_betterdisplay() {
  if [ -z "$DISPLAY_NAME" ] || ! command -v betterdisplaycli >/dev/null 2>&1; then
    return 1
  fi

  if output=$(betterdisplaycli set -namelike="$DISPLAY_NAME" -feature=ddc -vcp=inputSelect -value="$INPUT_VALUE" 2>&1); then
    return 0
  fi

  remember_error "$output"

  if output=$(betterdisplaycli set -namelike="$DISPLAY_NAME" -feature=ddc -vcp=0x60 -value="$INPUT_VALUE" 2>&1); then
    return 0
  fi

  remember_error "$output"
  return 1
}

try_ddcctl_binary() {
  binary_path="$1"

  [ -x "$binary_path" ] || return 1

  for display_index in $DISPLAY_INDEX_CANDIDATES; do
    if output=$("$binary_path" -d "$display_index" -i "$INPUT_VALUE" 2>&1); then
      return 0
    fi

    remember_error "$output"
  done

  return 1
}

add_display_index_candidate "$DISPLAY_INDEX"
add_display_index_candidate 1
add_display_index_candidate 2
add_display_index_candidate 3
add_display_index_candidate 4

if try_betterdisplay; then
  exit 0
fi

if try_ddcctl_binary "$BUNDLED_DDCCTL"; then
  exit 0
fi

if command -v ddcctl >/dev/null 2>&1; then
  if try_ddcctl_binary "$(command -v ddcctl)"; then
    exit 0
  fi
fi

if [ -n "$LAST_ERROR" ]; then
  echo "$LAST_ERROR" >&2
else
  echo "没有可用的 macOS DDC 辅助程序。请安装 BetterDisplay CLI，或检查打包的 ddcctl 是否存在。" >&2
fi

exit 1
