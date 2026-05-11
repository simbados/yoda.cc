#!/usr/bin/env bash
# Pre-deploy build script.
# Resolves shared/ symlinks into real files so each subdomain deployment
# is self-contained (required for Cloudflare Pages and similar platforms
# that may not preserve symlinks during the build checkout).
set -euo pipefail

SHARED="$(dirname "$0")/shared"

cp -L "$SHARED/style.css" "$(dirname "$0")/landing/style.css"
cp -L "$SHARED/style.css" "$(dirname "$0")/depsview/web/style.css"
cp -L "$SHARED/style.css" "$(dirname "$0")/brewview/web/style.css"

echo "build: shared assets copied to all tools."
