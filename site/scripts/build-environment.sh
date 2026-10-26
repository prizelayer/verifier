#!/bin/sh
# Builds the page for one environment and checks it, then sets it aside under out/<env>/ with its
# list of files, so the next environment's build cannot overwrite it. The publish workflow runs it
# once per environment; each artefact is checked against its own environment's API (check-bundle).
#
# Usage: VERIFIER_ENV=<env> sh scripts/build-environment.sh
set -eu

env="${VERIFIER_ENV:-}"
[ -n "$env" ] || { echo "build-environment: VERIFIER_ENV is not set: name the environment this build is for. Nothing was built."; exit 1; }
echo "$env" | grep -Eq '^[a-z]+$' || { echo "build-environment: '$env' is not an environment name. Nothing was built."; exit 1; }
[ ! -e "out/$env" ] || { echo "build-environment: out/$env already exists: one build per environment per run. Nothing was built."; exit 1; }

npm run build
SCAN_DIST=1 npx vitest run scripts/no-browser-storage.test.ts
npm run check-bundle
echo "build-environment: $env built with node $(node --version); its SHA256SUMS (printed here, in the public log of this run):"
node scripts/sha256sums.mjs dist
mkdir -p out
mv dist "out/$env"
echo "build-environment: $env set aside in out/$env"
