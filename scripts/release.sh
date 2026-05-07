#!/usr/bin/env bash
# Repack upstream omltcat/dcs-retribution-remote latest release with this
# fork's app/static + app/templates and publish as a GitHub release.
#
# Usage: scripts/release.sh <tag>     e.g. scripts/release.sh v0.1.0-gfranks.1
#
# Why: the upstream retribution_remote.exe is a pyinstaller binary that loads
# app/static + app/templates from disk at runtime. Since this fork only
# changes UI files (no Python), we can reuse the upstream exe verbatim and
# just overlay our updated UI dirs on top of it.

set -euo pipefail

if [ $# -ne 1 ]; then
    echo "usage: $0 <tag>   e.g. $0 v0.1.0-gfranks.1" >&2
    exit 64
fi
TAG="$1"

REPO_ROOT=$(git rev-parse --show-toplevel)
WORK=$(mktemp -d)
trap "rm -rf $WORK" EXIT

UPSTREAM_REPO="omltcat/dcs-retribution-remote"

echo "Resolving upstream latest release URL..."
UPSTREAM_URL=$(curl -sSL "https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest" \
    | jq -r '.assets[0].browser_download_url')
if [ -z "$UPSTREAM_URL" ] || [ "$UPSTREAM_URL" = "null" ]; then
    echo "Could not resolve upstream release URL (assets[0])" >&2
    exit 1
fi
echo "Upstream URL: $UPSTREAM_URL"

echo "Downloading upstream zip..."
curl -sSL "$UPSTREAM_URL" -o "$WORK/upstream.zip"

echo "Extracting upstream zip..."
mkdir "$WORK/dist"
( cd "$WORK/dist" && unzip -q "$WORK/upstream.zip" )

echo "Overlaying fork's app/static and app/templates..."
rm -rf "$WORK/dist/app/static" "$WORK/dist/app/templates"
cp -r "$REPO_ROOT/app/static"    "$WORK/dist/app/"
cp -r "$REPO_ROOT/app/templates" "$WORK/dist/app/"

echo "Re-zipping..."
( cd "$WORK/dist" && zip -qr "$WORK/retribution_remote.zip" . )

echo "Creating GitHub release ${TAG}..."
gh release create "$TAG" "$WORK/retribution_remote.zip" \
    --title "$TAG" \
    --notes "Repack of upstream ${UPSTREAM_REPO} with fork UI updates." \
    --latest

echo "Released ${TAG}: $(gh release view "$TAG" --json url -q .url)"
