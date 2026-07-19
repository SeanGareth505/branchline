#!/bin/bash
set -euo pipefail

APP="/Applications/Branchline.app"

osascript <<'EOF' >/dev/null 2>&1 || true
tell application "Terminal" to activate
EOF

if [[ ! -d "$APP" ]]; then
  osascript -e 'display dialog "Drag Branchline into Applications first, then run this helper again." buttons {"OK"} default button 1 with title "Branchline"'
  open /Applications
  exit 1
fi

xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP" 2>/dev/null || true
open "$APP"

osascript -e 'display notification "Branchline is ready." with title "Branchline"'
