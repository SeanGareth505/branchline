#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/src-tauri/gen/android"
KEYSTORE="$OUT_DIR/branchline-release.jks"
PROPS="$OUT_DIR/keystore.properties"
ALIAS="${ANDROID_KEY_ALIAS:-branchline}"
PASSWORD="${ANDROID_KEY_PASSWORD:-}"

if [[ -z "$PASSWORD" ]]; then
  read -r -s -p "Keystore password: " PASSWORD
  echo
fi

mkdir -p "$OUT_DIR"

if [[ ! -f "$KEYSTORE" ]]; then
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -alias "$ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASSWORD" -keypass "$PASSWORD" \
    -dname "CN=Branchline, OU=Release, O=Branchline, L=Internet, ST=NA, C=US"
fi

cat > "$PROPS" <<EOF
password=$PASSWORD
keyAlias=$ALIAS
storeFile=$KEYSTORE
EOF

echo
echo "Created:"
echo "  $KEYSTORE"
echo "  $PROPS"
echo
echo "Add these GitHub Actions secrets (Settings → Secrets and variables → Actions):"
echo
echo "  ANDROID_KEY_ALIAS=$ALIAS"
echo "  ANDROID_KEY_PASSWORD=<the password you entered>"
echo "  ANDROID_KEY_BASE64=$(base64 < "$KEYSTORE" | tr -d '\n')"
echo
echo "keystore.properties and *.jks are gitignored — do not commit them."
