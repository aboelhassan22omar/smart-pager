#!/usr/bin/env bash
# Builds the cashier app TEMPLATE apk: unsigned, generic label/icon, no assets/pager.json.
# The server turns it into each brand's apk (label, icon, config) and signs it (server/src/native/apk.js).
#
#   ANDROID_JAR=<sdk>/platforms/android-35/android.jar BUILD_TOOLS=<sdk>/build-tools/35.0.1 ./build.sh [out.apk]
#
# No Gradle: aapt2 (resources), javac, R8 (shrink + obfuscate to classes.dex). Needs JDK 17+ and Python 3.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/build/cashier-template.apk}"
: "${ANDROID_JAR:?set ANDROID_JAR to platforms/android-35/android.jar}"
: "${BUILD_TOOLS:?set BUILD_TOOLS to build-tools/35.x}"
VERSION_NAME="$(cat "$HERE/VERSION")"
# 1.2.3 -> 10203
VERSION_CODE="$(echo "$VERSION_NAME" | awk -F. '{ print $1 * 10000 + $2 * 100 + $3 }')"
PY=python3; "$PY" -c "" 2>/dev/null || PY=python  # Windows ships a python3 stub that does nothing

B="$HERE/build/work"
rm -rf "$B"
mkdir -p "$B/gen" "$B/classes" "$B/dex" "$(dirname "$OUT")"
cd "$HERE"

"$BUILD_TOOLS/aapt2" compile --dir res -o "$B/res.zip"
"$BUILD_TOOLS/aapt2" link -o "$B/base.apk" -I "$ANDROID_JAR" --manifest AndroidManifest.xml \
  --java "$B/gen" --proguard "$B/aapt-rules.pro" \
  --min-sdk-version 24 --target-sdk-version 35 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  "$B/res.zip"

# Lambdas compile against the build-tools stubs; R8 desugars them below.
BOOT="$ANDROID_JAR:$BUILD_TOOLS/core-lambda-stubs.jar"
if command -v cygpath >/dev/null; then BOOT="$(cygpath -w "$ANDROID_JAR");$(cygpath -w "$BUILD_TOOLS/core-lambda-stubs.jar")"; fi
mapfile -t SOURCES < <(find src "$B/gen" -name '*.java')
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -bootclasspath "$BOOT" -d "$B/classes" "${SOURCES[@]}"

mapfile -t CLASSES < <(find "$B/classes" -name '*.class')
java -cp "$BUILD_TOOLS/lib/d8.jar" com.android.tools.r8.R8 --release --min-api 24 \
  --lib "$ANDROID_JAR" --pg-conf "$B/aapt-rules.pro" --pg-conf proguard.pro \
  --output "$B/dex" "${CLASSES[@]}"

cp "$B/base.apk" "$OUT"
"$PY" - "$OUT" "$B/dex/classes.dex" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(sys.argv[2], 'classes.dex')
PY
echo "template: $OUT ($VERSION_NAME / $VERSION_CODE)"
