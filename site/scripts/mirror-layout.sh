#!/bin/sh
# Lays out the GitHub Pages mirror: the production verifier will live at its root, so until it does
# the root serves one static page that says so (mirror-root/index.html; a page, not a redirect, so
# the dev copy never looks like the product), and the dev build lives under dev/, unchanged.
# Prints every file it laid out.
#
# Usage: sh scripts/mirror-layout.sh <dev build dir> <out dir>
set -eu

here=$(cd "$(dirname "$0")" && pwd)
dev="${1:?usage: mirror-layout.sh <dev build dir> <out dir>}"
out="${2:?usage: mirror-layout.sh <dev build dir> <out dir>}"
[ -f "$dev/index.html" ] && [ -f "$dev/SHA256SUMS" ] || { echo "mirror-layout: $dev has no index.html or no SHA256SUMS. Nothing was laid out."; exit 1; }
[ ! -e "$out" ] || { echo "mirror-layout: $out already exists. Nothing was laid out."; exit 1; }

mkdir -p "$out/dev"
cp "$here/../mirror-root/index.html" "$out/index.html"
cp -R "$dev/." "$out/dev/"
echo "mirror-layout: the mirror, as GitHub Pages will serve it under /verifier/:"
(cd "$out" && find . -type f | sed 's|^\./||' | sort)
