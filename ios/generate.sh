#!/usr/bin/env bash
# Generates SmartPager.xcodeproj from project.yml.
#   PAGER_DOMAIN   domain serving /s/{shop} (default: pager.aurexis.cc)
#   APPLE_TEAM_ID  your Apple Developer Team ID (empty = unsigned builds only)
set -euo pipefail
cd "$(dirname "$0")"
export PAGER_DOMAIN="${PAGER_DOMAIN:-pager.aurexis.cc}"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
# App Store Connect only accepts builds made with Xcode 26+ (iOS 26 SDK) since 2026-04-28.
if xcode=$(xcodebuild -version 2>/dev/null | awk 'NR==1 {split($2, v, "."); print v[1]}') && [ -n "$xcode" ] && [ "$xcode" -lt 26 ]; then
  echo "Xcode $xcode is too old: the App Store needs Xcode 26 or newer. Update Xcode from the Mac App Store." >&2
  exit 1
fi
mkdir -p Generated
xcodegen generate --spec project.yml
echo "Generated SmartPager.xcodeproj for https://${PAGER_DOMAIN} (team: ${APPLE_TEAM_ID:-none})"
