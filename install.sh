#!/usr/bin/env bash
# Zen Link Groups – install, update and uninstall.
#
#   ./install.sh                installs the fx-autoconfig loader and the mod, and lists the
#                               mod in Zen's settings (Zen Mods), where it is switched and set up
#                               (run it again after a Zen update if the mod is gone)
#   ./install.sh --uninstall    removes the mod; the loader goes only if nothing else uses it
#
# Options:
#   --app PATH       path to Zen.app               (default: /Applications/Zen.app)
#   --profile DIR    Zen profile directory         (default: this install's profile, from installs.ini)
#   --dry-run        only prints what it would do
#
# Zen must not be running (Cmd+Q). Run it without sudo. Needs python3.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor/fx-autoconfig"
ZEN_SUPPORT="$HOME/Library/Application Support/zen"
ZEN_CACHES="$HOME/Library/Caches/zen"
# The mod's entry in Zen Mods loads this file; the groups are drawn by the
# sheet fx-autoconfig loads (see the file).
ZEN_MOD_STYLE="src/zen-mod/chrome.css"

APP="/Applications/Zen.app"
PROFILE=""
MODE="install"
DRY_RUN=0
STAMP="$(date +%Y%m%d-%H%M%S)"

die() {
  echo "Error: $*" >&2
  exit 1
}

run() {
  if ((DRY_RUN)); then
    printf '  [dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while (($#)); do
  case "$1" in
    --app) APP="${2:?--app needs a path}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile needs a path}"; shift 2 ;;
    --uninstall) MODE="uninstall"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

# Profile this Zen install starts with (installs.ini), else Default=1 from profiles.ini.
default_profile() {
  local rel=""
  if [[ -f "$ZEN_SUPPORT/installs.ini" ]]; then
    rel="$(awk -F= '/^Default=/ { sub(/^Default=/, ""); print; exit }' "$ZEN_SUPPORT/installs.ini")"
  fi
  if [[ -z "$rel" && -f "$ZEN_SUPPORT/profiles.ini" ]]; then
    rel="$(awk -F= '/^\[/ { path = "" } /^Path=/ { sub(/^Path=/, ""); path = $0 } /^Default=1/ { print path; exit }' \
      "$ZEN_SUPPORT/profiles.ini")"
  fi
  [[ -n "$rel" ]] || return 1
  case "$rel" in
    /*) echo "$rel" ;;
    *) echo "$ZEN_SUPPORT/$rel" ;;
  esac
}

# Copies src over dst; a different existing dst is kept as dst.backup-<time>.
# An identical dst is left alone, so an update needs no write where nothing changed.
install_file() {
  local src="$1" dst="$2"
  if [[ -e "$dst" ]] && cmp -s "$src" "$dst"; then
    return 0
  fi
  if [[ -e "$dst" ]]; then
    echo "  ! $dst already exists and differs – backing it up as $(basename "$dst").backup-$STAMP"
    run cp -p "$dst" "$dst.backup-$STAMP"
  fi
  run mkdir -p "$(dirname "$dst")"
  run cp "$src" "$dst"
}

# Removes dst only if it is exactly our vendored copy.
remove_if_ours() {
  local src="$1" dst="$2"
  if [[ ! -e "$dst" ]]; then
    return
  fi
  if cmp -s "$src" "$dst"; then
    run rm -f "$dst"
  else
    echo "  ! keeping $dst – it is not the copy from this repository"
  fi
}

# Folders of the profile holding files of another user, such as root after a
# run with sudo: this script cannot change those files.
foreign_in_profile() {
  local dir me
  me="$(id -un)"
  for dir in "$CHROME/utils" "$CHROME/JS" "$CHROME/CSS"; do
    if [[ -e "$dir" && -n "$(find "$dir" ! -user "$me" -print -quit 2>/dev/null)" ]]; then
      printf '%s\n' "$dir"
    fi
  done
}

foreign_report() {
  local line
  echo "these folders hold files of another user (an earlier run with sudo?):"
  while IFS= read -r line; do
    echo "  $line"
  done <<<"$1"
  echo "Make them yours, then run the script again without sudo:"
  # The user's shell expands $(id -un), not this script.
  # shellcheck disable=SC2016
  printf '  sudo chown -R "$(id -un)"'
  while IFS= read -r line; do
    printf ' %q' "$line"
  done <<<"$1"
  printf '\n'
}

# The profile and Zen's settings belong to you; files written as root would
# be out of reach for Zen, which runs as you.
((EUID != 0)) || die "do not run the installer with sudo. If macOS blocks writing to Zen.app, allow
  your terminal in System Settings → Privacy & Security → App Management instead."
command -v python3 >/dev/null 2>&1 || die "python3 not found (on macOS: xcode-select --install)"

[[ -d "$APP/Contents/Resources" ]] || die "$APP not found (pass --app /path/to/Zen.app)"
RESOURCES="$APP/Contents/Resources"

if [[ -z "$PROFILE" ]]; then
  PROFILE="$(default_profile)" || die "could not find a Zen profile (pass --profile DIR)"
fi
[[ -f "$PROFILE/prefs.js" ]] || die "$PROFILE does not look like a Zen profile (no prefs.js)"
CHROME="$PROFILE/chrome"
STARTUP_CACHE="$ZEN_CACHES/Profiles/$(basename "$PROFILE")/startupCache"
PY_FLAGS=()
if ((DRY_RUN)); then
  PY_FLAGS=(--dry-run)
fi

if pgrep -f "$APP/Contents/MacOS/zen" >/dev/null 2>&1; then
  if ((DRY_RUN)); then
    echo "Note: Zen is running – quit it (Cmd+Q) before a real run."
  else
    die "Zen is running. Quit it (Cmd+Q) and run the script again."
  fi
fi

foreign="$(foreign_in_profile)"
if [[ -n "$foreign" ]]; then
  report="$(foreign_report "$foreign")"
  if ((DRY_RUN)); then
    echo "Note: $report"
  else
    die "$report"
  fi
fi

echo "App:     $APP"
echo "Profile: $PROFILE"
echo

if [[ "$MODE" == "install" ]]; then
  echo "1/4 fx-autoconfig loader in the app ($(sed -n 's/^commit: //p' "$VENDOR/VERSION" | cut -c1-12))"
  if ! install_file "$VENDOR/program/config.js" "$RESOURCES/config.js" ||
    ! install_file "$VENDOR/program/defaults/pref/config-prefs.js" "$RESOURCES/defaults/pref/config-prefs.js"; then
    die "cannot write to $RESOURCES.
  macOS blocks changes to apps without the 'App Management' permission:
  System Settings → Privacy & Security → App Management → enable your terminal,
  then run the script again. If the loader's files there belong to root (an
  earlier run with sudo), make them yours first:
  sudo chown \"\$(id -un)\" \"$RESOURCES/config.js\" \"$RESOURCES/defaults/pref/config-prefs.js\""
  fi

  echo "2/4 Loader and mod in the profile"
  for file in "$VENDOR"/profile/chrome/utils/*; do
    install_file "$file" "$CHROME/utils/$(basename "$file")"
  done
  install_file "$HERE/src/JS/zenLinkGroups.uc.js" "$CHROME/JS/zenLinkGroups.uc.js"
  run rm -rf "$CHROME/JS/zen-link-groups"
  run mkdir -p "$CHROME/JS/zen-link-groups"
  for file in "$HERE"/src/JS/zen-link-groups/*.sys.mjs; do
    run cp "$file" "$CHROME/JS/zen-link-groups/"
  done
  install_file "$HERE/src/CSS/zenLinkGroups.uc.css" "$CHROME/CSS/zenLinkGroups.uc.css"

  echo "3/4 The mod in Zen's settings (Zen Mods)"
  python3 -I "$HERE/tools/zen_mods.py" install "$PROFILE" --style "$ZEN_MOD_STYLE" ${PY_FLAGS[@]+"${PY_FLAGS[@]}"}

  echo "4/4 Clearing the startup cache"
  run rm -rf "$STARTUP_CACHE"

  echo
  if ((DRY_RUN)); then
    echo "Dry run: nothing was changed."
    exit 0
  fi
  echo "Done. Start Zen: tabs opened from links will group under the tab they came from."
  echo "Switch the mod and set it up in Settings → Zen Mods → Zen Link Groups."
  echo "On the first start fx-autoconfig shows a one-time bar saying that Zen runs custom scripts."
else
  echo "1/4 Removing the mod from the profile"
  run rm -f "$CHROME/JS/zenLinkGroups.uc.js" "$CHROME/CSS/zenLinkGroups.uc.css" "$PROFILE/zen-link-groups.json"
  run rm -rf "$CHROME/JS/zen-link-groups"

  echo "2/4 Removing it from Zen's settings (Zen Mods)"
  python3 -I "$HERE/tools/zen_mods.py" uninstall "$PROFILE" ${PY_FLAGS[@]+"${PY_FLAGS[@]}"}

  echo "3/4 fx-autoconfig loader"
  others="$(find "$CHROME/JS" "$CHROME/CSS" -maxdepth 1 -type f \
    \( -name '*.uc.js' -o -name '*.uc.mjs' -o -name '*.sys.mjs' -o -name '*.uc.css' \) \
    ! -name 'zenLinkGroups.*' 2>/dev/null || true)"
  if [[ -n "$others" ]]; then
    echo "  keeping the loader – still used by:"
    while IFS= read -r line; do
      echo "    $line"
    done <<<"$others"
  else
    for file in "$VENDOR"/profile/chrome/utils/*; do
      remove_if_ours "$file" "$CHROME/utils/$(basename "$file")"
    done
    remove_if_ours "$VENDOR/program/config.js" "$RESOURCES/config.js"
    remove_if_ours "$VENDOR/program/defaults/pref/config-prefs.js" "$RESOURCES/defaults/pref/config-prefs.js"
    for dir in "$CHROME/utils" "$CHROME/JS" "$CHROME/CSS" "$RESOURCES/defaults/pref" "$RESOURCES/defaults"; do
      if [[ -d "$dir" ]] && [[ -z "$(ls -A "$dir")" ]]; then
        run rmdir "$dir"
      fi
    done
  fi

  echo "4/4 Clearing the startup cache"
  run rm -rf "$STARTUP_CACHE"
  echo
  if ((DRY_RUN)); then
    echo "Dry run: nothing was changed."
    exit 0
  fi
  echo "Uninstalled."
fi
