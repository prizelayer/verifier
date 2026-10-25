#!/bin/sh
# Reads the BUILT page and fails if it is not the page this repository means to publish.
#
# Every rule names the files it read and what it looked for, so a build with nothing in it cannot
# pass as clean. VERIFIER_ENV names the environment the build was made for (KAN-956): its own API
# must be the policy's one host, and every other environment's API must be nowhere in the bundle.
# Usage: VERIFIER_ENV=<env> sh scripts/check-bundle.sh dist
set -eu

dist="${1:?usage: check-bundle.sh <dist dir>}"
here=$(cd "$(dirname "$0")" && pwd)
fail=0
bad() { echo "check-bundle: FAIL: $*"; fail=1; }

# The environment, and its API and the others', from environments.json (the build's own table).
envname="${VERIFIER_ENV:-}"
table="$here/../environments.json"
[ -n "$envname" ] || { echo "check-bundle: FAIL: VERIFIER_ENV is not set: which environment this build is for is unknown. Nothing was checked."; exit 1; }
# One read of the table: line 1 is this environment's API, line 2 its list, then "<name> <api>" for
# every other environment.
values=$(node -e '
  const [file, name] = process.argv.slice(1)
  const t = JSON.parse(require("fs").readFileSync(file, "utf8"))
  if (!(name in t)) process.exit(1)
  console.log(t[name].api); console.log(t[name].sums)
  for (const [n, v] of Object.entries(t)) if (n !== name) console.log(n + " " + v.api)
' "$table" "$envname") || { echo "check-bundle: FAIL: VERIFIER_ENV '$envname' is not in $table. Nothing was checked."; exit 1; }
own_api=$(printf '%s\n' "$values" | sed -n 1p)
sums=$(printf '%s\n' "$values" | sed -n 2p)
others=$(printf '%s\n' "$values" | sed -n '3,$p')
echo "check-bundle: environment $envname: API $own_api, list $sums"

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

# The page may ask one server, for a lookup: its own environment's API. Its policy names only that
# host, and no other origin is compiled in. The host is the one value of src/lookup.ts.
policy=$(grep -oE 'content="[^"]*connect-src[^"]*"' "$html" | grep -oE 'connect-src [^;"]*' || true)
[ "$policy" = "connect-src $own_api" ] || bad "$html carries '$policy', not 'connect-src $own_api'"
grep -F -q -- "$own_api" $js || bad "the script does not name its environment's API $own_api"
# No other environment's API, anywhere: a production page that could ask dev could show a dev open
# as proven. Each is named, so a table with one environment says it compared against none.
if [ -z "$others" ]; then echo "check-bundle: no other environment in $table to forbid"; fi
while read -r other_name other_api; do
  [ -n "$other_name" ] || continue
  if grep -F -q -- "$other_api" $files; then bad "the bundle names $other_api, the API of $other_name"
  else echo "check-bundle: absent: $other_api (the API of $other_name)"; fi
done <<OTHERS
$others
OTHERS
# The footer links its environment's list of published files, on a host we do not run.
grep -F -q -- "$sums" $js || bad "the script does not link its environment's list $sums"
# The footer links to the code and to the build's two records, on GitHub: links, never fetched.
api_re=$(printf '%s' "$own_api" | sed 's/[.]/\\./g')
allowed="^(http://www\\.w3\\.org|https://react\\.dev|https://base-ui\\.com|https://tailwindcss\\.com|$api_re|https://github\\.com|https://prizelayer\\.github\\.io)\$"
origins=$(grep -ohE '(https?|wss?)://[A-Za-z0-9.-]+' $files | sort -u)
echo "check-bundle: origins in the bundle: $(echo $origins)"
for origin in $origins; do
  echo "$origin" | grep -Eq "$allowed" || bad "origin $origin is not on the allowed list"
done

# A build of the publish workflow names its own commit in the footer. Asked only when the build
# was given one, so a local build is not refused for naming none.
if [ -n "${VERIFIER_BUILD_COMMIT:-}" ]; then
  grep -F -q "$VERIFIER_BUILD_COMMIT" $js || bad "the script does not name the commit it was built from ($VERIFIER_BUILD_COMMIT)"
fi

# No browser storage (the same list the source scan reads).
while IFS= read -r api; do
  [ -n "$api" ] || continue
  if grep -F -q -- "$api" $js; then bad "the script uses $api"; fi
done < "$here/storage-apis.txt"

# The words that must be there, and the sentences that must not be: the claims the page cannot prove, and
# the two sentences that stopped being true once the player page showed the fingerprint before play and let a
# player set the client seed, so they cannot come back.
for required in 'Check an open yourself' 'What this does not prove' \
  'The secret we revealed is the one we registered.' 'The chances are the ones recorded on your open.' \
  'The pick itself.' 'From the number to your item.' \
  'On its own, it cannot tell whether you saw this fingerprint before your open, or who chose the client seed.' \
  'You never type a seed or a box here.' \
  'So this page cannot prove, on its own, that we did not choose the secret after your open.' \
  'This page does not check that record.'; do
  grep -F -q -- "$required" $js || bad "the script does not contain: $required"
done
for forbidden in 'published before you played' 'could not have changed it' 'existed before your open is in our audit log' \
  'You cannot set your own yet' 'You were not shown the fingerprint'; do
  if grep -F -i -q -- "$forbidden" $files; then bad "the bundle contains: $forbidden"; fi
done

[ "$fail" -eq 0 ] && echo "check-bundle: ok"
exit "$fail"
