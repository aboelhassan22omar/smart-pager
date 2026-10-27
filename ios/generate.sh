#!/usr/bin/env bash
# Generates SmartPager.xcodeproj from project.yml.
#   PAGER_DOMAIN   domain serving /s/{shop} (default: pager.aurexis.cc)
#   APPLE_TEAM_ID  Apple Developer Team ID that signs the app (default: MZ737V7Y46, the uploading team;
#                  change it after an App Store transfer)
set -euo pipefail
cd "$(dirname "$0")"
export PAGER_DOMAIN="${PAGER_DOMAIN:-pager.aurexis.cc}"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-MZ737V7Y46}"
# Xcode 27.1+ (iOS 27.1 SDK): the app fills iPhone Duo's displays instead of running letterboxed.
# ALLOW_XCODE_26=1 accepts 26.x (still App Store valid, Duo letterboxed): CI runners lag behind.
need="27 1"; [ "${ALLOW_XCODE_26:-}" = 1 ] && need="26 0"
if xcode=$(xcodebuild -version 2>/dev/null | awk 'NR==1 {print $2}') && [ -n "$xcode" ] &&
   ! echo "$xcode $need" | awk '{split($1, v, "."); exit !(v[1] > $2 || (v[1] == $2 && v[2] >= $3))}'; then
  echo "Xcode $xcode is too old: build with Xcode 27.1 or newer (iPhone Duo). Update Xcode from the Mac App Store." >&2
  exit 1
fi
mkdir -p Generated
xcodegen generate --spec project.yml
echo "Generated SmartPager.xcodeproj for https://${PAGER_DOMAIN} (team: ${APPLE_TEAM_ID:-none})"
