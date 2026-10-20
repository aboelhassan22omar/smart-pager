#!/usr/bin/env bash
# Generates SmartPager.xcodeproj from project.yml.
#   PAGER_DOMAIN   domain serving /s/{shop} (default: example.com)
#   APPLE_TEAM_ID  your Apple Developer Team ID (empty = unsigned builds only)
set -euo pipefail
cd "$(dirname "$0")"
export PAGER_DOMAIN="${PAGER_DOMAIN:-example.com}"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
mkdir -p Generated
xcodegen generate --spec project.yml
echo "Generated SmartPager.xcodeproj for https://${PAGER_DOMAIN} (team: ${APPLE_TEAM_ID:-none})"
