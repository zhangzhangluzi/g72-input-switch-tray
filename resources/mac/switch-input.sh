#!/bin/sh
set -eu

COMMAND="${1:-}"
INPUT_VALUE="$COMMAND"
DISPLAY_NAME="${DISPLAY_NAME:-}"
DISPLAY_INDEX="${DISPLAY_INDEX:-1}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUNDLED_DDCCTL="${BUNDLED_DDCCTL_PATH:-$SCRIPT_DIR/../bin/ddcctl}"
BETTERDISPLAY_APP_PATH="${BETTERDISPLAY_APP_PATH:-}"
DISABLE_BETTERDISPLAY="${DISABLE_BETTERDISPLAY:-0}"
LAST_ERROR=""
LAST_ERROR_PRIORITY=0
DISPLAY_INDEX_CANDIDATES=""
BETTERDISPLAY_PATH=""
BETTERDISPLAY_MODE=""

if [ "$COMMAND" != "--query-input" ]; then
  case "$INPUT_VALUE" in
    ''|*[!0-9]*)
      echo "用法：$0 <输入值数字>" >&2
      exit 1
      ;;
  esac
fi

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
  output="${1:-}"
  priority="${2:-1}"

  [ -n "$output" ] || return

  case "$priority" in
    ''|*[!0-9]*)
      priority=1
      ;;
  esac

  if [ "$priority" -ge "$LAST_ERROR_PRIORITY" ]; then
    LAST_ERROR="$output"
    LAST_ERROR_PRIORITY="$priority"
  fi
}

extract_external_display_count() {
  printf '%s\n' "${1:-}" | sed -n 's/.*I: found \([0-9][0-9]*\) external display.*/\1/p' | tail -n 1
}

is_ddcctl_usage_output() {
  case "${1:-}" in
    *"Usage:"*"ddcctl"*"-d <1-..>"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

get_expected_input_values() {
  case "$INPUT_VALUE" in
    17)
      printf '%s\n' "17 6"
      ;;
    18)
      printf '%s\n' "18 5"
      ;;
    15)
      printf '%s\n' "15 3"
      ;;
    16)
      printf '%s\n' "16 9 7"
      ;;
    *)
      printf '%s\n' "$INPUT_VALUE"
      ;;
  esac
}

query_betterdisplay_input() {
  betterdisplay_path="$1"
  betterdisplay_mode="$2"

  if [ "$betterdisplay_mode" = "cli" ]; then
    "$betterdisplay_path" get -namelike="$DISPLAY_NAME" -feature=ddc -vcp=inputSelect -value 2>&1
    return $?
  fi

  "$betterdisplay_path" get -nameLike="$DISPLAY_NAME" -ddc -vcp=inputSelect -value 2>&1
}

extract_numeric_output() {
  printf '%s\n' "${1:-}" | tr -d '\r' | tail -n 1 | tr -d '[:space:]'
}

extract_ddcctl_current_value() {
  printf '%s\n' "${1:-}" | sed -n 's/.*current: \([0-9][0-9]*\).*/\1/p' | tail -n 1
}

resolve_betterdisplay() {
  if [ -n "$BETTERDISPLAY_PATH" ] && [ -n "$BETTERDISPLAY_MODE" ]; then
    return 0
  fi

  case "$DISABLE_BETTERDISPLAY" in
    1|true|TRUE|yes|YES|on|ON)
      return 1
      ;;
  esac

  if [ -z "$DISPLAY_NAME" ]; then
    return 1
  fi

  if command -v betterdisplaycli >/dev/null 2>&1; then
    BETTERDISPLAY_PATH=$(command -v betterdisplaycli)
    BETTERDISPLAY_MODE="cli"
    return 0
  fi

  if [ -n "$BETTERDISPLAY_APP_PATH" ] && [ -x "$BETTERDISPLAY_APP_PATH" ]; then
    BETTERDISPLAY_PATH="$BETTERDISPLAY_APP_PATH"
    BETTERDISPLAY_MODE="app"
    return 0
  fi

  if [ -x "/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay" ]; then
    BETTERDISPLAY_PATH="/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay"
    BETTERDISPLAY_MODE="app"
    return 0
  fi

  if [ -x "$HOME/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay" ]; then
    BETTERDISPLAY_PATH="$HOME/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay"
    BETTERDISPLAY_MODE="app"
    return 0
  fi

  return 1
}

try_betterdisplay_query() {
  current_value=""

  resolve_betterdisplay || return 1

  if ! output=$(query_betterdisplay_input "$BETTERDISPLAY_PATH" "$BETTERDISPLAY_MODE"); then
    remember_error "$output" 2
    return 1
  fi

  current_value=$(extract_numeric_output "$output")

  case "$current_value" in
    ''|*[!0-9]*)
      remember_error "BetterDisplay 返回了无法识别的当前输入值：${output}" 2
      return 1
      ;;
  esac

  printf '%s\n' "$current_value"
  return 0
}

verify_betterdisplay_switch() {
  betterdisplay_path="$1"
  betterdisplay_mode="$2"
  expected_values=$(get_expected_input_values)

  if ! output=$(query_betterdisplay_input "$betterdisplay_path" "$betterdisplay_mode"); then
    remember_error "$output" 3
    return 1
  fi

  current_value=$(printf '%s\n' "$output" | tr -d '\r' | tail -n 1 | tr -d '[:space:]')

  case "$current_value" in
    ''|*[!0-9]*)
      remember_error "BetterDisplay 写入后返回了无法识别的当前输入值：${output}" 3
      return 1
      ;;
  esac

  for expected_value in $expected_values; do
    if [ "$current_value" = "$expected_value" ]; then
      return 0
    fi
  done

  remember_error "BetterDisplay 已发送输入切换命令，但当前输入仍是 ${current_value}，未匹配目标值集合：${expected_values}" 3
  return 1
}

try_ddcctl_query_binary() {
  binary_path="$1"
  detected_display_count=""
  candidate_list=""
  current_value=""

  [ -x "$binary_path" ] || return 1

  detected_display_count=$(discover_ddcctl_display_count "$binary_path")

  if [ -n "$detected_display_count" ] && [ "$detected_display_count" -eq 0 ]; then
    remember_error "ddcctl 没有检测到可控制的外接显示器。请确认显示器已连接、当前 Mac 仍然能看到它，并且显示器开启了 DDC/CI。" 2
    return 1
  fi

  candidate_list=$(build_ddcctl_candidate_list "$detected_display_count")

  for display_index in $candidate_list; do
    if output=$("$binary_path" -d "$display_index" -i "?" 2>&1); then
      current_value=$(extract_ddcctl_current_value "$output")

      case "$current_value" in
        ''|*[!0-9]*)
          remember_error "ddcctl 返回了无法识别的当前输入值：${output}" 2
          continue
          ;;
      esac

      printf '%s\n' "$current_value"
      return 0
    fi

    if is_ddcctl_usage_output "$output"; then
      remember_error "$output" 1
      continue
    fi

    remember_error "$output" 2
  done

  return 1
}

discover_ddcctl_display_count() {
  binary_path="$1"
  help_output=$("$binary_path" -h 2>&1 || true)
  extract_external_display_count "$help_output"
}

build_ddcctl_candidate_list() {
  max_count="${1:-}"

  if [ -z "$max_count" ]; then
    printf '%s\n' "$DISPLAY_INDEX_CANDIDATES"
    return
  fi

  filtered_candidates=""

  for display_index in $DISPLAY_INDEX_CANDIDATES; do
    if [ "$display_index" -le "$max_count" ]; then
      case " $filtered_candidates " in
        *" $display_index "*) ;;
        *) filtered_candidates="$filtered_candidates $display_index" ;;
      esac
    fi
  done

  next_index=1

  while [ "$next_index" -le "$max_count" ]; do
    case " $filtered_candidates " in
      *" $next_index "*) ;;
      *) filtered_candidates="$filtered_candidates $next_index" ;;
    esac

    next_index=$((next_index + 1))
  done

  printf '%s\n' "$filtered_candidates"
}

try_betterdisplay() {
  if ! resolve_betterdisplay; then
    return 1
  fi

  if [ "$BETTERDISPLAY_MODE" = "cli" ]; then
    if output=$("$BETTERDISPLAY_PATH" set -namelike="$DISPLAY_NAME" -feature=ddc -vcp=inputSelect -value="$INPUT_VALUE" 2>&1); then
      if verify_betterdisplay_switch "$BETTERDISPLAY_PATH" "$BETTERDISPLAY_MODE"; then
        return 0
      fi
    fi

    remember_error "$output" 2

    if output=$("$BETTERDISPLAY_PATH" set -namelike="$DISPLAY_NAME" -feature=ddc -vcp=0x60 -value="$INPUT_VALUE" 2>&1); then
      if verify_betterdisplay_switch "$BETTERDISPLAY_PATH" "$BETTERDISPLAY_MODE"; then
        return 0
      fi
    fi

    remember_error "$output" 2
    return 1
  fi

  if output=$("$BETTERDISPLAY_PATH" set -nameLike="$DISPLAY_NAME" -ddc -vcp=inputSelect -value="$INPUT_VALUE" 2>&1); then
    if verify_betterdisplay_switch "$BETTERDISPLAY_PATH" "$BETTERDISPLAY_MODE"; then
      return 0
    fi
  fi

  remember_error "$output" 2

  if output=$("$BETTERDISPLAY_PATH" set -nameLike="$DISPLAY_NAME" -ddc -vcp=0x60 -value="$INPUT_VALUE" 2>&1); then
    if verify_betterdisplay_switch "$BETTERDISPLAY_PATH" "$BETTERDISPLAY_MODE"; then
      return 0
    fi
  fi

  remember_error "$output" 2
  return 1
}

try_ddcctl_binary() {
  binary_path="$1"
  detected_display_count=""
  candidate_list=""

  [ -x "$binary_path" ] || return 1

  detected_display_count=$(discover_ddcctl_display_count "$binary_path")

  if [ -n "$detected_display_count" ] && [ "$detected_display_count" -eq 0 ]; then
    remember_error "ddcctl 没有检测到可控制的外接显示器。请确认显示器已连接、当前 Mac 仍然能看到它，并且显示器开启了 DDC/CI。" 2
    return 1
  fi

  candidate_list=$(build_ddcctl_candidate_list "$detected_display_count")

  for display_index in $candidate_list; do
    if output=$("$binary_path" -d "$display_index" -i "$INPUT_VALUE" 2>&1); then
      if verify_ddcctl_switch_binary "$binary_path" "$display_index"; then
        return 0
      fi

      continue
    fi

    if is_ddcctl_usage_output "$output"; then
      remember_error "$output" 1
      continue
    fi

    remember_error "$output" 2
  done

  return 1
}

verify_ddcctl_switch_binary() {
  binary_path="$1"
  display_index="$2"
  expected_values=$(get_expected_input_values)

  sleep 1

  if ! output=$("$binary_path" -d "$display_index" -i "?" 2>&1); then
    if is_ddcctl_usage_output "$output"; then
      remember_error "$output" 1
    else
      remember_error "ddcctl 已发送输入切换命令，但无法重新读回当前输入值：${output}" 3
    fi
    return 1
  fi

  current_value=$(extract_ddcctl_current_value "$output")

  case "$current_value" in
    ''|*[!0-9]*)
      remember_error "ddcctl 写入后返回了无法识别的当前输入值：${output}" 3
      return 1
      ;;
  esac

  for expected_value in $expected_values; do
    if [ "$current_value" = "$expected_value" ]; then
      return 0
    fi
  done

  remember_error "ddcctl 已发送输入切换命令，但当前输入仍是 ${current_value}，未匹配目标值集合：${expected_values}" 3
  return 1
}

add_display_index_candidate "$DISPLAY_INDEX"
add_display_index_candidate 1
add_display_index_candidate 2
add_display_index_candidate 3
add_display_index_candidate 4

if [ "$COMMAND" = "--query-input" ]; then
  if try_betterdisplay_query; then
    exit 0
  fi

  if try_ddcctl_query_binary "$BUNDLED_DDCCTL"; then
    exit 0
  fi

  if command -v ddcctl >/dev/null 2>&1; then
    if try_ddcctl_query_binary "$(command -v ddcctl)"; then
      exit 0
    fi
  fi

  if [ -n "$LAST_ERROR" ]; then
    echo "$LAST_ERROR" >&2
  else
    echo "没有可用的 macOS DDC 辅助程序。请安装 BetterDisplay CLI，或检查打包的 ddcctl 是否存在。" >&2
  fi

  exit 1
fi

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
