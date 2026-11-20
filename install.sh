#!/bin/bash
# DropDial installer for macOS. Run it from Terminal with:
#   curl -fsSL https://unknown8575.github.io/DropDial-Releases/install.sh | bash
#
# It downloads the newest DropDial for this Mac (Apple silicon or Intel) from DropDial's GitHub releases, checks the
# download against the fingerprint published with the release, signs the app for this Mac (ad-hoc, with Apple's own
# codesign) and puts it in Applications. Gatekeeper stays on; files fetched by curl simply aren't marked as browser
# downloads. Re-running it updates DropDial; your settings are kept.
#
# Written for the bash 3.2 that ships with macOS: plain ASCII, no bash 4 features.
# Copyright (c) 2026 Yash Gupta. All rights reserved.

# Everything runs inside main(), called on the last line, so a half-downloaded script does nothing.
main() {
  set -euo pipefail

  local repo="unknown8575/DropDial-Releases"
  local manifest_url="https://github.com/${repo}/releases/latest/download/latest.json"
  local api_url="https://api.github.com/repos/${repo}/releases/latest"

  local bold="" dim="" red="" green="" orange="" reset=""
  if [ -t 1 ]; then
    bold="$(printf '\033[1m')"; dim="$(printf '\033[2m')"; red="$(printf '\033[31m')"
    green="$(printf '\033[32m')"; orange="$(printf '\033[38;5;208m')"; reset="$(printf '\033[0m')"
  fi
  say() { printf '%s\n' "$*"; }
  step() { printf '%s==>%s %s\n' "${orange}${bold}" "${reset}${bold}" "$*${reset}"; }
  fail() { printf '%sDropDial was not installed:%s %s\n' "${red}${bold}" "${reset}" "$*" >&2; exit 1; }

  say ""
  say "${bold}DropDial${reset} ${dim}installer for Mac${reset}"
  say ""

  # ---------------------------------------------------------------- this Mac
  [ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS. On Windows, download DropDial from https://unknown8575.github.io/DropDial-Releases/download/"
  local macos major
  macos="$(sw_vers -productVersion 2>/dev/null || echo 0)"
  major="${macos%%.*}"
  if [ "${major}" -lt 12 ] 2>/dev/null; then fail "DropDial needs macOS 12 or later (this Mac has ${macos})."; fi

  local arch key
  arch="$(uname -m)"
  # An Apple silicon Mac running this Terminal under Rosetta still gets the Apple silicon version.
  if [ "${arch}" = "x86_64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then arch="arm64"; fi
  case "${arch}" in
    arm64) key="mac-arm64"; say "This Mac: Apple silicon, macOS ${macos}" ;;
    x86_64) key="mac-x64"; say "This Mac: Intel, macOS ${macos}" ;;
    *) fail "this Mac's processor (${arch}) isn't supported." ;;
  esac

  # Global (not local) so the clean-up below can still see it when the script ends.
  DROPDIAL_WORK="$(mktemp -d "${TMPDIR:-/tmp}/dropdial-install.XXXXXX")"
  trap 'rm -rf "${DROPDIAL_WORK:-}"' EXIT
  local work="${DROPDIAL_WORK}"

  # Reads one value from a JSON file with macOS's own plutil (macOS 12+).
  jget() { plutil -extract "$2" raw -o - "$1" 2>/dev/null || true; }

  # ---------------------------------------------------------------- find the newest version
  step "Looking for the newest version..."
  local version="" url="" size="" sha=""
  if curl -fsSL --retry 2 --connect-timeout 15 -o "${work}/latest.json" "${manifest_url}" 2>/dev/null; then
    version="$(jget "${work}/latest.json" version)"
    url="$(jget "${work}/latest.json" "${key}.url")"
    size="$(jget "${work}/latest.json" "${key}.size")"
    sha="$(jget "${work}/latest.json" "${key}.sha256" | tr 'A-F' 'a-f')"
  fi
  if [ -z "${url}" ]; then
    # No update file in the release: find the zip in the release itself (without a fingerprint to check).
    curl -fsSL --retry 2 --connect-timeout 15 -H "Accept: application/vnd.github+json" -o "${work}/release.json" "${api_url}" \
      || fail "GitHub couldn't be reached. Check your internet connection and try again."
    local i=0 name want
    want="-macOS-${key#mac-}.zip"
    while :; do
      name="$(jget "${work}/release.json" "assets.${i}.name")"
      [ -n "${name}" ] || break
      case "${name}" in
        DropDial-*"${want}") url="$(jget "${work}/release.json" "assets.${i}.browser_download_url")"; size="$(jget "${work}/release.json" "assets.${i}.size")"; break ;;
      esac
      i=$((i + 1))
    done
    version="$(jget "${work}/release.json" tag_name)"; version="${version#v}"
    [ -n "${url}" ] || fail "the newest release has no download for this Mac yet."
  fi
  case "${url}" in
    "https://github.com/${repo}/releases/download/"*) ;;
    *) fail "the download address in the release isn't DropDial's own." ;;
  esac

  local current=""
  if [ -d "/Applications/DropDial.app" ]; then
    current="$(defaults read /Applications/DropDial.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || true)"
  fi
  if [ -n "${current}" ]; then say "Installed: ${current}. Newest: ${version}."; else say "Newest version: ${version}."; fi

  # ---------------------------------------------------------------- download and check
  step "Downloading DropDial ${version}..."
  local zip="${work}/DropDial.zip"
  curl -fL --retry 2 --connect-timeout 15 --progress-bar -o "${zip}" "${url}" || fail "the download didn't finish. Check your internet connection and try again."
  if [ -n "${size}" ]; then
    local got
    got="$(stat -f %z "${zip}")"
    [ "${got}" = "${size}" ] || fail "the download is incomplete (${got} of ${size} bytes). Please try again."
  fi
  if [ -n "${sha}" ]; then
    step "Checking the download..."
    local actual
    actual="$(shasum -a 256 "${zip}" | awk '{print $1}')"
    [ "${actual}" = "${sha}" ] || fail "the download doesn't match the fingerprint published with the release. Please try again."
    say "${green}Fingerprint matches.${reset}"
  fi

  step "Unpacking..."
  ditto -x -k "${zip}" "${work}/unpacked" || fail "the download couldn't be unpacked."
  local app="${work}/unpacked/DropDial.app"
  [ -d "${app}" ] || fail "the download doesn't contain DropDial.app."

  step "Signing for this Mac..."
  xattr -cr "${app}" 2>/dev/null || true
  # Nested native code first (FFmpeg and the drag watcher), then the whole app.
  find "${app}/Contents/Resources" -type f \( -name '*.node' -o -name 'ffmpeg' -o -name '*.dylib' \) > "${work}/native.txt"
  local f
  while IFS= read -r f; do
    case "$(file -b "${f}")" in
      *Mach-O*) codesign --force --sign - "${f}" >/dev/null 2>&1 || fail "signing ${f##*/} failed." ;;
    esac
  done < "${work}/native.txt"
  codesign --force --deep --sign - "${app}" >/dev/null 2>&1 || fail "signing DropDial failed."

  # ---------------------------------------------------------------- install
  local dest_dir="/Applications"
  if [ ! -w "${dest_dir}" ]; then
    dest_dir="${HOME}/Applications"
    mkdir -p "${dest_dir}"
    say "${dim}Applications isn't writable for this account, so DropDial goes in ${dest_dir}.${reset}"
  fi
  local dest="${dest_dir}/DropDial.app"

  if pgrep -x DropDial >/dev/null 2>&1; then
    step "Closing DropDial..."
    osascript -e 'tell application "DropDial" to quit' >/dev/null 2>&1 || true
    local n=0
    while pgrep -x DropDial >/dev/null 2>&1 && [ "${n}" -lt 20 ]; do sleep 0.5; n=$((n + 1)); done
    pgrep -x DropDial >/dev/null 2>&1 && fail "DropDial is still open. Quit it and run the command again."
  fi

  step "Installing in ${dest_dir}..."
  if [ -e "${dest}" ]; then
    # The previous version goes to the Bin when macOS allows it; otherwise it is replaced.
    local stamp
    stamp="$(date +%Y%m%d-%H%M%S)"
    mv "${dest}" "${HOME}/.Trash/DropDial (previous ${stamp}).app" 2>/dev/null || rm -rf "${dest}" || fail "the previous version in ${dest_dir} couldn't be replaced."
  fi
  ditto "${app}" "${dest}" || fail "copying DropDial to ${dest_dir} failed."

  say ""
  say "${green}${bold}DropDial ${version} is installed.${reset} Opening it now."
  say "${dim}DropDial updates itself from now on. To reinstall, run the same command again.${reset}"
  open "${dest}" || true
}

main "$@"
