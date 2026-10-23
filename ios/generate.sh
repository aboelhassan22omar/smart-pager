#!/usr/bin/env bash
# Generates SmartPager.xcodeproj from project.yml.
#   PAGER_DOMAIN   domain serving /s/{shop} (default: pager.aurexis.cc)
#   APPLE_TEAM_ID  your Apple Developer Team ID (empty = unsigned builds only)
set -euo pipefail
cd "$(dirname "$0")"
export PAGER_DOMAIN="${PAGER_DOMAIN:-pager.aurexis.cc}"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
# Xcode 27.1+ (iOS 27.1 SDK): the app fills iPhone Duo's displays instead of running letterboxed.
if xcode=$(xcodebuild -version 2>/dev/null | awk 'NR==1 {print $2}') && [ -n "$xcode" ] &&
   ! echo "$xcode" | awk '{split($1, v, "."); exit !(v[1] > 27 || (v[1] == 27 && v[2] >= 1))}'; then
  echo "Xcode $xcode is too old: build with Xcode 27.1 or newer (iPhone Duo). Update Xcode from the Mac App Store." >&2
  exit 1
fi
mkdir -p Generated
xcodegen generate --spec project.yml
echo "Generated SmartPager.xcodeproj for https://${PAGER_DOMAIN} (team: ${APPLE_TEAM_ID:-none})"
