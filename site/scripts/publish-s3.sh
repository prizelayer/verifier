#!/bin/sh
# Publishes one built page to the S3 bucket behind our CloudFront host. Run by the publish workflow,
# under the publish role it assumed; it reads nothing else and needs no other right.
#
# The order is what keeps a reader from loading a page whose files are not there yet:
#   1. a copy of the whole build under releases/<commit>/, kept as a record;
#   2. the files index.html loads (hashed names, so they never change once written);
#   3. SHA256SUMS, then index.html last, both with no-cache;
#   4. only then the old hashed files are removed;
#   5. the edge is told to drop what it holds, and the script waits until it has.
# A run that fails part way leaves the old index.html in place, pointing at files still there.
#
# Usage: BUCKET=<bucket> DISTRIBUTION_ID_PARAMETER=<ssm name> COMMIT=<sha> sh scripts/publish-s3.sh <dist>
set -eu

dist="${1:?usage: publish-s3.sh <dist dir>}"
: "${BUCKET:?BUCKET is not set}" "${DISTRIBUTION_ID_PARAMETER:?DISTRIBUTION_ID_PARAMETER is not set}" "${COMMIT:?COMMIT is not set}"
[ -f "$dist/index.html" ] && [ -f "$dist/SHA256SUMS" ] || { echo "publish-s3: $dist has no index.html or no SHA256SUMS"; exit 1; }
echo "$COMMIT" | grep -Eq '^[0-9a-f]{40}$' || { echo "publish-s3: COMMIT is not a full commit sha"; exit 1; }

immutable="public, max-age=31536000, immutable"
echo "publish-s3: 1/5 record copy under releases/$COMMIT/"
aws s3 cp "$dist" "s3://$BUCKET/releases/$COMMIT/" --recursive --only-show-errors
echo "publish-s3: 2/5 the files the page loads"
aws s3 cp "$dist" "s3://$BUCKET/" --recursive --exclude index.html --exclude SHA256SUMS --cache-control "$immutable" --only-show-errors
echo "publish-s3: 3/5 SHA256SUMS, then index.html"
aws s3 cp "$dist/SHA256SUMS" "s3://$BUCKET/SHA256SUMS" --cache-control no-cache --content-type "text/plain; charset=utf-8" --only-show-errors
aws s3 cp "$dist/index.html" "s3://$BUCKET/index.html" --cache-control no-cache --content-type "text/html; charset=utf-8" --only-show-errors
echo "publish-s3: 4/5 remove files no build of this page loads any more"
aws s3 sync "$dist" "s3://$BUCKET/" --delete --exclude "releases/*" --exclude index.html --exclude SHA256SUMS --cache-control "$immutable" --only-show-errors
echo "publish-s3: 5/5 drop the edge's copies and wait"
distribution=$(aws ssm get-parameter --name "$DISTRIBUTION_ID_PARAMETER" --query Parameter.Value --output text)
invalidation=$(aws cloudfront create-invalidation --distribution-id "$distribution" --paths "/*" --query Invalidation.Id --output text)
aws cloudfront wait invalidation-completed --distribution-id "$distribution" --id "$invalidation"
echo "publish-s3: done, commit $COMMIT"
