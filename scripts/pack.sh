#!/bin/sh
# Builds the Chrome Web Store upload ZIP containing only what Chrome needs.
# The repo itself is the extension; this just drops dev files from the archive.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "JSON.parse(require('node:fs').readFileSync('manifest.json','utf8')).version")
out="dist/kimi-chat-exporter-v${version}.zip"
mkdir -p dist
rm -f "$out"
zip -q -r "$out" manifest.json popup.html popup.css popup.js tasks.html tasks.css tasks.js lib icons \
  -x "*.DS_Store" -x "*/.*"
echo "packed $out ($(du -h "$out" | cut -f1))"
unzip -l "$out" | tail -n +4 | head -n 20
