#!/bin/sh
# Reads the BUILT page and fails if it is not the page this repository means to publish.
#
# Every rule names the files it read and what it looked for, so a build with nothing in it cannot
# pass as clean. Usage: sh scripts/check-bundle.sh dist
set -eu

dist="${1:?usage: check-bundle.sh <dist dir>}"
here=$(cd "$(dirname "$0")" && pwd)
fail=0
bad() { echo "check-bundle: FAIL: $*"; fail=1; }

html="$dist/index.html"
[ -f "$html" ] || { echo "check-bundle: FAIL: $html does not exist"; exit 1; }
js=$(find "$dist/assets" -name '*.js' | sort)
css=$(find "$dist/assets" -name '*.css' | sort)
[ "$(printf '%s\n' "$js" | grep -c .)" -eq 1 ] || bad "expected exactly one script in $dist/assets, found: $js"
[ "$(printf '%s\n' "$css" | grep -c .)" -eq 1 ] || bad "expected exactly one stylesheet in $dist/assets, found: $css"
files="$html $js $css"
echo "check-bundle: reading $files"

# The page must run from a file on disk: a classic script, relative paths, no CORS-mode fetch.
for pattern in 'type="module"' 'crossorigin' 'src="/' 'href="/' 'url(/'; do
  if grep -F -n -- "$pattern" $html $css >/dev/null 2>&1; then bad "found '$pattern' (the page would not load from file://)"; fi
done
grep -F -q '<script defer src="./assets/app-' "$html" || bad "$html does not load ./assets/app-*.js as a classic deferred script"

# The page may ask one server, for a lookup: its own policy names only that host, and no other
# origin is compiled in. The host is the one constant of src/lookup.ts.
api='https://public-api.dev.prizelayer.com'
policy=$(grep -oE 'content="[^"]*connect-src[^"]*"' "$html" | grep -oE 'connect-src [^;"]*' || true)
[ "$policy" = "connect-src $api" ] || bad "$html carries '$policy', not 'connect-src $api'"
allowed='^(http://www\.w3\.org|https://react\.dev|https://base-ui\.com|https://tailwindcss\.com|https://public-api\.dev\.prizelayer\.com)$'
origins=$(grep -ohE '(https?|wss?)://[A-Za-z0-9.-]+' $files | sort -u)
echo "check-bundle: origins in the bundle: $(echo $origins)"
for origin in $origins; do
  echo "$origin" | grep -Eq "$allowed" || bad "origin $origin is not on the allowed list"
done

# No browser storage (the same list the source scan reads).
while IFS= read -r api; do
  [ -n "$api" ] || continue
  if grep -F -q -- "$api" $js; then bad "the script uses $api"; fi
done < "$here/storage-apis.txt"

# The words that must be there, and the two sentences that must not be, until the page can prove them.
for required in 'Check an open yourself' 'What this does not prove' \
  'The secret we revealed is the one we registered.' 'The chances are the ones recorded on your open.' \
  'The pick itself.' 'From the number to your item.' \
  'You were not shown the fingerprint or the client seed before you played' \
  'So this page cannot prove, on its own, that we did not choose the secret after your open.' \
  'This page does not check that record.'; do
  grep -F -q -- "$required" $js || bad "the script does not contain: $required"
done
for forbidden in 'published before you played' 'could not have changed it' 'existed before your open is in our audit log'; do
  if grep -F -i -q -- "$forbidden" $files; then bad "the bundle contains: $forbidden"; fi
done

[ "$fail" -eq 0 ] && echo "check-bundle: ok"
exit "$fail"
