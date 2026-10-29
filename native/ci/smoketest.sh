#!/usr/bin/env bash
# Startet die App im Android-Emulator: einmal online, einmal ohne Netz. Speichert Bildschirmfotos + Log.
set -u
PKG=de.medialyte.rechnungen
OUT=${1:-smoke}
mkdir -p "$OUT"
adb install -r app.apk
adb logcat -c
adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 > /dev/null
sleep 30
adb exec-out screencap -p > "$OUT/1-start-online.png"
adb shell input keyevent KEYCODE_BACK
sleep 3
adb shell dumpsys window | grep -E "mCurrentFocus" > "$OUT/after-back.txt" || true
# Neustart ohne Internet
adb shell am force-stop $PKG
adb shell svc wifi disable
adb shell svc data disable
sleep 25   # Google-Dienste im Emulator starten nach dem Netzwechsel neu
adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 > /dev/null
sleep 20
if ! adb shell dumpsys window | grep mCurrentFocus | grep -q $PKG; then
  echo "App nicht im Vordergrund – zweiter Start" | tee "$OUT/offline-retry.txt"
  adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 > /dev/null
  sleep 20
fi
adb exec-out screencap -p > "$OUT/2-start-offline.png"
adb shell dumpsys window | grep -E "mCurrentFocus" > "$OUT/offline-focus.txt" || true
adb shell svc wifi enable
adb shell svc data enable
adb logcat -d > "$OUT/logcat-full.txt"
grep -E "Capacitor|chromium|AndroidRuntime|FATAL|medialyte" "$OUT/logcat-full.txt" > "$OUT/logcat.txt" || true
adb shell dumpsys package $PKG | grep -E "versionCode|versionName" > "$OUT/package.txt" || true
ls -la "$OUT"
