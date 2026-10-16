#!/bin/sh
# The publish job's check before any credential is asked for and before any write. It runs right
# after the job's "started" marker, so a failure here reads as a failed publish, never as "approval
# not given".
#
# 1. Every setting is present and has its shape. An environment that GitHub created by itself,
#    because a job named it before anyone set it up, has no reviewer and none of these settings.
# 2. The account id and the role it names are masked, so no later line of this public log shows
#    them (the account id is an environment secret, which GitHub masks too; this covers the role).
# 3. This run's commit is still the head of main. A re-run of an older run, or an approval given
#    late, would otherwise publish an older build over a newer one; a newer commit publishes in its
#    own run.
#
# No value is ever printed. Usage: sh scripts/publish-guard.sh (reads the environment, see below).
set -eu
fail() { echo "::error::$*. Nothing was published."; exit 1; }

missing=""
for name in VERIFIER_AWS_ACCOUNT_ID VERIFIER_AWS_REGION VERIFIER_PUBLISH_ROLE VERIFIER_BUCKET VERIFIER_DISTRIBUTION_ID_PARAMETER VERIFIER_CLOUDFRONT_HOST GITHUB_SHA GITHUB_REPOSITORY; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || missing="$missing $name"
done
[ -z "$missing" ] || fail "the environment publish does not set:$missing"

echo "::add-mask::$VERIFIER_AWS_ACCOUNT_ID"
echo "::add-mask::arn:aws:iam::$VERIFIER_AWS_ACCOUNT_ID:role/$VERIFIER_PUBLISH_ROLE"

shape() { printf '%s' "$2" | grep -Eqx "$3" || fail "$1 does not have the shape of $4"; }
shape VERIFIER_AWS_ACCOUNT_ID "$VERIFIER_AWS_ACCOUNT_ID" '[0-9]{12}' "an account id (12 digits)"
shape VERIFIER_AWS_REGION "$VERIFIER_AWS_REGION" '[a-z]{2}(-[a-z]+)+-[0-9]' "a region"
shape VERIFIER_PUBLISH_ROLE "$VERIFIER_PUBLISH_ROLE" '[A-Za-z0-9+=,.@_-]{1,64}' "a role name"
shape VERIFIER_BUCKET "$VERIFIER_BUCKET" '[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]' "a bucket name"
shape VERIFIER_DISTRIBUTION_ID_PARAMETER "$VERIFIER_DISTRIBUTION_ID_PARAMETER" '/[A-Za-z0-9/_.-]+' "a parameter name"
shape VERIFIER_CLOUDFRONT_HOST "$VERIFIER_CLOUDFRONT_HOST" '[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+' "a host name (no scheme, no path)"

main=$(git ls-remote "https://github.com/$GITHUB_REPOSITORY.git" refs/heads/main | cut -f1) || main=""
[ -n "$main" ] || fail "the head of main could not be read, so this run cannot tell whether its build is still the newest"
[ "$main" = "$GITHUB_SHA" ] || fail "this run builds $GITHUB_SHA, but main is now $main; the newer commit publishes in its own run"
echo "publish-guard: every setting is present, and $GITHUB_SHA is the head of main"
